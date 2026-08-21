import { verifyPassword } from "./security.mjs";
import { approvalRequirement, defaultApprovalMode, elevationTtlMs, normalizeApprovalMode } from "./ops/risk.mjs";
import { registry } from "./ops/index.mjs";

export function createJobService(store, helper, {
  jobLog = null,
  operationRecordHooks = {},
  operationPrepareHooks = {},
} = {}) {

  /**
   * Decide how a job must be approved for this session (ADR-001 risk tiers).
   * Pure with respect to the store except reading the approval-mode setting.
   */
  function approvalPolicy(job, session = null) {
    const mode = normalizeApprovalMode(store.getSetting?.("approvalMode", null) ?? process.env.BOXPILOT_APPROVAL_MODE ?? defaultApprovalMode);
    return { mode, ...approvalRequirement({ jobType: job.type, mode, elevatedUntil: session?.elevatedUntil ?? null }) };
  }

  /**
   * @param {string} jobId
   * @param {string} ownerId
   * @param {string | { password?: string, session?: { tokenHash?: string, elevatedUntil?: string | null } }} approval
   *   A bare string is treated as a password (legacy callers).
   */
  async function prepareApproval(jobId, ownerId, approval = {}) {
    const { password = null, session = null } = typeof approval === "string" ? { password: approval } : approval ?? {};
    const owner = store.findOwnerById(ownerId);
    if (!owner) throw new Error("Approval reauthentication failed");
    const passwordProvided = typeof password === "string" && password.length > 0;
    if (passwordProvided && !(await verifyPassword(password, owner.passwordHash))) throw new Error("Approval reauthentication failed");
    const job = store.getJob(jobId);
    if (!job) throw new Error("Job not found");
    if (job.createdBy !== ownerId) throw new Error("Job not found");
    const policy = approvalPolicy(job, session);
    if (policy.passwordRequired && !passwordProvided) throw new Error(`Approval reauthentication required: ${policy.tier}-risk job needs the owner password`);
    let elevatedUntil = session?.elevatedUntil ?? null;
    if (passwordProvided && session?.tokenHash && typeof store.elevateSession === "function") {
      elevatedUntil = store.elevateSession(session.tokenHash, new Date(Date.now() + elevationTtlMs)) ?? elevatedUntil;
    }
    const role = session?.owner?.role ?? owner.role ?? "owner";
    if (role === "viewer" || role === "disabled") throw new Error("Viewers cannot approve jobs");
    if (policy.tier === "high" && role !== "owner") throw new Error("Only the owner can approve high-risk jobs");
    const approvalMethod = passwordProvided ? "password" : policy.elevated && policy.tier === "high" ? "elevated" : "confirm";
    const registeredOperation = job.type.startsWith("op:") ? registry.get(job.type.slice(3)) : null;
    if (!registeredOperation) throw new Error("Job type is not supported by this executor");
    const parameterError = registry.validate(registeredOperation.id, job.parameters ?? {});
    if (parameterError) throw new Error(`Job parameters are no longer valid: ${parameterError}`);
    const execution = {
      operation: registeredOperation.id,
      parameters: job.parameters ?? {},
      timeoutMs: registeredOperation.timeoutMs,
      applying: `Running ${registeredOperation.title}`,
      applied: `${registeredOperation.title} finished`,
      verified: `${registeredOperation.title} completed`,
      failed: `${registeredOperation.title} failed; review the recorded error and job log`,
      validate: () => true,
    };
    store.addApproval(jobId, ownerId, { method: approvalMethod, tier: policy.tier });
    store.recordAudit("job.approved", { actorId: ownerId, subjectId: jobId, details: { type: job.type, tier: policy.tier, method: approvalMethod } });
    store.transitionJob(jobId, "awaiting_approval", "applying");
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
    if (operation.readOnly) throw new Error("Read-only operations run directly; they are not staged as jobs");
    // Prepare hooks pin server-derived expectations (recorded evidence, live revisions) into
    // the staged parameters, so the browser only ever names the subject.
    if (operationPrepareHooks[operationId]) parameters = await operationPrepareHooks[operationId](parameters ?? {});
    const parameterError = registry.validate(operationId, parameters ?? {});
    if (parameterError) throw new Error(parameterError);
    return store.createJob({
      type: `op:${operationId}`,
      title: operation.title,
      risk: operation.risk,
      parameters: parameters ?? {},
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
  }

  /** Read-only: what approving this job would require for the given session. */
  function describeApproval(jobId, session = null) {
    const job = store.getJob(jobId);
    if (!job) return null;
    return approvalPolicy(job, session);
  }

  return { createOperationJob, approveAndRun, approveAndStart, describeApproval, approvalPolicy };
}
