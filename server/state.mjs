import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const defaultStateDirectory = process.platform === "linux" ? "/var/lib/boxpilot" : path.join(os.tmpdir(), "boxpilot");

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeJob(row, steps = [], approvals = []) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    state: row.state,
    risk: row.risk,
    parameters: parseJson(row.parameters_json),
    recovery: parseJson(row.recovery_json),
    result: row.result_json ? parseJson(row.result_json, null) : null,
    error: row.error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    steps,
    approvals,
  };
}

export function createStateStore({
  stateDirectory = process.env.BOXPILOT_STATE_DIRECTORY ?? defaultStateDirectory,
  databasePath,
  now = () => new Date(),
  tokenBytes = randomBytes,
} = {}) {
  const resolvedStateDirectory = path.resolve(stateDirectory);
  mkdirSync(resolvedStateDirectory, { recursive: true, mode: 0o700 });
  const resolvedDatabasePath = databasePath ?? path.join(resolvedStateDirectory, "boxpilot.sqlite3");
  const database = new DatabaseSync(resolvedDatabasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS owners (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bootstrap_tokens (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      risk TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      recovery_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_steps (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      destination_type TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      downtime_ms INTEGER NOT NULL,
      restore_drill_json TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL,
      verified_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vm_exports (
      id TEXT PRIMARY KEY,
      domain_name TEXT NOT NULL,
      domain_uuid TEXT NOT NULL,
      destination_type TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      manifest_checksum_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      protected INTEGER NOT NULL,
      encrypted INTEGER NOT NULL,
      restore_drill_json TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vm_backups (
      id TEXT PRIMARY KEY,
      export_id TEXT NOT NULL REFERENCES vm_exports(id),
      domain_name TEXT NOT NULL,
      domain_uuid TEXT NOT NULL,
      destination_type TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL,
      encrypted INTEGER NOT NULL,
      independent INTEGER NOT NULL,
      repository_verified INTEGER NOT NULL,
      protected INTEGER NOT NULL,
      restore_drill_json TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS migration_sources (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      manifest_json TEXT NOT NULL,
      imported_by TEXT NOT NULL REFERENCES owners(id),
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      actor_id TEXT,
      subject_id TEXT,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plans_created_at ON plans(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_steps_job_id ON job_steps(job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_exports_created_at ON vm_exports(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_backups_created_at ON vm_backups(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_migration_sources_imported_at ON migration_sources(imported_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at DESC);
  `);

  function timestamp() {
    return iso(now());
  }

  function ownerCount() {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM owners").get().count);
  }

  function createBootstrapToken({ ttlMs = 15 * 60 * 1000 } = {}) {
    if (ownerCount() > 0) throw new Error("An owner already exists");
    const token = tokenBytes(32).toString("base64url");
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    database.prepare("DELETE FROM bootstrap_tokens WHERE used_at IS NOT NULL OR expires_at <= ?").run(iso(createdAt));
    database.prepare("INSERT INTO bootstrap_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(digest(token), iso(createdAt), iso(expiresAt));
    return { token, expiresAt: iso(expiresAt) };
  }

  function consumeBootstrapToken(token, { username, passwordHash }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (ownerCount() > 0) throw new Error("An owner already exists");
      const entry = database.prepare("SELECT * FROM bootstrap_tokens WHERE token_hash = ?").get(digest(token));
      if (!entry || entry.used_at || entry.expires_at <= at) throw new Error("Bootstrap token is invalid or expired");
      const owner = { id: randomUUID(), username, createdAt: at };
      database.prepare("INSERT INTO owners (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
        .run(owner.id, owner.username, passwordHash, owner.createdAt);
      database.prepare("UPDATE bootstrap_tokens SET used_at = ? WHERE token_hash = ?").run(at, digest(token));
      database.prepare("INSERT INTO audit_events (id, type, actor_id, subject_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), "owner.bootstrapped", owner.id, owner.id, json({ username }), at);
      database.exec("COMMIT");
      return owner;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function findOwnerByUsername(username) {
    const row = database.prepare("SELECT * FROM owners WHERE username = ?").get(username);
    return row ? { id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at } : null;
  }

  function findOwnerById(id) {
    const row = database.prepare("SELECT * FROM owners WHERE id = ?").get(id);
    return row ? { id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at } : null;
  }

  function createSession(ownerId, { ttlMs = 12 * 60 * 60 * 1000 } = {}) {
    const token = tokenBytes(32).toString("base64url");
    const csrfToken = tokenBytes(32).toString("base64url");
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    database.prepare("INSERT INTO sessions (token_hash, owner_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(digest(token), ownerId, csrfToken, iso(createdAt), iso(expiresAt), iso(createdAt));
    return { token, csrfToken, expiresAt: iso(expiresAt) };
  }

  function getSession(token) {
    if (typeof token !== "string" || token.length < 20) return null;
    const at = timestamp();
    const row = database.prepare(`
      SELECT sessions.*, owners.username
      FROM sessions JOIN owners ON owners.id = sessions.owner_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(digest(token), at);
    if (!row) return null;
    database.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(at, digest(token));
    return {
      tokenHash: row.token_hash,
      owner: { id: row.owner_id, username: row.username },
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
    };
  }

  function deleteSession(token) {
    if (typeof token !== "string") return;
    database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(token));
  }

  function deleteExpiredSessions() {
    return Number(database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(timestamp()).changes);
  }

  function recordAudit(type, { actorId = null, subjectId = null, details = {} } = {}) {
    const event = { id: randomUUID(), type, actorId, subjectId, details, createdAt: timestamp() };
    database.prepare("INSERT INTO audit_events (id, type, actor_id, subject_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, event.type, event.actorId, event.subjectId, json(event.details), event.createdAt);
    return event;
  }

  function listAudit(limit = 100) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    return database.prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").all(safeLimit).map((row) => ({
      id: row.id,
      type: row.type,
      actorId: row.actor_id,
      subjectId: row.subject_id,
      details: parseJson(row.details_json),
      createdAt: row.created_at,
    }));
  }

  function createJob({
    type,
    title,
    risk = "low",
    parameters = {},
    recovery = {},
    createdBy,
    initialSteps = [
      { name: "preflight", state: "completed", detail: "Typed operation and helper compatibility validated" },
      { name: "checkpoint", state: "completed", detail: "No host state is changed by this canary operation" },
    ],
  }) {
    const at = timestamp();
    const job = { id: randomUUID(), type, title, state: "awaiting_approval", risk, parameters, recovery, createdBy, createdAt: at, updatedAt: at };
    database.prepare(`
      INSERT INTO jobs (id, type, title, state, risk, parameters_json, recovery_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, job.type, job.title, job.state, job.risk, json(job.parameters), json(job.recovery), job.createdBy, at, at);
    for (const step of initialSteps) addJobStep(job.id, step.name, step.state, step.detail);
    recordAudit("job.created", { actorId: createdBy, subjectId: job.id, details: { type, risk } });
    return getJob(job.id);
  }

  function createPlan({ type, subjectId, input = {}, output = {}, createdBy, ttlMs = 30 * 60 * 1000 }) {
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    const revision = digest(`${type}\n${subjectId}\n${json(input)}\n${json(output)}`).slice(0, 16);
    const plan = {
      id: randomUUID(), type, subjectId, revision, status: "draft", input, output,
      createdBy, createdAt: iso(createdAt), expiresAt: iso(expiresAt),
    };
    database.prepare(`
      INSERT INTO plans (id, type, subject_id, revision, status, input_json, output_json, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(plan.id, plan.type, plan.subjectId, plan.revision, plan.status, json(plan.input), json(plan.output), plan.createdBy, plan.createdAt, plan.expiresAt);
    recordAudit("plan.created", { actorId: createdBy, subjectId: plan.id, details: { type, subjectId, revision } });
    return plan;
  }

  function getPlan(id) {
    const row = database.prepare("SELECT * FROM plans WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      subjectId: row.subject_id,
      revision: row.revision,
      status: row.status,
      input: parseJson(row.input_json),
      output: parseJson(row.output_json),
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      expired: row.expires_at <= timestamp(),
    };
  }

  function stagePlan(id, ownerId) {
    const plan = getPlan(id);
    if (!plan || plan.createdBy !== ownerId) throw new Error("Plan not found");
    if (plan.expired) throw new Error("Plan has expired; inspect the host and create a new plan");
    if (plan.status !== "draft") throw new Error("Plan has already been staged");
    database.prepare("UPDATE plans SET status = 'staged' WHERE id = ? AND status = 'draft'").run(id);
    recordAudit("plan.staged", { actorId: ownerId, subjectId: id, details: { revision: plan.revision } });
    return { ...plan, status: "staged" };
  }

  function addJobStep(jobId, name, state, detail) {
    database.prepare("INSERT INTO job_steps (id, job_id, name, state, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), jobId, name, state, detail, timestamp());
  }

  function addApproval(jobId, ownerId) {
    const approval = { id: randomUUID(), jobId, ownerId, createdAt: timestamp() };
    database.prepare("INSERT INTO approvals (id, job_id, owner_id, created_at) VALUES (?, ?, ?, ?)")
      .run(approval.id, approval.jobId, approval.ownerId, approval.createdAt);
    return approval;
  }

  function transitionJob(jobId, fromStates, state, { result = undefined, error = undefined } = {}) {
    const allowed = Array.isArray(fromStates) ? fromStates : [fromStates];
    const placeholders = allowed.map(() => "?").join(", ");
    const current = database.prepare(`SELECT state FROM jobs WHERE id = ? AND state IN (${placeholders})`).get(jobId, ...allowed);
    if (!current) throw new Error("Job is not in an allowed state");
    database.prepare("UPDATE jobs SET state = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(state, result === undefined ? null : json(result), error ?? null, timestamp(), jobId);
    return getJob(jobId);
  }

  function getJob(id) {
    const row = database.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    if (!row) return null;
    const steps = database.prepare("SELECT name, state, detail, created_at AS createdAt FROM job_steps WHERE job_id = ? ORDER BY created_at").all(id);
    const approvals = database.prepare("SELECT owner_id AS ownerId, created_at AS createdAt FROM approvals WHERE job_id = ? ORDER BY created_at").all(id);
    return normalizeJob(row, steps, approvals);
  }

  function listJobs(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?").all(safeLimit).map((row) => getJob(row.id));
  }

  function recordBackup({ id, applicationId, destination, artifactPath, checksumSha256, sizeBytes, downtimeMs, restoreDrill, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO backups (id, application_id, destination_type, artifact_path, checksum_sha256, size_bytes, downtime_ms, restore_drill_json, created_by, created_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, applicationId, destination, artifactPath, checksumSha256, sizeBytes, downtimeMs, json(restoreDrill), createdBy, at, at);
    recordAudit("backup.verified", { actorId: createdBy, subjectId: id, details: { applicationId, destination, checksumSha256, sizeBytes } });
    return listBackups(1)[0];
  }

  function listBackups(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM backups ORDER BY created_at DESC LIMIT ?").all(safeLimit).map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      destination: row.destination_type,
      artifactPath: row.artifact_path,
      checksumSha256: row.checksum_sha256,
      sizeBytes: Number(row.size_bytes),
      downtimeMs: Number(row.downtime_ms),
      restoreDrill: parseJson(row.restore_drill_json),
      createdBy: row.created_by,
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
    }));
  }

  function recordVmExport({ id, domainName, domainUuid, destination, artifactPath, manifestChecksumSha256, sizeBytes, protected: protectedState, encrypted, restoreDrill, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO vm_exports (id, domain_name, domain_uuid, destination_type, artifact_path, manifest_checksum_sha256, size_bytes, protected, encrypted, restore_drill_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, domainName, domainUuid, destination, artifactPath, manifestChecksumSha256, sizeBytes, protectedState ? 1 : 0, encrypted ? 1 : 0, json(restoreDrill), createdBy, at);
    recordAudit("vm.export.recorded", { actorId: createdBy, subjectId: id, details: { domainName, domainUuid, destination, manifestChecksumSha256, sizeBytes, protected: protectedState, encrypted } });
    return listVmExports(1)[0];
  }

  function mapVmExport(row) {
    return row ? {
      id: row.id,
      domainName: row.domain_name,
      domainUuid: row.domain_uuid,
      destination: row.destination_type,
      artifactPath: row.artifact_path,
      manifestChecksumSha256: row.manifest_checksum_sha256,
      sizeBytes: Number(row.size_bytes),
      protected: Boolean(row.protected),
      encrypted: Boolean(row.encrypted),
      restoreDrill: parseJson(row.restore_drill_json),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function listVmExports(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM vm_exports ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapVmExport);
  }

  function getVmExport(id) {
    return mapVmExport(database.prepare("SELECT * FROM vm_exports WHERE id = ?").get(id));
  }

  function recordVmBackup({ id, exportId, domainName, domainUuid, destination, repositoryId, snapshotId, sizeBytes, encrypted, independent, repositoryVerified, protected: protectedState, restoreDrill, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO vm_backups (id, export_id, domain_name, domain_uuid, destination_type, repository_id, snapshot_id, size_bytes, encrypted, independent, repository_verified, protected, restore_drill_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, exportId, domainName, domainUuid, destination, repositoryId, snapshotId, sizeBytes, encrypted ? 1 : 0, independent ? 1 : 0, repositoryVerified ? 1 : 0, protectedState ? 1 : 0, json(restoreDrill), createdBy, at);
    recordAudit("vm.backup.recorded", { actorId: createdBy, subjectId: id, details: { exportId, domainName, destination, repositoryId, snapshotId, sizeBytes, encrypted, independent, repositoryVerified, protected: protectedState } });
    return listVmBackups(1)[0];
  }

  function listVmBackups(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM vm_backups ORDER BY created_at DESC LIMIT ?").all(safeLimit).map((row) => ({
      id: row.id,
      exportId: row.export_id,
      domainName: row.domain_name,
      domainUuid: row.domain_uuid,
      destination: row.destination_type,
      repositoryId: row.repository_id,
      snapshotId: row.snapshot_id,
      sizeBytes: Number(row.size_bytes),
      encrypted: Boolean(row.encrypted),
      independent: Boolean(row.independent),
      repositoryVerified: Boolean(row.repository_verified),
      protected: Boolean(row.protected),
      restoreDrill: parseJson(row.restore_drill_json),
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }

  function importMigrationSource({ fingerprint, manifest, importedBy }) {
    const existing = database.prepare("SELECT id FROM migration_sources WHERE fingerprint = ?").get(fingerprint);
    if (existing) return getMigrationSource(existing.id);
    const source = { id: randomUUID(), fingerprint, manifest, importedBy, importedAt: timestamp() };
    database.prepare("INSERT INTO migration_sources (id, fingerprint, manifest_json, imported_by, imported_at) VALUES (?, ?, ?, ?, ?)")
      .run(source.id, source.fingerprint, json(source.manifest), source.importedBy, source.importedAt);
    recordAudit("migration.source.imported", { actorId: importedBy, subjectId: source.id, details: { fingerprint, hostname: manifest.source.hostname } });
    return source;
  }

  function getMigrationSource(id) {
    const row = database.prepare("SELECT * FROM migration_sources WHERE id = ?").get(id);
    return row ? { id: row.id, fingerprint: row.fingerprint, manifest: parseJson(row.manifest_json), importedBy: row.imported_by, importedAt: row.imported_at } : null;
  }

  function listMigrationSources(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT id FROM migration_sources ORDER BY imported_at DESC LIMIT ?").all(safeLimit).map((row) => getMigrationSource(row.id));
  }

  function recoverInterruptedJobs() {
    const interrupted = database.prepare("SELECT id FROM jobs WHERE state IN ('applying', 'verifying')").all();
    for (const { id } of interrupted) {
      database.prepare("UPDATE jobs SET state = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run("BoxPilot restarted while this job was running. Review recovery guidance before retrying.", timestamp(), id);
      addJobStep(id, "recovery", "required", "The operation was interrupted; no automatic retry was attempted");
    }
    return interrupted.length;
  }

  function close() {
    database.close();
  }

  return {
    databasePath: resolvedDatabasePath,
    ownerCount,
    createBootstrapToken,
    consumeBootstrapToken,
    findOwnerByUsername,
    findOwnerById,
    createSession,
    getSession,
    deleteSession,
    deleteExpiredSessions,
    recordAudit,
    listAudit,
    createJob,
    createPlan,
    getPlan,
    stagePlan,
    addJobStep,
    addApproval,
    transitionJob,
    getJob,
    listJobs,
    recordBackup,
    listBackups,
    recordVmExport,
    listVmExports,
    getVmExport,
    recordVmBackup,
    listVmBackups,
    importMigrationSource,
    getMigrationSource,
    listMigrationSources,
    recoverInterruptedJobs,
    close,
  };
}

export const stateInternals = { digest, parseJson };
