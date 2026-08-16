import { randomUUID } from "node:crypto";

const shaPattern = /^[a-f0-9]{64}$/;

export function createKeelRollbackService({ store, helper }) {
  function promotion(promotionId) {
    const value = store.getApplicationRecoveryPromotion(promotionId);
    if (!value || value.applicationId !== "keel" || value.releaseVersion !== "1.2.6" || !value.rollbackAvailable
      || !value.healthIdentityVerified || value.databaseIntegrity !== "ok" || value.foreignKeyIssues !== 0 || !value.schemaVerified
      || !value.sourceRecoveryUnchanged || value.ownerLoginTested) throw new Error("Rollback-backed Keel promotion not found");
    if (store.getApplicationRecoveryRollbackByPromotion(promotionId)) throw new Error("This Keel promotion already has a completed operator rollback");
    return value;
  }

  async function plan(promotionId, ownerId) {
    const durable = promotion(promotionId);
    const inspectInput = { promotionId, expectedPreviousStateTreeDigestSha256: durable.previousStateTreeDigestSha256 };
    const inspection = await helper.request("application.keel.rollback.inspect", inspectInput);
    const input = {
      ...inspectInput,
      rollbackId: randomUUID(),
      expectedInstallId: inspection.installId,
      expectedRollbackEvidenceChecksumSha256: inspection.rollbackEvidenceChecksumSha256,
    };
    const output = {
      executable: inspection.ready === true,
      releaseVersion: inspection.releaseVersion,
      network: inspection.network,
      displacedDestination: inspection.displacedDestination,
      sourceCheckpointPreserved: inspection.sourceCheckpointPreserved === true,
      blockers: inspection.blockers ?? [],
      changes: [
        "Copy and revalidate the exact retained pre-promotion checkpoint into one generated rollback candidate",
        "Stop only the exact managed Keel service and verify current SQLite state before exchange",
        "Atomically retain the entire stopped current production state in a new root-only displaced-state checkpoint",
        "Atomically activate the copied pre-promotion checkpoint as /var/lib/keel",
        "Start Keel and require its fixed loopback health identity plus healthy SQLite",
        "Publish durable operator-rollback evidence while preserving the original promotion checkpoint",
      ],
      verification: [
        "Exact promotion UUID, original rollback evidence checksum, previous state-tree digest, and managed install UUID",
        "Production, candidate, and displaced state share one filesystem for atomic directory moves",
        "Current and restored SQLite integrity, zero foreign-key issues, required schema, and fixed Keel health identity",
        "Unchanged original promotion checkpoint, retained displaced production, and unchanged ports, Tailscale, firewall, and router",
      ],
      warnings: [
        "This replaces current notes, users, sessions, credentials, uploads, registration state, and claim state with the retained pre-promotion contents.",
        "Changes made after the promotion move out of production into a root-only local displaced-state checkpoint. Owner login is not tested.",
        "Neither the original checkpoint nor displaced state is an independent encrypted backup.",
        "An interrupted exchange restores the displaced current production before new rollback work is accepted.",
      ],
      recovery: "Any failed apply or verification stops the rollback candidate, restores the exact displaced current production directory, restarts it, requires its health identity, and removes only generated candidate and incomplete displaced-checkpoint paths.",
    };
    return store.createPlan({ type: "application.keel.rollback", subjectId: promotionId, input, output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    const durable = promotion(draft.input.promotionId);
    if (durable.previousStateTreeDigestSha256 !== draft.input.expectedPreviousStateTreeDigestSha256) throw new Error("The durable Keel promotion rollback digest changed after planning");
    const inspection = await helper.request("application.keel.rollback.inspect", {
      promotionId: draft.input.promotionId,
      expectedPreviousStateTreeDigestSha256: draft.input.expectedPreviousStateTreeDigestSha256,
    });
    if (inspection.ready !== true || inspection.installId !== draft.input.expectedInstallId
      || inspection.rollbackEvidenceChecksumSha256 !== draft.input.expectedRollbackEvidenceChecksumSha256) throw new Error(inspection.blockers?.join(" | ") || "The managed Keel rollback boundary changed after planning");
    return inspection;
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "application.keel.rollback") throw new Error("Keel operator rollback plan not found");
    if (draft.revision !== revision) throw new Error("Keel rollback plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "Keel rollback plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "application.keel.rollback",
      title: `Roll back Keel promotion ${draft.input.promotionId}`,
      risk: "critical",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: true, reason: draft.output.recovery, manual: "If both rollback candidate and displaced production health fail, keep Keel stopped and inspect the root-only displaced-state checkpoint named in the job evidence." },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact retained checkpoint, healthy managed installation, and same-filesystem displaced-state boundary validated" },
        { name: "checkpoint", state: "pending", detail: "The static rollback unit will stop only Keel and atomically retain the entire current production state before restoring the earlier checkpoint" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "application.keel.rollback") throw new Error("Unsupported Keel operator rollback job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged Keel rollback plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(staged.input) !== JSON.stringify(job.parameters.input)) throw new Error("The Keel rollback job inputs do not match the approved plan");
    await revalidate(staged);
    return staged;
  }

  function recordResult(job, result) {
    const input = job.parameters.input;
    if (result?.schemaVersion !== 1 || result?.passed !== true || result?.rollbackId !== input.rollbackId || result?.promotionId !== input.promotionId
      || result?.applicationId !== "keel" || result?.releaseVersion !== "1.2.6" || result?.installId !== input.expectedInstallId
      || result?.sourceRollbackEvidenceChecksumSha256 !== input.expectedRollbackEvidenceChecksumSha256
      || result?.sourcePreviousStateTreeDigestSha256 !== input.expectedPreviousStateTreeDigestSha256
      || result?.restoredStateTreeDigestSha256 !== input.expectedPreviousStateTreeDigestSha256 || !shaPattern.test(result?.displacedStateTreeDigestSha256 ?? "")
      || result?.displacedStatePath !== `/var/lib/boxpilot-managed/keel-rollback-checkpoints/${input.rollbackId}/state`
      || result?.displacedEvidencePath !== `/var/lib/boxpilot-managed/keel-rollback-checkpoints/${input.rollbackId}/checkpoint.json`
      || result?.displacedStateRetained !== true || result?.sourceRollbackCheckpointUnchanged !== true || result?.rollbackRequested !== true
      || result?.productionStateReplaced !== true || result?.healthIdentityVerified !== true || result?.databaseIntegrity !== "ok"
      || result?.foreignKeyIssues !== 0 || result?.schemaVerified !== true || result?.automaticFailureRecoveryTested !== false || result?.ownerLoginTested !== false
      || result?.network !== "host-loopback-only" || result?.publishedPortsChanged !== false || result?.tailscaleChanged !== false
      || result?.firewallChanged !== false || result?.routerChanged !== false || result?.browserPathAccepted !== false
      || result?.browserCommandAccepted !== false || result?.browserTokenAccepted !== false) throw new Error("Keel operator rollback evidence validation failed");
    return store.recordApplicationRecoveryRollback({
      id: input.rollbackId, promotionId: input.promotionId, applicationId: "keel", releaseVersion: result.releaseVersion,
      installId: result.installId, sourceRollbackEvidenceChecksumSha256: result.sourceRollbackEvidenceChecksumSha256,
      sourcePreviousStateTreeDigestSha256: result.sourcePreviousStateTreeDigestSha256, restoredStateTreeDigestSha256: result.restoredStateTreeDigestSha256,
      displacedStateTreeDigestSha256: result.displacedStateTreeDigestSha256, displacedStatePath: result.displacedStatePath,
      displacedEvidencePath: result.displacedEvidencePath, healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0,
      schemaVerified: true, displacedStateRetained: true, sourceRollbackCheckpointUnchanged: true, ownerLoginTested: false, createdBy: job.createdBy,
    });
  }

  function list() {
    return store.listApplicationRecoveryRollbacks().filter((entry) => entry.applicationId === "keel");
  }

  return { plan, stage, validateJob, recordResult, list };
}
