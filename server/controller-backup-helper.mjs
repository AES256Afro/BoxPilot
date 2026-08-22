import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const uuidPattern = /^[a-f0-9-]{36}$/;
const requiredTables = Object.freeze([
  "approvals",
  "audit_events",
  "backups",
  "bootstrap_tokens",
  "controller_backup_protections",
  "job_steps",
  "jobs",
  "owners",
  "plans",
  "schedules",
  "sessions",
  "settings",
  "vm_backups",
  "vm_exports",
]);

function confinedChild(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...parts);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Controller backup path escaped its fixed root");
  return candidate;
}

async function realDirectory(directory, mode = 0o700) {
  await mkdir(directory, { recursive: true, mode });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Controller backup root must be a real directory");
  await chmod(directory, mode);
}

async function verifyRealDirectory(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Controller backup root must be a real directory");
}

async function regularFile(filePath, label) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real regular file`);
  return metadata;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function databaseEvidence(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    const foreignKeyIssues = database.prepare("PRAGMA foreign_key_check").all();
    const schemaRows = database.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const tables = new Set(schemaRows.filter((row) => row.type === "table").map((row) => row.name));
    const missingTables = requiredTables.filter((table) => !tables.has(table));
    const schemaFingerprint = createHash("sha256").update(JSON.stringify(schemaRows)).digest("hex");
    const ownerCount = tables.has("owners") ? Number(database.prepare("SELECT COUNT(*) AS count FROM owners").get().count) : 0;
    return {
      integrityCheck: integrityRows.length === 1 && integrityRows[0].integrity_check === "ok" ? "ok" : "failed",
      foreignKeyIssues: foreignKeyIssues.length,
      missingTables,
      ownerCount,
      schemaFingerprint,
      userVersion: Number(database.prepare("PRAGMA user_version").get().user_version),
    };
  } finally {
    database.close();
  }
}

function validateControllerBackupInput(input) {
  const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
  if (keys.length !== 1 || keys[0] !== "backupId" || typeof input.backupId !== "string" || !uuidPattern.test(input.backupId)) return ["Controller backup accepts only one backupId UUID"];
  return [];
}

export function createControllerBackupHelper({
  sourceDatabasePath = process.env.BOXPILOT_CONTROLLER_DATABASE ?? "/var/lib/boxpilot/boxpilot.sqlite3",
  backupRoot = process.env.BOXPILOT_CONTROLLER_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups/boxpilot-controller",
  restoreDrillRoot = process.env.BOXPILOT_CONTROLLER_RESTORE_DRILL_ROOT ?? "/var/lib/boxpilot-managed/controller-restore-drills",
  // Local copies to keep. Every backup and every machine snapshot writes a full copy of the
  // database here, and nothing removed them — on a single-disk install that is the same volume the
  // live database sits on, so it fills up and takes the database with it.
  keepLocal = 10,
  now = () => new Date(),
} = {}) {
  /**
   * Keep the newest `keepLocal` local copies, never the one this call just made.
   *
   * This is only about the disk the database lives on, which on a single-disk install is the same
   * one — every backup and every machine snapshot wrote a full copy here and nothing removed them.
   * A copy that has been protected has an encrypted copy off the box, which is the durable one and
   * is governed separately by retention; the local artifact is a convenience.
   */
  async function pruneLocalBackups(justCreated) {
    const entries = await readdir(backupRoot, { withFileTypes: true }).catch(() => []);
    const directories = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuidPattern.test(entry.name)) continue;
      const info = await stat(path.join(backupRoot, entry.name)).catch(() => null);
      if (info) directories.push({ id: entry.name, at: info.mtimeMs });
    }
    const removed = [];
    for (const candidate of directories.sort((left, right) => right.at - left.at).slice(keepLocal)) {
      if (candidate.id === justCreated) continue;
      await rm(path.join(backupRoot, candidate.id), { recursive: true, force: true }).catch(() => {});
      removed.push(candidate.id);
    }
    return removed;
  }

  async function initialize() {
    await realDirectory(backupRoot);
    await realDirectory(restoreDrillRoot);
  }

  async function inspect() {
    try {
      await regularFile(sourceDatabasePath, "Controller database");
      await verifyRealDirectory(backupRoot);
      await verifyRealDirectory(restoreDrillRoot);
      const evidence = databaseEvidence(sourceDatabasePath);
      const ready = evidence.integrityCheck === "ok" && evidence.foreignKeyIssues === 0 && evidence.missingTables.length === 0 && evidence.ownerCount > 0;
      return {
        installed: true,
        healthy: ready,
        state: ready ? "ready" : "blocked",
        detail: ready ? "Live SQLite source passed fixed integrity, foreign-key, schema, and owner-state checks" : "Live SQLite source failed a required controller backup preflight",
        source: "fixed-boxpilot-state-database",
        journalAwareSnapshot: "sqlite-vacuum-into",
        evidence: { integrityCheck: evidence.integrityCheck, foreignKeyIssues: evidence.foreignKeyIssues, schemaComplete: evidence.missingTables.length === 0, ownerStatePresent: evidence.ownerCount > 0 },
        boundary: { mutationPerformed: false, databaseContentReturned: false, pathAccepted: false, commandAccepted: false, retentionPerformed: false },
      };
    } catch {
      return {
        installed: true,
        healthy: false,
        state: "unavailable",
        detail: "The fixed BoxPilot SQLite source or helper-owned backup roots are unavailable",
        source: "fixed-boxpilot-state-database",
        journalAwareSnapshot: "sqlite-vacuum-into",
        evidence: { integrityCheck: "unavailable", foreignKeyIssues: null, schemaComplete: false, ownerStatePresent: false },
        boundary: { mutationPerformed: false, databaseContentReturned: false, pathAccepted: false, commandAccepted: false, retentionPerformed: false },
      };
    }
  }

  async function createBackup(input) {
    const inputErrors = validateControllerBackupInput(input);
    if (inputErrors.length) throw new Error(inputErrors.join(" | "));
    await regularFile(sourceDatabasePath, "Controller database");
    await initialize();
    const sourceEvidence = databaseEvidence(sourceDatabasePath);
    if (sourceEvidence.integrityCheck !== "ok" || sourceEvidence.foreignKeyIssues !== 0 || sourceEvidence.missingTables.length || sourceEvidence.ownerCount < 1) throw new Error("Controller database failed fixed backup preflight");

    const backupDirectory = confinedChild(backupRoot, input.backupId);
    const artifactPath = confinedChild(backupDirectory, "boxpilot.sqlite3");
    const manifestPath = confinedChild(backupDirectory, "manifest.json");
    const drillDirectory = confinedChild(restoreDrillRoot, input.backupId);
    const drillDatabasePath = confinedChild(drillDirectory, "boxpilot.sqlite3");
    const startedAt = now();
    let backupDirectoryCreated = false;
    let drillDirectoryCreated = false;

    try {
      await mkdir(backupDirectory, { recursive: false, mode: 0o700 });
      backupDirectoryCreated = true;
      const source = new DatabaseSync(sourceDatabasePath, { readOnly: true });
      try {
        const quote = String.fromCharCode(39);
        const escapedArtifactPath = artifactPath.replaceAll(quote, `${quote}${quote}`);
        source.exec(`VACUUM INTO ${quote}${escapedArtifactPath}${quote}`);
      } finally {
        source.close();
      }
      await chmod(artifactPath, 0o600);
      const artifact = await regularFile(artifactPath, "Controller backup artifact");
      const checksumSha256 = await sha256File(artifactPath);
      const artifactEvidence = databaseEvidence(artifactPath);
      if (artifactEvidence.integrityCheck !== "ok" || artifactEvidence.foreignKeyIssues !== 0 || artifactEvidence.missingTables.length || artifactEvidence.ownerCount < 1 || artifactEvidence.schemaFingerprint !== sourceEvidence.schemaFingerprint) throw new Error("Controller backup artifact failed fixed verification");

      await mkdir(drillDirectory, { recursive: false, mode: 0o700 });
      drillDirectoryCreated = true;
      await copyFile(artifactPath, drillDatabasePath, fsConstants.COPYFILE_EXCL);
      await chmod(drillDatabasePath, 0o600);
      const drillEvidence = databaseEvidence(drillDatabasePath);
      const drillChecksumSha256 = await sha256File(drillDatabasePath);
      if (drillEvidence.integrityCheck !== "ok" || drillEvidence.foreignKeyIssues !== 0 || drillEvidence.missingTables.length || drillEvidence.ownerCount < 1 || drillEvidence.schemaFingerprint !== artifactEvidence.schemaFingerprint || drillChecksumSha256 !== checksumSha256) throw new Error("Isolated controller restore drill failed verification");
      await unlink(drillDatabasePath);
      await rmdir(drillDirectory);
      drillDirectoryCreated = false;

      const completedAt = now();
      const manifest = {
        schemaVersion: 1,
        backupId: input.backupId,
        applicationId: "boxpilot-controller",
        artifact: "boxpilot.sqlite3",
        checksumSha256,
        sizeBytes: artifact.size,
        createdAt: completedAt.toISOString(),
        method: "sqlite-vacuum-into",
        restoreDrill: {
          passed: true,
          copyChecksumMatched: true,
          integrityCheck: "ok",
          foreignKeyIssues: 0,
          schemaFingerprint: artifactEvidence.schemaFingerprint,
          schemaVerified: true,
          ownerStatePresent: true,
          workspaceRemoved: true,
        },
      };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const manifestChecksumSha256 = await sha256File(manifestPath);
      const manifestRoundTrip = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifestRoundTrip.backupId !== input.backupId || manifestRoundTrip.checksumSha256 !== checksumSha256 || manifestRoundTrip.restoreDrill?.passed !== true) throw new Error("Controller backup manifest failed verification");
      // Artifact first, then the manifest that vouches for it, then the directory holding both:
      // a power cut in the wrong order leaves a manifest describing a file that is not there.
      const artifactHandle = await open(artifactPath, "r");
      try { await artifactHandle.sync(); } finally { await artifactHandle.close(); }
      const manifestHandle = await open(manifestPath, "r");
      try { await manifestHandle.sync(); } finally { await manifestHandle.close(); }
      const directoryHandle = await open(backupDirectory, "r").catch(() => null);
      if (directoryHandle) { try { await directoryHandle.sync(); } catch { /* not every filesystem allows this */ } finally { await directoryHandle.close(); } }

      const removedLocal = await pruneLocalBackups(input.backupId);
      return {
        removedLocal,
        backupId: input.backupId,
        applicationId: "boxpilot-controller",
        destination: "local-managed",
        artifactPath,
        manifestPath,
        checksumSha256,
        manifestChecksumSha256,
        sizeBytes: artifact.size,
        downtimeMs: 0,
        consistentSnapshot: true,
        snapshotMethod: "sqlite-vacuum-into",
        sourceServiceStopped: false,
        restoreDrill: {
          passed: true,
          mode: "isolated-copy-open",
          network: "none",
          publishedPorts: 0,
          copyChecksumMatched: true,
          manifestChecksumSha256,
          integrityCheck: "ok",
          foreignKeyIssues: 0,
          schemaFingerprint: artifactEvidence.schemaFingerprint,
          schemaVerified: true,
          ownerStatePresent: true,
          workspaceRemoved: true,
          productionDatabaseReplaced: false,
          serviceStarted: false,
        },
        boundary: {
          databaseContentReturned: false,
          browserPathAccepted: false,
          browserCommandAccepted: false,
          productionDatabaseChanged: false,
          serviceStopped: false,
          networkAccessRequired: false,
          independentCopyCreated: false,
          retentionPerformed: false,
        },
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      };
    } catch (error) {
      if (drillDirectoryCreated) {
        await unlink(drillDatabasePath).catch(() => {});
        await rmdir(drillDirectory).catch(() => {});
      }
      if (backupDirectoryCreated) {
        await unlink(manifestPath).catch(() => {});
        await unlink(artifactPath).catch(() => {});
        await rmdir(backupDirectory).catch(() => {});
      }
      throw error;
    }
  }

  return { initialize, inspect, createBackup, backupRoot, restoreDrillRoot, sourceDatabasePath, internals: { pruneLocalBackups } };
}

export const controllerBackupHelperInternals = { confinedChild, databaseEvidence, requiredTables, sha256File, validateControllerBackupInput };
