import { verifyPassword } from "./security.mjs";
import { defaultThrottle as throttle } from "./login-throttle.mjs";
import { approvalRequirement, defaultApprovalMode, elevationTtlMs, normalizeApprovalMode } from "./ops/risk.mjs";
import { registry } from "./ops/index.mjs";
import { secretFields } from "./ops/registry.mjs";

/** What a secret parameter looks like in the database and the job API. */
export const secretPlaceholder = "[secret]";

export function createJobService(store, helper, {
  jobLog = null,
  operationRecordHooks = {},
  operationPrepareHooks = {},
} = {}) {
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
    return { minimumRole: registered?.minimumRole ?? null, confirmText: typeof confirmText === "string" && confirmText ? confirmText : null, mode, ...approvalRequirement({ jobType: job.type, mode, elevatedUntil: session?.elevatedUntil ?? null }) };
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
    if (!owner) throw new Error("Approval reauthentication failed");
    const passwordProvided = typeof password === "string" && password.length > 0;
    if (passwordProvided) {
      const gate = throttle.check([`user:${owner.id}`]);
      if (gate.blocked) throw new Error(`Approval reauthentication failed: too many wrong passwords, try again in ${Math.ceil(gate.retryAfterMs / 1000)} s`);
      const ok = await verifyPassword(password, owner.passwordHash);
      throttle.record([`user:${owner.id}`], ok);
      if (!ok) throw new Error("Approval reauthentication failed");
    }
    const job = store.getJob(jobId);
    if (!job) throw new Error("Job not found");
    const approverRole = session?.owner?.role ?? owner.role ?? "owner";
    if (job.createdBy !== ownerId && approverRole !== "owner") throw new Error("Job not found");
    const policy = approvalPolicy(job, session);
    if (policy.passwordRequired && !passwordProvided) throw new Error(`Approval reauthentication required: ${policy.tier}-risk job needs the owner password`);
    let elevatedUntil = session?.elevatedUntil ?? null;
    if (passwordProvided && session?.tokenHash && typeof store.elevateSession === "function") {
      elevatedUntil = store.elevateSession(session.tokenHash, new Date(Date.now() + elevationTtlMs)) ?? elevatedUntil;
    }
    const role = session?.owner?.role ?? owner.role ?? "owner";
    if (role === "viewer" || role === "disabled") throw new Error("Viewers cannot approve jobs");
    if (policy.tier === "high" && role !== "owner") throw new Error("Only the owner can approve high-risk jobs");
    if (policy.minimumRole === "owner" && role !== "owner") throw new Error("Only the owner can approve this job");
    if (policy.confirmText && confirmText !== policy.confirmText) throw new Error(`Type ${policy.confirmText} to confirm this ${policy.tier}-risk job`);
    const approvalMethod = passwordProvided ? "password" : policy.elevated && policy.tier === "high" ? "elevated" : "confirm";
    const registeredOperation = job.type.startsWith("op:") ? registry.get(job.type.slice(3)) : null;
    if (!registeredOperation) throw new Error("Job type is not supported by this executor");
    const parameters = { ...(job.parameters ?? {}) };
    const secrets = stagedSecrets.get(jobId) ?? {};
    for (const name of secretFields(registeredOperation.parameters)) {
      if (parameters[name] !== secretPlaceholder) continue;
      if (typeof secrets[name] !== "string") throw new Error("The credentials staged with this job are no longer available (the service restarted); stage it again");
      parameters[name] = secrets[name];
    }
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
    const execution = {
      operation: registeredOperation.id,
      parameters,
      timeoutMs: registeredOperation.timeoutMs,
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

  /** Move the live job log (written by root-side processes) into SQLite and remove the file. */
  async function persistJobOutput(jobId) {
    if (!jobLog) return;
    try {
      const { text, exists } = await jobLog.read(jobId, 0);
      if (exists && typeof store.saveJobOutput === "function") store.saveJobOutput(jobId, text);
      await jobLog.remove(jobId);
    } catch { /* output is best-effort */ }
  }

  async function executePrepared({ job, owner, execution }) {
    const jobId = job.id;
    try {
      const result = execution.run
        ? await execution.run()
        : execution.timeoutMs
          ? await helper.request(execution.operation, execution.parameters, { timeoutMs: execution.timeoutMs, jobId })
          : await helper.request(execution.operation, execution.parameters, { jobId });
      store.transitionJob(jobId, "applying", "verifying", { result });
      store.addJobStep(jobId, "apply", "completed", execution.applied);
      if (!execution.validate(result)) throw new Error(execution.run ? "Operation returned an invalid result" : "Helper returned an invalid operation result");
      // Registry ops with durable evidence record it web-side; a failed record fails the job.
      if (job.type.startsWith("op:")) operationRecordHooks[job.type.slice(3)]?.(job, result);
      store.addJobStep(jobId, "verify", "completed", execution.verified);
      const completed = store.transitionJob(jobId, "verifying", "completed", { result });
      store.recordAudit("job.completed", { actorId: owner.id, subjectId: jobId, details: { type: job.type } });
      await persistJobOutput(jobId);
      return completed;
    } catch (error) {
      stagedSecrets.delete(jobId);
      const current = store.getJob(jobId);
      if (["applying", "verifying"].includes(current?.state)) {
        store.addJobStep(jobId, "verify", "failed", execution.failed);
        // Helper operations that roll back on failure say so in the error itself.
        if (/rollback|cleanup completed|was unchanged/i.test(error.message)) {
          store.addJobStep(jobId, "rollback", "completed", "The operation undid its partial changes before failing; existing data was preserved");
        }
        store.transitionJob(jobId, current.state, "failed", { error: error.message });
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

  /** Stage a job for any registered, non-read-only operation. Approval and execution are generic. */
  async function createOperationJob(operationId, parameters, ownerId, { role = "owner" } = {}) {
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
    const persisted = { ...(parameters ?? {}) };
    const secrets = {};
    for (const name of secretFields(operation.parameters)) {
      if (typeof persisted[name] === "string" && persisted[name].length) { secrets[name] = persisted[name]; persisted[name] = secretPlaceholder; }
    }
    const job = store.createJob({
      type: `op:${operationId}`,
      title: operation.title,
      risk: operation.risk,
      parameters: persisted,
      recovery: {
        reason: operation.description || `${operation.title} is ${operation.risk} risk.`,
        manual: "If verification fails, review the job log and the helper journal, then rerun or undo the operation.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: `${operation.title}: parameters validated against the operation registry` },
        { name: "checkpoint", state: "completed", detail: `${operation.risk} risk · ${operation.readOnly ? "read-only" : "changes host state"} · runs through the root task runner` },
      ],
    });
    if (Object.keys(secrets).length) stagedSecrets.set(job.id, secrets);
    return job;
  }

  /** Read-only: what approving this job would require for the given session. */
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

  function describeApproval(jobId, session = null) {
    const job = store.getJob(jobId);
    if (!job) return null;
    return approvalPolicy(job, session);
  }

  return { createOperationJob, approveAndRun, approveAndStart, describeApproval, approvalPolicy, cancelJob, prepareParameters };
}
