import { chmod, chown, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createVmRestoreDrillHelper, vmRestoreDrillHelperInternals } from "./vm-restore-drill-helper.mjs";

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern = /^[a-f0-9]{64}$/;
const safeDomainPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

export function validateVmRecoveryInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["A VM recovery request is required"];
  if (typeof input.restoreId !== "string" || !uuidPattern.test(input.restoreId)) errors.push("Restore id must be a UUID");
  if (typeof input.backupId !== "string" || !uuidPattern.test(input.backupId)) errors.push("Backup id must be a UUID");
  if (typeof input.exportId !== "string" || !uuidPattern.test(input.exportId)) errors.push("Export id must be a UUID");
  if (typeof input.sourceDomainName !== "string" || !safeDomainPattern.test(input.sourceDomainName)) errors.push("Source domain name is invalid");
  if (typeof input.sourceDomainUuid !== "string" || !uuidPattern.test(input.sourceDomainUuid)) errors.push("Source domain UUID is invalid");
  if (typeof input.targetDomainName !== "string" || !safeDomainPattern.test(input.targetDomainName)) errors.push("Recovery domain name is invalid");
  if (typeof input.targetDomainName === "string" && input.targetDomainName.toLowerCase().startsWith("boxpilot-drill-")) errors.push("Recovery domain name uses the reserved restore-drill namespace");
  if (typeof input.restoreDrillId !== "string" || !uuidPattern.test(input.restoreDrillId)) errors.push("Restore drill id must be a UUID");
  if (typeof input.repositoryId !== "string" || !shaPattern.test(input.repositoryId)) errors.push("Repository id is invalid");
  if (typeof input.snapshotId !== "string" || !shaPattern.test(input.snapshotId)) errors.push("Snapshot id is invalid");
  if (typeof input.expectedManifestChecksumSha256 !== "string" || !shaPattern.test(input.expectedManifestChecksumSha256)) errors.push("Manifest checksum is invalid");
  if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes <= 0) errors.push("Expected backup size is invalid");
  if (typeof input.expectedDestinationRevision !== "string" || !shaPattern.test(input.expectedDestinationRevision)) errors.push("Destination revision is invalid");
  return errors;
}

function restoreInput(input) {
  return {
    drillId: input.restoreId,
    backupId: input.backupId,
    exportId: input.exportId,
    domainName: input.sourceDomainName,
    domainUuid: input.sourceDomainUuid,
    repositoryId: input.repositoryId,
    snapshotId: input.snapshotId,
    expectedManifestChecksumSha256: input.expectedManifestChecksumSha256,
    expectedSizeBytes: input.expectedSizeBytes,
    expectedDestinationRevision: input.expectedDestinationRevision,
  };
}

function xmlAttributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])(.*?)\2/g)) result[match[1]] = match[3];
  return result;
}

function interfaceRows(output) {
  const lines = output.split("\n");
  const separator = lines.findIndex((line) => /^\s*-{3,}/.test(line));
  return separator < 0 ? [] : lines.slice(separator + 1).map((line) => line.trim()).filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createVmRecoveryHelper({
  restoreEngine = createVmRestoreDrillHelper(),
  virtInstallBinary = process.env.BOXPILOT_VIRT_INSTALL_BINARY ?? "/usr/bin/virt-install",
  virshBinary = process.env.BOXPILOT_VIRSH_BINARY ?? "/usr/bin/virsh",
  connectionUri = process.env.BOXPILOT_LIBVIRT_URI ?? "qemu:///system",
  imageRoot = process.env.BOXPILOT_VM_IMAGE_ROOT ?? "/var/lib/libvirt/images",
  recoveryRoot = process.env.BOXPILOT_VM_RECOVERY_ROOT ?? "/var/lib/libvirt/images/boxpilot-recoveries",
  qemuGroup = process.env.BOXPILOT_LIBVIRT_QEMU_GROUP ?? "libvirt-qemu",
  statFile = lstat,
  changeMode = chmod,
  changeOwner = chown,
  move = rename,
  remove = rm,
  writeText = writeFile,
  run = vmRestoreDrillHelperInternals.defaultRunner,
} = {}) {
  const resolvedImageRoot = path.resolve(imageRoot);
  const resolvedRecoveryRoot = path.resolve(recoveryRoot);
  if (path.dirname(resolvedRecoveryRoot) !== resolvedImageRoot || path.basename(resolvedRecoveryRoot) !== "boxpilot-recoveries") {
    throw new Error("The VM recovery root must be the fixed boxpilot-recoveries directory inside the libvirt image root");
  }

  async function virsh(args, options) {
    return run(virshBinary, ["--connect", connectionUri, ...args], options);
  }

  async function domainNames() {
    const result = await virsh(["list", "--all", "--name"], { timeout: 15000 });
    return result.stdout.split("\n").map((name) => name.trim()).filter(Boolean);
  }

  async function pathExists(candidate) {
    try {
      return await statFile(candidate);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function inspect(input) {
    const errors = validateVmRecoveryInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    const snapshot = await restoreEngine.inspect(restoreInput(input));
    const blockers = [...(snapshot.blockers ?? [])];
    let names = [];
    try {
      names = await domainNames();
      if (names.some((name) => name.toLowerCase() === input.targetDomainName.toLowerCase())) blockers.push("The recovery domain name is already in use");
    } catch {
      blockers.push("Libvirt recovery-domain inspection is unavailable");
    }
    const finalDirectory = path.join(resolvedRecoveryRoot, input.restoreId);
    if (path.dirname(finalDirectory) !== resolvedRecoveryRoot) throw new Error("Recovery destination escaped the fixed root");
    try {
      const rootMetadata = await pathExists(resolvedRecoveryRoot);
      if (rootMetadata && (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())) blockers.push("The fixed recovery root is unsafe");
      if (await pathExists(finalDirectory)) blockers.push("The generated recovery destination already exists");
    } catch {
      blockers.push("Recovery destination inspection is unavailable");
    }
    return {
      ready: snapshot.ready === true && blockers.length === 0,
      snapshot,
      targetDomainName: input.targetDomainName,
      targetNameAvailable: !names.some((name) => name.toLowerCase() === input.targetDomainName.toLowerCase()),
      network: "none",
      persistent: true,
      initialState: "stopped",
      autostart: false,
      memoryMiB: 2048,
      vcpus: 2,
      blockers,
    };
  }

  async function grantPersistentDiskAccess(finalDirectory, disks) {
    const group = await run("/usr/bin/id", ["-g", qemuGroup], { timeout: 15000 });
    const groupId = Number(group.stdout);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error("The libvirt QEMU group identity is unavailable");
    await changeOwner(resolvedRecoveryRoot, 0, groupId);
    await changeMode(resolvedRecoveryRoot, 0o710);
    await changeOwner(finalDirectory, 0, groupId);
    await changeMode(finalDirectory, 0o710);
    for (const disk of disks) {
      if (path.dirname(disk.path) !== finalDirectory) throw new Error("Recovery disk escaped the fixed destination");
      await changeOwner(disk.path, 0, groupId);
      await changeMode(disk.path, 0o640);
    }
    return groupId;
  }

  async function revokePersistentDiskAccess(finalDirectory, disks) {
    for (const disk of disks) {
      if (await pathExists(disk.path)) {
        await changeMode(disk.path, 0o600);
        await changeOwner(disk.path, 0, 0);
      }
    }
    if (await pathExists(finalDirectory)) {
      await changeMode(finalDirectory, 0o700);
      await changeOwner(finalDirectory, 0, 0);
    }
  }

  function validateDefinitionXml(xml, input, disks) {
    if (!new RegExp(`<name>\\s*${escapeRegExp(input.targetDomainName)}\\s*</name>`, "i").test(xml)) throw new Error("Generated recovery domain XML has the wrong name");
    if (/<interface\b/i.test(xml)) throw new Error("Generated recovery domain XML unexpectedly contains a network interface");
    const sourceFiles = (xml.match(/<source\b[^>]*>/g) ?? []).map(xmlAttributes).map((source) => source.file).filter(Boolean);
    const expected = disks.map((disk) => disk.path).sort();
    if (sourceFiles.length !== expected.length || sourceFiles.sort().some((file, index) => file !== expected[index])) throw new Error("Generated recovery domain XML has unexpected disk sources");
    const channelTargets = (xml.match(/<target\b[^>]*>/g) ?? []).map(xmlAttributes);
    if (!channelTargets.some((target) => target.type === "virtio" && target.name === "org.qemu.guest_agent.0")) throw new Error("Generated recovery domain XML is missing the fixed guest-agent channel");
  }

  async function defineAndVerify(input, prepared, finalDirectory, disks) {
    const args = [
      "--connect", connectionUri,
      "--name", input.targetDomainName,
      "--vcpus", "2",
      "--memory", "2048",
      "--osinfo", "generic",
      "--import",
    ];
    for (const disk of disks) args.push("--disk", `path=${disk.path},format=qcow2,bus=${disk.bus}`);
    args.push(
      "--network", "none",
      "--channel", "unix,target_type=virtio,name=org.qemu.guest_agent.0",
      "--boot", prepared.restored.firmware === "uefi" ? "uefi" : "hd",
      "--graphics", "spice,listen=127.0.0.1",
      "--noautoconsole",
      "--print-xml",
    );
    const generated = await run(virtInstallBinary, args, { timeout: 180000 });
    validateDefinitionXml(generated.stdout, input, disks);
    const definitionPath = path.join(finalDirectory, "recovery-domain.xml");
    await writeText(definitionPath, `${generated.stdout.trim()}\n`, { mode: 0o600, flag: "wx" });
    await changeOwner(definitionPath, 0, 0);
    await changeMode(definitionPath, 0o600);
    await virsh(["define", definitionPath], { timeout: 30000 });
    await virsh(["autostart", input.targetDomainName, "--disable"], { timeout: 15000 });
    const [info, state, interfaces, xml, uuid] = await Promise.all([
      virsh(["dominfo", input.targetDomainName], { timeout: 15000 }),
      virsh(["domstate", input.targetDomainName], { timeout: 15000 }),
      virsh(["domiflist", input.targetDomainName], { timeout: 15000 }),
      virsh(["dumpxml", input.targetDomainName], { timeout: 15000 }),
      virsh(["domuuid", input.targetDomainName], { timeout: 15000 }),
    ]);
    validateDefinitionXml(xml.stdout, input, disks);
    const domainUuid = uuid.stdout.split("\n")[0].trim();
    if (!uuidPattern.test(domainUuid) || !/^Persistent:\s+yes$/mi.test(info.stdout) || !/^Autostart:\s+disable[d]?$/mi.test(info.stdout)
      || !["shut off", "shutoff"].includes(state.stdout.split("\n")[0].trim().toLowerCase()) || interfaceRows(interfaces.stdout).length !== 0) {
      throw new Error("The recovered domain was not persistent, stopped, non-autostarting, and network-isolated");
    }
    return { domainUuid, definitionPath };
  }

  async function undefineExactRecovery(targetDomainName, finalDirectory) {
    if (!(await domainNames()).includes(targetDomainName)) return "not-required";
    const [info, state, interfaces, xml] = await Promise.all([
      virsh(["dominfo", targetDomainName], { timeout: 15000 }),
      virsh(["domstate", targetDomainName], { timeout: 15000 }),
      virsh(["domiflist", targetDomainName], { timeout: 15000 }),
      virsh(["dumpxml", targetDomainName], { timeout: 15000 }),
    ]);
    const sourceFiles = (xml.stdout.match(/<source\b[^>]*>/g) ?? []).map(xmlAttributes).map((source) => source.file).filter(Boolean);
    if (!/^Persistent:\s+yes$/mi.test(info.stdout) || !["shut off", "shutoff"].includes(state.stdout.trim().toLowerCase())
      || interfaceRows(interfaces.stdout).length !== 0 || sourceFiles.length < 1
      || sourceFiles.some((file) => typeof file !== "string" || !file.startsWith(`${finalDirectory}${path.sep}`))) {
      throw new Error("The incomplete recovery domain failed exact rollback validation");
    }
    const undefineArgs = ["undefine", targetDomainName];
    if (/<nvram\b/i.test(xml.stdout)) undefineArgs.push("--nvram");
    await virsh(undefineArgs, { timeout: 30000 });
    if ((await domainNames()).includes(targetDomainName)) throw new Error("The incomplete recovery domain remained defined");
    return "completed";
  }

  async function createRecovery(input, { progress = null } = {}) {
    const errors = validateVmRecoveryInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    const readiness = await inspect(input);
    if (!readiness.ready) throw new Error(readiness.blockers.join(" | ") || "The guarded VM recovery is not ready");
    const finalDirectory = path.join(resolvedRecoveryRoot, input.restoreId);
    let prepared = null;
    let disks = [];
    let moved = false;
    let domainDefined = false;
    try {
      // The restore is the long part of a recovery; its output belongs in the job log.
      prepared = await restoreEngine.prepareSnapshot(restoreInput(input), { progress });
      await mkdir(resolvedRecoveryRoot, { recursive: true, mode: 0o700 });
      await move(prepared.restored.restoredExport, finalDirectory);
      moved = true;
      disks = prepared.restored.disks.map((disk) => ({ ...disk, path: path.join(finalDirectory, path.basename(disk.path)) }));
      await remove(prepared.drillDirectory, { recursive: true, force: true });
      await grantPersistentDiskAccess(finalDirectory, disks);
      for (const file of ["manifest.json", "domain.xml"]) {
        const filePath = path.join(finalDirectory, file);
        await changeOwner(filePath, 0, 0);
        await changeMode(filePath, 0o600);
      }
      const defined = await defineAndVerify(input, prepared, finalDirectory, disks);
      domainDefined = true;
      return {
        created: true,
        restoreId: input.restoreId,
        backupId: input.backupId,
        exportId: input.exportId,
        sourceDomain: input.sourceDomainName,
        sourceDomainUuid: input.sourceDomainUuid,
        domain: input.targetDomainName,
        domainUuid: defined.domainUuid,
        repositoryId: input.repositoryId,
        snapshotId: input.snapshotId,
        sizeBytes: prepared.restored.sizeBytes,
        fileCount: prepared.restored.fileCount,
        persistent: true,
        state: "stopped",
        network: "none",
        autostart: false,
        encryptedSource: true,
        protectedSource: true,
        restoredChecksumsVerified: true,
        restoredDisksVerified: true,
        sourceUnchanged: true,
        snapshotUnchanged: true,
      };
    } catch (error) {
      let domainCleanup = "not-required";
      let artifactCleanup = "not-required";
      try {
        if (domainDefined || (await domainNames()).includes(input.targetDomainName)) domainCleanup = await undefineExactRecovery(input.targetDomainName, finalDirectory);
      } catch {
        domainCleanup = "failed";
      }
      if (moved && domainCleanup !== "failed") {
        try {
          await revokePersistentDiskAccess(finalDirectory, disks);
          await remove(finalDirectory, { recursive: true, force: true });
          artifactCleanup = (await pathExists(finalDirectory)) ? "failed" : "completed";
        } catch {
          artifactCleanup = "failed";
        }
      }
      const cleanup = domainCleanup === "failed" || artifactCleanup === "failed"
        ? " Automatic recovery-clone cleanup failed; preserve the exact generated domain and disk directory for manual inspection."
        : moved
          ? " Automatic recovery-clone rollback removed the new domain definition and generated disk directory."
          : " The root-only restic staging workspace was preserved for inspection.";
      throw new Error(`${error.message}${cleanup}`);
    }
  }

  return { inspect, createRecovery };
}
