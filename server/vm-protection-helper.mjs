import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, statfs } from "node:fs/promises";
import path from "node:path";
import { streamRun } from "./exec.mjs";

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern = /^[a-f0-9]{64}$/;
/** Share of the repository's data packs re-hashed after each backup; restic rotates which ones. */
const readDataSubsetPercent = 10;

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

export function validateVmProtectionInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["A VM protection request is required"];
  if (typeof input.backupId !== "string" || !uuidPattern.test(input.backupId)) errors.push("Backup id must be a UUID");
  if (typeof input.exportId !== "string" || !uuidPattern.test(input.exportId)) errors.push("Export id must be a UUID");
  if (typeof input.domainName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(input.domainName)) errors.push("Domain name is invalid");
  if (typeof input.domainUuid !== "string" || !uuidPattern.test(input.domainUuid)) errors.push("Domain UUID is invalid");
  if (typeof input.expectedManifestChecksumSha256 !== "string" || !shaPattern.test(input.expectedManifestChecksumSha256)) errors.push("Manifest checksum is invalid");
  if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes <= 0) errors.push("Expected export size is invalid");
  if (typeof input.expectedDestinationRevision !== "string" || !shaPattern.test(input.expectedDestinationRevision)) errors.push("Destination revision is invalid");
  return errors;
}

export function createVmProtectionHelper({
  resticBinary = process.env.BOXPILOT_RESTIC_BINARY ?? "/usr/bin/restic",
  findmntBinary = process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  mountRoot = process.env.BOXPILOT_VM_BACKUP_MOUNT ?? "/mnt/boxpilot-backup",
  passwordFile = process.env.BOXPILOT_RESTIC_PASSWORD_FILE ?? "/etc/boxpilot/secrets/vm-backup-restic-password",
  cacheRoot = process.env.BOXPILOT_RESTIC_CACHE_DIRECTORY ?? "/var/cache/boxpilot-restic",
  exportRoot = process.env.BOXPILOT_VM_EXPORT_ROOT ?? "/var/lib/boxpilot-managed/vm-exports",
  imageRoot = process.env.BOXPILOT_VM_IMAGE_ROOT ?? "/var/lib/libvirt/images",
  statFile = lstat,
  statFilesystem = statfs,
  readText = readFile,
  run = defaultRunner,
} = {}) {
  const resolvedMountRoot = path.resolve(mountRoot);
  const resolvedRepository = path.join(resolvedMountRoot, "restic-vm");
  const resolvedPasswordFile = path.resolve(passwordFile);
  const resolvedCacheRoot = path.resolve(cacheRoot);
  const resolvedExportRoot = path.resolve(exportRoot);
  const resolvedImageRoot = path.resolve(imageRoot);

  if ((!resolvedMountRoot.startsWith("/mnt/") && !resolvedMountRoot.startsWith("/media/")) || resolvedMountRoot === "/mnt" || resolvedMountRoot === "/media") {
    throw new Error("The VM backup mount must be a dedicated path below /mnt or /media");
  }
  if (path.dirname(resolvedRepository) !== resolvedMountRoot) throw new Error("The restic repository escaped the configured mount");

  async function sha256(filePath) {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) digest.update(chunk);
    return digest.digest("hex");
  }

  function commonResticArguments() {
    return ["--repo", resolvedRepository, "--password-file", resolvedPasswordFile, "--cache-dir", resolvedCacheRoot];
  }

  async function inspect() {
    const blockers = [];
    let resticVersion = null;
    let mount = null;
    let destinationFreeBytes = null;
    let repositoryId = null;
    try {
      const result = await run(resticBinary, ["version", "--json"], { timeout: 15000 });
      const version = JSON.parse(result.stdout).version;
      if (!/^\d+\.\d+\.\d+/.test(version ?? "")) throw new Error("invalid version");
      resticVersion = version;
    } catch {
      blockers.push("Install restic before configuring VM protection");
    }

    try {
      const result = await run(findmntBinary, ["--json", "--mountpoint", resolvedMountRoot, "--output", "TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN"], { timeout: 15000 });
      const filesystem = JSON.parse(result.stdout).filesystems?.[0];
      if (!filesystem || path.resolve(filesystem.target) !== resolvedMountRoot) throw new Error("not an exact mountpoint");
      if (String(filesystem.options ?? "").split(",").includes("ro")) throw new Error("read only");
      const [mountMetadata, exportMetadata, imageMetadata, capacity] = await Promise.all([
        statFile(resolvedMountRoot), statFile(resolvedExportRoot), statFile(resolvedImageRoot), statFilesystem(resolvedMountRoot),
      ]);
      if (!mountMetadata.isDirectory() || mountMetadata.isSymbolicLink()) throw new Error("unsafe mountpoint");
      if (mountMetadata.dev === exportMetadata.dev || mountMetadata.dev === imageMetadata.dev) throw new Error("same source filesystem");
      destinationFreeBytes = Number(capacity.bavail) * Number(capacity.bsize);
      if (!Number.isSafeInteger(destinationFreeBytes) || destinationFreeBytes <= 0) throw new Error("invalid capacity");
      mount = {
        target: resolvedMountRoot,
        sourceType: String(filesystem.fstype ?? "unknown"),
        source: String(filesystem.source ?? "unknown"),
        device: String(filesystem["maj:min"] ?? filesystem.majmin ?? "unknown"),
        independentFilesystem: true,
        writable: true,
      };
    } catch {
      blockers.push("Mount a writable independent filesystem at the configured VM backup mount");
    }

    try {
      const metadata = await statFile(resolvedPasswordFile);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o600 || metadata.size < 16 || metadata.size > 4096) throw new Error("unsafe password file");
    } catch {
      blockers.push("Create the root-owned mode-0600 restic password file from the server terminal");
    }

    if (resticVersion && mount && blockers.length === 0) {
      try {
        const result = await run(resticBinary, [...commonResticArguments(), "cat", "config"], { timeout: 30000 });
        const config = JSON.parse(result.stdout);
        if (!shaPattern.test(config.id ?? "")) throw new Error("invalid repository config");
        repositoryId = config.id;
      } catch {
        blockers.push("Initialize the encrypted restic repository on the independent mount");
      }
    }

    const destinationRevision = repositoryId && mount
      ? createHash("sha256").update(JSON.stringify({ repositoryId, source: mount.source, sourceType: mount.sourceType, device: mount.device, target: mount.target })).digest("hex")
      : null;
    return {
      adapter: "mounted-restic",
      ready: blockers.length === 0,
      encrypted: repositoryId !== null,
      independent: mount?.independentFilesystem === true,
      resticVersion,
      mount,
      repositoryId,
      destinationRevision,
      destinationFreeBytes,
      blockers,
      setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-restic-setup.sh",
      recoveryKeyRequired: true,
    };
  }

  async function verifyExport(parameters) {
    const exportDirectory = path.join(resolvedExportRoot, parameters.exportId);
    if (path.dirname(exportDirectory) !== resolvedExportRoot) throw new Error("VM export escaped the managed root");
    const exportMetadata = await statFile(exportDirectory);
    if (!exportMetadata.isDirectory() || exportMetadata.isSymbolicLink()) throw new Error("VM export artifact is not a safe managed directory");
    const manifestPath = path.join(exportDirectory, "manifest.json");
    const manifestMetadata = await statFile(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size <= 0 || manifestMetadata.size > 1024 * 1024) throw new Error("VM export manifest is unsafe");
    if (await sha256(manifestPath) !== parameters.expectedManifestChecksumSha256) throw new Error("VM export manifest checksum changed after approval");
    const manifest = JSON.parse(await readText(manifestPath, "utf8"));
    if (manifest.exportId !== parameters.exportId || manifest.domain?.name !== parameters.domainName || manifest.domain?.uuid !== parameters.domainUuid
      || manifest.destination !== "local-managed" || manifest.encrypted !== false || manifest.protected !== false || manifest.restoreDrill?.passed !== false
      || manifest.domainXml?.file !== "domain.xml" || !Array.isArray(manifest.disks) || manifest.disks.length < 1 || manifest.disks.length > 32) {
      throw new Error("VM export manifest identity or safety metadata is invalid");
    }
    const files = [manifest.domainXml, ...manifest.disks];
    const names = files.map((file) => file.file);
    if (new Set(names).size !== names.length || names.some((name) => typeof name !== "string" || path.basename(name) !== name || !/^[A-Za-z0-9._-]{1,80}$/.test(name))) {
      throw new Error("VM export manifest contains an unsafe file name");
    }
    let sizeBytes = manifestMetadata.size;
    for (const file of files) {
      if (!shaPattern.test(file.checksumSha256 ?? "") || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) throw new Error("VM export manifest contains invalid file evidence");
      const filePath = path.join(exportDirectory, file.file);
      const metadata = await statFile(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.sizeBytes || await sha256(filePath) !== file.checksumSha256) {
        throw new Error("VM export content verification failed before backup");
      }
      sizeBytes += metadata.size;
    }
    if (sizeBytes !== parameters.expectedSizeBytes) throw new Error("VM export size changed after approval");
    return { exportDirectory, fileCount: files.length + 1, sizeBytes };
  }

  async function createBackup(parameters, { progress = null } = {}) {
    const errors = validateVmProtectionInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const destination = await inspect();
    if (!destination.ready || destination.destinationRevision !== parameters.expectedDestinationRevision) throw new Error("The encrypted independent backup destination is unavailable or changed");
    if (destination.destinationFreeBytes < parameters.expectedSizeBytes + 1024 ** 3) throw new Error("The independent backup destination does not have enough free space");
    const source = await verifyExport(parameters);
    await mkdir(resolvedCacheRoot, { recursive: true, mode: 0o700 });
    const exportTag = `boxpilot-export-${parameters.exportId}`;
    const backupTag = `boxpilot-backup-${parameters.backupId}`;
    progress?.("Backing up the export into the encrypted repository...", "stdout");
    const backup = await run(resticBinary, [
      ...commonResticArguments(), "backup", source.exportDirectory, "--json", "--host", "boxpilot", "--tag", "boxpilot-vm", "--tag", exportTag, "--tag", backupTag,
    ], { timeout: 12 * 60 * 60 * 1000 });
    // Only the summary matters, and the retained tail can start mid-line once a long run passes
    // the cap. A line that does not parse is a truncated status frame, not a reason to fail a
    // backup whose snapshot already exists.
    const messages = backup.stdout.split("\n").flatMap((line) => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
    const summary = messages.findLast((message) => message.message_type === "summary");
    if (!summary || !shaPattern.test(summary.snapshot_id ?? "") || summary.dry_run === true || summary.total_bytes_processed !== source.sizeBytes) {
      throw new Error("Restic did not return complete snapshot evidence");
    }
    // Structure always, plus a rotating slice of the data. A full --read-data grows with the
    // repository rather than with this backup, so on a box with a few VMs it eventually runs past
    // the operation's own deadline and every backup starts failing.
    progress?.("Verifying the repository...", "stdout");
    await run(resticBinary, [...commonResticArguments(), "check", `--read-data-subset=${readDataSubsetPercent}%`, "--quiet"], { timeout: 12 * 60 * 60 * 1000, onLine: progress ?? null });
    const snapshotsResult = await run(resticBinary, [...commonResticArguments(), "snapshots", "--json", "--tag", backupTag], { timeout: 30000 });
    const snapshots = JSON.parse(snapshotsResult.stdout);
    const snapshot = snapshots.find((candidate) => candidate.id === summary.snapshot_id);
    if (!snapshot || !snapshot.paths?.includes(source.exportDirectory) || !snapshot.tags?.includes(exportTag) || !snapshot.tags?.includes(backupTag)) {
      throw new Error("Restic snapshot identity verification failed");
    }
    return {
      created: true,
      backupId: parameters.backupId,
      exportId: parameters.exportId,
      domain: parameters.domainName,
      domainUuid: parameters.domainUuid,
      destination: "mounted-restic",
      repositoryId: destination.repositoryId,
      snapshotId: summary.snapshot_id,
      sizeBytes: source.sizeBytes,
      fileCount: source.fileCount,
      encrypted: true,
      independent: true,
      repositoryVerified: true,
      protected: false,
      restoreDrill: { passed: false, reason: "An isolated restore boot has not run" },
    };
  }

  return { inspect, createBackup };
}

export const vmProtectionHelperInternals = { defaultRunner };
