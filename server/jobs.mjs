import { verifyPassword } from "./security.mjs";

export function createJobService(store, helper, {
  validateApplicationJob = async () => {},
  validateBackupJob = async () => {},
  validateVmCreationJob = async () => {},
  validateVmLifecycleJob = async () => {},
  recordBackupResult = () => {},
} = {}) {
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
    if (!["helper.canary.verify", "application.uptime-kuma.deploy", "application.uptime-kuma.backup", "virtualization.domain.create", "virtualization.domain.action"].includes(job.type)) throw new Error("Job type is not supported by this executor");
    if (job.type === "application.uptime-kuma.deploy") await validateApplicationJob(job);
    if (job.type === "application.uptime-kuma.backup") await validateBackupJob(job);
    const validatedVmPlan = job.type === "virtualization.domain.create" ? await validateVmCreationJob(job) : null;
    const validatedVmLifecyclePlan = job.type === "virtualization.domain.action" ? await validateVmLifecycleJob(job) : null;
    if (job.type === "virtualization.domain.create" && !validatedVmPlan?.input) throw new Error("The staged VM creation plan is unavailable or changed");
    if (job.type === "virtualization.domain.action" && !validatedVmLifecyclePlan?.input) throw new Error("The staged VM lifecycle plan is unavailable or changed");
    const execution = job.type === "helper.canary.verify" ? {
      operation: "canary.verify",
      parameters: {},
      applying: "Sending typed canary request over the local Unix socket",
      applied: "Restricted helper accepted the typed request",
      verified: "Helper identity and no-mutation guarantee verified",
      failed: "The helper canary did not complete successfully",
      validate: (result) => result?.verified && result?.mutationPerformed === false,
    } : job.type === "application.uptime-kuma.deploy" ? {
      operation: "application.uptime-kuma.deploy",
      parameters: { hostPort: job.parameters.hostPort },
      applying: "Applying the curated digest-pinned Uptime Kuma stack through the restricted helper",
      applied: "Restricted helper applied the curated stack without exposing the Docker socket to the web process",
      verified: "Uptime Kuma container and internal HTTP health check passed",
      failed: "Uptime Kuma did not pass deployment and health verification",
      validate: (result) => result?.installed && result?.healthy && result?.dataPreserved,
    } : job.type === "application.uptime-kuma.backup" ? {
      operation: "application.uptime-kuma.backup",
      parameters: { backupId: job.parameters.backupId },
      applying: "Stopping the source cleanly, archiving managed data, and restarting it through the restricted helper",
      applied: "Source health returned and the immutable backup artifact passed SHA-256 integrity collection",
      verified: "An isolated no-network restore container passed health verification and was removed",
      failed: "The backup or isolated restore drill did not pass verification",
      validate: (result) => result?.backupId === job.parameters.backupId && result?.sourceRestartVerified && result?.restoreDrill?.passed,
    } : job.type === "virtualization.domain.create" ? {
      operation: "virtualization.domain.create",
      parameters: validatedVmPlan.input,
      applying: "Creating the exact validated VM through the restricted libvirt helper",
      applied: "Restricted helper created the domain without accepting a command, path, or argument array from the web process",
      verified: "Domain identity, allocated disk, default network, and requested autostart state were verified",
      failed: "VM creation or its post-create verification did not complete successfully",
      validate: (result) => result?.created && result?.verified && result?.domain === validatedVmPlan.input.name && result?.media === validatedVmPlan.input.isoFile,
    } : {
      operation: "virtualization.domain.action",
      parameters: validatedVmLifecyclePlan.input,
      applying: `Requesting the reviewed ${validatedVmLifecyclePlan.output.label.toLowerCase()} operation through the restricted libvirt helper`,
      applied: "Restricted helper accepted the fixed lifecycle operation after independently matching current VM state",
      verified: "Post-operation power and autostart state matched the reviewed lifecycle plan",
      failed: "VM lifecycle execution or state verification did not complete successfully",
      validate: (result) => result?.verified && result?.domain === validatedVmLifecyclePlan.input.name && result?.action === validatedVmLifecyclePlan.input.action,
    };
    store.addApproval(jobId, ownerId);
    store.recordAudit("job.approved", { actorId: ownerId, subjectId: jobId, details: { type: job.type } });
    store.transitionJob(jobId, "awaiting_approval", "applying");
    store.addJobStep(jobId, "approval", "completed", `Approved by ${owner.username}`);
    store.addJobStep(jobId, "apply", "running", execution.applying);
    try {
      const result = await helper.request(execution.operation, execution.parameters);
      store.transitionJob(jobId, "applying", "verifying", { result });
      store.addJobStep(jobId, "apply", "completed", execution.applied);
      if (!execution.validate(result)) throw new Error("Helper returned an invalid operation result");
      if (job.type === "application.uptime-kuma.backup") recordBackupResult(job, result);
      store.addJobStep(jobId, "verify", "completed", execution.verified);
      const completed = store.transitionJob(jobId, "verifying", "completed", { result });
      store.recordAudit("job.completed", { actorId: ownerId, subjectId: jobId, details: { type: job.type } });
      return completed;
    } catch (error) {
      const current = store.getJob(jobId);
      if (["applying", "verifying"].includes(current?.state)) {
        store.addJobStep(jobId, "verify", "failed", execution.failed);
        if (job.type === "application.uptime-kuma.deploy" && error.message.includes("Automated rollback completed")) {
          store.addJobStep(jobId, "rollback", "completed", "Managed container and network were removed or the previous Compose definition was restored; data was preserved");
        }
        if (job.type === "virtualization.domain.create" && error.message.includes("Automated rollback completed")) {
          store.addJobStep(jobId, "rollback", "completed", "The newly created exact-name domain and its allocated storage were removed");
        }
        store.transitionJob(jobId, current.state, "failed", { error: error.message });
      }
      store.recordAudit("job.failed", { actorId: ownerId, subjectId: jobId, details: { type: job.type } });
      throw error;
    }
  }

  return { createCanary, approveAndRun };
}
