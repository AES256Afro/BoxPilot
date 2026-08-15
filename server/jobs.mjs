import { verifyPassword } from "./security.mjs";

export function createJobService(store, helper, {
  validateApplicationJob = async () => {},
  validateBackupJob = async () => {},
  validateVmCreationJob = async () => {},
  validateVmExportJob = async () => {},
  validateVmProtectionJob = async () => {},
  validateVmRestoreDrillJob = async () => {},
  validateVmLifecycleJob = async () => {},
  validateVmSnapshotJob = async () => {},
  recordBackupResult = () => {},
  recordVmExportResult = () => {},
  recordVmProtectionResult = () => {},
  recordVmRestoreDrillResult = () => {},
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

  async function prepareApproval(jobId, ownerId, password) {
    const owner = store.findOwnerById(ownerId);
    if (!owner || !(await verifyPassword(password, owner.passwordHash))) throw new Error("Approval reauthentication failed");
    const job = store.getJob(jobId);
    if (!job) throw new Error("Job not found");
    if (job.createdBy !== ownerId) throw new Error("Job not found");
    if (!["helper.canary.verify", "application.uptime-kuma.deploy", "application.uptime-kuma.backup", "virtualization.domain.create", "virtualization.domain.action", "virtualization.domain.snapshot.create", "virtualization.domain.export.create", "virtualization.export.backup.create", "virtualization.export.backup.restore-drill"].includes(job.type)) throw new Error("Job type is not supported by this executor");
    if (job.type === "application.uptime-kuma.deploy") await validateApplicationJob(job);
    if (job.type === "application.uptime-kuma.backup") await validateBackupJob(job);
    const validatedVmPlan = job.type === "virtualization.domain.create" ? await validateVmCreationJob(job) : null;
    const validatedVmExportPlan = job.type === "virtualization.domain.export.create" ? await validateVmExportJob(job) : null;
    const validatedVmProtectionPlan = job.type === "virtualization.export.backup.create" ? await validateVmProtectionJob(job) : null;
    const validatedVmRestoreDrillPlan = job.type === "virtualization.export.backup.restore-drill" ? await validateVmRestoreDrillJob(job) : null;
    const validatedVmLifecyclePlan = job.type === "virtualization.domain.action" ? await validateVmLifecycleJob(job) : null;
    const validatedVmSnapshotPlan = job.type === "virtualization.domain.snapshot.create" ? await validateVmSnapshotJob(job) : null;
    if (job.type === "virtualization.domain.create" && !validatedVmPlan?.input) throw new Error("The staged VM creation plan is unavailable or changed");
    if (job.type === "virtualization.domain.export.create" && !validatedVmExportPlan?.input) throw new Error("The staged VM export plan is unavailable or changed");
    if (job.type === "virtualization.export.backup.create" && !validatedVmProtectionPlan?.input) throw new Error("The staged VM protection plan is unavailable or changed");
    if (job.type === "virtualization.export.backup.restore-drill" && !validatedVmRestoreDrillPlan?.input) throw new Error("The staged VM restore drill plan is unavailable or changed");
    if (job.type === "virtualization.domain.action" && !validatedVmLifecyclePlan?.input) throw new Error("The staged VM lifecycle plan is unavailable or changed");
    if (job.type === "virtualization.domain.snapshot.create" && !validatedVmSnapshotPlan?.input) throw new Error("The staged VM snapshot plan is unavailable or changed");
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
    } : job.type === "virtualization.domain.export.create" ? {
      operation: "virtualization.domain.export.create",
      parameters: validatedVmExportPlan.input,
      timeoutMs: 6 * 60 * 60 * 1000,
      applying: "Exporting the reviewed stopped VM into a new local, root-only artifact through the restricted helper",
      applied: "Restricted helper flattened the current VM state into standalone qcow2 disks and collected SHA-256 integrity metadata",
      verified: "Exported disks passed qemu-img structural checks and source-to-export content comparison; this local unencrypted copy is not yet a protected backup",
      failed: "VM export or content verification did not complete successfully; the source VM remains unchanged",
      validate: (result) => result?.created && result?.contentVerified && result?.domain === validatedVmExportPlan.input.name && result?.exportId === validatedVmExportPlan.input.exportId && result?.protected === false && result?.encrypted === false && result?.restoreDrill?.passed === false,
    } : job.type === "virtualization.export.backup.create" ? {
      operation: "virtualization.export.backup.create",
      parameters: validatedVmProtectionPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Reverifying the local export and writing an encrypted snapshot to the reviewed independent restic destination",
      applied: "Restic published an encrypted snapshot without changing the local VM export or deleting repository data",
      verified: "Local SHA-256 evidence, a full repository data read, and exact snapshot identity passed; isolated restore boot remains required before protected status",
      failed: "Encrypted independent VM backup or repository verification did not complete successfully; preserve both the local export and repository for inspection",
      validate: (result) => result?.created && result?.backupId === validatedVmProtectionPlan.input.backupId && result?.exportId === validatedVmProtectionPlan.input.exportId && result?.encrypted === true && result?.independent === true && result?.repositoryVerified === true && result?.protected === false && result?.restoreDrill?.passed === false,
    } : job.type === "virtualization.export.backup.restore-drill" ? {
      operation: "virtualization.export.backup.restore-drill",
      parameters: validatedVmRestoreDrillPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Restoring the exact encrypted snapshot and booting its disks as a transient no-network domain through the restricted helper",
      applied: "Restic restored and reverified the snapshot; the transient domain started without a network interface",
      verified: "Restored checksums and qcow2 structures, repeated guest-agent health, transient isolation, and complete successful cleanup passed",
      failed: "The isolated restore drill did not complete; protected status remains false and the restored workspace is preserved for inspection",
      validate: (result) => result?.passed && result?.drillId === validatedVmRestoreDrillPlan.input.drillId && result?.backupId === validatedVmRestoreDrillPlan.input.backupId && result?.network === "none" && result?.transient === true && result?.persistentDomainCreated === false && result?.guestAgentPing === true && result?.temporaryQemuDiskAccessGranted === true && result?.temporaryQemuDiskAccessRemoved === true && result?.transientFirmwareStateRemoved === true && result?.cleanupVerified === true && result?.protected === true,
    } : job.type === "virtualization.domain.action" ? {
      operation: "virtualization.domain.action",
      parameters: validatedVmLifecyclePlan.input,
      applying: `Requesting the reviewed ${validatedVmLifecyclePlan.output.label.toLowerCase()} operation through the restricted libvirt helper`,
      applied: "Restricted helper accepted the fixed lifecycle operation after independently matching current VM state",
      verified: "Post-operation power and autostart state matched the reviewed lifecycle plan",
      failed: "VM lifecycle execution or state verification did not complete successfully",
      validate: (result) => result?.verified && result?.domain === validatedVmLifecyclePlan.input.name && result?.action === validatedVmLifecyclePlan.input.action,
    } : {
      operation: "virtualization.domain.snapshot.create",
      parameters: validatedVmSnapshotPlan.input,
      applying: "Creating the reviewed internal snapshot for the stopped domain through the restricted libvirt helper",
      applied: "Restricted helper created the snapshot after independently matching domain UUID, stopped state, managed qcow2 disks, and snapshot inventory",
      verified: "Snapshot is current, internal, and records an offline-consistent stopped guest state",
      failed: "Snapshot creation or offline consistency verification did not complete successfully; leave the VM stopped for inspection",
      validate: (result) => result?.created && result?.verified && result?.domain === validatedVmSnapshotPlan.input.name && result?.snapshotName === validatedVmSnapshotPlan.input.snapshotName && result?.consistency === "offline-consistent" && result?.independentBackup === false,
    };
    store.addApproval(jobId, ownerId);
    store.recordAudit("job.approved", { actorId: ownerId, subjectId: jobId, details: { type: job.type } });
    store.transitionJob(jobId, "awaiting_approval", "applying");
    store.addJobStep(jobId, "approval", "completed", `Approved by ${owner.username}`);
    store.addJobStep(jobId, "apply", "running", execution.applying);
    return { job, owner, execution };
  }

  async function executePrepared({ job, owner, execution }) {
    const jobId = job.id;
    try {
      const result = execution.timeoutMs
        ? await helper.request(execution.operation, execution.parameters, { timeoutMs: execution.timeoutMs })
        : await helper.request(execution.operation, execution.parameters);
      store.transitionJob(jobId, "applying", "verifying", { result });
      store.addJobStep(jobId, "apply", "completed", execution.applied);
      if (!execution.validate(result)) throw new Error("Helper returned an invalid operation result");
      if (job.type === "application.uptime-kuma.backup") recordBackupResult(job, result);
      if (job.type === "virtualization.domain.export.create") recordVmExportResult(job, result);
      if (job.type === "virtualization.export.backup.create") recordVmProtectionResult(job, result);
      if (job.type === "virtualization.export.backup.restore-drill") recordVmRestoreDrillResult(job, result);
      store.addJobStep(jobId, "verify", "completed", execution.verified);
      const completed = store.transitionJob(jobId, "verifying", "completed", { result });
      store.recordAudit("job.completed", { actorId: owner.id, subjectId: jobId, details: { type: job.type } });
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
        if (job.type === "virtualization.domain.export.create" && error.message.includes("Automated export cleanup completed")) {
          store.addJobStep(jobId, "rollback", "completed", "The incomplete new export directory was removed; the source domain and disks were not changed");
        }
        if (job.type === "virtualization.export.backup.restore-drill" && error.message.includes("Transient drill domain cleanup completed")) {
          store.addJobStep(jobId, "rollback", "completed", "The server-generated transient drill domain was removed; restored files were preserved for inspection");
        }
        store.transitionJob(jobId, current.state, "failed", { error: error.message });
      }
      store.recordAudit("job.failed", { actorId: owner.id, subjectId: jobId, details: { type: job.type } });
      throw error;
    }
  }

  async function approveAndRun(jobId, ownerId, password) {
    return executePrepared(await prepareApproval(jobId, ownerId, password));
  }

  async function approveAndStart(jobId, ownerId, password) {
    const prepared = await prepareApproval(jobId, ownerId, password);
    void executePrepared(prepared).catch(() => {});
    return store.getJob(jobId);
  }

  return { createCanary, approveAndRun, approveAndStart };
}
