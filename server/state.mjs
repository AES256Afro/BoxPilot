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
    CREATE TABLE IF NOT EXISTS application_recoveries (
      id TEXT PRIMARY KEY,
      backup_id TEXT NOT NULL REFERENCES backups(id),
      application_id TEXT NOT NULL,
      destination_type TEXT NOT NULL,
      state_path TEXT NOT NULL UNIQUE,
      evidence_path TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL,
      state TEXT NOT NULL,
      network TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS application_recovery_drills (
      id TEXT PRIMARY KEY,
      recovery_id TEXT NOT NULL REFERENCES application_recoveries(id),
      application_id TEXT NOT NULL,
      release_version TEXT NOT NULL,
      source_evidence_checksum_sha256 TEXT NOT NULL,
      source_state_tree_digest_sha256 TEXT NOT NULL,
      network TEXT NOT NULL,
      health_identity_verified INTEGER NOT NULL,
      database_integrity TEXT NOT NULL,
      foreign_key_issues INTEGER NOT NULL,
      schema_verified INTEGER NOT NULL,
      process_started INTEGER NOT NULL,
      process_stopped INTEGER NOT NULL,
      workspace_removed INTEGER NOT NULL,
      source_recovery_unchanged INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS application_recovery_promotions (
      id TEXT PRIMARY KEY,
      recovery_id TEXT NOT NULL REFERENCES application_recoveries(id),
      drill_id TEXT NOT NULL REFERENCES application_recovery_drills(id),
      application_id TEXT NOT NULL,
      release_version TEXT NOT NULL,
      previous_install_id TEXT NOT NULL,
      source_evidence_checksum_sha256 TEXT NOT NULL,
      source_state_tree_digest_sha256 TEXT NOT NULL,
      previous_state_tree_digest_sha256 TEXT NOT NULL,
      promoted_state_tree_digest_sha256 TEXT NOT NULL,
      rollback_path TEXT NOT NULL UNIQUE,
      rollback_evidence_path TEXT NOT NULL UNIQUE,
      health_identity_verified INTEGER NOT NULL,
      database_integrity TEXT NOT NULL,
      foreign_key_issues INTEGER NOT NULL,
      schema_verified INTEGER NOT NULL,
      rollback_available INTEGER NOT NULL,
      source_recovery_unchanged INTEGER NOT NULL,
      owner_login_tested INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS application_backup_protections (
      id TEXT PRIMARY KEY,
      backup_id TEXT NOT NULL UNIQUE REFERENCES backups(id),
      application_id TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS migration_sources (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      manifest_json TEXT NOT NULL,
      imported_by TEXT NOT NULL REFERENCES owners(id),
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS migration_transfers (
      id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL REFERENCES migration_sources(id),
      source_fingerprint TEXT NOT NULL,
      content_revision TEXT NOT NULL,
      workload_name TEXT NOT NULL,
      destination_type TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_verified INTEGER NOT NULL,
      source_preserved INTEGER NOT NULL,
      activation_performed INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dns_acceptances (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
      application_id TEXT NOT NULL,
      resolver_address TEXT NOT NULL,
      assessment_id TEXT NOT NULL REFERENCES plans(id),
      deployment_job_id TEXT NOT NULL REFERENCES jobs(id),
      backup_id TEXT NOT NULL REFERENCES backups(id),
      origin TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      passed INTEGER NOT NULL,
      second_device_tested INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_enrollment_tokens (
      token_hash TEXT PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS fleet_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      capabilities_json TEXT NOT NULL,
      status TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      enrolled_by TEXT NOT NULL REFERENCES owners(id),
      enrolled_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS fleet_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES fleet_agents(id),
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      controller_acceptance_id TEXT REFERENCES dns_acceptances(id),
      router_acceptance_id TEXT REFERENCES router_dns_acceptances(id),
      state TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS fleet_evidence (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE REFERENCES fleet_tasks(id),
      agent_id TEXT NOT NULL REFERENCES fleet_agents(id),
      sequence INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      passed INTEGER NOT NULL,
      signature TEXT NOT NULL,
      received_at TEXT NOT NULL,
      UNIQUE(agent_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS router_checkpoints (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      firmware_version TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      hash_origin TEXT NOT NULL,
      configuration_uploaded INTEGER NOT NULL,
      file_retained_by_operator INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS router_dns_acceptances (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
      plan_id TEXT NOT NULL REFERENCES plans(id),
      checkpoint_id TEXT NOT NULL REFERENCES router_checkpoints(id),
      resolver_address TEXT NOT NULL,
      origin TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      assertions_json TEXT NOT NULL,
      passed INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_application_recoveries_created_at ON application_recoveries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_application_recovery_drills_created_at ON application_recovery_drills(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_application_recovery_promotions_created_at ON application_recovery_promotions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_retention_runs_created_at ON vm_retention_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_migration_sources_imported_at ON migration_sources(imported_at DESC);
    CREATE INDEX IF NOT EXISTS idx_migration_transfers_created_at ON migration_transfers(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dns_acceptances_created_at ON dns_acceptances(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_router_dns_acceptances_created_at ON router_dns_acceptances(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fleet_tasks_agent_state ON fleet_tasks(agent_id, state, created_at);
    CREATE INDEX IF NOT EXISTS idx_fleet_evidence_received_at ON fleet_evidence(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_router_checkpoints_created_at ON router_checkpoints(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at DESC);
  `);

  const fleetTaskColumns = database.prepare("PRAGMA table_info(fleet_tasks)").all().map((column) => column.name);
  if (!fleetTaskColumns.includes("available_at")) {
    database.exec("ALTER TABLE fleet_tasks ADD COLUMN available_at TEXT");
    database.exec("UPDATE fleet_tasks SET available_at = created_at WHERE available_at IS NULL");
  }
  if (!fleetTaskColumns.includes("router_acceptance_id")) {
    database.exec("ALTER TABLE fleet_tasks ADD COLUMN router_acceptance_id TEXT REFERENCES router_dns_acceptances(id)");
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_fleet_tasks_agent_dispatch ON fleet_tasks(agent_id, state, available_at, expires_at)");

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

  function listActiveJobs() {
    return database.prepare("SELECT id FROM jobs WHERE state IN ('applying', 'verifying') ORDER BY created_at").all().map((row) => getJob(row.id));
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

  function recordApplicationRecovery({ id, backupId, applicationId, destination, statePath, evidencePath, sizeBytes, state, network, createdBy }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        INSERT INTO application_recoveries (id, backup_id, application_id, destination_type, state_path, evidence_path, size_bytes, state, network, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, backupId, applicationId, destination, statePath, evidencePath, sizeBytes, state, network, createdBy, at);
      recordAudit("application.recovery.created", { actorId: createdBy, subjectId: id, details: { backupId, applicationId, destination, sizeBytes, state, network } });
      const recovery = getApplicationRecovery(id);
      database.exec("COMMIT");
      return recovery;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the original record error. */ }
      throw error;
    }
  }

  function getApplicationRecovery(id) {
    return mapApplicationRecovery(database.prepare("SELECT * FROM application_recoveries WHERE id = ?").get(id));
  }

  function listApplicationRecoveries(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM application_recoveries ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapApplicationRecovery);
  }

  function mapApplicationRecoveryDrill(row) {
    return row ? {
      id: row.id,
      recoveryId: row.recovery_id,
      applicationId: row.application_id,
      releaseVersion: row.release_version,
      sourceEvidenceChecksumSha256: row.source_evidence_checksum_sha256,
      sourceStateTreeDigestSha256: row.source_state_tree_digest_sha256,
      network: row.network,
      healthIdentityVerified: Boolean(row.health_identity_verified),
      databaseIntegrity: row.database_integrity,
      foreignKeyIssues: Number(row.foreign_key_issues),
      schemaVerified: Boolean(row.schema_verified),
      processStarted: Boolean(row.process_started),
      processStopped: Boolean(row.process_stopped),
      workspaceRemoved: Boolean(row.workspace_removed),
      sourceRecoveryUnchanged: Boolean(row.source_recovery_unchanged),
      passed: Boolean(row.passed),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function recordApplicationRecoveryDrill({ id, recoveryId, applicationId, releaseVersion, sourceEvidenceChecksumSha256, sourceStateTreeDigestSha256, network, healthIdentityVerified, databaseIntegrity, foreignKeyIssues, schemaVerified, processStarted, processStopped, workspaceRemoved, sourceRecoveryUnchanged, passed, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO application_recovery_drills (id, recovery_id, application_id, release_version, source_evidence_checksum_sha256, source_state_tree_digest_sha256, network, health_identity_verified, database_integrity, foreign_key_issues, schema_verified, process_started, process_stopped, workspace_removed, source_recovery_unchanged, passed, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, recoveryId, applicationId, releaseVersion, sourceEvidenceChecksumSha256, sourceStateTreeDigestSha256, network, healthIdentityVerified ? 1 : 0, databaseIntegrity, foreignKeyIssues, schemaVerified ? 1 : 0, processStarted ? 1 : 0, processStopped ? 1 : 0, workspaceRemoved ? 1 : 0, sourceRecoveryUnchanged ? 1 : 0, passed ? 1 : 0, createdBy, at);
    recordAudit("application.recovery.drill.passed", { actorId: createdBy, subjectId: id, details: { recoveryId, applicationId, releaseVersion, network, passed } });
    return getApplicationRecoveryDrill(id);
  }

  function getApplicationRecoveryDrill(id) {
    return mapApplicationRecoveryDrill(database.prepare("SELECT * FROM application_recovery_drills WHERE id = ?").get(id));
  }

  function listApplicationRecoveryDrills(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM application_recovery_drills ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapApplicationRecoveryDrill);
  }

  function mapApplicationRecoveryPromotion(row) {
    return row ? {
      id: row.id,
      recoveryId: row.recovery_id,
      drillId: row.drill_id,
      applicationId: row.application_id,
      releaseVersion: row.release_version,
      previousInstallId: row.previous_install_id,
      sourceEvidenceChecksumSha256: row.source_evidence_checksum_sha256,
      sourceStateTreeDigestSha256: row.source_state_tree_digest_sha256,
      previousStateTreeDigestSha256: row.previous_state_tree_digest_sha256,
      promotedStateTreeDigestSha256: row.promoted_state_tree_digest_sha256,
      rollbackPath: row.rollback_path,
      rollbackEvidencePath: row.rollback_evidence_path,
      healthIdentityVerified: Boolean(row.health_identity_verified),
      databaseIntegrity: row.database_integrity,
      foreignKeyIssues: Number(row.foreign_key_issues),
      schemaVerified: Boolean(row.schema_verified),
      rollbackAvailable: Boolean(row.rollback_available),
      sourceRecoveryUnchanged: Boolean(row.source_recovery_unchanged),
      ownerLoginTested: Boolean(row.owner_login_tested),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function recordApplicationRecoveryPromotion({ id, recoveryId, drillId, applicationId, releaseVersion, previousInstallId, sourceEvidenceChecksumSha256, sourceStateTreeDigestSha256, previousStateTreeDigestSha256, promotedStateTreeDigestSha256, rollbackPath, rollbackEvidencePath, healthIdentityVerified, databaseIntegrity, foreignKeyIssues, schemaVerified, rollbackAvailable, sourceRecoveryUnchanged, ownerLoginTested, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO application_recovery_promotions (id, recovery_id, drill_id, application_id, release_version, previous_install_id, source_evidence_checksum_sha256, source_state_tree_digest_sha256, previous_state_tree_digest_sha256, promoted_state_tree_digest_sha256, rollback_path, rollback_evidence_path, health_identity_verified, database_integrity, foreign_key_issues, schema_verified, rollback_available, source_recovery_unchanged, owner_login_tested, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, recoveryId, drillId, applicationId, releaseVersion, previousInstallId, sourceEvidenceChecksumSha256, sourceStateTreeDigestSha256, previousStateTreeDigestSha256, promotedStateTreeDigestSha256, rollbackPath, rollbackEvidencePath, healthIdentityVerified ? 1 : 0, databaseIntegrity, foreignKeyIssues, schemaVerified ? 1 : 0, rollbackAvailable ? 1 : 0, sourceRecoveryUnchanged ? 1 : 0, ownerLoginTested ? 1 : 0, createdBy, at);
    recordAudit("application.recovery.promoted", { actorId: createdBy, subjectId: id, details: { recoveryId, drillId, applicationId, releaseVersion, rollbackAvailable } });
    return getApplicationRecoveryPromotion(id);
  }

  function getApplicationRecoveryPromotion(id) {
    return mapApplicationRecoveryPromotion(database.prepare("SELECT * FROM application_recovery_promotions WHERE id = ?").get(id));
  }

  function listApplicationRecoveryPromotions(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM application_recovery_promotions ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapApplicationRecoveryPromotion);
  }

  function recordApplicationBackupProtection({ id, backupId, applicationId, destination, repositoryId, snapshotId, sizeBytes, encrypted, independent, repositoryVerified, protected: protectedState, restoreDrill, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO application_backup_protections (id, backup_id, application_id, destination_type, repository_id, snapshot_id, size_bytes, encrypted, independent, repository_verified, protected, restore_drill_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, backupId, applicationId, destination, repositoryId, snapshotId, sizeBytes, encrypted ? 1 : 0, independent ? 1 : 0, repositoryVerified ? 1 : 0, protectedState ? 1 : 0, json(restoreDrill), createdBy, at);
    recordAudit("application.backup.protected", { actorId: createdBy, subjectId: id, details: { backupId, applicationId, destination, repositoryId, snapshotId, sizeBytes, protected: protectedState } });
    return getApplicationBackupProtection(id);
  }

  function mapApplicationBackupProtection(row) {
    return row ? {
      id: row.id,
      backupId: row.backup_id,
      applicationId: row.application_id,
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
    } : null;
  }

  function getApplicationBackupProtection(id) {
    return mapApplicationBackupProtection(database.prepare("SELECT * FROM application_backup_protections WHERE id = ?").get(id));
  }

  function getApplicationBackupProtectionByBackup(backupId) {
    return mapApplicationBackupProtection(database.prepare("SELECT * FROM application_backup_protections WHERE backup_id = ?").get(backupId));
  }

  function listApplicationBackupProtections(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM application_backup_protections ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapApplicationBackupProtection);
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

  function mapMigrationTransfer(row) {
    return row ? {
      id: row.id,
      bundleId: row.bundle_id,
      sourceId: row.source_id,
      sourceFingerprint: row.source_fingerprint,
      contentRevision: row.content_revision,
      workloadName: row.workload_name,
      destination: row.destination_type,
      fileCount: Number(row.file_count),
      sizeBytes: Number(row.size_bytes),
      contentVerified: Boolean(row.content_verified),
      sourcePreserved: Boolean(row.source_preserved),
      activationPerformed: Boolean(row.activation_performed),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function recordMigrationTransfer({ id, bundleId, sourceId, sourceFingerprint, contentRevision, workloadName, destination, fileCount, sizeBytes, contentVerified, sourcePreserved, activationPerformed, createdBy }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      const source = getMigrationSource(sourceId);
      if (!source || source.fingerprint !== sourceFingerprint) throw new Error("Migration transfer source evidence does not match an imported source");
      if (contentVerified !== true || sourcePreserved !== true || activationPerformed !== false) throw new Error("Migration transfer evidence is incomplete");
      database.prepare(`
        INSERT INTO migration_transfers (id, bundle_id, source_id, source_fingerprint, content_revision, workload_name, destination_type, file_count, size_bytes, content_verified, source_preserved, activation_performed, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, bundleId, sourceId, sourceFingerprint, contentRevision, workloadName, destination, fileCount, sizeBytes, 1, 1, 0, createdBy, at);
      recordAudit("migration.transfer.verified", { actorId: createdBy, subjectId: id, details: { bundleId, sourceId, sourceFingerprint, contentRevision, workloadName, destination, fileCount, sizeBytes, contentVerified: true, sourcePreserved: true, activationPerformed: false } });
      const transfer = getMigrationTransfer(id);
      database.exec("COMMIT");
      return transfer;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original transfer-record error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function getMigrationTransfer(id) {
    return mapMigrationTransfer(database.prepare("SELECT * FROM migration_transfers WHERE id = ?").get(id));
  }

  function listMigrationTransfers(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM migration_transfers ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapMigrationTransfer);
  }

  function recordDnsAcceptance({ id, jobId, applicationId, resolverAddress, assessmentId, deploymentJobId, backupId, origin, checks, passed, secondDeviceTested, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO dns_acceptances (id, job_id, application_id, resolver_address, assessment_id, deployment_job_id, backup_id, origin, checks_json, passed, second_device_tested, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, jobId, applicationId, resolverAddress, assessmentId, deploymentJobId, backupId, origin, json(checks), passed ? 1 : 0, secondDeviceTested ? 1 : 0, createdBy, at);
    recordAudit("network.dns.acceptance.verified", { actorId: createdBy, subjectId: id, details: { applicationId, resolverAddress, origin, passed, secondDeviceTested } });
    return listDnsAcceptances(1)[0];
  }

  function listDnsAcceptances(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM dns_acceptances ORDER BY created_at DESC LIMIT ?").all(safeLimit).map((row) => ({
      id: row.id,
      jobId: row.job_id,
      applicationId: row.application_id,
      resolverAddress: row.resolver_address,
      assessmentId: row.assessment_id,
      deploymentJobId: row.deployment_job_id,
      backupId: row.backup_id,
      origin: row.origin,
      checks: parseJson(row.checks_json, []),
      passed: Boolean(row.passed),
      secondDeviceTested: Boolean(row.second_device_tested),
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }

  function createAgentEnrollmentToken(createdBy, { ttlMs = 10 * 60 * 1000 } = {}) {
    const token = tokenBytes(32).toString("base64url");
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    database.prepare("DELETE FROM agent_enrollment_tokens WHERE used_at IS NOT NULL OR expires_at <= ?").run(iso(createdAt));
    database.prepare("INSERT INTO agent_enrollment_tokens (token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(digest(token), createdBy, iso(createdAt), iso(expiresAt));
    recordAudit("fleet.enrollment.created", { actorId: createdBy, details: { expiresAt: iso(expiresAt) } });
    return { token, expiresAt: iso(expiresAt) };
  }

  function mapFleetAgent(row, { includePublicKey = false } = {}) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      fingerprint: row.fingerprint,
      capabilities: parseJson(row.capabilities_json, []),
      status: row.status,
      lastSequence: Number(row.last_sequence),
      enrolledBy: row.enrolled_by,
      enrolledAt: row.enrolled_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      ...(includePublicKey ? { publicKey: row.public_key } : {}),
    };
  }

  function consumeAgentEnrollmentToken({ token, name, publicKey, fingerprint, capabilities }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      const entry = database.prepare("SELECT * FROM agent_enrollment_tokens WHERE token_hash = ?").get(digest(token));
      if (!entry || entry.used_at || entry.expires_at <= at) throw new Error("Enrollment token is invalid or expired");
      const agent = {
        id: randomUUID(), name, publicKey, fingerprint, capabilities, status: "active",
        lastSequence: 0, enrolledBy: entry.created_by, enrolledAt: at,
      };
      database.prepare(`
        INSERT INTO fleet_agents (id, name, public_key, fingerprint, capabilities_json, status, last_sequence, enrolled_by, enrolled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(agent.id, agent.name, agent.publicKey, agent.fingerprint, json(agent.capabilities), agent.status, agent.lastSequence, agent.enrolledBy, agent.enrolledAt);
      database.prepare("UPDATE agent_enrollment_tokens SET used_at = ? WHERE token_hash = ?").run(at, digest(token));
      recordAudit("fleet.agent.enrolled", { actorId: agent.enrolledBy, subjectId: agent.id, details: { name, fingerprint, capabilities } });
      database.exec("COMMIT");
      return mapFleetAgent(database.prepare("SELECT * FROM fleet_agents WHERE id = ?").get(agent.id));
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the enrollment error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function getFleetAgent(id, { includePublicKey = false } = {}) {
    return mapFleetAgent(database.prepare("SELECT * FROM fleet_agents WHERE id = ?").get(id), { includePublicKey });
  }

  function listFleetAgents(limit = 100) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    return database.prepare("SELECT * FROM fleet_agents ORDER BY enrolled_at DESC LIMIT ?").all(safeLimit).map((row) => mapFleetAgent(row));
  }

  function advanceFleetAgentSequence(id, sequence) {
    const at = timestamp();
    const update = database.prepare("UPDATE fleet_agents SET last_sequence = ?, last_seen_at = ? WHERE id = ? AND status = 'active' AND last_sequence < ?")
      .run(sequence, at, id, sequence);
    if (Number(update.changes) !== 1) throw new Error("Agent request was replayed, revoked, or out of sequence");
    return getFleetAgent(id);
  }

  function revokeFleetAgent(id, ownerId) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      const update = database.prepare("UPDATE fleet_agents SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'").run(at, id);
      if (Number(update.changes) !== 1) throw new Error("Active agent not found");
      database.prepare("UPDATE fleet_tasks SET state = 'expired' WHERE agent_id = ? AND state = 'pending'").run(id);
      recordAudit("fleet.agent.revoked", { actorId: ownerId, subjectId: id });
      const agent = getFleetAgent(id);
      database.exec("COMMIT");
      return agent;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the revocation error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function mapFleetTask(row) {
    return row ? {
      id: row.id,
      agentId: row.agent_id,
      type: row.type,
      payload: parseJson(row.payload_json),
      controllerAcceptanceId: row.controller_acceptance_id,
      routerAcceptanceId: row.router_acceptance_id,
      state: row.state,
      createdBy: row.created_by,
      createdAt: row.created_at,
      availableAt: row.available_at ?? row.created_at,
      expiresAt: row.expires_at,
      completedAt: row.completed_at,
    } : null;
  }

  function createFleetTask({ agentId, type, payload, controllerAcceptanceId = null, routerAcceptanceId = null, createdBy, delayMs = 0, ttlMs = 10 * 60 * 1000 }) {
    const agent = getFleetAgent(agentId);
    if (!agent || agent.status !== "active") throw new Error("Active agent not found");
    const createdAt = now();
    const task = {
      id: randomUUID(), agentId, type, payload, controllerAcceptanceId, routerAcceptanceId, state: "pending", createdBy,
      createdAt: iso(createdAt), availableAt: iso(new Date(createdAt.getTime() + delayMs)), expiresAt: iso(new Date(createdAt.getTime() + delayMs + ttlMs)), completedAt: null,
    };
    database.prepare(`
      INSERT INTO fleet_tasks (id, agent_id, type, payload_json, controller_acceptance_id, router_acceptance_id, state, created_by, created_at, available_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.agentId, task.type, json(task.payload), task.controllerAcceptanceId, task.routerAcceptanceId, task.state, task.createdBy, task.createdAt, task.availableAt, task.expiresAt);
    recordAudit("fleet.task.created", { actorId: createdBy, subjectId: task.id, details: { agentId, type, controllerAcceptanceId, routerAcceptanceId, availableAt: task.availableAt, expiresAt: task.expiresAt, recurring: false } });
    return task;
  }

  function getFleetTask(id) {
    return mapFleetTask(database.prepare("SELECT * FROM fleet_tasks WHERE id = ?").get(id));
  }

  function getPendingFleetTask(agentId) {
    const at = timestamp();
    database.prepare("UPDATE fleet_tasks SET state = 'expired' WHERE agent_id = ? AND state = 'pending' AND expires_at <= ?").run(agentId, at);
    return mapFleetTask(database.prepare("SELECT * FROM fleet_tasks WHERE agent_id = ? AND state = 'pending' AND available_at <= ? AND expires_at > ? ORDER BY available_at LIMIT 1").get(agentId, at, at));
  }

  function listFleetTasks(limit = 100) {
    const at = timestamp();
    database.prepare("UPDATE fleet_tasks SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?").run(at);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    return database.prepare("SELECT * FROM fleet_tasks ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapFleetTask);
  }

  function recordFleetEvidence({ id, taskId, agentId, sequence, result, passed, signature }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      const sequenceUpdate = database.prepare("UPDATE fleet_agents SET last_sequence = ?, last_seen_at = ? WHERE id = ? AND status = 'active' AND last_sequence < ?")
        .run(sequence, at, agentId, sequence);
      if (Number(sequenceUpdate.changes) !== 1) throw new Error("Agent request was replayed, revoked, or out of sequence");
      const task = database.prepare("SELECT * FROM fleet_tasks WHERE id = ? AND agent_id = ? AND state = 'pending' AND available_at <= ? AND expires_at > ?").get(taskId, agentId, at, at);
      if (!task) throw new Error("Fleet task is unavailable, expired, or already completed");
      database.prepare(`
        INSERT INTO fleet_evidence (id, task_id, agent_id, sequence, result_json, passed, signature, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, taskId, agentId, sequence, json(result), passed ? 1 : 0, signature, at);
      database.prepare("UPDATE fleet_tasks SET state = 'completed', completed_at = ? WHERE id = ?").run(at, taskId);
      recordAudit("fleet.evidence.recorded", { actorId: null, subjectId: id, details: { taskId, agentId, passed, signed: true } });
      const evidence = getFleetEvidence(id);
      database.exec("COMMIT");
      return evidence;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the evidence error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function mapFleetEvidence(row) {
    return row ? {
      id: row.id,
      taskId: row.task_id,
      agentId: row.agent_id,
      sequence: Number(row.sequence),
      result: parseJson(row.result_json),
      passed: Boolean(row.passed),
      signature: row.signature,
      receivedAt: row.received_at,
    } : null;
  }

  function getFleetEvidence(id) {
    return mapFleetEvidence(database.prepare("SELECT * FROM fleet_evidence WHERE id = ?").get(id));
  }

  function listFleetEvidence(limit = 100) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    return database.prepare("SELECT * FROM fleet_evidence ORDER BY received_at DESC LIMIT ?").all(safeLimit).map(mapFleetEvidence);
  }

  function recordRouterCheckpoint({ id = randomUUID(), modelId, firmwareVersion, checksumSha256, sizeBytes, hashOrigin, configurationUploaded, fileRetainedByOperator, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO router_checkpoints (id, model_id, firmware_version, checksum_sha256, size_bytes, hash_origin, configuration_uploaded, file_retained_by_operator, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, modelId, firmwareVersion, checksumSha256, sizeBytes, hashOrigin, configurationUploaded ? 1 : 0, fileRetainedByOperator ? 1 : 0, createdBy, at);
    recordAudit("router.checkpoint.recorded", { actorId: createdBy, subjectId: id, details: { modelId, firmwareVersion, checksumSha256, sizeBytes, hashOrigin, configurationUploaded, fileRetainedByOperator } });
    return getRouterCheckpoint(id);
  }

  function mapRouterCheckpoint(row) {
    return row ? {
      id: row.id,
      modelId: row.model_id,
      firmwareVersion: row.firmware_version,
      checksumSha256: row.checksum_sha256,
      sizeBytes: Number(row.size_bytes),
      hashOrigin: row.hash_origin,
      configurationUploaded: Boolean(row.configuration_uploaded),
      fileRetainedByOperator: Boolean(row.file_retained_by_operator),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function getRouterCheckpoint(id) {
    return mapRouterCheckpoint(database.prepare("SELECT * FROM router_checkpoints WHERE id = ?").get(id));
  }

  function listRouterCheckpoints(limit = 100) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    return database.prepare("SELECT * FROM router_checkpoints ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapRouterCheckpoint);
  }

  function recordRouterDnsAcceptance({ id, jobId, planId, checkpointId, resolverAddress, origin, checks, assertions, passed, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO router_dns_acceptances (id, job_id, plan_id, checkpoint_id, resolver_address, origin, checks_json, assertions_json, passed, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, jobId, planId, checkpointId, resolverAddress, origin, json(checks), json(assertions), passed ? 1 : 0, createdBy, at);
    recordAudit("router.dns.acceptance.verified", { actorId: createdBy, subjectId: id, details: { checkpointId, resolverAddress, origin, passed } });
    return listRouterDnsAcceptances(1)[0];
  }

  function mapRouterDnsAcceptance(row) {
    return row ? {
      id: row.id,
      jobId: row.job_id,
      planId: row.plan_id,
      checkpointId: row.checkpoint_id,
      resolverAddress: row.resolver_address,
      origin: row.origin,
      checks: parseJson(row.checks_json, []),
      assertions: parseJson(row.assertions_json, {}),
      passed: Boolean(row.passed),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function getRouterDnsAcceptance(id) {
    return mapRouterDnsAcceptance(database.prepare("SELECT * FROM router_dns_acceptances WHERE id = ?").get(id));
  }

  function listRouterDnsAcceptances(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM router_dns_acceptances ORDER BY created_at DESC LIMIT ?").all(safeLimit).map(mapRouterDnsAcceptance);
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
    listActiveJobs,
    recordBackup,
    getBackup,
    listBackups,
    recordApplicationRecovery,
    getApplicationRecovery,
    listApplicationRecoveries,
    recordApplicationRecoveryDrill,
    getApplicationRecoveryDrill,
    listApplicationRecoveryDrills,
    recordApplicationRecoveryPromotion,
    getApplicationRecoveryPromotion,
    listApplicationRecoveryPromotions,
    recordApplicationBackupProtection,
    getApplicationBackupProtection,
    getApplicationBackupProtectionByBackup,
    listApplicationBackupProtections,
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
    importMigrationSource,
    getMigrationSource,
    listMigrationSources,
    recordMigrationTransfer,
    getMigrationTransfer,
    listMigrationTransfers,
    recordDnsAcceptance,
    listDnsAcceptances,
    createAgentEnrollmentToken,
    consumeAgentEnrollmentToken,
    getFleetAgent,
    listFleetAgents,
    advanceFleetAgentSequence,
    revokeFleetAgent,
    createFleetTask,
    getFleetTask,
    getPendingFleetTask,
    listFleetTasks,
    recordFleetEvidence,
    getFleetEvidence,
    listFleetEvidence,
    recordRouterCheckpoint,
    getRouterCheckpoint,
    listRouterCheckpoints,
    recordRouterDnsAcceptance,
    getRouterDnsAcceptance,
    listRouterDnsAcceptances,
    recoverInterruptedJobs,
    close,
  };
}

export const stateInternals = { digest, parseJson };
