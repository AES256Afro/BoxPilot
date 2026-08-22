import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, chown, lstat, mkdir, readFile, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { streamRun } from "./exec.mjs";
import { createVmProtectionHelper } from "./vm-protection-helper.mjs";

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern = /^[a-f0-9]{64}$/;
const safeDomainPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const allowedDiskBuses = new Set(["virtio", "sata", "scsi", "ide"]);

/**
 * restic's --json output is a stream of status lines that runs for as long as the backup does.
 * execFile held all of it in a fixed 4 MB buffer and killed the child on overflow — mid-backup,
 * with the snapshot already written and nothing recorded. streamRun consumes it line by line and
 * keeps only a bounded tail, and passes each line to the job log so a multi-hour run shows progress.
 */
async function defaultRunner(binary, args, { timeout = 180000, onLine = null } = {}) {
  const result = await streamRun(binary, args, { timeout, onLine: onLine ?? (() => {}), tailBytes: 4 * 1024 * 1024 });
  if (!result.ok) {
    const detail = result.stderr.split("\n").filter(Boolean).slice(-2).join(" ") || `exit ${result.code ?? "unknown"}`;
    throw Object.assign(new Error(`${binary} failed: ${detail}`), { stdout: result.stdout, stderr: result.stderr, code: result.code });
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function restoreDrillDomainName(drillId) {
  return `boxpilot-drill-${String(drillId).replaceAll("-", "")}`;
}

function drillIdFromDomainName(domainName) {
  const match = /^boxpilot-drill-([a-f0-9]{32})$/i.exec(domainName);
  if (!match) return null;
  const value = match[1].toLowerCase();
  const drillId = `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  return uuidPattern.test(drillId) ? drillId : null;
}

export function validateVmRestoreDrillInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["A VM restore drill request is required"];
  if (typeof input.drillId !== "string" || !uuidPattern.test(input.drillId)) errors.push("Drill id must be a UUID");
  if (typeof input.backupId !== "string" || !uuidPattern.test(input.backupId)) errors.push("Backup id must be a UUID");
  if (typeof input.exportId !== "string" || !uuidPattern.test(input.exportId)) errors.push("Export id must be a UUID");
  if (typeof input.domainName !== "string" || !safeDomainPattern.test(input.domainName)) errors.push("Domain name is invalid");
  if (typeof input.domainUuid !== "string" || !uuidPattern.test(input.domainUuid)) errors.push("Domain UUID is invalid");
  if (typeof input.repositoryId !== "string" || !shaPattern.test(input.repositoryId)) errors.push("Repository id is invalid");
  if (typeof input.snapshotId !== "string" || !shaPattern.test(input.snapshotId)) errors.push("Snapshot id is invalid");
  if (typeof input.expectedManifestChecksumSha256 !== "string" || !shaPattern.test(input.expectedManifestChecksumSha256)) errors.push("Manifest checksum is invalid");
  if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes <= 0) errors.push("Expected backup size is invalid");
  if (typeof input.expectedDestinationRevision !== "string" || !shaPattern.test(input.expectedDestinationRevision)) errors.push("Destination revision is invalid");
  return errors;
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])(.*?)\2/g)) result[match[1]] = match[3];
  return result;
}

function diskBusesFromXml(xml, targets) {
  const targetTags = xml.match(/<target\b[^>]*>/g) ?? [];
  return targets.map((target) => {
    const matches = targetTags.map(attributes).filter((candidate) => candidate.dev === target && candidate.bus);
    if (matches.length !== 1 || !allowedDiskBuses.has(matches[0].bus)) throw new Error(`Restored disk ${target} has an unsupported or ambiguous bus`);
    return matches[0].bus;
  });
}

export function createVmRestoreDrillHelper({
  resticBinary = process.env.BOXPILOT_RESTIC_BINARY ?? "/usr/bin/restic",
  virtInstallBinary = process.env.BOXPILOT_VIRT_INSTALL_BINARY ?? "/usr/bin/virt-install",
  virshBinary = process.env.BOXPILOT_VIRSH_BINARY ?? "/usr/bin/virsh",
  qemuImgBinary = process.env.BOXPILOT_QEMU_IMG_BINARY ?? "/usr/bin/qemu-img",
  connectionUri = process.env.BOXPILOT_LIBVIRT_URI ?? "qemu:///system",
  mountRoot = process.env.BOXPILOT_VM_BACKUP_MOUNT ?? "/mnt/boxpilot-backup",
  passwordFile = process.env.BOXPILOT_RESTIC_PASSWORD_FILE ?? "/etc/boxpilot/secrets/vm-backup-restic-password",
  cacheRoot = process.env.BOXPILOT_RESTIC_CACHE_DIRECTORY ?? "/var/cache/boxpilot-restic",
  exportRoot = process.env.BOXPILOT_VM_EXPORT_ROOT ?? "/var/lib/boxpilot-managed/vm-exports",
  imageRoot = process.env.BOXPILOT_VM_IMAGE_ROOT ?? "/var/lib/libvirt/images",
  restoreRoot = process.env.BOXPILOT_VM_RESTORE_DRILL_ROOT ?? "/var/lib/libvirt/images/boxpilot-restore-drills",
  nvramRoot = process.env.BOXPILOT_LIBVIRT_NVRAM_ROOT ?? "/var/lib/libvirt/qemu/nvram",
  qemuGroup = process.env.BOXPILOT_LIBVIRT_QEMU_GROUP ?? "libvirt-qemu",
  destinationInspector = null,
  statFile = lstat,
  statFilesystem = statfs,
  readText = readFile,
  readDirectory = readdir,
  changeMode = chmod,
  changeOwner = chown,
  run = defaultRunner,
  wait = delay,
  removeDirectory = rm,
  clock = () => Date.now(),
  // How long a workspace left behind by a failed drill is kept so it can be inspected. Longer than
  // a working day; shorter than the time it takes several of them to fill the VM disk.
  preservedWorkspaceMs = 24 * 60 * 60 * 1000,
} = {}) {
  const resolvedMountRoot = path.resolve(mountRoot);
  const resolvedRepository = path.join(resolvedMountRoot, "restic-vm");
  const resolvedPasswordFile = path.resolve(passwordFile);
  const resolvedCacheRoot = path.resolve(cacheRoot);
  const resolvedExportRoot = path.resolve(exportRoot);
  const resolvedImageRoot = path.resolve(imageRoot);
  const resolvedRestoreRoot = path.resolve(restoreRoot);
  const resolvedNvramRoot = path.resolve(nvramRoot);
  if (path.dirname(resolvedRestoreRoot) !== resolvedImageRoot || path.basename(resolvedRestoreRoot) !== "boxpilot-restore-drills") {
    throw new Error("The VM restore drill root must be the fixed boxpilot-restore-drills directory inside the libvirt image root");
  }
  const inspectDestination = destinationInspector ?? createVmProtectionHelper({
    resticBinary, mountRoot: resolvedMountRoot, passwordFile: resolvedPasswordFile, cacheRoot: resolvedCacheRoot,
    exportRoot: resolvedExportRoot, imageRoot, statFile, statFilesystem, readText, run,
  }).inspect;

  function resticArguments() {
    return ["--repo", resolvedRepository, "--password-file", resolvedPasswordFile, "--cache-dir", resolvedCacheRoot];
  }

  async function virsh(args, options) {
    return run(virshBinary, ["--connect", connectionUri, ...args], options);
  }

  async function domainNames() {
    const result = await virsh(["list", "--all", "--name"], { timeout: 15000 });
    return result.stdout.split("\n").map((name) => name.trim()).filter(Boolean);
  }

  async function generatedNvramFiles(drillDomain) {
    let entries;
    try {
      entries = await readDirectory(resolvedNvramRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.name.startsWith(`${drillDomain}_`))
      .map((entry) => {
        if (!new RegExp(`^${drillDomain}_[A-Za-z0-9._-]{1,80}$`).test(entry.name)) throw new Error("A generated restore drill NVRAM file has an unsafe name");
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("A generated restore drill NVRAM path is not a safe regular file");
        return path.join(resolvedNvramRoot, entry.name);
      });
  }

  async function removeGeneratedNvram(drillDomain) {
    const files = await generatedNvramFiles(drillDomain);
    for (const file of files) await rm(file, { force: false });
    if ((await generatedNvramFiles(drillDomain)).length !== 0) throw new Error("Generated transient UEFI NVRAM remained after cleanup");
    return files.length;
  }

  async function securePreservedWorkspace(workspace) {
    async function secureEntry(entryPath) {
      const metadata = await statFile(entryPath);
      if (metadata.isSymbolicLink()) throw new Error("A preserved restore drill workspace contains a symbolic link");
      if (metadata.isDirectory()) {
        await changeMode(entryPath, 0o700);
        await changeOwner(entryPath, 0, 0);
        const entries = await readDirectory(entryPath, { withFileTypes: true });
        for (const entry of entries) await secureEntry(path.join(entryPath, entry.name));
        return;
      }
      if (!metadata.isFile()) throw new Error("A preserved restore drill workspace contains an unsupported file type");
      await changeMode(entryPath, 0o600);
      await changeOwner(entryPath, 0, 0);
    }
    await secureEntry(workspace);
  }

  async function recoverOrphans() {
    let restoreRootExists = false;
    try {
      const metadata = await statFile(resolvedRestoreRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The restore drill root is unsafe");
      restoreRootExists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let nvramEntries;
    try {
      nvramEntries = await readDirectory(resolvedNvramRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") nvramEntries = [];
      else throw error;
    }
    const generatedNvramDomains = new Set();
    for (const entry of nvramEntries.filter((candidate) => candidate.name.startsWith("boxpilot-drill-"))) {
      const match = /^(boxpilot-drill-[a-f0-9]{32})_[A-Za-z0-9._-]{1,80}$/i.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) throw new Error("An unsafe reserved restore drill NVRAM path requires manual inspection");
      generatedNvramDomains.add(match[1].toLowerCase());
    }
    if (!restoreRootExists && generatedNvramDomains.size === 0) {
      return { inspectedWorkspaces: 0, stoppedDomains: 0, removedNvramFiles: 0, normalizedWorkspaces: 0 };
    }
    if (!restoreRootExists) throw new Error("Generated restore drill NVRAM exists without its managed workspace");

    const workspaceEntries = await readDirectory(resolvedRestoreRoot, { withFileTypes: true });
    const workspaces = new Map();
    for (const entry of workspaceEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !uuidPattern.test(entry.name)) throw new Error("The restore drill root contains an unexpected entry");
      const workspace = path.join(resolvedRestoreRoot, entry.name);
      workspaces.set(restoreDrillDomainName(entry.name).toLowerCase(), workspace);
    }
    for (const domain of generatedNvramDomains) {
      if (!workspaces.has(domain)) throw new Error("Generated restore drill NVRAM exists without its exact managed workspace");
    }

    const names = await domainNames();
    const generatedDomains = names.filter((name) => name.startsWith("boxpilot-drill-"));
    for (const domain of generatedDomains) {
      const drillId = drillIdFromDomainName(domain);
      const workspace = workspaces.get(domain.toLowerCase());
      if (!drillId || !workspace || path.basename(workspace) !== drillId) throw new Error("A reserved restore drill domain cannot be tied to an exact managed workspace");
      const [domainInfo, interfaces, domainXml] = await Promise.all([
        virsh(["dominfo", domain], { timeout: 15000 }),
        virsh(["domiflist", domain], { timeout: 15000 }),
        virsh(["dumpxml", domain], { timeout: 15000 }),
      ]);
      const interfaceLines = interfaces.stdout.split("\n");
      const separator = interfaceLines.findIndex((line) => /^\s*-{3,}/.test(line));
      const attachedInterfaces = separator < 0 ? [] : interfaceLines.slice(separator + 1).map((line) => line.trim()).filter(Boolean);
      const sourceFiles = (domainXml.stdout.match(/<source\b[^>]*>/g) ?? []).map(attributes).map((source) => source.file).filter(Boolean);
      if (!/^Persistent:\s+no$/mi.test(domainInfo.stdout) || attachedInterfaces.length !== 0 || sourceFiles.length < 1
        || sourceFiles.some((file) => typeof file !== "string" || !file.startsWith(`${workspace}${path.sep}`))) {
        throw new Error("A reserved restore drill domain failed transient, network, or disk-path recovery validation");
      }
    }

    let stoppedDomains = 0;
    for (const domain of generatedDomains) {
      await virsh(["destroy", domain], { timeout: 30000 });
      stoppedDomains += 1;
    }
    const remaining = await domainNames();
    if (generatedDomains.some((domain) => remaining.includes(domain))) throw new Error("A recovered transient restore drill domain remained active");

    let removedNvramFiles = 0;
    let normalizedWorkspaces = 0;
    let removedWorkspaces = 0;
    let reclaimedBytes = 0;
    for (const [domain, workspace] of workspaces) {
      removedNvramFiles += await removeGeneratedNvram(domain);
      // A workspace is a full copy of the VM's disks, on the same filesystem as every live VM
      // disk. One left behind by a failed drill is kept for a day so it can be looked at, then
      // removed — before it fills the disk and blocks every future drill and recovery.
      const age = await workspaceAgeMs(workspace);
      if (age !== null && age > preservedWorkspaceMs && !remaining.includes(restoreDrillDomainName(path.basename(workspace)))) {
        reclaimedBytes += await workspaceSize(workspace);
        await removeDirectory(workspace, { recursive: true, force: true });
        removedWorkspaces += 1;
        continue;
      }
      await securePreservedWorkspace(workspace);
      normalizedWorkspaces += 1;
    }
    await changeMode(resolvedRestoreRoot, 0o700);
    await changeOwner(resolvedRestoreRoot, 0, 0);
    return { inspectedWorkspaces: workspaces.size, stoppedDomains, removedNvramFiles, normalizedWorkspaces, removedWorkspaces, reclaimedBytes };
  }

  /** How long ago a preserved workspace was written, or null when it cannot be read. */
  async function workspaceAgeMs(workspace) {
    try { return Math.max(0, clock() - (await statFile(workspace)).mtimeMs); } catch { return null; }
  }

  /** Bytes a workspace occupies, best effort — reported so the log says what was reclaimed. */
  async function workspaceSize(workspace) {
    let total = 0;
    const walk = async (directory) => {
      const entries = await readDirectory(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else total += await statFile(full).then((info) => info.size, () => 0);
      }
    };
    await walk(workspace);
    return total;
  }

  async function sha256(filePath) {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) digest.update(chunk);
    return digest.digest("hex");
  }

  async function inspect(parameters) {
    const errors = validateVmRestoreDrillInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const destination = await inspectDestination();
    const blockers = [...(destination.blockers ?? [])];
    if (destination.ready && (destination.repositoryId !== parameters.repositoryId || destination.destinationRevision !== parameters.expectedDestinationRevision)) {
      blockers.push("The encrypted repository identity changed after the backup was recorded");
    }
    let restoreFreeBytes = null;
    try {
      const capacity = await statFilesystem(resolvedImageRoot);
      restoreFreeBytes = Number(capacity.bavail) * Number(capacity.bsize);
      if (!Number.isSafeInteger(restoreFreeBytes) || restoreFreeBytes <= 0) throw new Error("invalid capacity");
      if (restoreFreeBytes < parameters.expectedSizeBytes + 1024 ** 3) blockers.push("This server does not report enough temporary space for the isolated restore drill");
    } catch {
      blockers.push("Temporary restore capacity is unavailable");
    }
    const drillDomain = restoreDrillDomainName(parameters.drillId);
    try {
      if ((await domainNames()).includes(drillDomain)) blockers.push("The generated transient drill domain name is already in use");
    } catch {
      blockers.push("Libvirt domain-name inspection is unavailable");
    }
    try {
      if ((await generatedNvramFiles(drillDomain)).length > 0) blockers.push("Generated transient drill NVRAM already exists");
    } catch {
      blockers.push("Libvirt NVRAM inspection is unavailable");
    }
    const drillDirectory = path.join(resolvedRestoreRoot, parameters.drillId);
    try {
      await statFile(drillDirectory);
      blockers.push("The generated restore drill workspace already exists");
    } catch (error) {
      if (error.code !== "ENOENT") blockers.push("Restore drill workspace inspection is unavailable");
    }
    return {
      ready: destination.ready === true && blockers.length === 0,
      destination,
      restoreFreeBytes,
      requiredBytes: parameters.expectedSizeBytes + 1024 ** 3,
      drillDomain,
      memoryMiB: 2048,
      vcpus: 2,
      network: "none",
      transient: true,
      blockers,
    };
  }

  async function verifyRestoredExport(parameters, drillDirectory) {
    const relativeExportRoot = resolvedExportRoot.replace(/^\/+/, "");
    const restoredExport = path.join(drillDirectory, relativeExportRoot, parameters.exportId);
    if (!restoredExport.startsWith(`${drillDirectory}${path.sep}`)) throw new Error("Restored export escaped the drill workspace");
    const directoryMetadata = await statFile(restoredExport);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new Error("Restored export is not a safe directory");
    const manifestPath = path.join(restoredExport, "manifest.json");
    const manifestMetadata = await statFile(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size <= 0 || manifestMetadata.size > 1024 * 1024) throw new Error("Restored manifest is unsafe");
    if (await sha256(manifestPath) !== parameters.expectedManifestChecksumSha256) throw new Error("Restored manifest checksum does not match the recorded export");
    const manifest = JSON.parse(await readText(manifestPath, "utf8"));
    if (manifest.exportId !== parameters.exportId || manifest.domain?.name !== parameters.domainName || manifest.domain?.uuid !== parameters.domainUuid
      || manifest.destination !== "local-managed" || manifest.encrypted !== false || manifest.protected !== false || manifest.restoreDrill?.passed !== false
      || manifest.domainXml?.file !== "domain.xml" || !Array.isArray(manifest.disks) || manifest.disks.length < 1 || manifest.disks.length > 32) {
      throw new Error("Restored manifest identity or safety metadata is invalid");
    }
    const files = [manifest.domainXml, ...manifest.disks];
    const names = ["manifest.json", ...files.map((file) => file.file)];
    if (new Set(names).size !== names.length || names.some((name) => typeof name !== "string" || path.basename(name) !== name || !/^[A-Za-z0-9._-]{1,80}$/.test(name))) {
      throw new Error("Restored manifest contains an unsafe file name");
    }
    const entries = await readDirectory(restoredExport, { withFileTypes: true });
    if (entries.length !== names.length || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !names.includes(entry.name))) {
      throw new Error("Restored export contains unexpected or unsafe entries");
    }
    const xmlPath = path.join(restoredExport, "domain.xml");
    const xml = await readText(xmlPath, "utf8");
    const targets = manifest.disks.map((disk) => disk.target);
    if (new Set(targets).size !== targets.length || targets.some((target) => !/^vd[a-z]{1,2}$/.test(target))) throw new Error("Restore drills require unique virtio-style disk targets");
    const buses = diskBusesFromXml(xml, targets);
    let sizeBytes = manifestMetadata.size;
    for (const file of files) {
      if (!shaPattern.test(file.checksumSha256 ?? "") || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) throw new Error("Restored manifest file evidence is invalid");
      const filePath = path.join(restoredExport, file.file);
      const metadata = await statFile(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.sizeBytes || await sha256(filePath) !== file.checksumSha256) {
        throw new Error("Restored file integrity verification failed");
      }
      sizeBytes += metadata.size;
    }
    if (sizeBytes !== parameters.expectedSizeBytes) throw new Error("Restored logical size does not match the recorded backup");
    const disks = [];
    for (let index = 0; index < manifest.disks.length; index += 1) {
      const disk = manifest.disks[index];
      const diskPath = path.join(restoredExport, disk.file);
      const check = await run(qemuImgBinary, ["check", "--output=json", diskPath], { timeout: 30 * 60 * 1000 });
      const result = JSON.parse(check.stdout || "{}");
      if (Number(result.corruptions ?? 0) !== 0 || Number(result["check-errors"] ?? 0) !== 0) throw new Error(`Restored disk ${disk.target} failed qemu-img verification`);
      disks.push({ target: disk.target, path: diskPath, bus: buses[index] });
    }
    return { restoredExport, disks, firmware: /<loader\b/i.test(xml) ? "uefi" : "bios", sizeBytes, fileCount: names.length };
  }

  async function prepareSnapshot(parameters) {
    const errors = validateVmRestoreDrillInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const readiness = await inspect(parameters);
    if (!readiness.ready) throw new Error(readiness.blockers.join(" | ") || "The encrypted VM snapshot restore is not ready");
    const drillDirectory = path.join(resolvedRestoreRoot, parameters.drillId);
    if (path.dirname(drillDirectory) !== resolvedRestoreRoot) throw new Error("Restore workspace escaped the fixed root");
    await mkdir(resolvedRestoreRoot, { recursive: true, mode: 0o700 });
    await changeMode(resolvedRestoreRoot, 0o700);
    await mkdir(drillDirectory, { mode: 0o700 });
    try {
      const backupTag = `boxpilot-backup-${parameters.backupId}`;
      const exportTag = `boxpilot-export-${parameters.exportId}`;
      const expectedSourcePath = path.join(resolvedExportRoot, parameters.exportId);
      const snapshotsResult = await run(resticBinary, [...resticArguments(), "snapshots", "--json", "--tag", backupTag], { timeout: 30000 });
      const snapshots = JSON.parse(snapshotsResult.stdout);
      const snapshot = snapshots.find((candidate) => candidate.id === parameters.snapshotId);
      if (!snapshot || snapshot.paths?.length !== 1 || snapshot.paths[0] !== expectedSourcePath
        || !snapshot.tags?.includes(backupTag) || !snapshot.tags?.includes(exportTag)) {
        throw new Error("The recorded restic snapshot identity, path, or tags changed");
      }
      await run(resticBinary, [...resticArguments(), "restore", parameters.snapshotId, "--target", drillDirectory, "--verify"], { timeout: 12 * 60 * 60 * 1000 });
      const restored = await verifyRestoredExport(parameters, drillDirectory);
      return { drillDirectory, restored, readiness };
    } catch (error) {
      throw new Error(`${error.message} The root-only restored workspace was preserved for inspection.`);
    }
  }

  async function waitForGuestAgent(drillDomain) {
    const command = '{"execute":"guest-ping"}';
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const result = await virsh(["qemu-agent-command", drillDomain, command], { timeout: 8000 });
        const response = JSON.parse(result.stdout);
        if (response.return && typeof response.return === "object") {
          await wait(2000);
          const confirmation = await virsh(["qemu-agent-command", drillDomain, command], { timeout: 8000 });
          if (JSON.parse(confirmation.stdout).return && (await virsh(["domstate", drillDomain], { timeout: 15000 })).stdout.split("\n")[0].trim() === "running") return true;
        }
      } catch {
        // The guest agent normally refuses requests until the restored OS has booted.
      }
      await wait(5000);
    }
    throw new Error("The isolated restored guest did not provide a QEMU guest-agent health signal within ten minutes");
  }

  async function grantQemuDiskAccess(drillDirectory, restoredExport, disks) {
    const group = await run("/usr/bin/id", ["-g", qemuGroup], { timeout: 15000 });
    const groupId = Number(group.stdout);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error("The libvirt QEMU group identity is unavailable");
    const relativeExport = path.relative(drillDirectory, restoredExport);
    if (!relativeExport || relativeExport.startsWith("..") || path.isAbsolute(relativeExport)) throw new Error("Restored export access path escaped the drill workspace");
    const directories = [resolvedRestoreRoot, drillDirectory];
    let current = drillDirectory;
    for (const segment of relativeExport.split(path.sep)) {
      current = path.join(current, segment);
      directories.push(current);
    }
    const access = { groupId, directories, disks: disks.map((disk) => disk.path) };
    try {
      for (const directory of directories) {
        await changeOwner(directory, 0, groupId);
        await changeMode(directory, 0o710);
      }
      for (const disk of disks) {
        if (path.dirname(disk.path) !== restoredExport) throw new Error("Restored disk access path escaped the verified export");
        await changeOwner(disk.path, 0, groupId);
        await changeMode(disk.path, 0o640);
      }
      return access;
    } catch (error) {
      try {
        await revokeQemuDiskAccess(access);
      } catch {
        throw new Error(`${error.message} Temporary QEMU disk permissions could not be fully revoked.`);
      }
      throw error;
    }
  }

  async function revokeQemuDiskAccess(access) {
    for (const diskPath of access.disks) {
      await changeMode(diskPath, 0o600);
      await changeOwner(diskPath, 0, 0);
    }
    for (const directory of [...access.directories].reverse()) {
      await changeMode(directory, 0o700);
      await changeOwner(directory, 0, 0);
    }
  }

  async function runDrill(parameters) {
    const errors = validateVmRestoreDrillInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const readiness = await inspect(parameters);
    if (!readiness.ready) throw new Error(readiness.blockers.join(" | ") || "The isolated restore drill is not ready");
    const drillDomain = readiness.drillDomain;
    const drillDirectory = path.join(resolvedRestoreRoot, parameters.drillId);
    if (path.dirname(drillDirectory) !== resolvedRestoreRoot) throw new Error("Restore drill workspace escaped the managed root");
    await mkdir(resolvedRestoreRoot, { recursive: true, mode: 0o700 });
    await changeMode(resolvedRestoreRoot, 0o700);
    await mkdir(drillDirectory, { mode: 0o700 });
    let domainStarted = false;
    let diskAccess = null;
    try {
      const backupTag = `boxpilot-backup-${parameters.backupId}`;
      const exportTag = `boxpilot-export-${parameters.exportId}`;
      const expectedSourcePath = path.join(resolvedExportRoot, parameters.exportId);
      const snapshotsResult = await run(resticBinary, [...resticArguments(), "snapshots", "--json", "--tag", backupTag], { timeout: 30000 });
      const snapshots = JSON.parse(snapshotsResult.stdout);
      const snapshot = snapshots.find((candidate) => candidate.id === parameters.snapshotId);
      if (!snapshot || snapshot.paths?.length !== 1 || snapshot.paths[0] !== expectedSourcePath
        || !snapshot.tags?.includes(backupTag) || !snapshot.tags?.includes(exportTag)) {
        throw new Error("The recorded restic snapshot identity, path, or tags changed");
      }
      await run(resticBinary, [...resticArguments(), "restore", parameters.snapshotId, "--target", drillDirectory, "--verify"], { timeout: 12 * 60 * 60 * 1000 });
      const restored = await verifyRestoredExport(parameters, drillDirectory);
      diskAccess = await grantQemuDiskAccess(drillDirectory, restored.restoredExport, restored.disks);
      const argumentsList = [
        "--connect", connectionUri,
        "--name", drillDomain,
        "--vcpus", "2",
        "--memory", "2048",
        "--osinfo", "generic",
        "--import",
      ];
      for (const disk of restored.disks) argumentsList.push("--disk", `path=${disk.path},format=qcow2,bus=${disk.bus}`);
      argumentsList.push(
        "--network", "none",
        "--channel", "unix,target_type=virtio,name=org.qemu.guest_agent.0",
        "--boot", restored.firmware === "uefi" ? "uefi" : "hd",
        "--graphics", "none",
        "--noautoconsole",
        "--transient",
      );
      await run(virtInstallBinary, argumentsList, { timeout: 180000 });
      domainStarted = (await domainNames()).includes(drillDomain);
      if (!domainStarted) throw new Error("The transient restore drill domain did not start");
      const [domainInfo, interfaces] = await Promise.all([
        virsh(["dominfo", drillDomain], { timeout: 15000 }),
        virsh(["domiflist", drillDomain], { timeout: 15000 }),
      ]);
      const interfaceLines = interfaces.stdout.split("\n");
      const separator = interfaceLines.findIndex((line) => /^\s*-{3,}/.test(line));
      const attachedInterfaces = separator < 0 ? [] : interfaceLines.slice(separator + 1).map((line) => line.trim()).filter(Boolean);
      if (!new RegExp(`^Name:\\s+${drillDomain}$`, "mi").test(domainInfo.stdout) || !/^State:\s+running$/mi.test(domainInfo.stdout)
        || !/^Persistent:\s+no$/mi.test(domainInfo.stdout) || attachedInterfaces.length !== 0) {
        throw new Error("The restore drill domain was not running, transient, and network-isolated");
      }
      await waitForGuestAgent(drillDomain);
      await virsh(["destroy", drillDomain], { timeout: 30000 });
      domainStarted = false;
      if ((await domainNames()).includes(drillDomain)) throw new Error("The transient restore drill domain remained defined after shutdown");
      await removeGeneratedNvram(drillDomain);
      await revokeQemuDiskAccess(diskAccess);
      diskAccess = null;
      await rm(drillDirectory, { recursive: true, force: true });
      try {
        await statFile(drillDirectory);
        throw new Error("The successful restore drill workspace was not removed");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return {
        passed: true,
        drillId: parameters.drillId,
        backupId: parameters.backupId,
        exportId: parameters.exportId,
        domain: parameters.domainName,
        domainUuid: parameters.domainUuid,
        repositoryId: parameters.repositoryId,
        snapshotId: parameters.snapshotId,
        sizeBytes: restored.sizeBytes,
        fileCount: restored.fileCount,
        network: "none",
        transient: true,
        persistentDomainCreated: false,
        guestAgentPing: true,
        restoredChecksumsVerified: true,
        restoredDisksVerified: true,
        temporaryQemuDiskAccessGranted: true,
        temporaryQemuDiskAccessRemoved: true,
        transientFirmwareStateRemoved: true,
        cleanupVerified: true,
        protected: true,
      };
    } catch (error) {
      let domainCleanup = "not-required";
      try {
        if (domainStarted || (await domainNames()).includes(drillDomain)) {
          await virsh(["destroy", drillDomain], { timeout: 30000 });
          domainCleanup = (await domainNames()).includes(drillDomain) ? "failed" : "completed";
        }
      } catch {
        domainCleanup = "failed";
      }
      let accessCleanup = "not-required";
      if (diskAccess) {
        try {
          await revokeQemuDiskAccess(diskAccess);
          diskAccess = null;
          accessCleanup = "completed";
        } catch {
          accessCleanup = "failed";
        }
      }
      let nvramCleanup = "not-required";
      if (domainCleanup !== "failed") {
        try {
          const removed = await removeGeneratedNvram(drillDomain);
          nvramCleanup = removed > 0 ? "completed" : "not-required";
        } catch {
          nvramCleanup = "failed";
        }
      }
      const cleanupMessage = domainCleanup === "completed"
        ? " Transient drill domain cleanup completed; the restored workspace was preserved for inspection."
        : domainCleanup === "failed"
          ? " Transient drill domain cleanup failed; inspect the exact generated domain and restored workspace immediately."
          : " The restored workspace was preserved for inspection.";
      const accessMessage = accessCleanup === "completed"
        ? " Temporary QEMU disk permissions were revoked."
        : accessCleanup === "failed"
          ? " Temporary QEMU disk-permission revocation failed; isolate the host and inspect the workspace immediately."
          : "";
      const nvramMessage = nvramCleanup === "completed"
        ? " Generated transient UEFI NVRAM cleanup completed."
        : nvramCleanup === "failed"
          ? " Generated transient UEFI NVRAM cleanup failed; inspect the exact drill domain state immediately."
          : "";
      throw new Error(`${error.message}${cleanupMessage}${accessMessage}${nvramMessage}`);
    }
  }

  return { inspect, prepareSnapshot, runDrill, recoverOrphans };
}

export const vmRestoreDrillHelperInternals = { attributes, diskBusesFromXml, drillIdFromDomainName, defaultRunner };
