import { randomUUID } from "node:crypto";

/** @param {import("node:sqlite").DatabaseSync} database */
export function applySchema(database) {
  // synchronous NORMAL under WAL (M48.5): no fsync per commit; durable at each checkpoint, consistent whatever happens.
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
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
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      rp_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      algorithm INTEGER NOT NULL,
      sign_count INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS recovery_codes (
      code_hash TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS oidc_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES owners(id)
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
    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES owners(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run_at TEXT,
      last_result TEXT,
      last_job_ids_json TEXT,
      frequency TEXT,
      minute INTEGER,
      hour INTEGER,
      weekday INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_due_at TEXT
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
    CREATE INDEX IF NOT EXISTS idx_approvals_job_id ON approvals(job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_controller_backup_protections_created_at ON controller_backup_protections(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_controller_retention_runs_created_at ON controller_retention_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_exports_created_at ON vm_exports(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_backups_created_at ON vm_backups(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_recoveries_created_at ON vm_recoveries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_retention_runs_created_at ON vm_retention_runs(created_at DESC);
    -- Columns that are actually filtered on. Without these, every non-owner job list and every
    -- session cleanup was a full scan, and the scheduler's due check runs once a minute.
    CREATE INDEX IF NOT EXISTS idx_jobs_created_by ON jobs(created_by, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
    CREATE INDEX IF NOT EXISTS idx_sessions_owner_id ON sessions(owner_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_due_at);
    CREATE INDEX IF NOT EXISTS idx_plans_expires_at ON plans(expires_at);
  `);
  // idx_audit_created_at duplicated idx_audit_events_created_at under a second name, doubling the
  // write cost of every audit insert for nothing.
  database.exec("DROP INDEX IF EXISTS idx_audit_created_at;");

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

  const ownerColumns = database.prepare("PRAGMA table_info(owners)").all().map((column) => column.name);
  if (!ownerColumns.includes("role")) database.exec("ALTER TABLE owners ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'");
  const sessionColumns = database.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name);
  if (!sessionColumns.includes("elevated_until")) database.exec("ALTER TABLE sessions ADD COLUMN elevated_until TEXT");
  // A public per-session id and the "from where" metadata for the session list (M19.4). The token
  // hash stays the secret; the id is what the owner sees and revokes by.
  for (const [column, definition] of [["id", "TEXT"], ["client_address", "TEXT"], ["user_agent", "TEXT"], ["method", "TEXT"]]) {
    if (!sessionColumns.includes(column)) database.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${definition}`);
  }
  // Give any session that predates the id column a stable one, so every row is revocable.
  for (const row of database.prepare("SELECT token_hash FROM sessions WHERE id IS NULL").all()) {
    database.prepare("UPDATE sessions SET id = ? WHERE token_hash = ?").run(randomUUID(), row.token_hash);
  }
  // v1.33.0 shipped flows without a cadence; a flow on a clock needs one (ADR-002 addendum). A flow
  // armed for a drive (M26.5) names the managed mount whose loss starts it.
  const flowColumns = database.prepare("PRAGMA table_info(flows)").all().map((column) => column.name);
  for (const [column, definition] of [["frequency", "TEXT"], ["minute", "INTEGER"], ["hour", "INTEGER"], ["weekday", "INTEGER"], ["enabled", "INTEGER NOT NULL DEFAULT 1"], ["next_due_at", "TEXT"], ["trigger_flow_id", "TEXT"], ["webhook_hash", "TEXT"], ["trigger_drive", "TEXT"]]) {
    if (!flowColumns.includes(column)) database.exec(`ALTER TABLE flows ADD COLUMN ${column} ${definition}`);
  }
  const approvalColumns = database.prepare("PRAGMA table_info(approvals)").all().map((column) => column.name);
  if (!approvalColumns.includes("method")) database.exec("ALTER TABLE approvals ADD COLUMN method TEXT NOT NULL DEFAULT 'password'");
  if (!approvalColumns.includes("tier")) database.exec("ALTER TABLE approvals ADD COLUMN tier TEXT");
  // M30.3: a timeout is a result of its own on the job, not a phrase in its error.
  if (!database.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "timeout_json")) database.exec("ALTER TABLE jobs ADD COLUMN timeout_json TEXT");
}
