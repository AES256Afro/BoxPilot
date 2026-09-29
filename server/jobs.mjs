import { verifyPassword } from "./security.mjs";
import { defaultThrottle as throttle } from "./login-throttle.mjs";
import { approvalRequirement, defaultApprovalMode, elevationTtlMs, normalizeApprovalMode } from "./ops/risk.mjs";
import { registry } from "./ops/index.mjs";
import { budgetFor, nextBudgetMs, placeholderPaths, restoreSecrets, secretPaths, secretPlaceholder, splitSecrets } from "./ops/registry.mjs";
import { asSentence } from "./health-alerts.mjs";
import { formatDuration, jobTimeoutRecord, timeoutMessage, timeoutOf } from "./timeouts.mjs";
import { productVersion } from "./version.mjs";

/** What a secret parameter looks like in the database and the job API. */
export { secretPlaceholder };
export const stagedSecretTtlMs = 30 * 60_000;
/**
 * How long a staged job may wait for an approval nobody gives (M36). Past this it is cancelled, with
 * a notice: a job staged three weeks ago was staged against a server that has moved on since.
 */
export const approvalMaxAgeMs = 7 * 24 * 60 * 60_000;
/** A failed job someone has looked at and let go: it stays in Activity and stops asking for attention. */
export const dismissed = (job) => (job?.steps ?? []).some((step) => step.name === "dismissed" && step.state === "completed");
/** A job that ran but whose result BoxPilot could not save; it carries a failed "record" step. */
export const recordFailed = (job) => (job?.steps ?? []).some((step) => step.name === "record" && step.state === "failed");

/** The job-log step for a timeout: which limit ran out, and how long the job had run by then. */
function timeoutStep(timeout) {
  if (timeout.phase === "queued") return `Waited ${formatDuration(timeout.elapsedMs)} behind other work and never started`;
  if (timeout.scope === "operation") return `Used its whole ${formatDuration(timeout.budgetMs)}; BoxPilot stopped waiting after ${formatDuration(timeout.elapsedMs)}`;
  return `${timeout.step ?? "One step"} ran out of its ${formatDuration(timeout.budgetMs)}; the job had run for ${formatDuration(timeout.elapsedMs)}`;
}

/**
 * The health-alert condition for a job log BoxPilot could not open (M30.1). One for the server,
 * whichever job hit it: the helper writes every log the same way, so one it cannot read is rarely
 * alone, and the owner needs one push, not one per job.
 */
export const jobLogAlertKey = "joblog.unreadable";
/** A job whose log was written but could not be read; it carries a failed "log" step. */
export const logUnreadable = (job) => (job?.steps ?? []).some((step) => step.name === "log" && step.state === "failed");

/** What stood in the way, as the end of a sentence: "permission denied (the log folder is mode 700)". */
function unreadableReason(status) {
  const reason = status?.code === "EACCES" || status?.code === "EPERM" ? "permission denied"
    : status?.code === "ENOTFILE" ? "it is not a file" : `error ${status?.code ?? "unknown"}`;
  const blocking = status?.blocking;
  return blocking && Number.isInteger(blocking.mode) ? `${reason} (the log ${blocking.what} is mode ${blocking.mode.toString(8)})` : reason;
}

/** One condition per operation and subject: a nightly backup that cannot record is one alert, not one a night. */
function recordAlertKey(job) {
  const subject = job.parameters?.id ?? job.parameters?.name ?? null;
  return `record.failed:${job.type.slice(3)}${typeof subject === "string" && subject ? `:${subject.slice(0, 64)}` : ""}`;
}

export function createJobService(store, helper, {
  // Which of an app's environment values are secrets, from its manifest (catalog/index.mjs
  // secretEnvNamesLookup). An app's password or API token arrives nested inside values.env, where
  // only the manifest can say which entry it is; secretPaths asks this for it.
  secretEnvNamesFor = async () => [],
  jobLog = null,
  operationRecordHooks = {},
  operationPrepareHooks = {},
  onOperationSettled = () => {},
  // The health-alert ledger (raise/clear). A result that could not be saved is announced through it.
  alerts = null,
  now = () => Date.now(),
  secretTtlMs = stagedSecretTtlMs,
  approvalMaxAge = approvalMaxAgeMs,
  version = productVersion,
} = {}) {
  // Announcing never holds up or fails the job: the ledger may wait on a notification target.
  const tell = (call) => { try { Promise.resolve(call()).catch(() => {}); } catch { /* the job's outcome stands */ } };

  /**
   * Registry ops with durable evidence record it web-side, and a failed record fails the job. The
   * operation itself did run, so the job says which half failed, and the owner hears about it once
   * per operation until a later run records cleanly - with or without a notification target.
   */
  async function recordResult(job, result) {
    const hook = operationRecordHooks[job.type.slice(3)];
    if (!hook) return;
    try {
      await hook(job, result);
    } catch (error) {
      store.addJobStep(job.id, "record", "failed", `The operation ran, but BoxPilot could not save its result: ${error.message}`.slice(0, 500));
      const subject = job.parameters?.id ?? job.parameters?.name ?? null;
      const label = `${job.title}${typeof subject === "string" && subject ? ` (${subject})` : ""}`;
      if (alerts) tell(() => alerts.raise({ key: recordAlertKey(job), title: `Result not saved: ${label}`, message: `${label} ran, but BoxPilot could not save what it did: ${asSentence(error.message)} Pages that show it may be out of date until it runs again. The job log is in Activity.`, priority: "high" }));
      throw error;
    }
    if (alerts) tell(() => alerts.clear(recordAlertKey(job)));
  }
  // Secret parameters (share passwords) staged with a job live here until it runs; they are
  // never written to SQLite or the job log. A restart forgets them and the job must be re-staged.
  const stagedSecrets = new Map();

  /**
   * Decide how a job must be approved for this session (ADR-001 risk tiers).
   * Pure with respect to the store except reading the approval-mode setting.
   */
  function approvalPolicy(job, session = null) {
    const mode = normalizeApprovalMode(store.getSetting?.("approvalMode", null) ?? process.env.BOXPILOT_APPROVAL_MODE ?? defaultApprovalMode);
    const registered = job.type.startsWith("op:") ? registry.get(job.type.slice(3)) : null;
    let confirmText = null;
    try { confirmText = registered?.confirm ? registered.confirm(job.parameters ?? {}) ?? null : null; } catch { confirmText = null; }
    const expiresAt = job.recovery?.approvalExpiresAt ?? null;
    const expired = Boolean(expiresAt && Date.parse(expiresAt) <= now());
    return { expiresAt, expired, minimumRole: registered?.minimumRole ?? null, confirmText: typeof confirmText === "string" && confirmText ? confirmText : null, mode, ...approvalRequirement({ jobType: job.type, mode, elevatedUntil: session?.elevatedUntil ?? null, now: () => new Date(now()) }) };
  }

  /**
   * @param {string} jobId
   * @param {string} ownerId
   * @param {string | { password?: string, session?: { tokenHash?: string, elevatedUntil?: string | null } }} approval
   *   A bare string is treated as a password (legacy callers).
   */
  async function prepareApproval(jobId, ownerId, approval = {}) {
    const { password = null, session = null, confirmText = null } = typeof approval === "string" ? { password: approval } : approval ?? {};
    const owner = store.findOwnerById(ownerId);
    if (!owner) throw Object.assign(new Error("Wrong password"), { code: "wrong_password" });
    const passwordProvided = typeof password === "string" && password.length > 0;
    if (passwordProvided) {
      const gate = throttle.check([`user:${owner.id}`]);
      if (gate.blocked) throw Object.assign(new Error(`Too many wrong passwords. Try again in ${Math.ceil(gate.retryAfterMs / 1000)} s`), { code: "wrong_password" });
      const ok = await verifyPassword(password, owner.passwordHash);
      throttle.record([`user:${owner.id}`], ok);
      if (!ok) throw Object.assign(new Error("Wrong password"), { code: "wrong_password" });
    }
    const job = store.getJob(jobId);
    if (!job) throw new Error("Job not found");
    const approverRole = session?.owner?.role ?? owner.role ?? "owner";
    if (job.createdBy !== ownerId && approverRole !== "owner") throw new Error("Job not found");
    const policy = approvalPolicy(job, session);
    if (policy.expired) {
      expireSecretJob(job);
      throw Object.assign(new Error("This approval expired after 30 minutes. Close it and stage the operation again with its credentials."), { code: "approval_expired" });
    }
    if (policy.passwordRequired && !passwordProvided) throw Object.assign(new Error(`Enter the owner password: ${policy.tier}-risk job needs the owner password`), { code: "password_required" });
    let elevatedUntil = session?.elevatedUntil ?? null;
    if (passwordProvided && session?.tokenHash && typeof store.elevateSession === "function") {
      elevatedUntil = store.elevateSession(session.tokenHash, new Date(now() + elevationTtlMs)) ?? elevatedUntil;
    }
    const role = session?.owner?.role ?? owner.role ?? "owner";
    if (role === "viewer" || role === "disabled") throw new Error("Viewers cannot approve jobs");
    if (policy.tier === "high" && role !== "owner") throw new Error("Only the owner can approve high-risk jobs");
    if (policy.minimumRole === "owner" && role !== "owner") throw new Error("Only the owner can approve this job");
    if (policy.confirmText && confirmText !== policy.confirmText) throw new Error(`Type ${policy.confirmText} to confirm this ${policy.tier}-risk job`);
    const approvalMethod = passwordProvided ? "password" : policy.elevated && policy.tier === "high" ? "elevated" : "confirm";
    const registeredOperation = job.type.startsWith("op:") ? registry.get(job.type.slice(3)) : null;
    if (!registeredOperation) throw new Error("Job type is not supported by this executor");
    // Staged for a server that has moved on (an update to a version already running): approving it
    // would do nothing or harm, so it is cancelled with the reason instead of run (M36).
    const superseded = supersededReason(job, registeredOperation);
    if (superseded) {
      withdraw(job, `Superseded: ${superseded}.`, "job.superseded");
      throw Object.assign(new Error(`${superseded}, so BoxPilot cancelled it. Nothing ran.`), { code: "job_superseded" });
    }
    const parameters = restoreSecrets(job.parameters ?? {}, stagedSecrets.get(jobId)?.values);
    // A placeholder still present, anywhere, means the staged copy is gone (the service restarted):
    // refuse rather than run with the literal text "[secret]" as a password or an app's token.
    if (placeholderPaths(parameters).length) throw new Error("The credentials staged with this job are no longer available (the service restarted); stage it again");
    const parameterError = registry.validate(registeredOperation.id, parameters);
    if (parameterError) throw new Error(`Job parameters are no longer valid: ${parameterError}`);
    // An operation that restarts (or reboots) BoxPilot must not start while another job is mid-run:
    // the restart would cut that job off and leave it marked interrupted, its work half-done. The
    // update job is still awaiting_approval here, so it is not yet in the active list itself. This is
    // a best-effort guard against the common case (approving an update while a job is visibly
    // running), not a lock against a job that starts in the same instant.
    if (registeredOperation.restartsService && typeof store.listActiveJobs === "function") {
      const running = store.listActiveJobs().filter((other) => other.id !== jobId);
      if (running.length) {
        const names = running.map((other) => other.title).join(", ");
        throw new Error(`Wait for ${running.length === 1 ? "a running job" : `${running.length} running jobs`} to finish first: ${names}. "${registeredOperation.title}" restarts BoxPilot and would interrupt ${running.length === 1 ? "it" : "them"}.`);
      }
    }
    // The budget this job runs under: the operation's own, or the larger one it was staged with by
    // "Try again with more time" (M30.3), re-checked against the registry here.
    const budgetMs = budgetFor(registeredOperation, job.recovery?.budgetMs ?? null);
    const execution = {
      operation: registeredOperation.id,
      parameters,
      timeoutMs: budgetMs,
      // Sent to the helper only when it differs, so an older helper still runs every normal job.
      ...(budgetMs !== registeredOperation.timeoutMs ? { budgetMs } : {}),
      applying: `Running ${registeredOperation.title}`,
      applied: `${registeredOperation.title} finished`,
      verified: `${registeredOperation.title} completed`,
      failed: `${registeredOperation.title} failed; review the recorded error and job log`,
      validate: () => true,
    };
    // The transition is the atomic guard against a double approval; record evidence only once it succeeded.
    store.transitionJob(jobId, "awaiting_approval", "applying");
    store.addApproval(jobId, ownerId, { method: approvalMethod, tier: policy.tier });
    store.recordAudit("job.approved", { actorId: ownerId, subjectId: jobId, details: { type: job.type, tier: policy.tier, method: approvalMethod } });
    store.addJobStep(jobId, "approval", "completed", `Approved by ${owner.username} (${policy.tier} risk, ${approvalMethod})`);
    store.addJobStep(jobId, "apply", "running", execution.applying);
    return { job, owner, execution, approval: { tier: policy.tier, method: approvalMethod, elevatedUntil } };
  }

  /**
   * M30.1, the M27.4 canary on every job: the helper has finished writing this job's log, so can
   * this process open it? An open and an fstat, not a read. A log it cannot open is said on the
   * job, where an empty log used to read as "This job recorded no output", and raised once for
   * the server; the next log that opens clears it. A job that printed nothing has no file, which
   * is neither: it proves nothing about the next one. A reader without `check` skips all of this.
   */
  async function confirmLogReadable(jobId) {
    if (typeof jobLog.check !== "function") return true;
    let status;
    try { status = await jobLog.check(jobId); } catch { return true; }
    if (status?.state === "readable") {
      if (alerts) tell(() => alerts.clear(jobLogAlertKey));
      return true;
    }
    if (status?.state !== "unreadable") return true;
    const reason = unreadableReason(status);
    store.addJobStep(jobId, "log", "failed", `BoxPilot could not open this job's output: ${reason}. The job itself ran; its output is not shown here.`.slice(0, 500));
    const title = store.getJob(jobId)?.title ?? "A job";
    if (alerts) tell(() => alerts.raise({ key: jobLogAlertKey, title: "Job output cannot be read", message: `The helper wrote the output of ${title}, but BoxPilot could not open it: ${reason}. Jobs still run; their output is missing from Activity until the helper writes a log BoxPilot can read. The Root helper check on Repair says what to fix.`, priority: "high" }));
    return false;
  }

  /** Move the live job log (written by root-side processes) into SQLite and remove the file. */
  async function persistJobOutput(jobId) {
    if (!jobLog) return;
    try {
      if (!await confirmLogReadable(jobId)) return;
      const { text, exists } = await jobLog.read(jobId, 0);
      if (exists && typeof store.saveJobOutput === "function") {
        store.saveJobOutput(jobId, text);
        // The runtime directory belongs to root. The helper verifies the full durable copy
        // before unlinking; failed, incomplete and truncated logs remain available.
        if (store.getJob(jobId)?.state === "completed") await helper.request("job.output.release", { jobId }, { timeoutMs: 10_000 });
      }
    } catch { /* output is best-effort */ }
  }

  /**
   * The job's timeout record, when the operation ran out of time (M30.3): which budget, how long it
   * had run, how far its log got, and whether "Try again with more time" is on offer. Null for any
   * other failure. More time is offered when the operation declares a larger maximum, the job did
   * not already have it, the work had started (a job that never left the queue needs the queue to
   * clear, not more time), and its parameters hold no secrets, which are gone once it has run.
   */
  async function timeoutRecordFor(job, execution, error, startedAt) {
    const timeout = timeoutOf(error);
    if (!timeout) return null;
    const operation = registry.get(job.type.slice(3));
    const moreTimeMs = timeout.phase === "queued" || placeholderPaths(job.parameters ?? {}).length ? null : nextBudgetMs(operation, execution.timeoutMs);
    let log = "";
    try { log = jobLog ? (await jobLog.read(job.id, 0))?.text ?? "" : ""; } catch { /* the record stands without it */ }
    return jobTimeoutRecord(timeout, { elapsedMs: now() - startedAt, log, moreTimeMs });
  }

  async function executePrepared({ job, owner, execution }) {
    const jobId = job.id;
    const startedAt = now();
    let refreshed = false;
    const refreshEvidence = async () => {
      if (refreshed) return;
      refreshed = true;
      // Invalidate before publishing terminal state so a UI refresh sees new evidence.
      try { await onOperationSettled(job); } catch { /* preserve the operation's actual outcome */ }
    };
    try {
      const result = execution.run
        ? await execution.run()
        : execution.timeoutMs
          ? await helper.request(execution.operation, execution.parameters, { timeoutMs: execution.timeoutMs, jobId, ...(execution.budgetMs ? { budgetMs: execution.budgetMs } : {}) })
          : await helper.request(execution.operation, execution.parameters, { jobId });
      store.transitionJob(jobId, "applying", "verifying", { result });
      store.addJobStep(jobId, "apply", "completed", execution.applied);
      if (!execution.validate(result)) throw new Error(execution.run ? "Operation returned an invalid result" : "Helper returned an invalid operation result");
      // Registry ops with durable evidence record it web-side; a failed record fails the job.
      if (job.type.startsWith("op:")) await recordResult(job, result);
      store.addJobStep(jobId, "verify", "completed", execution.verified);
      await refreshEvidence();
      const completed = store.transitionJob(jobId, "verifying", "completed", { result });
      store.recordAudit("job.completed", { actorId: owner.id, subjectId: jobId, details: { type: job.type } });
      await persistJobOutput(jobId);
      return completed;
    } catch (error) {
      stagedSecrets.delete(jobId);
      await refreshEvidence();
      const current = store.getJob(jobId);
      if (["applying", "verifying"].includes(current?.state)) {
        // Only the operation itself can run out of time; a record hook failing afterwards cannot.
        const timeout = current.state === "applying" && job.type.startsWith("op:") ? await timeoutRecordFor(job, execution, error, startedAt) : null;
        // A step's own limit comes with the operation's sentence (what it undid); the whole budget
        // running out has no such sentence, so it gets one saying what is known.
        const message = timeout && (timeout.scope === "operation" || timeout.phase === "queued") ? timeoutMessage(job.title, timeout) : error.message;
        if (timeout) store.addJobStep(jobId, "timeout", "reached", timeoutStep(timeout).slice(0, 500));
        // The step that failed is the one that was running. A failure while applying used to be
        // written as "verify failed" beside an "apply running" nothing ever closed, so the job's
        // steps said the operation was still going while the job said it had failed; verify never
        // ran at all. Applying ends as failed, with the operation's own sentence; verifying (a
        // record that could not be saved) ends verify.
        if (current.state === "applying") store.addJobStep(jobId, "apply", "failed", (timeout ? `${job.title} ran out of time` : `${job.title} failed: ${message}`).slice(0, 500));
        else store.addJobStep(jobId, "verify", "failed", execution.failed);
        // Helper operations that roll back on failure say so in the error itself.
        if (/rollback|cleanup completed|was unchanged/i.test(error.message)) {
          store.addJobStep(jobId, "rollback", "completed", "The operation undid its partial changes before failing; existing data was preserved");
        }
        store.transitionJob(jobId, current.state, "failed", { error: message, ...(timeout ? { timeout } : {}) });
      }
      store.recordAudit("job.failed", { actorId: owner.id, subjectId: jobId, details: { type: job.type } });
      await persistJobOutput(jobId);
      throw error;
    } finally {
      stagedSecrets.delete(jobId);
    }
  }

  async function approveAndRun(jobId, ownerId, approval) {
    return executePrepared(await prepareApproval(jobId, ownerId, approval));
  }

  async function approveAndStart(jobId, ownerId, approval) {
    const prepared = await prepareApproval(jobId, ownerId, approval);
    void executePrepared(prepared).catch(() => {});
    return store.getJob(jobId);
  }

  /**
   * Stage a job for any registered, non-read-only operation. Approval and execution are generic.
   *
   * `budgetMs` stages it with more time than normal (M30.3; the registry decides whether it counts),
   * and `rerunOf` / `retryOf` name the job this one runs again: after a restart cut it off (M30.2),
   * or after it ran out of time. They are kept on the record so each run links to the one before.
   */
  async function createOperationJob(operationId, parameters, ownerId, { role = "owner", budgetMs = null, rerunOf = null, retryOf = null } = {}) {
    const operation = registry.get(operationId);
    if (!operation) throw new Error("Operation not found");
    if (role === "viewer" || role === "disabled") throw new Error("Viewers cannot stage operations");
    if (operation.risk === "high" && role !== "owner") throw new Error("Only the owner can stage high-risk operations");
    if (operation.minimumRole === "owner" && role !== "owner") throw new Error("Only the owner can stage this operation");
    if (operation.readOnly) throw new Error("Read-only operations run directly; they are not staged as jobs");
    // Prepare hooks pin server-derived expectations (recorded evidence, live revisions) into
    // the staged parameters, so the browser only ever names the subject.
    if (operationPrepareHooks[operationId]) parameters = await operationPrepareHooks[operationId](parameters ?? {});
    const parameterError = registry.validate(operationId, parameters ?? {});
    if (parameterError) throw new Error(parameterError);
    // Every secret, top-level or an app's own inside values.env, is staged in memory and the record
    // keeps a placeholder, so the controller database - and every backup of it - never holds one.
    const { stored: persisted, secrets } = splitSecrets(parameters ?? {}, await secretPaths(operation, parameters ?? {}, { secretEnvNamesFor }));
    const approvalExpiresAt = secrets.length ? new Date(now() + secretTtlMs).toISOString() : null;
    const budget = budgetFor(operation, budgetMs);
    const job = store.createJob({
      type: `op:${operationId}`,
      title: operation.title,
      risk: operation.risk,
      parameters: persisted,
      recovery: {
        ...(approvalExpiresAt ? { approvalExpiresAt } : {}),
        ...(budget !== operation.timeoutMs ? { budgetMs: budget } : {}),
        ...(typeof rerunOf === "string" && rerunOf ? { rerunOf } : {}),
        ...(typeof retryOf === "string" && retryOf ? { retryOf } : {}),
        reason: operation.description || `${operation.title} is ${operation.risk} risk.`,
        manual: "If verification fails, review the job log and the helper journal, then rerun or undo the operation.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: `${operation.title}: parameters validated against the operation registry` },
        { name: "checkpoint", state: "completed", detail: `${operation.risk} risk · ${operation.readOnly ? "read-only" : "changes host state"} · runs through the root task runner` },
        ...(typeof rerunOf === "string" && rerunOf ? [{ name: "rerun", state: "completed", detail: `Ran again after BoxPilot restarted. The first run, job ${rerunOf}, was cut off.` }] : []),
        ...(typeof retryOf === "string" && retryOf ? [{ name: "retry", state: "completed", detail: `Trying again with more time. The last run, job ${retryOf}, ran out of time.` }] : []),
        ...(budget !== operation.timeoutMs ? [{ name: "budget", state: "completed", detail: `Allowed ${formatDuration(budget)} instead of the usual ${formatDuration(operation.timeoutMs)}` }] : []),
      ],
    });
    if (secrets.length) stagedSecrets.set(job.id, { values: secrets, expiresAt: Date.parse(approvalExpiresAt) });
    return job;
  }

  /**
   * "Try again with more time" (M30.3): stage the same operation, with the same parameters, again,
   * with twice the budget that ran out, up to the operation's declared maximum. It is staged, not
   * run: it goes through the same approval, at the same tier, as any other job, by whoever asks.
   */
  async function retryWithMoreTime(jobId, ownerId, { role = "owner" } = {}) {
    const job = store.getJob(jobId);
    if (!job || (job.createdBy !== ownerId && role !== "owner")) throw new Error("Job not found");
    const operation = job.type.startsWith("op:") ? registry.get(job.type.slice(3)) : null;
    const refuse = (message) => Object.assign(new Error(message), { code: "more_time_refused" });
    if (!operation || job.state !== "failed" || !job.timeout) throw refuse("Only a job that ran out of time can be tried again with more time");
    if (job.timeout.phase === "queued") throw refuse("This job never started: it waited behind other work. Run it again once that work has finished.");
    if (placeholderPaths(job.parameters ?? {}).length) throw refuse("This job was given passwords, and BoxPilot does not keep them after a job runs. Start it again from where you started it.");
    const budgetMs = nextBudgetMs(operation, budgetFor(operation, job.recovery?.budgetMs ?? null));
    if (!budgetMs) throw refuse(operation.maxTimeoutMs ? `${operation.title} already had the most time it can have, ${formatDuration(operation.maxTimeoutMs)}.` : `${operation.title} cannot be given more time.`);
    const retry = await createOperationJob(operation.id, job.parameters ?? {}, ownerId, { role, budgetMs, retryOf: job.id });
    store.addJobStep(job.id, "retry", "staged", `Staged again with ${formatDuration(budgetMs)} as job ${retry.id}`);
    store.recordAudit("job.more-time", { actorId: ownerId, subjectId: retry.id, details: { type: job.type, retryOf: job.id, budgetMs } });
    return retry;
  }

  /** Apply the operation's prepare hook without staging — the scheduler validates with it. */
  async function prepareParameters(operationId, parameters = {}) {
    return operationPrepareHooks[operationId] ? operationPrepareHooks[operationId](parameters ?? {}) : parameters ?? {};
  }

  /** Withdraw a job that is still awaiting approval (its creator, or the owner); staged secrets are dropped. */
  function cancelJob(jobId, ownerId, { role = "owner", reason = "Cancelled before approval" } = {}) {
    const job = store.getJob(jobId);
    if (!job || (job.createdBy !== ownerId && role !== "owner")) throw new Error("Job not found");
    if (job.state !== "awaiting_approval") throw new Error("Only jobs that are awaiting approval can be cancelled");
    store.transitionJob(jobId, "awaiting_approval", "cancelled", { error: reason });
    stagedSecrets.delete(jobId);
    store.recordAudit("job.cancelled", { actorId: ownerId, subjectId: jobId, details: { type: job.type, reason } });
    return store.getJob(jobId);
  }

  /** Why a staged job no longer has anything to do, from its operation's own rule, or null. */
  function supersededReason(job, operation = job?.type?.startsWith("op:") ? registry.get(job.type.slice(3)) : null) {
    if (typeof operation?.supersededWhen !== "function") return null;
    try { return operation.supersededWhen(job.parameters ?? {}, { version }) ?? null; } catch { return null; }
  }

  /** Cancel a job still awaiting approval on BoxPilot's own account, saying why on the job itself. */
  function withdraw(job, reason, action) {
    try {
      store.transitionJob(job.id, "awaiting_approval", "cancelled", { error: reason });
    } catch { return false; } // approved or cancelled in the meantime: nothing to withdraw
    stagedSecrets.delete(job.id);
    store.addJobStep(job.id, "cancelled", "completed", reason.slice(0, 500));
    store.recordAudit(action, { actorId: null, subjectId: job.id, details: { type: job.type, reason } });
    return true;
  }

  /**
   * Staged jobs nobody will approve (M36): one its operation says has been superseded - an update to
   * a version the server already runs - is cancelled with that reason; one that has waited longer
   * than `approvalMaxAge` is cancelled too, and the owner is told, once, through the ledger. Run at
   * startup, so an update that just landed clears the approvals it made pointless, and hourly.
   */
  function sweepStaleApprovals() {
    const swept = [];
    for (const job of store.listAwaitingApproval?.() ?? []) {
      const superseded = supersededReason(job);
      if (superseded) {
        if (withdraw(job, `Superseded: ${superseded}.`, "job.superseded")) swept.push({ id: job.id, why: "superseded", reason: superseded });
        continue;
      }
      const waited = now() - Date.parse(job.updatedAt ?? job.createdAt ?? "");
      if (!Number.isFinite(waited) || waited <= approvalMaxAge) continue;
      const days = Math.round(approvalMaxAge / 86_400_000);
      if (!withdraw(job, `Nobody approved it in ${days} days, so BoxPilot cancelled it. Nothing ran; stage it again if it is still wanted.`, "job.approval.lapsed")) continue;
      swept.push({ id: job.id, why: "lapsed" });
      if (alerts) tell(() => alerts.tell({ key: `approval.lapsed:${job.id}`, title: `Not approved in ${days} days: ${job.title}`, message: `${job.title} waited ${days} days for an approval, so BoxPilot cancelled it. Nothing ran. Stage it again from its page if it is still wanted.`, priority: "default" }));
    }
    return swept;
  }

  /**
   * "I have seen this failure" (M36): a failed job the owner or its creator has looked at stops
   * asking for attention on Home and Ops. It stays in Activity, failed, with who let it go.
   */
  function dismissFailure(jobId, ownerId, { role = "owner" } = {}) {
    const job = store.getJob(jobId);
    if (!job || (job.createdBy !== ownerId && role !== "owner")) throw new Error("Job not found");
    if (job.state !== "failed") throw new Error("Only a failed job can be dismissed");
    if (dismissed(job)) return job;
    const who = store.findOwnerById(ownerId)?.username ?? "someone";
    store.addJobStep(jobId, "dismissed", "completed", `Dismissed by ${who}. It stays here, but no longer asks for attention.`);
    store.recordAudit("job.dismissed", { actorId: ownerId, subjectId: jobId, details: { type: job.type } });
    return store.getJob(jobId);
  }

  /** Read-only: what approving this job would require for the given session. */
  function describeApproval(jobId, session = null) {
    const job = store.getJob(jobId);
    if (!job) return null;
    return approvalPolicy(job, session);
  }

  function expireSecretJob(job) {
    stagedSecrets.delete(job.id);
    if (job.state !== "awaiting_approval") return;
    const reason = "Approval expired. Stage the operation again and re-enter its credentials.";
    store.transitionJob(job.id, "awaiting_approval", "cancelled", { error: reason });
    store.recordAudit("job.approval.expired", { actorId: null, subjectId: job.id, details: { type: job.type } });
  }

  /** Whether this job's secrets are staged in memory now. The stored-secret scrub leaves such a job alone. */
  const holdsStagedSecrets = (jobId) => stagedSecrets.has(jobId);

  /** Drop finished or expired secrets. Called once a minute, and expiry is also enforced at approval. */
  function pruneStagedSecrets() {
    let dropped = 0;
    for (const [jobId, record] of stagedSecrets) {
      const job = store.getJob(jobId);
      if (job?.state === "awaiting_approval" && record.expiresAt > now()) continue;
      stagedSecrets.delete(jobId); dropped += 1;
      if (job?.state === "awaiting_approval") expireSecretJob(job);
    }
    return dropped;
  }

  return { pruneStagedSecrets, holdsStagedSecrets, createOperationJob, retryWithMoreTime, approveAndRun, approveAndStart, describeApproval, approvalPolicy, cancelJob, prepareParameters, sweepStaleApprovals, dismissFailure, supersededReason };
}
