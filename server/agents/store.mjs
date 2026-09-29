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
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
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
  `);

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
    return Number(prepare("UPDATE agents SET deleted_at = ?, next_run_at = NULL WHERE id = ? AND deleted_at IS NULL").run(iso(), agentId).changes) > 0;
  }

  // ---- runs ----

  const runOf = (row) => row && {
    id: row.id, agentId: row.agent_id, version: row.version, kind: row.kind, trigger: parse(row.trigger_json, {}), question: row.question ?? null,
    requestedBy: row.requested_by ?? null, readRole: row.read_role, readAs: row.read_as ?? null, state: row.state, reason: row.reason ?? null,
    queuedAt: row.queued_at, startedAt: row.started_at ?? null, finishedAt: row.finished_at ?? null, leaseExpiresAt: row.lease_expires_at ?? null,
    runnerId: row.runner_id ?? null, answer: row.answer ?? null, outputKind: row.output_kind ?? null,
    usage: parse(row.usage_json, {}), flags: parse(row.flags_json, {}), eval: parse(row.eval_json, null),
  };

  function enqueueRun({ agentId, version, kind, trigger = {}, question = null, requestedBy = null, readRole, readAs = null, state = "queued", reason = null, evalInfo = null }) {
    const id = randomUUID();
    const at = iso();
    prepare(`INSERT INTO agent_runs (id, agent_id, version, kind, trigger_json, question, requested_by, read_role, read_as, state, reason, queued_at, finished_at, eval_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, agentId, version, kind, json(trigger), question, requestedBy, readRole, readAs, state, reason, at, finishedStates.has(state) ? at : null, evalInfo ? json(evalInfo) : null);
    return getRun(id);
  }

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
    const rows = prepare("SELECT usage_json FROM agent_runs WHERE agent_id = ? AND started_at >= ?").all(agentId, since);
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

  const noteOf = (row) => ({ id: row.id, agentId: row.agent_id, title: row.title, body: row.body, source: parse(row.source_json, {}), createdAt: row.created_at, updatedAt: row.updated_at, freshUntil: row.fresh_until ?? null });

  /** Keep a note: one with the same title is replaced, and the oldest go past `maxNotes`. */
  function writeNote(agentId, { title, body, source = {}, freshUntil = null, maxNotes = 50 }) {
    return transaction(() => {
      const at = iso();
      const existing = prepare("SELECT id FROM agent_notes WHERE agent_id = ? AND lower(title) = lower(?)").get(agentId, title);
      const id = existing?.id ?? randomUUID();
      if (existing) prepare("UPDATE agent_notes SET body = ?, source_json = ?, updated_at = ?, fresh_until = ? WHERE id = ?").run(body, json(source), at, freshUntil, id);
      else prepare("INSERT INTO agent_notes (id, agent_id, title, body, source_json, created_at, updated_at, fresh_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, agentId, title, body, json(source), at, at, freshUntil);
      prepare("DELETE FROM agent_notes WHERE agent_id = ? AND id NOT IN (SELECT id FROM agent_notes WHERE agent_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)").run(agentId, agentId, maxNotes);
      return noteOf(prepare("SELECT * FROM agent_notes WHERE id = ?").get(id));
    });
  }

  const listNotes = (agentId, { limit = 100 } = {}) => prepare("SELECT * FROM agent_notes WHERE agent_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(agentId, Math.min(Math.max(limit, 1), 200)).map(noteOf);
  const deleteNote = (agentId, noteId) => Number(prepare("DELETE FROM agent_notes WHERE agent_id = ? AND id = ?").run(agentId, noteId).changes) > 0;

  // ---- proposals ----

  const proposalOf = (row) => row && {
    id: row.id, agentId: row.agent_id ?? null, runId: row.run_id ?? null, source: row.source, title: row.title, reason: row.reason ?? "",
    steps: parse(row.steps_json, []), dropped: parse(row.dropped_json, []), flags: parse(row.flags_json, {}), state: row.state, forRole: row.for_role,
    requestedBy: row.requested_by ?? null, createdAt: row.created_at, expiresAt: row.expires_at, decidedBy: row.decided_by ?? null, decidedAt: row.decided_at ?? null, jobIds: parse(row.job_ids_json, []),
  };

  function createProposal({ agentId = null, runId = null, source = "agent", title, reason = "", steps, dropped = [], flags = {}, forRole, requestedBy = null, expiresAt }) {
    const id = randomUUID();
    prepare(`INSERT INTO agent_proposals (id, agent_id, run_id, source, title, reason, steps_json, dropped_json, flags_json, state, for_role, requested_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`).run(id, agentId, runId, source, title, reason, json(steps), json(dropped), json(flags), forRole, requestedBy, iso(), expiresAt);
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

  const documentOf = (row) => ({ id: row.id, title: row.title, text: row.text, enabled: Boolean(row.enabled), createdBy: row.created_by, createdAt: row.created_at, characters: row.text.length });

  function addDocument({ title, text, createdBy }) {
    const id = randomUUID();
    prepare("INSERT INTO agent_documents (id, title, text, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(id, title, text, createdBy, iso());
    return documentOf(prepare("SELECT * FROM agent_documents WHERE id = ?").get(id));
  }
  const listDocuments = () => prepare("SELECT * FROM agent_documents ORDER BY created_at DESC LIMIT 200").all().map(documentOf);
  const setDocumentEnabled = (id, enabled) => Number(prepare("UPDATE agent_documents SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes) > 0;
  const deleteDocument = (id) => Number(prepare("DELETE FROM agent_documents WHERE id = ?").run(id).changes) > 0;

  // ---- evaluation ----

  function setQuestions(agentId, questions, { updatedBy = null } = {}) {
    prepare("INSERT INTO agent_evals (agent_id, questions_json, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET questions_json = excluded.questions_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .run(agentId, json(questions), updatedBy, iso());
  }
  const getQuestions = (agentId) => { const row = prepare("SELECT questions_json FROM agent_evals WHERE agent_id = ?").get(agentId); return row ? parse(row.questions_json, []) : null; };

  const evalRunOf = (row) => row && { id: row.id, agentId: row.agent_id, version: row.version, state: row.state, results: parse(row.results_json, []), score: row.score ?? null, createdBy: row.created_by, createdAt: row.created_at, finishedAt: row.finished_at ?? null };
  function createEvalRun({ agentId, version, results, createdBy }) {
    const id = randomUUID();
    prepare("INSERT INTO agent_eval_runs (id, agent_id, version, state, results_json, created_by, created_at) VALUES (?, ?, ?, 'running', ?, ?, ?)").run(id, agentId, version, json(results), createdBy, iso());
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
    createAgent, getAgent, listAgents, getVersion, listVersions, addVersion, setPaused, setNextRun, noteEvent, deleteAgent,
    enqueueRun, getRun, listRuns, activeRuns, claimNext, holdsLease, extendLease, finishRun, mergeRunFlags, setEvalInfo, markAgentRan, usageSince,
    addStep, listSteps, countSteps,
    writeNote, listNotes, deleteNote,
    createProposal, getProposal, listProposals, decideProposal, findOpenProposal, listProposalsForRun,
    addDocument, listDocuments, setDocumentEnabled, deleteDocument,
    setQuestions, getQuestions, createEvalRun, getEvalRun, setEvalResults, listEvalRuns, gradeEval,
    prune, expireProposals,
    close: () => database.close(),
  };
}
