import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { controllerBackupHelperInternals } from "./controller-backup-helper.mjs";

const execFile = promisify(execFileCallback);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern = /^[a-f0-9]{64}$/;

async function defaultRunner(binary, args, { timeout = 180000 } = {}) {
  const result = await execFile(binary, args, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export function validateControllerProtectionInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["A controller protection request is required"];
  if (typeof input.protectionId !== "string" || !uuidPattern.test(input.protectionId)) errors.push("Protection id must be a UUID");
  if (typeof input.backupId !== "string" || !uuidPattern.test(input.backupId)) errors.push("Backup id must be a UUID");
  if (typeof input.expectedArtifactChecksumSha256 !== "string" || !shaPattern.test(input.expectedArtifactChecksumSha256)) errors.push("Artifact checksum is invalid");
  if (typeof input.expectedManifestChecksumSha256 !== "string" || !shaPattern.test(input.expectedManifestChecksumSha256)) errors.push("Manifest checksum is invalid");
  if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes <= 0) errors.push("Expected artifact size is invalid");
  if (typeof input.expectedDestinationRevision !== "string" || !shaPattern.test(input.expectedDestinationRevision)) errors.push("Destination revision is invalid");
  return errors;
}

function confinedChild(root, child) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, child);
  if (path.dirname(candidate) !== resolvedRoot) throw new Error("Controller protection path escaped its fixed root");
  return candidate;
}

export function createControllerProtectionHelper({
  resticBinary = process.env.BOXPILOT_RESTIC_BINARY ?? "/usr/bin/restic",
  findmntBinary = process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  mountRoot = process.env.BOXPILOT_CONTROLLER_BACKUP_MOUNT ?? "/mnt/boxpilot-backup",
  passwordFile = process.env.BOXPILOT_CONTROLLER_RESTIC_PASSWORD_FILE ?? "/etc/boxpilot/secrets/controller-backup-restic-password",
  cacheRoot = process.env.BOXPILOT_CONTROLLER_RESTIC_CACHE_DIRECTORY ?? "/var/cache/boxpilot-controller-restic",
  backupRoot = process.env.BOXPILOT_CONTROLLER_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups/boxpilot-controller",
  sourceDatabasePath = process.env.BOXPILOT_CONTROLLER_DATABASE ?? "/var/lib/boxpilot/boxpilot.sqlite3",
  restoreDrillRoot = process.env.BOXPILOT_CONTROLLER_PROTECTION_DRILL_ROOT ?? "/var/lib/boxpilot-managed/controller-independent-restore-drills",
  statFile = lstat,
  statFilesystem = statfs,
  readText = readFile,
  readDirectory = readdir,
  run = defaultRunner,
} = {}) {
  const resolvedMountRoot = path.resolve(mountRoot);
  const resolvedRepository = path.join(resolvedMountRoot, "restic-controller");
  const resolvedPasswordFile = path.resolve(passwordFile);
  const resolvedCacheRoot = path.resolve(cacheRoot);
  const resolvedBackupRoot = path.resolve(backupRoot);
  const resolvedSourceDatabasePath = path.resolve(sourceDatabasePath);
  const resolvedRestoreDrillRoot = path.resolve(restoreDrillRoot);

  if ((!resolvedMountRoot.startsWith("/mnt/") && !resolvedMountRoot.startsWith("/media/")) || resolvedMountRoot === "/mnt" || resolvedMountRoot === "/media") {
    throw new Error("The controller backup mount must be a dedicated path below /mnt or /media");
  }
  if (path.dirname(resolvedRepository) !== resolvedMountRoot || path.basename(resolvedRepository) !== "restic-controller") throw new Error("The controller restic repository escaped the configured mount");
  if (path.basename(resolvedRestoreDrillRoot) !== "controller-independent-restore-drills") throw new Error("The controller restore drill root must use its fixed reserved name");

  async function initialize() {
    await mkdir(resolvedRestoreDrillRoot, { recursive: true, mode: 0o700 });
    const metadata = await statFile(resolvedRestoreDrillRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("The controller protection drill root is unsafe");
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
      blockers.push("Install restic before configuring controller disaster protection");
    }

    try {
      const result = await run(findmntBinary, ["--json", "--mountpoint", resolvedMountRoot, "--output", "TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN"], { timeout: 15000 });
      const filesystem = JSON.parse(result.stdout).filesystems?.[0];
      if (!filesystem || path.resolve(filesystem.target) !== resolvedMountRoot) throw new Error("not an exact mountpoint");
      if (String(filesystem.options ?? "").split(",").includes("ro")) throw new Error("read only");
      const [mountMetadata, backupMetadata, databaseMetadata, capacity] = await Promise.all([
        statFile(resolvedMountRoot), statFile(resolvedBackupRoot), statFile(resolvedSourceDatabasePath), statFilesystem(resolvedMountRoot),
      ]);
      if (!mountMetadata.isDirectory() || mountMetadata.isSymbolicLink()) throw new Error("unsafe mountpoint");
      if (mountMetadata.dev === backupMetadata.dev || mountMetadata.dev === databaseMetadata.dev) throw new Error("same source filesystem");
      destinationFreeBytes = Number(capacity.bavail) * Number(capacity.bsize);
      if (!Number.isSafeInteger(destinationFreeBytes) || destinationFreeBytes <= 0) throw new Error("invalid capacity");
      mount = {
        target: resolvedMountRoot,
        source: String(filesystem.source ?? "unknown"),
        sourceType: String(filesystem.fstype ?? "unknown"),
        device: String(filesystem["maj:min"] ?? filesystem.majmin ?? "unknown"),
        independentFilesystem: true,
        writable: true,
      };
    } catch {
      blockers.push("Mount a writable filesystem independent from both BoxPilot state locations at /mnt/boxpilot-backup");
    }

    try {
      const metadata = await statFile(resolvedPasswordFile);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o600 || metadata.size < 16 || metadata.size > 4096) throw new Error("unsafe password file");
    } catch {
      blockers.push("Create the separate root-owned mode-0600 controller recovery password from the server terminal");
    }

    if (resticVersion && mount && blockers.length === 0) {
      try {
        const result = await run(resticBinary, [...resticArguments(), "cat", "config"], { timeout: 30000 });
        const config = JSON.parse(result.stdout);
        if (!shaPattern.test(config.id ?? "")) throw new Error("invalid repository config");
        repositoryId = config.id;
      } catch {
        blockers.push("Initialize and verify the fixed encrypted controller restic repository");
      }
    }

    const destinationRevision = repositoryId && mount
      ? createHash("sha256").update(JSON.stringify({ repositoryId, source: mount.source, sourceType: mount.sourceType, device: mount.device, target: mount.target })).digest("hex")
      : null;
    return {
      adapter: "mounted-restic-controller",
      ready: blockers.length === 0,
      encrypted: repositoryId !== null,
      independent: mount?.independentFilesystem === true,
      resticVersion,
      mount,
      repositoryId,
      destinationRevision,
      destinationFreeBytes,
      blockers,
      setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-controller-restic-setup.sh",
      recoveryKeyRequired: true,
      boundary: { mutationPerformed: false, browserPathAccepted: false, browserPasswordAccepted: false, repositorySelectorAccepted: false },
    };
  }

  async function verifyLocalBackup(parameters, root = resolvedBackupRoot) {
    const backupDirectory = confinedChild(root, parameters.backupId);
    const directoryMetadata = await statFile(backupDirectory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new Error("Controller backup is not a safe managed directory");
    const entries = await readDirectory(backupDirectory, { withFileTypes: true });
    const expectedNames = ["boxpilot.sqlite3", "manifest.json"];
    if (entries.length !== expectedNames.length || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expectedNames.includes(entry.name))) throw new Error("Controller backup contains unexpected or unsafe entries");
    const artifactPath = path.join(backupDirectory, "boxpilot.sqlite3");
    const manifestPath = path.join(backupDirectory, "manifest.json");
    const [artifactMetadata, manifestMetadata] = await Promise.all([statFile(artifactPath), statFile(manifestPath)]);
    if (!artifactMetadata.isFile() || artifactMetadata.isSymbolicLink() || artifactMetadata.size !== parameters.expectedSizeBytes) throw new Error("Controller backup artifact size changed after approval");
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size < 1 || manifestMetadata.size > 1024 * 1024) throw new Error("Controller backup manifest is unsafe");
    const [artifactChecksum, manifestChecksum] = await Promise.all([sha256(artifactPath), sha256(manifestPath)]);
    if (artifactChecksum !== parameters.expectedArtifactChecksumSha256 || manifestChecksum !== parameters.expectedManifestChecksumSha256) throw new Error("Controller backup checksum changed after approval");
    const manifest = JSON.parse(await readText(manifestPath, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.backupId !== parameters.backupId || manifest.applicationId !== "boxpilot-controller"
      || manifest.artifact !== "boxpilot.sqlite3" || manifest.checksumSha256 !== artifactChecksum || manifest.sizeBytes !== artifactMetadata.size
      || manifest.method !== "sqlite-vacuum-into" || manifest.restoreDrill?.passed !== true || manifest.restoreDrill?.integrityCheck !== "ok"
      || manifest.restoreDrill?.foreignKeyIssues !== 0 || manifest.restoreDrill?.schemaVerified !== true || manifest.restoreDrill?.ownerStatePresent !== true) {
      throw new Error("Controller backup manifest identity or verification evidence is invalid");
    }
    const database = controllerBackupHelperInternals.databaseEvidence(artifactPath);
    if (database.integrityCheck !== "ok" || database.foreignKeyIssues !== 0 || database.missingTables.length || database.ownerCount < 1 || database.schemaFingerprint !== manifest.restoreDrill.schemaFingerprint) {
      throw new Error("Controller backup database failed independent protection verification");
    }
    return { backupDirectory, artifactPath, manifestPath, artifactMetadata, manifestMetadata, database, totalBytes: artifactMetadata.size + manifestMetadata.size };
  }

  async function protect(parameters) {
    const errors = validateControllerProtectionInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const destination = await inspect();
    if (!destination.ready || destination.destinationRevision !== parameters.expectedDestinationRevision) throw new Error("The encrypted independent controller destination is unavailable or changed");
    const source = await verifyLocalBackup(parameters);
    if (destination.destinationFreeBytes < source.totalBytes + 256 * 1024 ** 2) throw new Error("The independent controller destination does not have enough free space");
    await mkdir(resolvedCacheRoot, { recursive: true, mode: 0o700 });
    await initialize();
    const backupTag = `boxpilot-controller-backup-${parameters.backupId}`;
    const protectionTag = `boxpilot-controller-protection-${parameters.protectionId}`;
    const backup = await run(resticBinary, [
      ...resticArguments(), "backup", source.backupDirectory, "--json", "--host", "boxpilot", "--tag", "boxpilot-controller", "--tag", backupTag, "--tag", protectionTag,
    ], { timeout: 12 * 60 * 60 * 1000 });
    const messages = backup.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const summary = messages.findLast((message) => message.message_type === "summary");
    if (!summary || !shaPattern.test(summary.snapshot_id ?? "") || summary.dry_run === true || summary.total_bytes_processed !== source.totalBytes) throw new Error("Restic did not return complete controller snapshot evidence");
    await run(resticBinary, [...resticArguments(), "check", "--read-data", "--quiet"], { timeout: 12 * 60 * 60 * 1000 });
    const snapshotsResult = await run(resticBinary, [...resticArguments(), "snapshots", "--json", "--tag", protectionTag], { timeout: 30000 });
    const snapshots = JSON.parse(snapshotsResult.stdout);
    const snapshot = snapshots.find((candidate) => candidate.id === summary.snapshot_id);
    if (!snapshot || snapshot.paths?.length !== 1 || snapshot.paths[0] !== source.backupDirectory || !snapshot.tags?.includes("boxpilot-controller") || !snapshot.tags?.includes(backupTag) || !snapshot.tags?.includes(protectionTag)) throw new Error("Restic controller snapshot identity verification failed");

    const drillDirectory = confinedChild(resolvedRestoreDrillRoot, parameters.protectionId);
    await mkdir(drillDirectory, { recursive: false, mode: 0o700 });
    await run(resticBinary, [...resticArguments(), "restore", summary.snapshot_id, "--target", drillDirectory, "--verify"], { timeout: 12 * 60 * 60 * 1000 });
    const restoredRoot = path.join(drillDirectory, resolvedBackupRoot.replace(/^\/+/, ""));
    const restored = await verifyLocalBackup(parameters, restoredRoot);
    if (restored.totalBytes !== source.totalBytes || restored.database.schemaFingerprint !== source.database.schemaFingerprint) throw new Error("Restored controller snapshot evidence does not match the verified source");
    await rm(drillDirectory, { recursive: true, force: false });
    try {
      await statFile(drillDirectory);
      throw new Error("The successful controller restore drill workspace was not removed");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    return {
      created: true,
      protectionId: parameters.protectionId,
      backupId: parameters.backupId,
      destination: "mounted-restic-controller",
      repositoryId: destination.repositoryId,
      snapshotId: summary.snapshot_id,
      sizeBytes: source.artifactMetadata.size,
      storedBytesVerified: source.totalBytes,
      artifactChecksumSha256: parameters.expectedArtifactChecksumSha256,
      manifestChecksumSha256: parameters.expectedManifestChecksumSha256,
      encrypted: true,
      independent: true,
      repositoryVerified: true,
      protected: true,
      restoreDrill: {
        passed: true,
        mode: "exact-snapshot-isolated-copy-open",
        network: "none",
        publishedPorts: 0,
        artifactChecksumMatched: true,
        manifestChecksumMatched: true,
        integrityCheck: "ok",
        foreignKeyIssues: 0,
        schemaFingerprint: source.database.schemaFingerprint,
        schemaVerified: true,
        ownerStatePresent: true,
        workspaceRemoved: true,
        productionDatabaseReplaced: false,
        serviceStarted: false,
      },
      boundary: {
        browserPathAccepted: false,
        browserPasswordAccepted: false,
        repositorySelectorAccepted: false,
        productionDatabaseChanged: false,
        localBackupChanged: false,
        networkAccessRequired: false,
        retentionPerformed: false,
        prunePerformed: false,
      },
    };
  }

  return { initialize, inspect, protect };
}

export const controllerProtectionHelperInternals = { confinedChild, defaultRunner };
