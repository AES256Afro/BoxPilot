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
    CREATE TABLE IF NOT EXISTS job_output (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      output TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS controller_backup_protections (
      id TEXT PRIMARY KEY,
      backup_id TEXT NOT NULL UNIQUE REFERENCES backups(id),
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
    CREATE TABLE IF NOT EXISTS controller_retention_runs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      before_snapshot_revision TEXT NOT NULL,
      after_snapshot_revision TEXT,
      before_count INTEGER NOT NULL,
      after_count INTEGER,
      forgotten_json TEXT NOT NULL,
      kept_snapshot_ids_json TEXT NOT NULL,
      repository_verified INTEGER NOT NULL,
      complete INTEGER NOT NULL,
      prune_performed INTEGER NOT NULL,
      verification_json TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS controller_retention_members (
      run_id TEXT NOT NULL REFERENCES controller_retention_runs(id),
      protection_id TEXT NOT NULL UNIQUE REFERENCES controller_backup_protections(id),
      snapshot_id TEXT NOT NULL UNIQUE,
      forgotten_at TEXT NOT NULL,
      PRIMARY KEY (run_id, protection_id)
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
    CREATE TABLE IF NOT EXISTS vm_recoveries (
      id TEXT PRIMARY KEY,
      backup_id TEXT NOT NULL REFERENCES vm_backups(id),
      source_domain_name TEXT NOT NULL,
      source_domain_uuid TEXT NOT NULL,
      domain_name TEXT NOT NULL UNIQUE,
      domain_uuid TEXT NOT NULL UNIQUE,
      destination_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      state TEXT NOT NULL,
      network TEXT NOT NULL,
      autostart INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vm_retention_runs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      before_snapshot_revision TEXT NOT NULL,
      after_snapshot_revision TEXT,
      before_count INTEGER NOT NULL,
      after_count INTEGER,
      forgotten_json TEXT NOT NULL,
      kept_snapshot_ids_json TEXT NOT NULL,
      repository_verified INTEGER NOT NULL,
      complete INTEGER NOT NULL,
      prune_performed INTEGER NOT NULL,
      verification_json TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vm_retention_members (
      run_id TEXT NOT NULL REFERENCES vm_retention_runs(id),
      backup_id TEXT NOT NULL UNIQUE REFERENCES vm_backups(id),
      snapshot_id TEXT NOT NULL UNIQUE,
      forgotten_at TEXT NOT NULL,
      PRIMARY KEY (run_id, backup_id)
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      frequency TEXT NOT NULL,
      minute INTEGER NOT NULL,
      hour INTEGER,
      weekday INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL,
      next_due_at TEXT NOT NULL,
      last_run_at TEXT,
      last_job_id TEXT,
      last_result TEXT
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
    CREATE INDEX IF NOT EXISTS idx_controller_backup_protections_created_at ON controller_backup_protections(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_controller_retention_runs_created_at ON controller_retention_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_exports_created_at ON vm_exports(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_backups_created_at ON vm_backups(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_recoveries_created_at ON vm_recoveries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_retention_runs_created_at ON vm_retention_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at DESC);
  `);

  // Tables from retired features (legacy application recovery/protection, migrations, fleet,
  // router checkpoints, DNS acceptance). Controller backups retain history if it is ever needed.
  database.exec(`
    DROP TABLE IF EXISTS application_recovery_rollbacks;
    DROP TABLE IF EXISTS application_recovery_promotions;
    DROP TABLE IF EXISTS application_recovery_drills;
    DROP TABLE IF EXISTS application_recoveries;
    DROP TABLE IF EXISTS application_retention_members;
    DROP TABLE IF EXISTS application_retention_runs;
    DROP TABLE IF EXISTS application_backup_protections;
    DROP TABLE IF EXISTS fleet_evidence;
    DROP TABLE IF EXISTS fleet_tasks;
    DROP TABLE IF EXISTS fleet_agents;
    DROP TABLE IF EXISTS agent_enrollment_tokens;
    DROP TABLE IF EXISTS router_dns_acceptances;
    DROP TABLE IF EXISTS router_checkpoints;
    DROP TABLE IF EXISTS dns_acceptances;
    DROP TABLE IF EXISTS migration_transfers;
    DROP TABLE IF EXISTS migration_sources;
  `);

  const sessionColumns = database.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name);
  if (!sessionColumns.includes("elevated_until")) database.exec("ALTER TABLE sessions ADD COLUMN elevated_until TEXT");
  const approvalColumns = database.prepare("PRAGMA table_info(approvals)").all().map((column) => column.name);
  if (!approvalColumns.includes("method")) database.exec("ALTER TABLE approvals ADD COLUMN method TEXT NOT NULL DEFAULT 'password'");
  if (!approvalColumns.includes("tier")) database.exec("ALTER TABLE approvals ADD COLUMN tier TEXT");

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

  function findFirstOwner() {
    const row = database.prepare("SELECT * FROM owners ORDER BY created_at ASC LIMIT 1").get();
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
      elevatedUntil: row.elevated_until ?? null,
    };
  }

  /** Mark a session as recently password-verified until `until` (ISO string or Date). Returns the new value or null if the session is gone. */
  function elevateSession(tokenHash, until) {
    const value = until instanceof Date ? iso(until) : until;
    if (typeof tokenHash !== "string" || typeof value !== "string") return null;
    const changes = Number(database.prepare("UPDATE sessions SET elevated_until = ? WHERE token_hash = ?").run(value, tokenHash).changes);
    return changes > 0 ? value : null;
  }

  function clearSessionElevation(tokenHash) {
    if (typeof tokenHash !== "string") return;
    database.prepare("UPDATE sessions SET elevated_until = NULL WHERE token_hash = ?").run(tokenHash);
  }

  function saveJobOutput(jobId, output) {
    database.prepare("INSERT INTO job_output (job_id, output, created_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET output = excluded.output").run(jobId, String(output ?? "").slice(-2 * 1024 * 1024), timestamp());
  }

  function getJobOutput(jobId) {
    const row = database.prepare("SELECT output FROM job_output WHERE job_id = ?").get(jobId);
    return row ? row.output : null;
  }

  function getSetting(key, fallback = null) {
    const row = database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
    return row ? parseJson(row.value_json, fallback) : fallback;
  }

  function setSetting(key, value, { updatedBy = null } = {}) {
    database.prepare("INSERT INTO settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .run(key, json(value), updatedBy, timestamp());
    return value;
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

  // Job-change subscription for the SSE events feed. Emissions are coalesced per job and
  // microtask so a burst of step writes delivers one snapshot with the final state.
  const jobSubscribers = new Set();
  const pendingJobEmits = new Set();

  function subscribeJobs(listener) {
    jobSubscribers.add(listener);
    return () => jobSubscribers.delete(listener);
  }

  function emitJobChanged(jobId) {
    if (jobSubscribers.size === 0 || pendingJobEmits.has(jobId)) return;
    pendingJobEmits.add(jobId);
    queueMicrotask(() => {
      pendingJobEmits.delete(jobId);
      const job = getJob(jobId);
      if (!job) return;
      for (const listener of [...jobSubscribers]) {
        try { listener(job); } catch { /* a broken subscriber must not affect job execution */ }
      }
    });
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
    emitJobChanged(job.id);
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

  function addJobStep(jobId, name, state, detail) {
    database.prepare("INSERT INTO job_steps (id, job_id, name, state, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), jobId, name, state, detail, timestamp());
    emitJobChanged(jobId);
  }

  function addApproval(jobId, ownerId, { method = "password", tier = null } = {}) {
    const approval = { id: randomUUID(), jobId, ownerId, method, tier, createdAt: timestamp() };
    database.prepare("INSERT INTO approvals (id, job_id, owner_id, method, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(approval.id, approval.jobId, approval.ownerId, approval.method, approval.tier, approval.createdAt);
    emitJobChanged(jobId);
    return approval;
  }

  function transitionJob(jobId, fromStates, state, { result = undefined, error = undefined } = {}) {
    const allowed = Array.isArray(fromStates) ? fromStates : [fromStates];
    const placeholders = allowed.map(() => "?").join(", ");
    const current = database.prepare(`SELECT state FROM jobs WHERE id = ? AND state IN (${placeholders})`).get(jobId, ...allowed);
    if (!current) throw new Error("Job is not in an allowed state");
    database.prepare("UPDATE jobs SET state = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(state, result === undefined ? null : json(result), error ?? null, timestamp(), jobId);
    emitJobChanged(jobId);
    return getJob(jobId);
  }

  function getJob(id) {
    const row = database.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    if (!row) return null;
    const steps = database.prepare("SELECT name, state, detail, created_at AS createdAt FROM job_steps WHERE job_id = ? ORDER BY created_at").all(id);
    const approvals = database.prepare("SELECT owner_id AS ownerId, method, tier, created_at AS createdAt FROM approvals WHERE job_id = ? ORDER BY created_at").all(id);
    return normalizeJob(row, steps, approvals);
  }

  function listJobs(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?").all(safeLimit).map((row) => getJob(row.id));
  }

  function listActiveJobs() {
    return database.prepare("SELECT id FROM jobs WHERE state IN ('applying', 'verifying') ORDER BY created_at").all().map((row) => getJob(row.id));
  }

  function normalizeSchedule(row) {
    if (!row) return null;
    return {
      id: row.id,
      operationId: row.operation_id,
      parameters: parseJson(row.parameters_json),
      frequency: row.frequency,
      minute: row.minute,
      hour: row.hour,
      weekday: row.weekday,
      enabled: Boolean(row.enabled),
      createdBy: row.created_by,
      createdAt: row.created_at,
      nextDueAt: row.next_due_at,
      lastRunAt: row.last_run_at,
      lastJobId: row.last_job_id,
      lastResult: row.last_result,
    };
  }

  function createSchedule({ operationId, parameters = {}, frequency, minute, hour = null, weekday = null, createdBy, nextDueAt }) {
    const schedule = { id: randomUUID(), operationId, parameters, frequency, minute, hour, weekday, enabled: true, createdBy, createdAt: timestamp(), nextDueAt };
    database.prepare("INSERT INTO schedules (id, operation_id, parameters_json, frequency, minute, hour, weekday, enabled, created_by, created_at, next_due_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)")
      .run(schedule.id, operationId, json(parameters), frequency, minute, hour, weekday, createdBy, schedule.createdAt, nextDueAt);
    recordAudit("schedule.created", { actorId: createdBy, subjectId: schedule.id, details: { operationId, frequency, minute, hour, weekday } });
    return getSchedule(schedule.id);
  }

  function getSchedule(id) {
    return normalizeSchedule(database.prepare("SELECT * FROM schedules WHERE id = ?").get(id));
  }

  function listSchedules() {
    return database.prepare("SELECT * FROM schedules ORDER BY created_at").all().map(normalizeSchedule);
  }

  function listDueSchedules(nowIso) {
    return database.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_due_at <= ? ORDER BY next_due_at").all(nowIso).map(normalizeSchedule);
  }

  function setScheduleEnabled(id, enabled, { actorId = null, nextDueAt = null } = {}) {
    const changes = nextDueAt
      ? database.prepare("UPDATE schedules SET enabled = ?, next_due_at = ? WHERE id = ?").run(enabled ? 1 : 0, nextDueAt, id).changes
      : database.prepare("UPDATE schedules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes;
    if (!Number(changes)) throw new Error("Schedule not found");
    recordAudit(enabled ? "schedule.enabled" : "schedule.disabled", { actorId, subjectId: id });
    return getSchedule(id);
  }

  function markScheduleRun(id, { jobId = null, result = null, nextDueAt }) {
    database.prepare("UPDATE schedules SET last_run_at = ?, last_job_id = ?, last_result = ?, next_due_at = ? WHERE id = ?")
      .run(timestamp(), jobId, result, nextDueAt, id);
    return getSchedule(id);
  }

  function deleteSchedule(id, { actorId = null } = {}) {
    const changes = Number(database.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes);
    if (!changes) throw new Error("Schedule not found");
    recordAudit("schedule.deleted", { actorId, subjectId: id });
    return true;
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

  function getBackup(id) {
    const row = database.prepare("SELECT * FROM backups WHERE id = ?").get(id);
    return row ? {
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
    } : null;
  }

  function mapApplicationRecovery(row) {
    return row ? {
      id: row.id,
      backupId: row.backup_id,
      applicationId: row.application_id,
      destination: row.destination_type,
      statePath: row.state_path,
      evidencePath: row.evidence_path,
      sizeBytes: Number(row.size_bytes),
      state: row.state,
      network: row.network,
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function recordControllerBackupProtection({ id, backupId, destination, repositoryId, snapshotId, sizeBytes, encrypted, independent, repositoryVerified, protected: protectedState, restoreDrill, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO controller_backup_protections (id, backup_id, destination_type, repository_id, snapshot_id, size_bytes, encrypted, independent, repository_verified, protected, restore_drill_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, backupId, destination, repositoryId, snapshotId, sizeBytes, encrypted ? 1 : 0, independent ? 1 : 0, repositoryVerified ? 1 : 0, protectedState ? 1 : 0, json(restoreDrill), createdBy, at);
    recordAudit("controller.backup.protected", { actorId: createdBy, subjectId: id, details: { backupId, destination, repositoryId, snapshotId, sizeBytes, protected: protectedState } });
    return getControllerBackupProtection(id);
  }

  function mapControllerBackupProtection(row) {
    if (!row) return null;
    const retained = row.retention_run_id == null;
    return {
      id: row.id,
      backupId: row.backup_id,
      destination: row.destination_type,
      repositoryId: row.repository_id,
      snapshotId: row.snapshot_id,
      sizeBytes: Number(row.size_bytes),
      encrypted: Boolean(row.encrypted),
      independent: Boolean(row.independent),
      repositoryVerified: Boolean(row.repository_verified),
      protected: Boolean(row.protected) && retained,
      retained,
      retention: retained ? null : { runId: row.retention_run_id, forgottenAt: row.forgotten_at },
      restoreDrill: parseJson(row.restore_drill_json),
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  function getControllerBackupProtection(id) {
    return mapControllerBackupProtection(database.prepare(`
      SELECT controller_backup_protections.*, controller_retention_members.run_id AS retention_run_id, controller_retention_members.forgotten_at
      FROM controller_backup_protections
      LEFT JOIN controller_retention_members ON controller_retention_members.protection_id = controller_backup_protections.id
      WHERE controller_backup_protections.id = ?
    `).get(id));
  }

  function getControllerBackupProtectionByBackup(backupId) {
    return mapControllerBackupProtection(database.prepare(`
      SELECT controller_backup_protections.*, controller_retention_members.run_id AS retention_run_id, controller_retention_members.forgotten_at
      FROM controller_backup_protections
      LEFT JOIN controller_retention_members ON controller_retention_members.protection_id = controller_backup_protections.id
      WHERE controller_backup_protections.backup_id = ?
    `).get(backupId));
  }

  function listControllerBackupProtections(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare(`
      SELECT controller_backup_protections.*, controller_retention_members.run_id AS retention_run_id, controller_retention_members.forgotten_at
      FROM controller_backup_protections
      LEFT JOIN controller_retention_members ON controller_retention_members.protection_id = controller_backup_protections.id
      ORDER BY controller_backup_protections.created_at DESC LIMIT ?
    `).all(safeLimit).map(mapControllerBackupProtection);
  }

  function listAllControllerBackupProtections() {
    return database.prepare(`
      SELECT controller_backup_protections.*, controller_retention_members.run_id AS retention_run_id, controller_retention_members.forgotten_at
      FROM controller_backup_protections
      LEFT JOIN controller_retention_members ON controller_retention_members.protection_id = controller_backup_protections.id
      ORDER BY controller_backup_protections.created_at DESC
    `).all().map(mapControllerBackupProtection);
  }

  function mapControllerRetentionRun(row) {
    return row ? {
      id: row.id,
      repositoryId: row.repository_id,
      beforeSnapshotSetRevision: row.before_snapshot_revision,
      afterSnapshotSetRevision: row.after_snapshot_revision,
      beforeCount: Number(row.before_count),
      afterCount: row.after_count == null ? null : Number(row.after_count),
      forgotten: parseJson(row.forgotten_json, []),
      keptSnapshotIds: parseJson(row.kept_snapshot_ids_json, []),
      repositoryVerified: Boolean(row.repository_verified),
      complete: Boolean(row.complete),
      prunePerformed: Boolean(row.prune_performed),
      verification: parseJson(row.verification_json, []),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function recordControllerRetention({ id, repositoryId, beforeSnapshotSetRevision, afterSnapshotSetRevision, beforeCount, afterCount, forgotten, keptSnapshotIds, repositoryVerified, complete = repositoryVerified, prunePerformed, verification = [], createdBy }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!Array.isArray(forgotten) || forgotten.length < 1) throw new Error("A controller retention run must identify forgotten protections");
      database.prepare(`
        INSERT INTO controller_retention_runs (id, repository_id, before_snapshot_revision, after_snapshot_revision, before_count, after_count, forgotten_json, kept_snapshot_ids_json, repository_verified, complete, prune_performed, verification_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, repositoryId, beforeSnapshotSetRevision, afterSnapshotSetRevision ?? null, beforeCount, afterCount ?? null, json(forgotten), json(keptSnapshotIds), repositoryVerified ? 1 : 0, complete ? 1 : 0, prunePerformed ? 1 : 0, json(verification), createdBy, at);
      for (const item of forgotten) {
        const protection = database.prepare("SELECT snapshot_id FROM controller_backup_protections WHERE id = ?").get(item.protectionId);
        if (!protection || protection.snapshot_id !== item.snapshotId) throw new Error("Retention evidence does not match a recorded controller protection");
        database.prepare("INSERT INTO controller_retention_members (run_id, protection_id, snapshot_id, forgotten_at) VALUES (?, ?, ?, ?)")
          .run(id, item.protectionId, item.snapshotId, at);
      }
      recordAudit("controller.retention.applied", { actorId: createdBy, subjectId: id, details: { repositoryId, beforeCount, afterCount, forgottenCount: forgotten.length, repositoryVerified, complete, prunePerformed, verification } });
      const run = getControllerRetentionRun(id);
      database.exec("COMMIT");
      return run;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original retention-record error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function getControllerRetentionRun(id) {
    return mapControllerRetentionRun(database.prepare("SELECT * FROM controller_retention_runs WHERE id = ?").get(id));
  }

  function listControllerRetentionRuns(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM controller_retention_runs ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapControllerRetentionRun);
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

  function mapVmBackup(row) {
    return row ? {
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
      retained: row.retention_run_id == null,
      retention: row.retention_run_id == null ? null : { runId: row.retention_run_id, forgottenAt: row.forgotten_at },
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function listVmBackups(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare(`
      SELECT vm_backups.*, vm_retention_members.run_id AS retention_run_id, vm_retention_members.forgotten_at
      FROM vm_backups LEFT JOIN vm_retention_members ON vm_retention_members.backup_id = vm_backups.id
      ORDER BY vm_backups.created_at DESC LIMIT ?
    `).all(safeLimit).map(mapVmBackup);
  }

  function listAllVmBackups() {
    return database.prepare(`
      SELECT vm_backups.*, vm_retention_members.run_id AS retention_run_id, vm_retention_members.forgotten_at
      FROM vm_backups LEFT JOIN vm_retention_members ON vm_retention_members.backup_id = vm_backups.id
      ORDER BY vm_backups.created_at DESC
    `).all().map(mapVmBackup);
  }

  function getVmBackup(id) {
    return mapVmBackup(database.prepare(`
      SELECT vm_backups.*, vm_retention_members.run_id AS retention_run_id, vm_retention_members.forgotten_at
      FROM vm_backups LEFT JOIN vm_retention_members ON vm_retention_members.backup_id = vm_backups.id
      WHERE vm_backups.id = ?
    `).get(id));
  }

  function recordVmRestoreDrill({ backupId, restoreDrill, createdBy }) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const update = database.prepare("UPDATE vm_backups SET protected = 1, restore_drill_json = ? WHERE id = ? AND protected = 0")
        .run(json(restoreDrill), backupId);
      if (Number(update.changes) !== 1) throw new Error("VM backup is unavailable or already protected");
      recordAudit("vm.restore_drill.passed", { actorId: createdBy, subjectId: backupId, details: restoreDrill });
      const backup = getVmBackup(backupId);
      database.exec("COMMIT");
      return backup;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original evidence-write error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function mapVmRecovery(row) {
    return row ? {
      id: row.id,
      backupId: row.backup_id,
      sourceDomainName: row.source_domain_name,
      sourceDomainUuid: row.source_domain_uuid,
      domainName: row.domain_name,
      domainUuid: row.domain_uuid,
      destination: row.destination_type,
      sizeBytes: Number(row.size_bytes),
      state: row.state,
      network: row.network,
      autostart: Boolean(row.autostart),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function recordVmRecovery({ id, backupId, sourceDomainName, sourceDomainUuid, domainName, domainUuid, destination, sizeBytes, state, network, autostart, createdBy }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        INSERT INTO vm_recoveries (id, backup_id, source_domain_name, source_domain_uuid, domain_name, domain_uuid, destination_type, size_bytes, state, network, autostart, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, backupId, sourceDomainName, sourceDomainUuid, domainName, domainUuid, destination, sizeBytes, state, network, autostart ? 1 : 0, createdBy, at);
      recordAudit("vm.recovery.created", { actorId: createdBy, subjectId: id, details: { backupId, sourceDomainName, domainName, domainUuid, destination, sizeBytes, state, network, autostart } });
      const recovery = getVmRecovery(id);
      database.exec("COMMIT");
      return recovery;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original recovery-record error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function getVmRecovery(id) {
    return mapVmRecovery(database.prepare("SELECT * FROM vm_recoveries WHERE id = ?").get(id));
  }

  function listVmRecoveries(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM vm_recoveries ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapVmRecovery);
  }

  function listAllVmRecoveries() {
    return database.prepare("SELECT * FROM vm_recoveries ORDER BY created_at DESC").all().map(mapVmRecovery);
  }

  function mapVmRetentionRun(row) {
    return row ? {
      id: row.id,
      repositoryId: row.repository_id,
      beforeSnapshotSetRevision: row.before_snapshot_revision,
      afterSnapshotSetRevision: row.after_snapshot_revision,
      beforeCount: Number(row.before_count),
      afterCount: row.after_count == null ? null : Number(row.after_count),
      forgotten: parseJson(row.forgotten_json, []),
      keptSnapshotIds: parseJson(row.kept_snapshot_ids_json, []),
      repositoryVerified: Boolean(row.repository_verified),
      complete: Boolean(row.complete),
      prunePerformed: Boolean(row.prune_performed),
      verification: parseJson(row.verification_json, []),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function recordVmRetention({ id, repositoryId, beforeSnapshotSetRevision, afterSnapshotSetRevision, beforeCount, afterCount, forgotten, keptSnapshotIds, repositoryVerified, complete = repositoryVerified, prunePerformed, verification = [], createdBy }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!Array.isArray(forgotten) || forgotten.length < 1) throw new Error("A retention run must identify forgotten backups");
      database.prepare(`
        INSERT INTO vm_retention_runs (id, repository_id, before_snapshot_revision, after_snapshot_revision, before_count, after_count, forgotten_json, kept_snapshot_ids_json, repository_verified, complete, prune_performed, verification_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, repositoryId, beforeSnapshotSetRevision, afterSnapshotSetRevision ?? null, beforeCount, afterCount ?? null, json(forgotten), json(keptSnapshotIds), repositoryVerified ? 1 : 0, complete ? 1 : 0, prunePerformed ? 1 : 0, json(verification), createdBy, at);
      for (const item of forgotten) {
        const backup = database.prepare("SELECT snapshot_id FROM vm_backups WHERE id = ?").get(item.backupId);
        if (!backup || backup.snapshot_id !== item.snapshotId) throw new Error("Retention evidence does not match a recorded VM backup");
        database.prepare("INSERT INTO vm_retention_members (run_id, backup_id, snapshot_id, forgotten_at) VALUES (?, ?, ?, ?)")
          .run(id, item.backupId, item.snapshotId, at);
      }
      recordAudit("vm.retention.applied", { actorId: createdBy, subjectId: id, details: { repositoryId, beforeCount, afterCount, forgottenCount: forgotten.length, repositoryVerified, complete, prunePerformed, verification } });
      const run = getVmRetentionRun(id);
      database.exec("COMMIT");
      return run;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original evidence-write error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function getVmRetentionRun(id) {
    return mapVmRetentionRun(database.prepare("SELECT * FROM vm_retention_runs WHERE id = ?").get(id));
  }

  function listVmRetentionRuns(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM vm_retention_runs ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapVmRetentionRun);
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
    findFirstOwner,
    findOwnerById,
    createSession,
    getSession,
    elevateSession,
    clearSessionElevation,
    getSetting,
    setSetting,
    saveJobOutput,
    getJobOutput,
    deleteSession,
    deleteExpiredSessions,
    recordAudit,
    listAudit,
    subscribeJobs,
    createJob,
    createPlan,
    getPlan,
    addJobStep,
    addApproval,
    transitionJob,
    getJob,
    listJobs,
    listActiveJobs,
    createSchedule,
    getSchedule,
    listSchedules,
    listDueSchedules,
    setScheduleEnabled,
    markScheduleRun,
    deleteSchedule,
    recordBackup,
    getBackup,
    listBackups,
    recordControllerBackupProtection,
    getControllerBackupProtection,
    getControllerBackupProtectionByBackup,
    listControllerBackupProtections,
    listAllControllerBackupProtections,
    recordControllerRetention,
    getControllerRetentionRun,
    listControllerRetentionRuns,
    recordVmExport,
    listVmExports,
    getVmExport,
    recordVmBackup,
    listVmBackups,
    listAllVmBackups,
    getVmBackup,
    recordVmRestoreDrill,
    recordVmRecovery,
    getVmRecovery,
    listVmRecoveries,
    listAllVmRecoveries,
    recordVmRetention,
    getVmRetentionRun,
    listVmRetentionRuns,
    recoverInterruptedJobs,
    close,
  };
}

export const stateInternals = { digest, parseJson };
