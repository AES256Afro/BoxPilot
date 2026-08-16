import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern = /^[a-f0-9]{64}$/;
const applicationIds = new Set(["uptime-kuma", "pi-hole", "keel"]);

async function defaultRunner(binary, args, { timeout = 180000 } = {}) {
  const result = await execFile(binary, args, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export function validateApplicationProtectionInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["An application protection request is required"];
  if (typeof input.protectionId !== "string" || !uuidPattern.test(input.protectionId)) errors.push("Protection id must be a UUID");
  if (typeof input.backupId !== "string" || !uuidPattern.test(input.backupId)) errors.push("Backup id must be a UUID");
  if (!applicationIds.has(input.applicationId)) errors.push("Application id is invalid");
  if (typeof input.expectedArtifactChecksumSha256 !== "string" || !shaPattern.test(input.expectedArtifactChecksumSha256)) errors.push("Artifact checksum is invalid");
  if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes <= 0) errors.push("Expected artifact size is invalid");
  if (typeof input.expectedDestinationRevision !== "string" || !shaPattern.test(input.expectedDestinationRevision)) errors.push("Destination revision is invalid");
  return errors;
}

function confinedArchive(root, applicationId, backupId) {
  if (!applicationIds.has(applicationId) || !uuidPattern.test(backupId)) throw new Error("Application backup identity is invalid");
  const resolvedRoot = path.resolve(root);
  const applicationRoot = path.join(resolvedRoot, applicationId);
  const candidate = path.join(applicationRoot, `${backupId}.tar.gz`);
  if (path.dirname(candidate) !== applicationRoot) throw new Error("Application protection path escaped its fixed root");
  return candidate;
}

function confinedChild(root, child) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, child);
  if (path.dirname(candidate) !== resolvedRoot) throw new Error("Application protection path escaped its fixed root");
  return candidate;
}

export function createApplicationProtectionHelper({
  resticBinary = process.env.BOXPILOT_RESTIC_BINARY ?? "/usr/bin/restic",
  findmntBinary = process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  mountRoot = process.env.BOXPILOT_APPLICATION_BACKUP_MOUNT ?? "/mnt/boxpilot-backup",
  passwordFile = process.env.BOXPILOT_APPLICATION_RESTIC_PASSWORD_FILE ?? "/etc/boxpilot/secrets/application-backup-restic-password",
  cacheRoot = process.env.BOXPILOT_APPLICATION_RESTIC_CACHE_DIRECTORY ?? "/var/cache/boxpilot-application-restic",
  backupRoot = process.env.BOXPILOT_APPLICATION_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups",
  applicationRoot = process.env.BOXPILOT_APP_ROOT ?? "/var/lib/boxpilot-managed/apps",
  restoreDrillRoot = process.env.BOXPILOT_APPLICATION_PROTECTION_DRILL_ROOT ?? "/var/lib/boxpilot-managed/application-independent-restore-drills",
  statFile = lstat,
  statFilesystem = statfs,
  run = defaultRunner,
} = {}) {
  const resolvedMountRoot = path.resolve(mountRoot);
  const resolvedRepository = path.join(resolvedMountRoot, "restic-applications");
  const resolvedPasswordFile = path.resolve(passwordFile);
  const resolvedCacheRoot = path.resolve(cacheRoot);
  const resolvedBackupRoot = path.resolve(backupRoot);
  const resolvedApplicationRoot = path.resolve(applicationRoot);
  const resolvedRestoreDrillRoot = path.resolve(restoreDrillRoot);

  if ((!resolvedMountRoot.startsWith("/mnt/") && !resolvedMountRoot.startsWith("/media/")) || resolvedMountRoot === "/mnt" || resolvedMountRoot === "/media") throw new Error("The application backup mount must be a dedicated path below /mnt or /media");
  if (path.dirname(resolvedRepository) !== resolvedMountRoot || path.basename(resolvedRepository) !== "restic-applications") throw new Error("The application restic repository escaped the configured mount");
  if (path.basename(resolvedRestoreDrillRoot) !== "application-independent-restore-drills") throw new Error("The application restore drill root must use its fixed reserved name");

  async function initialize() {
    await mkdir(resolvedRestoreDrillRoot, { recursive: true, mode: 0o700 });
    const metadata = await statFile(resolvedRestoreDrillRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The application protection drill root is unsafe");
    await chmod(resolvedRestoreDrillRoot, 0o700);
  }

  function resticArguments() {
    return ["--repo", resolvedRepository, "--password-file", resolvedPasswordFile, "--cache-dir", resolvedCacheRoot];
  }

  async function sha256(filePath) {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) digest.update(chunk);
    return digest.digest("hex");
  }

  async function inspect() {
    const blockers = [];
    let resticVersion = null;
    let mount = null;
    let repositoryId = null;
    let destinationFreeBytes = null;
    try {
      const result = await run(resticBinary, ["version", "--json"], { timeout: 15000 });
      const version = JSON.parse(result.stdout).version;
      if (!/^\d+\.\d+\.\d+/.test(version ?? "")) throw new Error("invalid restic version");
      resticVersion = version;
    } catch {
      blockers.push("Install restic before configuring application disaster protection");
    }
    try {
      const result = await run(findmntBinary, ["--json", "--mountpoint", resolvedMountRoot, "--output", "TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN"], { timeout: 15000 });
      const filesystem = JSON.parse(result.stdout).filesystems?.[0];
      if (!filesystem || path.resolve(filesystem.target) !== resolvedMountRoot) throw new Error("not an exact mountpoint");
      if (String(filesystem.options ?? "").split(",").includes("ro")) throw new Error("read only");
      const [mountMetadata, backupMetadata, applicationMetadata, capacity] = await Promise.all([
        statFile(resolvedMountRoot), statFile(resolvedBackupRoot), statFile(resolvedApplicationRoot), statFilesystem(resolvedMountRoot),
      ]);
      if (!mountMetadata.isDirectory() || mountMetadata.isSymbolicLink()) throw new Error("unsafe mountpoint");
      if (mountMetadata.dev === backupMetadata.dev || mountMetadata.dev === applicationMetadata.dev) throw new Error("same source filesystem");
      destinationFreeBytes = Number(capacity.bavail) * Number(capacity.bsize);
      if (!Number.isSafeInteger(destinationFreeBytes) || destinationFreeBytes <= 0) throw new Error("invalid capacity");
      mount = { target: resolvedMountRoot, source: String(filesystem.source ?? "unknown"), sourceType: String(filesystem.fstype ?? "unknown"), device: String(filesystem["maj:min"] ?? filesystem.majmin ?? "unknown"), independentFilesystem: true, writable: true };
    } catch {
      blockers.push("Mount a writable filesystem independent from both application state and local backups at /mnt/boxpilot-backup");
    }
    try {
      const metadata = await statFile(resolvedPasswordFile);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o600 || metadata.size < 16 || metadata.size > 4096) throw new Error("unsafe password file");
    } catch {
      blockers.push("Create the separate root-owned mode-0600 application recovery password from the Bigbox terminal");
    }
    if (resticVersion && mount && blockers.length === 0) {
      try {
        const result = await run(resticBinary, [...resticArguments(), "cat", "config"], { timeout: 30000 });
        const config = JSON.parse(result.stdout);
        if (!shaPattern.test(config.id ?? "")) throw new Error("invalid repository config");
        repositoryId = config.id;
      } catch {
        blockers.push("Initialize and verify the fixed encrypted application restic repository");
      }
    }
    const destinationRevision = repositoryId && mount
      ? createHash("sha256").update(JSON.stringify({ repositoryId, source: mount.source, sourceType: mount.sourceType, device: mount.device, target: mount.target })).digest("hex")
      : null;
    return {
      adapter: "mounted-restic-applications", ready: blockers.length === 0, encrypted: repositoryId !== null,
      independent: mount?.independentFilesystem === true, resticVersion, mount, repositoryId, destinationRevision,
      destinationFreeBytes, blockers, setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-application-restic-setup.sh", recoveryKeyRequired: true,
      boundary: { mutationPerformed: false, browserPathAccepted: false, browserPasswordAccepted: false, repositorySelectorAccepted: false },
    };
  }

  async function verifyArchive(parameters, root = resolvedBackupRoot) {
    const artifactPath = confinedArchive(root, parameters.applicationId, parameters.backupId);
    const metadata = await statFile(artifactPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== parameters.expectedSizeBytes || (metadata.mode & 0o777) !== 0o600) throw new Error("Application backup artifact size, type, or mode changed after approval");
    const checksum = await sha256(artifactPath);
    if (checksum !== parameters.expectedArtifactChecksumSha256) throw new Error("Application backup checksum changed after approval");
    return { artifactPath, metadata, checksum };
  }

  async function protect(parameters) {
    const errors = validateApplicationProtectionInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const destination = await inspect();
    if (!destination.ready || destination.destinationRevision !== parameters.expectedDestinationRevision) throw new Error("The encrypted independent application destination is unavailable or changed");
    const source = await verifyArchive(parameters);
    if (destination.destinationFreeBytes < source.metadata.size + 256 * 1024 ** 2) throw new Error("The independent application destination does not have enough free space");
    await mkdir(resolvedCacheRoot, { recursive: true, mode: 0o700 });
    await initialize();
    const applicationTag = `boxpilot-application-${parameters.applicationId}`;
    const backupTag = `boxpilot-application-backup-${parameters.backupId}`;
    const protectionTag = `boxpilot-application-protection-${parameters.protectionId}`;
    const backup = await run(resticBinary, [...resticArguments(), "backup", source.artifactPath, "--json", "--host", "boxpilot", "--tag", "boxpilot-application", "--tag", applicationTag, "--tag", backupTag, "--tag", protectionTag], { timeout: 12 * 60 * 60 * 1000 });
    const messages = backup.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const summary = messages.findLast((message) => message.message_type === "summary");
    if (!summary || !shaPattern.test(summary.snapshot_id ?? "") || summary.dry_run === true || summary.total_bytes_processed !== source.metadata.size) throw new Error("Restic did not return complete application snapshot evidence");
    await run(resticBinary, [...resticArguments(), "check", "--read-data", "--quiet"], { timeout: 12 * 60 * 60 * 1000 });
    const snapshotsResult = await run(resticBinary, [...resticArguments(), "snapshots", "--json", "--tag", protectionTag], { timeout: 30000 });
    const snapshots = JSON.parse(snapshotsResult.stdout);
    const snapshot = snapshots.find((candidate) => candidate.id === summary.snapshot_id);
    if (!snapshot || snapshot.paths?.length !== 1 || snapshot.paths[0] !== source.artifactPath
      || !snapshot.tags?.includes("boxpilot-application") || !snapshot.tags?.includes(applicationTag)
      || !snapshot.tags?.includes(backupTag) || !snapshot.tags?.includes(protectionTag)) throw new Error("Restic application snapshot identity verification failed");
    const drillDirectory = confinedChild(resolvedRestoreDrillRoot, parameters.protectionId);
    await mkdir(drillDirectory, { recursive: false, mode: 0o700 });
    await run(resticBinary, [...resticArguments(), "restore", summary.snapshot_id, "--target", drillDirectory, "--verify"], { timeout: 12 * 60 * 60 * 1000 });
    const restoredRoot = path.join(drillDirectory, resolvedBackupRoot.replace(/^\/+/, ""));
    const restored = await verifyArchive(parameters, restoredRoot);
    if (restored.metadata.size !== source.metadata.size || restored.checksum !== source.checksum) throw new Error("Restored application snapshot evidence does not match the verified source");
    await rm(drillDirectory, { recursive: true, force: false });
    try {
      await statFile(drillDirectory);
      throw new Error("The successful application restore drill workspace was not removed");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return {
      created: true, protectionId: parameters.protectionId, backupId: parameters.backupId, applicationId: parameters.applicationId,
      destination: "mounted-restic-applications", repositoryId: destination.repositoryId, snapshotId: summary.snapshot_id,
      sizeBytes: source.metadata.size, artifactChecksumSha256: parameters.expectedArtifactChecksumSha256,
      encrypted: true, independent: true, repositoryVerified: true, protected: true,
      restoreDrill: { passed: true, mode: "exact-snapshot-artifact-restore", network: "none", publishedPorts: 0, artifactChecksumMatched: true, artifactSizeMatched: true, priorApplicationRestoreEvidencePreserved: true, workspaceRemoved: true, applicationStarted: false, productionStateReplaced: false },
      boundary: { browserPathAccepted: false, browserPasswordAccepted: false, repositorySelectorAccepted: false, productionApplicationChanged: false, localBackupChanged: false, networkAccessRequired: false, retentionPerformed: false, prunePerformed: false, routerMutationPerformed: false, dnsCutoverPerformed: false },
    };
  }

  return { initialize, inspect, protect };
}

export const applicationProtectionHelperInternals = { confinedArchive, confinedChild, defaultRunner };
