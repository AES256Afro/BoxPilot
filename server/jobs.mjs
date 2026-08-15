import { verifyPassword } from "./security.mjs";

export function createJobService(store, helper) {
  function createCanary(ownerId) {
    return store.createJob({
      type: "helper.canary.verify",
      title: "Verify restricted helper boundary",
      risk: "none",
      parameters: {},
      recovery: {
        automaticRollback: false,
        reason: "The canary performs no host mutation, so no rollback is required.",
        manual: "If the helper is unavailable, inspect boxpilot-helper.service and retry after it is healthy.",
      },
      createdBy: ownerId,
    });
  }

  async function approveAndRun(jobId, ownerId, password) {
    const owner = store.findOwnerById(ownerId);
    if (!owner || !(await verifyPassword(password, owner.passwordHash))) throw new Error("Approval reauthentication failed");
    const job = store.getJob(jobId);
    if (!job) throw new Error("Job not found");
    if (job.type !== "helper.canary.verify") throw new Error("Job type is not supported by this executor");
    store.addApproval(jobId, ownerId);
    store.recordAudit("job.approved", { actorId: ownerId, subjectId: jobId, details: { type: job.type } });
    store.transitionJob(jobId, "awaiting_approval", "applying");
    store.addJobStep(jobId, "approval", "completed", `Approved by ${owner.username}`);
    store.addJobStep(jobId, "apply", "running", "Sending typed canary request over the local Unix socket");
    try {
      const result = await helper.request("canary.verify", {});
      store.transitionJob(jobId, "applying", "verifying", { result });
      store.addJobStep(jobId, "apply", "completed", "Restricted helper accepted the typed request");
      if (!result?.verified || result?.mutationPerformed !== false) throw new Error("Helper returned an invalid canary result");
      store.addJobStep(jobId, "verify", "completed", "Helper identity and no-mutation guarantee verified");
      const completed = store.transitionJob(jobId, "verifying", "completed", { result });
      store.recordAudit("job.completed", { actorId: ownerId, subjectId: jobId, details: { type: job.type } });
      return completed;
    } catch (error) {
      const current = store.getJob(jobId);
      if (["applying", "verifying"].includes(current?.state)) {
        store.addJobStep(jobId, "verify", "failed", "The helper canary did not complete successfully");
        store.transitionJob(jobId, current.state, "failed", { error: error.message });
      }
      store.recordAudit("job.failed", { actorId: ownerId, subjectId: jobId, details: { type: job.type } });
      throw error;
    }
  }

  return { createCanary, approveAndRun };
}
