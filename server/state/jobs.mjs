import { randomUUID } from "node:crypto";
import { digest, iso, json, parseJson } from "./shared.mjs";

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
    // M30.3: a job that ran out of time says so here (server/timeouts.mjs has the shape).
    timeout: row.timeout_json ? parseJson(row.timeout_json, null) : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    steps,
    approvals,
  };
}

/** @param {import("./shared.mjs").StateContext & { recordAudit: import("./shared.mjs").RecordAudit, deleteExpiredSessions: ReturnType<typeof import("./people.mjs").createPeopleStore>["deleteExpiredSessions"] }} context */
export function createJobStore({ database, now, timestamp, recordAudit, deleteExpiredSessions }) {
  function saveJobOutput(jobId, output) {
    database.prepare("INSERT INTO job_output (job_id, output, created_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET output = excluded.output, created_at = excluded.created_at").run(jobId, String(output ?? "").slice(-2 * 1024 * 1024), timestamp());
  }

  function getJobOutput(jobId) {
    const row = database.prepare("SELECT output FROM job_output WHERE job_id = ?").get(jobId);
    return row ? row.output : null;
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

  /**
   * Housekeeping, run daily. Every row class that grows with use is bounded here — a home server
   * runs for years untouched, and a table nothing ever deletes from ends up inside every controller
   * backup as well as on disk.
   */
  function pruneHistory({ keepJobs = 500, jobDays = 90, keepAudit = 20_000, staleJobDays = 30, now = timestamp() } = {}) {
    const cutoff = new Date(Date.parse(now) - jobDays * 86_400_000).toISOString();
    const removedJobs = database.prepare("DELETE FROM jobs WHERE state IN ('completed', 'failed', 'cancelled') AND created_at < ? AND id NOT IN (SELECT id FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?)").run(cutoff, keepJobs).changes;
    const removedAudit = database.prepare("DELETE FROM audit_events WHERE id NOT IN (SELECT id FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?)").run(keepAudit).changes;
    // A job nobody approved is abandoned, not pending: the staged parameters it refers to live in
    // memory and did not survive the restart that left it here.
    const staleCutoff = new Date(Date.parse(now) - staleJobDays * 86_400_000).toISOString();
    const removedAbandoned = database.prepare("DELETE FROM jobs WHERE state = 'awaiting_approval' AND created_at < ?").run(staleCutoff).changes;
    const removedSessions = deleteExpiredSessions();
    // Plans carry the inputs and outputs of a preview and expire in half an hour.
    const removedPlans = database.prepare("DELETE FROM plans WHERE expires_at <= ?").run(now).changes;
    return { removedJobs, removedAudit, removedAbandoned, removedSessions, removedPlans };
  }

  function transitionJob(jobId, fromStates, state, { result = undefined, error = undefined, timeout = undefined } = {}) {
    const allowed = Array.isArray(fromStates) ? fromStates : [fromStates];
    const placeholders = allowed.map(() => "?").join(", ");
    const current = database.prepare(`SELECT state FROM jobs WHERE id = ? AND state IN (${placeholders})`).get(jobId, ...allowed);
    if (!current) throw new Error("Job is not in an allowed state");
    // COALESCE, not overwrite: a job that succeeded on the host and then failed its evidence check
    // would otherwise lose the artifact path and checksum the earlier transition recorded.
    database.prepare("UPDATE jobs SET state = ?, result_json = COALESCE(?, result_json), error = COALESCE(?, error), timeout_json = COALESCE(?, timeout_json), updated_at = ? WHERE id = ?")
      .run(state, result === undefined ? null : json(result), error ?? null, timeout ? json(timeout) : null, timestamp(), jobId);
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

  /**
   * Turn job rows into full jobs with three queries in total, rather than three per job. The jobs
   * list is polled while any job runs, and `?limit=200` used to mean 601 statements per request.
   */
  function hydrateJobs(rows) {
    if (!rows.length) return [];
    const placeholders = rows.map(() => "?").join(", ");
    const ids = rows.map((row) => row.id);
    const stepsByJob = new Map(ids.map((id) => [id, []]));
    const approvalsByJob = new Map(ids.map((id) => [id, []]));
    for (const step of database.prepare(`SELECT job_id AS jobId, name, state, detail, created_at AS createdAt FROM job_steps WHERE job_id IN (${placeholders}) ORDER BY created_at`).all(...ids)) {
      stepsByJob.get(step.jobId)?.push({ name: step.name, state: step.state, detail: step.detail, createdAt: step.createdAt });
    }
    for (const approval of database.prepare(`SELECT job_id AS jobId, owner_id AS ownerId, method, tier, created_at AS createdAt FROM approvals WHERE job_id IN (${placeholders}) ORDER BY created_at`).all(...ids)) {
      approvalsByJob.get(approval.jobId)?.push({ ownerId: approval.ownerId, method: approval.method, tier: approval.tier, createdAt: approval.createdAt });
    }
    return rows.map((row) => normalizeJob(row, stepsByJob.get(row.id) ?? [], approvalsByJob.get(row.id) ?? []));
  }

  /** Recent jobs, newest first. `createdBy` limits the list to one account (non-owners see only their own). */
  function listJobs(limit = 50, { createdBy = null } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 200);
    const rows = createdBy
      ? database.prepare("SELECT * FROM jobs WHERE created_by = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(createdBy, safeLimit)
      : database.prepare("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(safeLimit);
    return hydrateJobs(rows);
  }

  function listActiveJobs() {
    return hydrateJobs(database.prepare("SELECT * FROM jobs WHERE state IN ('applying', 'verifying') ORDER BY created_at").all());
  }

  /** Every job still waiting for someone to approve it, oldest first (M36: stale approvals). */
  function listAwaitingApproval() {
    return hydrateJobs(database.prepare("SELECT * FROM jobs WHERE state = 'awaiting_approval' ORDER BY created_at").all());
  }

  function recoverInterruptedJobs() {
    /** @type {Array<Record<string, any>>} */
    const interrupted = database.prepare("SELECT id, title, state FROM jobs WHERE state IN ('applying', 'verifying')").all();
    if (!interrupted.length) return [];
    // A job whose last word from the helper was that it waited behind earlier work never began: the
    // helper starts nothing queued once it is stopping, and the web side, stopped first in a restart
    // of both, never heard the refusal. Said as never started, and free to run again (job-reruns.mjs).
    const lastQueueStep = database.prepare("SELECT state FROM job_steps WHERE job_id = ? AND name = 'queue' ORDER BY created_at DESC, rowid DESC LIMIT 1");
    for (const job of interrupted) job.neverStarted = job.state === "applying" && lastQueueStep.get(job.id)?.state === "waiting";
    // One transaction: a crash during startup recovery would otherwise leave some jobs marked
    // failed with no step saying why.
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const { id, state, neverStarted } of interrupted) {
        database.prepare("UPDATE jobs SET state = 'failed', error = ?, updated_at = ? WHERE id = ?")
          .run(neverStarted
            ? "BoxPilot restarted before this job began, while it waited for earlier work on the server, so nothing was changed. It can be run again as it is."
            : "BoxPilot restarted while this job was running. The operation itself may still have finished on its own; check what it changed before retrying.", timestamp(), id);
        // A failed job leaves no step running: the one it was in ends here, cut off.
        addJobStep(id, state === "verifying" ? "verify" : "apply", "failed", neverStarted ? "Never started: BoxPilot restarted while it waited for earlier work" : "Cut off when BoxPilot restarted");
        // Whether it runs again is decided after this, from the registry (server/job-reruns.mjs).
        addJobStep(id, "recovery", "required", neverStarted ? "BoxPilot restarted before the operation began; nothing was changed" : "The operation was interrupted by a BoxPilot restart");
      }
      database.exec("COMMIT");
    } catch (error) {
      // If BEGIN itself failed there is no transaction of ours to roll back, and rolling one back
      // would report the wrong error — or discard somebody else's.
      try { database.exec("ROLLBACK"); } catch { /* nothing of ours was open */ }
      throw error;
    }
    // The callers used to get a count. The jobs themselves are what a notification needs.
    return interrupted;
  }

  return {
    saveJobOutput,
    getJobOutput,
    subscribeJobs,
    emitJobChanged,
    createJob,
    createPlan,
    getPlan,
    addJobStep,
    addApproval,
    transitionJob,
    getJob,
    listJobs,
    pruneHistory,
    listActiveJobs,
    listAwaitingApproval,
    recoverInterruptedJobs,
  };
}
