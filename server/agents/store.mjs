/**
 * Where agents live (M37): their versioned specs, their runs and every step of each run, their
 * notes, the plans they proposed, the owner's documents and the golden questions. Tables in
 * BoxPilot's own database, beside the rest, so a controller backup carries them; opened on a
 * connection of their own so the state store stays as it is.
 *
 * Synchronous (node:sqlite), and every read-modify-write is one IMMEDIATE transaction, so a run is
 * claimed by one runner once. Bounded: prune() keeps each table to what the pages show.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const json = (value) => JSON.stringify(value === undefined ? null : value);
const parse = (value, fallback) => { try { return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; } };
export const digestToken = (token) => createHash("sha256").update(String(token)).digest("hex");

export const runStates = Object.freeze(["queued", "running", "completed", "degraded", "failed", "cancelled", "killed", "interrupted", "refused", "timeout"]);
export const finishedStates = new Set(["completed", "degraded", "failed", "cancelled", "killed", "interrupted", "refused", "timeout"]);

export function createAgentStore({ databasePath, now = () => new Date(), random = randomBytes }) {
  const database = new DatabaseSync(databasePath);
  const compiled = new Map();
  const prepare = (sql) => { let statement = compiled.get(sql); if (!statement) { statement = database.prepare(sql); compiled.set(sql, statement); } return statement; };
  // secure_delete: what the owner tells an agent to forget is overwritten, not just unlinked.
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      template TEXT,
      version INTEGER NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      paused_until TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      next_run_at TEXT,
      last_run_at TEXT,
      events_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS agent_versions (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      spec_json TEXT NOT NULL,
      note TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, version)
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL,
      trigger_json TEXT NOT NULL DEFAULT '{}',
      question TEXT,
      requested_by TEXT,
      read_role TEXT NOT NULL,
      read_as TEXT,
      state TEXT NOT NULL,
      reason TEXT,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      lease_hash TEXT,
      lease_expires_at TEXT,
      runner_id TEXT,
      answer TEXT,
      output_kind TEXT,
      usage_json TEXT NOT NULL DEFAULT '{}',
      flags_json TEXT NOT NULL DEFAULT '{}',
      eval_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, queued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_state ON agent_runs(state, queued_at);
    CREATE TABLE IF NOT EXISTS agent_run_steps (
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT,
      state TEXT NOT NULL,
      input_json TEXT,
      output TEXT,
      flags_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      duration_ms INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS agent_notes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      fresh_until TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_notes_agent ON agent_notes(agent_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS agent_proposals (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      run_id TEXT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      reason TEXT,
      steps_json TEXT NOT NULL,
      dropped_json TEXT NOT NULL DEFAULT '[]',
      flags_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL,
      for_role TEXT NOT NULL,
      requested_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT,
      job_ids_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_agent_proposals_state ON agent_proposals(state, created_at DESC);
    CREATE TABLE IF NOT EXISTS agent_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_evals (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      questions_json TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_eval_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      state TEXT NOT NULL,
      results_json TEXT NOT NULL,
      score REAL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      turns_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      UNIQUE (agent_id, person_id)
    );
    CREATE TABLE IF NOT EXISTS agent_episodes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      run_id TEXT,
      text TEXT NOT NULL,
      read_role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_episodes_agent ON agent_episodes(agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS agent_vectors (
      kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      text_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, item_id)
    );
    CREATE TABLE IF NOT EXISTS agent_feedback (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      model TEXT,
      verdict TEXT NOT NULL,
      note TEXT,
      given_by TEXT,
      given_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_feedback_agent ON agent_feedback(agent_id, given_at DESC);
  `);
  // Columns added after the first M37 tables: added in place where an older database lacks them.
  const ensureColumn = (table, column, definition) => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  ensureColumn("agents", "webhook_hash", "TEXT");
  ensureColumn("agent_runs", "parent_run_id", "TEXT");
  ensureColumn("agent_runs", "root_run_id", "TEXT");
  ensureColumn("agent_runs", "depth", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agent_runs", "thread_id", "TEXT");
  ensureColumn("agent_notes", "pinned", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agent_notes", "shared", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agent_notes", "read_role", "TEXT NOT NULL DEFAULT 'owner'");
  ensureColumn("agent_proposals", "kind", "TEXT NOT NULL DEFAULT 'plan'");
  ensureColumn("agent_proposals", "question", "TEXT");
  ensureColumn("agent_documents", "source", "TEXT NOT NULL DEFAULT 'upload'");
  ensureColumn("agent_documents", "external_id", "TEXT");
  ensureColumn("agent_documents", "pinned", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agent_eval_runs", "model", "TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs(parent_run_id)");

  const iso = () => now().toISOString();
  function transaction(fn) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* nothing of ours was open */ }
      throw error;
    }
  }

  // ---- agents and their versions ----

  const agentOf = (row) => row && {
    id: row.id, name: row.name, template: row.template, version: row.version,
    paused: Boolean(row.paused), pausedUntil: row.paused_until ?? null,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at ?? null,
    nextRunAt: row.next_run_at ?? null, lastRunAt: row.last_run_at ?? null, events: parse(row.events_json, {}),
    webhookHash: row.webhook_hash ?? null,
  };

  function createAgent({ spec, template = null, createdBy = null, nextRunAt = null }) {
    const id = randomUUID();
    const at = iso();
    transaction(() => {
      prepare("INSERT INTO agents (id, name, template, version, created_by, created_at, updated_at, next_run_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)").run(id, spec.name, template, createdBy, at, at, nextRunAt);
      prepare("INSERT INTO agent_versions (agent_id, version, spec_json, note, created_by, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(id, json(spec), template ? `Created from ${template}` : "Created", createdBy, at);
    });
    return getAgent(id);
  }

  function getAgent(id, { includeDeleted = false } = {}) {
    const row = prepare("SELECT * FROM agents WHERE id = ?").get(String(id ?? ""));
    if (!row || (row.deleted_at && !includeDeleted)) return null;
    return { ...agentOf(row), spec: getVersion(row.id, row.version)?.spec ?? null };
  }

  function listAgents() {
    return prepare("SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY created_at").all().map((row) => ({ ...agentOf(row), spec: getVersion(row.id, row.version)?.spec ?? null }));
  }

  function getVersion(agentId, version) {
    const row = prepare("SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?").get(agentId, version);
    return row ? { version: row.version, spec: parse(row.spec_json, null), note: row.note, createdBy: row.created_by, createdAt: row.created_at } : null;
  }

  function listVersions(agentId) {
    return prepare("SELECT version, note, created_by, created_at FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 100").all(agentId)
      .map((row) => ({ version: row.version, note: row.note, createdBy: row.created_by, createdAt: row.created_at }));
  }

  /** A new version with this spec, when it differs from the current one. Returns the version number. */
  function addVersion(agentId, { spec, note = null, createdBy = null, nextRunAt }) {
    return transaction(() => {
      const row = prepare("SELECT version FROM agents WHERE id = ? AND deleted_at IS NULL").get(agentId);
      if (!row) return null;
      const version = row.version + 1;
      const at = iso();
      prepare("INSERT INTO agent_versions (agent_id, version, spec_json, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(agentId, version, json(spec), note, createdBy, at);
      prepare("UPDATE agents SET version = ?, name = ?, updated_at = ?, next_run_at = ? WHERE id = ?").run(version, spec.name, at, nextRunAt ?? null, agentId);
      return version;
    });
  }

  function setPaused(agentId, paused, { until = null } = {}) {
    return Number(prepare("UPDATE agents SET paused = ?, paused_until = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(paused ? 1 : 0, paused ? until : null, iso(), agentId).changes) > 0;
  }

  function setNextRun(agentId, nextRunAt) {
    prepare("UPDATE agents SET next_run_at = ? WHERE id = ?").run(nextRunAt, agentId);
  }

  function noteEvent(agentId, family, at) {
    transaction(() => {
      const row = prepare("SELECT events_json FROM agents WHERE id = ?").get(agentId);
      if (!row) return;
      const events = { ...parse(row.events_json, {}), [family]: at };
      prepare("UPDATE agents SET events_json = ? WHERE id = ?").run(json(events), agentId);
    });
  }

  function deleteAgent(agentId) {
    return Number(prepare("UPDATE agents SET deleted_at = ?, next_run_at = NULL, webhook_hash = NULL WHERE id = ? AND deleted_at IS NULL").run(iso(), agentId).changes) > 0;
  }

  /** The webhook's digest (never the token), or null to take the webhook away. */
  function setWebhook(agentId, hash) {
    return Number(prepare("UPDATE agents SET webhook_hash = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(hash, iso(), agentId).changes) > 0;
  }

  // ---- runs ----

  const runOf = (row) => row && {
    id: row.id, agentId: row.agent_id, version: row.version, kind: row.kind, trigger: parse(row.trigger_json, {}), question: row.question ?? null,
    requestedBy: row.requested_by ?? null, readRole: row.read_role, readAs: row.read_as ?? null, state: row.state, reason: row.reason ?? null,
    queuedAt: row.queued_at, startedAt: row.started_at ?? null, finishedAt: row.finished_at ?? null, leaseExpiresAt: row.lease_expires_at ?? null,
    runnerId: row.runner_id ?? null, answer: row.answer ?? null, outputKind: row.output_kind ?? null,
    usage: parse(row.usage_json, {}), flags: parse(row.flags_json, {}), eval: parse(row.eval_json, null),
    parentRunId: row.parent_run_id ?? null, rootRunId: row.root_run_id ?? null, depth: row.depth ?? 0, threadId: row.thread_id ?? null,
  };

  function enqueueRun({ agentId, version, kind, trigger = {}, question = null, requestedBy = null, readRole, readAs = null, state = "queued", reason = null, evalInfo = null, parentRunId = null, rootRunId = null, depth = 0, threadId = null }) {
    const id = randomUUID();
    const at = iso();
    prepare(`INSERT INTO agent_runs (id, agent_id, version, kind, trigger_json, question, requested_by, read_role, read_as, state, reason, queued_at, finished_at, eval_json, parent_run_id, root_run_id, depth, thread_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, agentId, version, kind, json(trigger), question, requestedBy, readRole, readAs, state, reason, at, finishedStates.has(state) ? at : null, evalInfo ? json(evalInfo) : null, parentRunId, rootRunId ?? (parentRunId ? null : id), depth, threadId);
    if (!rootRunId && parentRunId) prepare("UPDATE agent_runs SET root_run_id = COALESCE((SELECT root_run_id FROM agent_runs WHERE id = ?), ?) WHERE id = ?").run(parentRunId, parentRunId, id);
    return getRun(id);
  }

  /** The runs a run handed work to, in the order they were made. */
  const listChildren = (runId) => prepare("SELECT * FROM agent_runs WHERE parent_run_id = ? ORDER BY queued_at, rowid LIMIT 20").all(runId).map(runOf);
  /** Every run under one root: an orchestrated request's whole tree, flat. */
  const listTree = (rootRunId) => prepare("SELECT * FROM agent_runs WHERE root_run_id = ? ORDER BY queued_at, rowid LIMIT 50").all(rootRunId).map(runOf);

  function getRun(id) {
    return runOf(prepare("SELECT * FROM agent_runs WHERE id = ?").get(String(id ?? "")));
  }

  function listRuns({ agentId = null, limit = 50, states = null, requestedBy = undefined } = {}) {
    const safe = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const clauses = [];
    const values = [];
    if (agentId) { clauses.push("agent_id = ?"); values.push(agentId); }
    if (states?.length) { clauses.push(`state IN (${states.map(() => "?").join(", ")})`); values.push(...states); }
    if (requestedBy !== undefined) { clauses.push("requested_by IS ?"); values.push(requestedBy); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return prepare(`SELECT * FROM agent_runs ${where} ORDER BY queued_at DESC, rowid DESC LIMIT ?`).all(...values, safe).map(runOf);
  }

  const activeRuns = () => prepare("SELECT * FROM agent_runs WHERE state IN ('queued', 'running') ORDER BY queued_at, rowid").all().map(runOf);

  /**
   * The next run to hand to the runner, or null. One at a time across the whole server: while any
   * run holds a live lease nothing else is handed out. `choose(queued)` picks among the queued
   * runs (the service's rules: paused agents, quiet hours, budgets); the lease is the runner's
   * proof that the run is still its own.
   */
  function claimNext({ runnerId, leaseMs, choose }) {
    return transaction(() => {
      const at = now();
      const busy = prepare("SELECT id FROM agent_runs WHERE state = 'running' AND lease_expires_at > ?").get(at.toISOString());
      if (busy) return null;
      const queued = prepare("SELECT * FROM agent_runs WHERE state = 'queued' ORDER BY queued_at, rowid LIMIT 100").all().map(runOf);
      const picked = choose(queued);
      if (!picked) return null;
      const lease = random(24).toString("base64url");
      const changed = prepare("UPDATE agent_runs SET state = 'running', started_at = ?, lease_hash = ?, lease_expires_at = ?, runner_id = ? WHERE id = ? AND state = 'queued'")
        .run(at.toISOString(), digestToken(lease), new Date(at.getTime() + leaseMs).toISOString(), runnerId, picked.id).changes;
      if (!Number(changed)) return null;
      return { run: getRun(picked.id), lease };
    });
  }

  /** Whether `lease` is the live lease of this running run. */
  function holdsLease(runId, lease) {
    const row = prepare("SELECT lease_hash, state FROM agent_runs WHERE id = ?").get(String(runId ?? ""));
    return Boolean(row && typeof lease === "string" && row.lease_hash === digestToken(lease));
  }

  function extendLease(runId, leaseMs) {
    prepare("UPDATE agent_runs SET lease_expires_at = ? WHERE id = ? AND state = 'running'").run(new Date(now().getTime() + leaseMs).toISOString(), runId);
  }

  /** Move a run to a finished state, once: a run that already finished stays as it ended. */
  function finishRun(runId, { state, reason = null, answer = null, outputKind = null, usage = null, flags = null, evalInfo = undefined }) {
    const row = prepare("SELECT usage_json, flags_json, eval_json FROM agent_runs WHERE id = ?").get(runId);
    if (!row) return null;
    const changed = prepare(`UPDATE agent_runs SET state = ?, reason = COALESCE(?, reason), answer = COALESCE(?, answer), output_kind = COALESCE(?, output_kind),
      usage_json = ?, flags_json = ?, eval_json = ?, finished_at = ?, lease_expires_at = NULL WHERE id = ? AND state IN ('queued', 'running')`)
      .run(state, reason, answer, outputKind, json({ ...parse(row.usage_json, {}), ...(usage ?? {}) }), json({ ...parse(row.flags_json, {}), ...(flags ?? {}) }), evalInfo === undefined ? row.eval_json : json(evalInfo), iso(), runId).changes;
    return Number(changed) ? getRun(runId) : null;
  }

  function mergeRunFlags(runId, flags) {
    const row = prepare("SELECT flags_json FROM agent_runs WHERE id = ?").get(runId);
    if (row) prepare("UPDATE agent_runs SET flags_json = ? WHERE id = ?").run(json({ ...parse(row.flags_json, {}), ...flags }), runId);
  }

  function setEvalInfo(runId, evalInfo) {
    prepare("UPDATE agent_runs SET eval_json = ? WHERE id = ?").run(json(evalInfo), runId);
  }

  function markAgentRan(agentId, at) {
    prepare("UPDATE agents SET last_run_at = ? WHERE id = ?").run(at, agentId);
  }

  /** Runs started today (since `since`) and the model time they used: what a budget counts. */
  function usageSince(agentId, since) {
    const rows = agentId === null
      ? prepare("SELECT usage_json FROM agent_runs WHERE started_at >= ?").all(since)
      : prepare("SELECT usage_json FROM agent_runs WHERE agent_id = ? AND started_at >= ?").all(agentId, since);
    let modelMs = 0; let tokens = 0;
    for (const row of rows) {
      const usage = parse(row.usage_json, {});
      modelMs += (Number(usage.modelMs) || 0) + (Number(usage.loadMs) || 0);
      tokens += (Number(usage.promptTokens) || 0) + (Number(usage.completionTokens) || 0);
    }
    return { runs: rows.length, modelMs, tokens };
  }

  // ---- steps ----

  const stepOf = (row) => ({
    seq: row.seq, kind: row.kind, name: row.name ?? null, state: row.state, input: parse(row.input_json, null), output: row.output ?? null,
    flags: parse(row.flags_json, {}), startedAt: row.started_at, durationMs: row.duration_ms ?? null, tokensIn: row.tokens_in ?? null, tokensOut: row.tokens_out ?? null,
  });

  function addStep(runId, { kind, name = null, state = "done", input = null, output = null, flags = {}, startedAt = null, durationMs = null, tokensIn = null, tokensOut = null }) {
    return transaction(() => {
      const seq = Number(prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_run_steps WHERE run_id = ?").get(runId).next);
      if (seq > 200) return null;
      prepare(`INSERT INTO agent_run_steps (run_id, seq, kind, name, state, input_json, output, flags_json, started_at, duration_ms, tokens_in, tokens_out)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, seq, kind, name, state, input === null ? null : json(input), output, json(flags), startedAt ?? iso(), durationMs, tokensIn, tokensOut);
      return stepOf(prepare("SELECT * FROM agent_run_steps WHERE run_id = ? AND seq = ?").get(runId, seq));
    });
  }

  const listSteps = (runId) => prepare("SELECT * FROM agent_run_steps WHERE run_id = ? ORDER BY seq").all(runId).map(stepOf);
  const countSteps = (runId, kind) => Number(prepare("SELECT COUNT(*) AS count FROM agent_run_steps WHERE run_id = ? AND kind = ?").get(runId, kind).count);

  // ---- notes ----

  const noteOf = (row) => ({
    id: row.id, agentId: row.agent_id, title: row.title, body: row.body, source: parse(row.source_json, {}), createdAt: row.created_at, updatedAt: row.updated_at, freshUntil: row.fresh_until ?? null,
    pinned: Boolean(row.pinned), shared: Boolean(row.shared), readRole: row.read_role ?? "owner",
  });

  /**
   * Keep a note: one with the same title is replaced, and the oldest unpinned ones go past
   * `maxNotes`. `readRole` is what the run that learned it could read: another agent sees a shared
   * note only if its own run may read as much.
   */
  function writeNote(agentId, { title, body, source = {}, freshUntil = null, maxNotes = 50, readRole = "owner", shared = false }) {
    return transaction(() => {
      const at = iso();
      const existing = prepare("SELECT id FROM agent_notes WHERE agent_id = ? AND lower(title) = lower(?)").get(agentId, title);
      const id = existing?.id ?? randomUUID();
      if (existing) prepare("UPDATE agent_notes SET body = ?, source_json = ?, updated_at = ?, fresh_until = ?, read_role = ?, shared = ? WHERE id = ?").run(body, json(source), at, freshUntil, readRole, shared ? 1 : 0, id);
      else prepare("INSERT INTO agent_notes (id, agent_id, title, body, source_json, created_at, updated_at, fresh_until, read_role, shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, agentId, title, body, json(source), at, at, freshUntil, readRole, shared ? 1 : 0);
      const dropped = prepare("SELECT id FROM agent_notes WHERE agent_id = ? AND pinned = 0 AND id NOT IN (SELECT id FROM agent_notes WHERE agent_id = ? ORDER BY pinned DESC, updated_at DESC, rowid DESC LIMIT ?)").all(agentId, agentId, maxNotes).map((entry) => entry.id);
      for (const gone of dropped) { prepare("DELETE FROM agent_notes WHERE id = ?").run(gone); prepare("DELETE FROM agent_vectors WHERE kind = 'note' AND item_id = ?").run(gone); }
      return noteOf(prepare("SELECT * FROM agent_notes WHERE id = ?").get(id));
    });
  }

  const listNotes = (agentId, { limit = 100 } = {}) => prepare("SELECT * FROM agent_notes WHERE agent_id = ? ORDER BY pinned DESC, updated_at DESC, rowid DESC LIMIT ?").all(agentId, Math.min(Math.max(limit, 1), 200)).map(noteOf);
  const getNote = (agentId, noteId) => { const row = prepare("SELECT * FROM agent_notes WHERE agent_id = ? AND id = ?").get(agentId, noteId); return row ? noteOf(row) : null; };
  /** Notes other agents shared, from agents that still exist. */
  const listSharedNotes = ({ exceptAgentId = null, limit = 200 } = {}) => prepare("SELECT n.* FROM agent_notes n JOIN agents a ON a.id = n.agent_id WHERE n.shared = 1 AND a.deleted_at IS NULL AND n.agent_id IS NOT ? ORDER BY n.updated_at DESC LIMIT ?").all(exceptAgentId, limit).map(noteOf);
  /** Forget: the note and its embedding go, overwritten on disk (secure_delete). */
  const deleteNote = (agentId, noteId) => transaction(() => {
    const changed = Number(prepare("DELETE FROM agent_notes WHERE agent_id = ? AND id = ?").run(agentId, noteId).changes) > 0;
    if (changed) prepare("DELETE FROM agent_vectors WHERE kind = 'note' AND item_id = ?").run(noteId);
    return changed;
  });
  /** The owner's edit of a note: its words, how long it stays fresh, pinned, shared. */
  function updateNote(agentId, noteId, { title, body, freshUntil, pinned, shared }) {
    return transaction(() => {
      const current = prepare("SELECT * FROM agent_notes WHERE agent_id = ? AND id = ?").get(agentId, noteId);
      if (!current) return null;
      prepare("UPDATE agent_notes SET title = ?, body = ?, fresh_until = ?, pinned = ?, shared = ?, updated_at = ? WHERE id = ?")
        .run(title ?? current.title, body ?? current.body, freshUntil === undefined ? current.fresh_until : freshUntil, pinned === undefined ? current.pinned : pinned ? 1 : 0, shared === undefined ? current.shared : shared ? 1 : 0, iso(), noteId);
      if (body !== undefined || title !== undefined) prepare("DELETE FROM agent_vectors WHERE kind = 'note' AND item_id = ?").run(noteId);
      return noteOf(prepare("SELECT * FROM agent_notes WHERE id = ?").get(noteId));
    });
  }

  // ---- conversations ----

  const threadOf = (row) => row && { id: row.id, agentId: row.agent_id, personId: row.person_id, summary: row.summary, turns: parse(row.turns_json, []), updatedAt: row.updated_at };
  const getThread = (agentId, personId) => threadOf(prepare("SELECT * FROM agent_threads WHERE agent_id = ? AND person_id = ?").get(agentId, personId));
  function saveThread(agentId, personId, { summary, turns }) {
    const at = iso();
    prepare(`INSERT INTO agent_threads (id, agent_id, person_id, summary, turns_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, person_id) DO UPDATE SET summary = excluded.summary, turns_json = excluded.turns_json, updated_at = excluded.updated_at`).run(randomUUID(), agentId, personId, summary, json(turns), at);
    return getThread(agentId, personId);
  }
  const deleteThread = (agentId, personId) => Number(prepare("DELETE FROM agent_threads WHERE agent_id = ? AND person_id = ?").run(agentId, personId).changes) > 0;

  // ---- episodes: what past runs found ----

  const episodeOf = (row) => ({ id: row.id, agentId: row.agent_id, runId: row.run_id ?? null, text: row.text, readRole: row.read_role, createdAt: row.created_at });
  function addEpisode({ agentId, runId, text, readRole, keep = 200 }) {
    return transaction(() => {
      const id = randomUUID();
      prepare("INSERT INTO agent_episodes (id, agent_id, run_id, text, read_role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, agentId, runId, text, readRole, iso());
      const dropped = prepare("SELECT id FROM agent_episodes WHERE agent_id = ? AND id NOT IN (SELECT id FROM agent_episodes WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)").all(agentId, agentId, keep).map((entry) => entry.id);
      for (const gone of dropped) { prepare("DELETE FROM agent_episodes WHERE id = ?").run(gone); prepare("DELETE FROM agent_vectors WHERE kind = 'episode' AND item_id = ?").run(gone); }
      return episodeOf(prepare("SELECT * FROM agent_episodes WHERE id = ?").get(id));
    });
  }
  const listEpisodes = (agentId, { limit = 100 } = {}) => prepare("SELECT * FROM agent_episodes WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(agentId, Math.min(Math.max(limit, 1), 200)).map(episodeOf);
  const deleteEpisode = (agentId, episodeId) => transaction(() => {
    const changed = Number(prepare("DELETE FROM agent_episodes WHERE agent_id = ? AND id = ?").run(agentId, episodeId).changes) > 0;
    if (changed) prepare("DELETE FROM agent_vectors WHERE kind = 'episode' AND item_id = ?").run(episodeId);
    return changed;
  });

  // ---- embeddings ----

  function setVector(kind, itemId, { model, vector, textHash }) {
    prepare(`INSERT INTO agent_vectors (kind, item_id, model, dims, vector, text_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, item_id) DO UPDATE SET model = excluded.model, dims = excluded.dims, vector = excluded.vector, text_hash = excluded.text_hash, updated_at = excluded.updated_at`)
      .run(kind, itemId, model, vector.byteLength / 4, vector, textHash, iso());
  }
  /** Every stored vector of these kinds: `${kind}:${id}` to { model, vector, textHash }. */
  function vectorsOf(kinds) {
    const rows = prepare(`SELECT kind, item_id, model, vector, text_hash FROM agent_vectors WHERE kind IN (${kinds.map(() => "?").join(", ")})`).all(...kinds);
    return new Map(rows.map((row) => [`${row.kind}:${row.item_id}`, { model: row.model, vector: row.vector, textHash: row.text_hash }]));
  }
  const deleteVector = (kind, itemId) => prepare("DELETE FROM agent_vectors WHERE kind = ? AND item_id = ?").run(kind, itemId);
  const deleteVectorsLike = (kind, prefix) => prepare("DELETE FROM agent_vectors WHERE kind = ? AND item_id LIKE ?").run(kind, `${prefix}%`);
  const countVectors = () => Number(prepare("SELECT COUNT(*) AS count FROM agent_vectors").get().count);

  // ---- feedback ----

  function setFeedback(runId, { agentId, version, model = null, verdict, note = null, givenBy }) {
    prepare(`INSERT INTO agent_feedback (run_id, agent_id, version, model, verdict, note, given_by, given_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, given_by = excluded.given_by, given_at = excluded.given_at`).run(runId, agentId, version, model, verdict, note, givenBy, iso());
    return getFeedback(runId);
  }
  const feedbackOf = (row) => row && { runId: row.run_id, agentId: row.agent_id, version: row.version, model: row.model ?? null, verdict: row.verdict, note: row.note ?? null, givenBy: row.given_by ?? null, givenAt: row.given_at };
  const getFeedback = (runId) => feedbackOf(prepare("SELECT * FROM agent_feedback WHERE run_id = ?").get(String(runId ?? "")));
  const listFeedback = (agentId, { limit = 500 } = {}) => prepare("SELECT * FROM agent_feedback WHERE agent_id = ? ORDER BY given_at DESC LIMIT ?").all(agentId, limit).map(feedbackOf);

  // ---- proposals ----

  const proposalOf = (row) => row && {
    id: row.id, agentId: row.agent_id ?? null, runId: row.run_id ?? null, source: row.source, title: row.title, reason: row.reason ?? "",
    steps: parse(row.steps_json, []), dropped: parse(row.dropped_json, []), flags: parse(row.flags_json, {}), state: row.state, forRole: row.for_role,
    requestedBy: row.requested_by ?? null, createdAt: row.created_at, expiresAt: row.expires_at, decidedBy: row.decided_by ?? null, decidedAt: row.decided_at ?? null, jobIds: parse(row.job_ids_json, []),
    kind: row.kind ?? "plan", question: row.question ?? null,
  };

  /**
   * A card. `kind`: plan (steps to stage), question (the agent asks before guessing), or
   * escalation (it hands something to the owner: low confidence, a limit, a risk).
   */
  function createProposal({ agentId = null, runId = null, source = "agent", kind = "plan", title, reason = "", question = null, steps = [], dropped = [], flags = {}, forRole, requestedBy = null, expiresAt }) {
    const id = randomUUID();
    prepare(`INSERT INTO agent_proposals (id, agent_id, run_id, source, kind, title, reason, question, steps_json, dropped_json, flags_json, state, for_role, requested_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`).run(id, agentId, runId, source, kind, title, reason, question, json(steps), json(dropped), json(flags), forRole, requestedBy, iso(), expiresAt);
    return getProposal(id);
  }

  const getProposal = (id) => proposalOf(prepare("SELECT * FROM agent_proposals WHERE id = ?").get(String(id ?? "")));
  const listProposals = ({ states = ["open"], limit = 50 } = {}) => prepare(`SELECT * FROM agent_proposals WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...states, Math.min(Math.max(limit, 1), 200)).map(proposalOf);

  function decideProposal(id, { state, decidedBy, jobIds = [] }) {
    const changed = prepare("UPDATE agent_proposals SET state = ?, decided_by = ?, decided_at = ?, job_ids_json = ? WHERE id = ? AND state = 'open'").run(state, decidedBy, iso(), json(jobIds), id).changes;
    return Number(changed) ? getProposal(id) : null;
  }

  const findOpenProposal = (source, title) => proposalOf(prepare("SELECT * FROM agent_proposals WHERE source = ? AND title = ? AND state = 'open'").get(source, title));
  const listProposalsForRun = (runId) => prepare("SELECT * FROM agent_proposals WHERE run_id = ? ORDER BY created_at, rowid LIMIT 10").all(runId).map(proposalOf);

  // ---- documents ----

  const documentOf = (row) => ({
    id: row.id, title: row.title, text: row.text, enabled: Boolean(row.enabled), createdBy: row.created_by, createdAt: row.created_at, characters: row.text.length,
    source: row.source ?? "upload", externalId: row.external_id ?? null, pinned: Boolean(row.pinned),
  });

  /** A document: pasted or uploaded by the owner, or brought in by a connector (source, externalId). */
  function addDocument({ title, text, createdBy, source = "upload", externalId = null, pinned = false }) {
    const id = randomUUID();
    prepare("INSERT INTO agent_documents (id, title, text, created_by, created_at, source, external_id, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, title, text, createdBy, iso(), source, externalId, pinned ? 1 : 0);
    return documentOf(prepare("SELECT * FROM agent_documents WHERE id = ?").get(id));
  }
  /** A connector's document: replaced when it changed, added when new. Returns { document, changed }. */
  function upsertDocument({ source, externalId, title, text, createdBy = null }) {
    return transaction(() => {
      const current = prepare("SELECT * FROM agent_documents WHERE source = ? AND external_id = ?").get(source, externalId);
      if (!current) return { document: addDocument({ title, text, createdBy, source, externalId }), changed: true };
      if (current.text === text && current.title === title) return { document: documentOf(current), changed: false };
      prepare("UPDATE agent_documents SET title = ?, text = ?, created_at = ? WHERE id = ?").run(title, text, iso(), current.id);
      prepare("DELETE FROM agent_vectors WHERE kind = 'doc' AND item_id LIKE ?").run(`${current.id}#%`);
      return { document: documentOf(prepare("SELECT * FROM agent_documents WHERE id = ?").get(current.id)), changed: true };
    });
  }
  const listDocuments = () => prepare("SELECT * FROM agent_documents ORDER BY created_at DESC LIMIT 500").all().map(documentOf);
  const getDocument = (id) => { const row = prepare("SELECT * FROM agent_documents WHERE id = ?").get(String(id ?? "")); return row ? documentOf(row) : null; };
  const findDocument = (title) => { const row = prepare("SELECT * FROM agent_documents WHERE enabled = 1 AND lower(title) = lower(?) ORDER BY created_at DESC").get(String(title ?? "")); return row ? documentOf(row) : null; };
  const setDocumentEnabled = (id, enabled) => Number(prepare("UPDATE agent_documents SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes) > 0;
  const setDocumentPinned = (id, pinned) => Number(prepare("UPDATE agent_documents SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id).changes) > 0;
  const deleteDocument = (id) => transaction(() => {
    const changed = Number(prepare("DELETE FROM agent_documents WHERE id = ?").run(id).changes) > 0;
    if (changed) prepare("DELETE FROM agent_vectors WHERE kind = 'doc' AND item_id LIKE ?").run(`${id}#%`);
    return changed;
  });

  // ---- evaluation ----

  function setQuestions(agentId, questions, { updatedBy = null } = {}) {
    prepare("INSERT INTO agent_evals (agent_id, questions_json, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET questions_json = excluded.questions_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .run(agentId, json(questions), updatedBy, iso());
  }
  const getQuestions = (agentId) => { const row = prepare("SELECT questions_json FROM agent_evals WHERE agent_id = ?").get(agentId); return row ? parse(row.questions_json, []) : null; };

  const evalRunOf = (row) => row && { id: row.id, agentId: row.agent_id, version: row.version, model: row.model ?? null, state: row.state, results: parse(row.results_json, []), score: row.score ?? null, createdBy: row.created_by, createdAt: row.created_at, finishedAt: row.finished_at ?? null };
  /** An evaluation, tied to the agent's version and the model in use, so accuracy can be followed over both. */
  function createEvalRun({ agentId, version, results, createdBy, model = null }) {
    const id = randomUUID();
    prepare("INSERT INTO agent_eval_runs (id, agent_id, version, model, state, results_json, created_by, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)").run(id, agentId, version, model, json(results), createdBy, iso());
    return getEvalRun(id);
  }
  const getEvalRun = (id) => evalRunOf(prepare("SELECT * FROM agent_eval_runs WHERE id = ?").get(id));
  const setEvalResults = (id, results) => prepare("UPDATE agent_eval_runs SET results_json = ? WHERE id = ?").run(json(results), id);
  const listEvalRuns = (agentId, limit = 10) => prepare("SELECT * FROM agent_eval_runs WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(agentId, limit).map(evalRunOf);

  /** Record one question's grade; when none is left pending, the evaluation is done and scored. */
  function gradeEval(evalId, questionId, grade) {
    return transaction(() => {
      const current = getEvalRun(evalId);
      if (!current) return null;
      const results = current.results.map((entry) => (entry.questionId === questionId ? { ...entry, ...grade } : entry));
      const pending = results.some((entry) => entry.passed === null);
      const score = pending ? null : results.length ? results.filter((entry) => entry.passed).length / results.length : 0;
      prepare("UPDATE agent_eval_runs SET results_json = ?, state = ?, score = ?, finished_at = ? WHERE id = ?").run(json(results), pending ? "running" : "done", score, pending ? null : iso(), evalId);
      return getEvalRun(evalId);
    });
  }

  // ---- housekeeping ----

  /**
   * Keep what the pages show: finished runs from the last 30 days beyond the newest 500 (their
   * steps go with them), decided or expired proposals after 30 days, finished evaluations beyond
   * the newest 20 per agent.
   */
  function prune({ keepRuns = 500, runDays = 30, at = now() } = {}) {
    const cutoff = new Date(at.getTime() - runDays * 86_400_000).toISOString();
    const runs = prepare(`DELETE FROM agent_runs WHERE state NOT IN ('queued', 'running') AND queued_at < ? AND id NOT IN (SELECT id FROM agent_runs ORDER BY queued_at DESC, rowid DESC LIMIT ?)`).run(cutoff, keepRuns).changes;
    const proposals = prepare("DELETE FROM agent_proposals WHERE state != 'open' AND created_at < ?").run(cutoff).changes;
    const evals = prepare("DELETE FROM agent_eval_runs WHERE state = 'done' AND id NOT IN (SELECT id FROM agent_eval_runs e WHERE e.agent_id = agent_eval_runs.agent_id ORDER BY created_at DESC LIMIT 20)").run().changes;
    return { runs: Number(runs), proposals: Number(proposals), evals: Number(evals) };
  }

  function expireProposals(at = now()) {
    return Number(prepare("UPDATE agent_proposals SET state = 'expired' WHERE state = 'open' AND expires_at <= ?").run(at.toISOString()).changes);
  }

  return {
    databasePath, transaction,
    createAgent, getAgent, listAgents, getVersion, listVersions, addVersion, setPaused, setNextRun, noteEvent, deleteAgent, setWebhook,
    enqueueRun, getRun, listRuns, listChildren, listTree, activeRuns, claimNext, holdsLease, extendLease, finishRun, mergeRunFlags, setEvalInfo, markAgentRan, usageSince,
    addStep, listSteps, countSteps,
    writeNote, listNotes, getNote, listSharedNotes, deleteNote, updateNote,
    getThread, saveThread, deleteThread,
    addEpisode, listEpisodes, deleteEpisode,
    setVector, vectorsOf, deleteVector, deleteVectorsLike, countVectors,
    setFeedback, getFeedback, listFeedback,
    createProposal, getProposal, listProposals, decideProposal, findOpenProposal, listProposalsForRun,
    addDocument, upsertDocument, listDocuments, getDocument, findDocument, setDocumentEnabled, setDocumentPinned, deleteDocument,
    setQuestions, getQuestions, createEvalRun, getEvalRun, setEvalResults, listEvalRuns, gradeEval,
    prune, expireProposals,
    close: () => database.close(),
  };
}
