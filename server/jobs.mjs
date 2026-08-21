import { verifyPassword } from "./security.mjs";
import { approvalRequirement, defaultApprovalMode, elevationTtlMs, normalizeApprovalMode } from "./ops/risk.mjs";
import { registry } from "./ops/index.mjs";

export function createJobService(store, helper, {
  jobLog = null,
  operationRecordHooks = {},
  operationPrepareHooks = {},
  validateVmCreationJob = async () => {},
  validateVmMediaImportJob = async () => {},
  validateVmExportJob = async () => {},
  validateVmProtectionJob = async () => {},
  validateVmRetentionJob = async () => {},
  validateVmRestoreDrillJob = async () => {},
  validateVmRecoveryJob = async () => {},
  recordVmExportResult = () => {},
  recordVmProtectionResult = () => {},
  recordVmRetentionResult = () => {},
  recordVmRestoreDrillResult = () => {},
  recordVmRecoveryResult = () => {},
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
    const approvalMethod = passwordProvided ? "password" : policy.elevated && policy.tier === "high" ? "elevated" : "confirm";
    const registeredOperation = job.type.startsWith("op:") ? registry.get(job.type.slice(3)) : null;
    if (job.type.startsWith("op:") && !registeredOperation) throw new Error("Job type is not supported by this executor");
    if (registeredOperation) {
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
    if (!["virtualization.media.import", "virtualization.domain.create", "virtualization.domain.export.create", "virtualization.export.backup.create", "virtualization.export.backup.retention.apply", "virtualization.export.backup.restore-drill", "virtualization.backup.recovery.create"].includes(job.type)) throw new Error("Job type is not supported by this executor");
    const validatedVmPlan = job.type === "virtualization.domain.create" ? await validateVmCreationJob(job) : null;
    const validatedVmMediaImportPlan = job.type === "virtualization.media.import" ? await validateVmMediaImportJob(job) : null;
    const validatedVmExportPlan = job.type === "virtualization.domain.export.create" ? await validateVmExportJob(job) : null;
    const validatedVmProtectionPlan = job.type === "virtualization.export.backup.create" ? await validateVmProtectionJob(job) : null;
    const validatedVmRetentionPlan = job.type === "virtualization.export.backup.retention.apply" ? await validateVmRetentionJob(job) : null;
    const validatedVmRestoreDrillPlan = job.type === "virtualization.export.backup.restore-drill" ? await validateVmRestoreDrillJob(job) : null;
    const validatedVmRecoveryPlan = job.type === "virtualization.backup.recovery.create" ? await validateVmRecoveryJob(job) : null;
    if (job.type === "virtualization.domain.create" && !validatedVmPlan?.input) throw new Error("The staged VM creation plan is unavailable or changed");
    if (job.type === "virtualization.media.import" && !validatedVmMediaImportPlan?.input) throw new Error("The staged VM media import plan is unavailable or changed");
    if (job.type === "virtualization.domain.export.create" && !validatedVmExportPlan?.input) throw new Error("The staged VM export plan is unavailable or changed");
    if (job.type === "virtualization.export.backup.create" && !validatedVmProtectionPlan?.input) throw new Error("The staged VM protection plan is unavailable or changed");
    if (job.type === "virtualization.export.backup.retention.apply" && !validatedVmRetentionPlan?.input) throw new Error("The staged VM retention plan is unavailable or changed");
    if (job.type === "virtualization.export.backup.restore-drill" && !validatedVmRestoreDrillPlan?.input) throw new Error("The staged VM restore drill plan is unavailable or changed");
    if (job.type === "virtualization.backup.recovery.create" && !validatedVmRecoveryPlan?.input) throw new Error("The staged VM recovery plan is unavailable or changed");
    const execution = job.type === "virtualization.media.import" ? {
      operation: "virtualization.media.import",
      parameters: validatedVmMediaImportPlan.input,
      timeoutMs: 6 * 60 * 60 * 1000,
      applying: "Copying the exact staged ISO into the fixed libvirt media library through the restricted helper",
      applied: "The helper published the new ISO atomically after complete source and destination SHA-256 verification",
      verified: "Filename, byte count, SHA-256, destination confinement, non-overwrite, and no-libvirt-mutation boundaries passed",
      failed: "VM media import or final verification did not complete; existing media remains unchanged and the staged upload should remain available",
      validate: (result) => result?.imported === true && result?.verified === true
        && result?.importId === validatedVmMediaImportPlan.input.importId
        && result?.filename === validatedVmMediaImportPlan.input.filename
        && result?.sizeBytes === validatedVmMediaImportPlan.input.expectedSizeBytes
        && result?.sha256 === validatedVmMediaImportPlan.input.expectedSha256
        && result?.boundary?.existingMediaOverwritten === false
        && result?.boundary?.arbitraryPathAccepted === false
        && result?.boundary?.virtualMachineCreated === false
        && result?.boundary?.libvirtChanged === false,
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
    } : job.type === "virtualization.export.backup.retention.apply" ? {
      operation: "virtualization.export.backup.retention.apply",
      parameters: validatedVmRetentionPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Forgetting only the exact reviewed old protected snapshot references through the restricted helper",
      applied: "Restic removed the approved snapshot metadata without running prune or changing source VMs and local exports",
      verified: "A full repository data read passed, every approved snapshot is absent, and every noncandidate snapshot remains",
      failed: "VM retention did not complete or verify; do not retry until repository and durable backup evidence are inspected",
      validate: (result) => result?.applied && result?.complete === true && result?.retentionId === validatedVmRetentionPlan.input.retentionId && result?.repositoryId === validatedVmRetentionPlan.input.repositoryId && result?.repositoryVerified === true && result?.prunePerformed === false && result?.spaceReclaimed === false,
    } : job.type === "virtualization.export.backup.restore-drill" ? {
      operation: "virtualization.export.backup.restore-drill",
      parameters: validatedVmRestoreDrillPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Restoring the exact encrypted snapshot and booting its disks as a transient no-network domain through the restricted helper",
      applied: "Restic restored and reverified the snapshot; the transient domain started without a network interface",
      verified: "Restored checksums and qcow2 structures, repeated guest-agent health, transient isolation, and complete successful cleanup passed",
      failed: "The isolated restore drill did not complete; protected status remains false and the restored workspace is preserved for inspection",
      validate: (result) => result?.passed && result?.drillId === validatedVmRestoreDrillPlan.input.drillId && result?.backupId === validatedVmRestoreDrillPlan.input.backupId && result?.network === "none" && result?.transient === true && result?.persistentDomainCreated === false && result?.guestAgentPing === true && result?.temporaryQemuDiskAccessGranted === true && result?.temporaryQemuDiskAccessRemoved === true && result?.transientFirmwareStateRemoved === true && result?.cleanupVerified === true && result?.protected === true,
    } : job.type === "virtualization.backup.recovery.create" ? {
      operation: "virtualization.backup.recovery.create",
      parameters: validatedVmRecoveryPlan.input,
      timeoutMs: 12 * 60 * 60 * 1000,
      applying: "Restoring the exact protected snapshot and materializing verified disks in a new managed recovery directory",
      applied: "Verified recovery disks were materialized and a new persistent no-network libvirt domain was defined",
      verified: "The recovery clone is stopped, persistent, non-autostarting, network-isolated, and tied to exact protected source evidence",
      failed: "The recovery clone did not complete; BoxPilot confined rollback to the new target name and server-generated recovery directory",
      validate: (result) => result?.created && result?.restoreId === validatedVmRecoveryPlan.input.restoreId && result?.backupId === validatedVmRecoveryPlan.input.backupId && result?.domain === validatedVmRecoveryPlan.input.targetDomainName && result?.persistent === true && result?.state === "stopped" && result?.network === "none" && result?.autostart === false && result?.sourceUnchanged === true && result?.snapshotUnchanged === true,
    } : (() => { throw new Error("Job type is not supported by this executor"); })();
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
      if (job.type === "virtualization.export.backup.retention.apply" && result?.applied === true) recordVmRetentionResult(job, result);
      if (!execution.validate(result)) throw new Error(execution.run ? "Operation returned an invalid result" : "Helper returned an invalid operation result");
      // Registry ops with durable evidence record it web-side; a failed record fails the job.
      if (job.type.startsWith("op:")) operationRecordHooks[job.type.slice(3)]?.(job, result);
      if (job.type === "virtualization.domain.export.create") recordVmExportResult(job, result);
      if (job.type === "virtualization.export.backup.create") recordVmProtectionResult(job, result);
      if (job.type === "virtualization.export.backup.restore-drill") recordVmRestoreDrillResult(job, result);
      if (job.type === "virtualization.backup.recovery.create") recordVmRecoveryResult(job, result);
      store.addJobStep(jobId, "verify", "completed", execution.verified);
      const completed = store.transitionJob(jobId, "verifying", "completed", { result });
      store.recordAudit("job.completed", { actorId: owner.id, subjectId: jobId, details: { type: job.type } });
      await persistJobOutput(jobId);
      return completed;
    } catch (error) {
      const current = store.getJob(jobId);
      if (["applying", "verifying"].includes(current?.state)) {
        store.addJobStep(jobId, "verify", "failed", execution.failed);
        if (job.type === "virtualization.domain.create" && error.message.includes("Automated rollback completed")) {
          store.addJobStep(jobId, "rollback", "completed", "The newly created exact-name domain and its allocated storage were removed");
        }
        if (job.type === "virtualization.media.import" && error.message.includes("Existing managed media was unchanged")) {
          store.addJobStep(jobId, "rollback", "completed", "Only the generated import partial or newly published exact-name ISO was removed; the staged upload and existing managed media were preserved");
        }
        if (job.type === "virtualization.domain.export.create" && error.message.includes("Automated export cleanup completed")) {
          store.addJobStep(jobId, "rollback", "completed", "The incomplete new export directory was removed; the source domain and disks were not changed");
        }
        if (job.type === "virtualization.export.backup.restore-drill" && error.message.includes("Transient drill domain cleanup completed")) {
          store.addJobStep(jobId, "rollback", "completed", "The server-generated transient drill domain was removed; restored files were preserved for inspection");
        }
        if (job.type === "virtualization.backup.recovery.create" && error.message.includes("Automatic recovery-clone rollback removed")) {
          store.addJobStep(jobId, "rollback", "completed", "The incomplete new recovery domain definition and its server-generated disk directory were removed; protected source evidence was unchanged");
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
  async function createOperationJob(operationId, parameters, ownerId) {
    const operation = registry.get(operationId);
    if (!operation) throw new Error("Operation not found");
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
