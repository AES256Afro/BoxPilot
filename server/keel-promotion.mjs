import { randomUUID } from "node:crypto";

const shaPattern = /^[a-f0-9]{64}$/;

export function createKeelPromotionService({ store, helper }) {
  function recovery(recoveryId) {
    const value = store.getApplicationRecovery(recoveryId);
    if (!value || value.applicationId !== "keel" || value.destination !== "managed-keel-recovery" || value.state !== "stopped" || value.network !== "none") throw new Error("Stopped Keel recovery clone not found");
    return value;
  }

  function passingDrill(recoveryId) {
    const value = store.listApplicationRecoveryDrills(200).find((drill) => drill.recoveryId === recoveryId && drill.applicationId === "keel" && drill.releaseVersion === "1.2.6");
    if (!value || !value.passed || !value.healthIdentityVerified || value.databaseIntegrity !== "ok" || value.foreignKeyIssues !== 0
      || !value.schemaVerified || !value.processStarted || !value.processStopped || !value.workspaceRemoved || !value.sourceRecoveryUnchanged
      || value.network !== "private-loopback-only" || !shaPattern.test(value.sourceEvidenceChecksumSha256 ?? "")
      || !shaPattern.test(value.sourceStateTreeDigestSha256 ?? "")) throw new Error("The latest isolated Keel startup rehearsal must pass before production promotion");
    return value;
  }

  async function plan(recoveryId, ownerId) {
    recovery(recoveryId);
    const drill = passingDrill(recoveryId);
    const inspectInput = {
      recoveryId,
      drillId: drill.id,
      expectedEvidenceChecksumSha256: drill.sourceEvidenceChecksumSha256,
      expectedStateTreeDigestSha256: drill.sourceStateTreeDigestSha256,
    };
    const inspection = await helper.request("application.keel.promotion.inspect", inspectInput);
    const input = { ...inspectInput, promotionId: randomUUID(), expectedInstallId: inspection.installId };
    const output = {
      executable: inspection.ready === true,
      releaseVersion: inspection.releaseVersion,
      network: inspection.network,
      rollbackDestination: inspection.rollbackDestination,
      blockers: inspection.blockers ?? [],
      changes: [
        "Copy and revalidate the exact stopped recovery into one generated promotion candidate",
        "Stop only the exact managed Keel service and verify its SQLite state before exchange",
        "Atomically move the stopped current production state into a root-only rollback checkpoint",
        "Atomically activate the drilled recovery state as /var/lib/keel",
        "Start Keel and require its fixed loopback health identity plus healthy SQLite",
        "Publish durable promotion and rollback evidence while preserving the source recovery",
      ],
      verification: [
        "Exact recovery UUID, passing drill UUID, evidence checksum, complete state-tree digest, and managed install UUID",
        "Production, candidate, and rollback state share one filesystem for atomic directory moves",
        "Previous and promoted SQLite integrity, zero foreign-key issues, required schema, and fixed Keel health identity",
        "Unchanged source recovery, retained prior production rollback, unchanged published ports, Tailscale, firewall, and router",
      ],
      warnings: [
        "This replaces production notes, users, sessions, credentials, uploads, registration state, and claim state with the selected recovery contents.",
        "Keel is briefly unavailable while the old state is stopped and checkpointed. Owner login is not tested by this job.",
        "The rollback checkpoint is local to this server and is not an independent encrypted backup.",
        "An interrupted directory exchange is reconciled by the same fixed no-argument unit, which restores previous production before new work is accepted.",
      ],
      recovery: "Any failed apply or verification stops the promoted service, restores the exact previous production directory, restarts it, requires its health identity, and removes only generated candidate and incomplete checkpoint paths.",
    };
    return store.createPlan({ type: "application.keel.promotion", subjectId: recoveryId, input, output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    recovery(draft.input.recoveryId);
    const drill = passingDrill(draft.input.recoveryId);
    if (drill.id !== draft.input.drillId || drill.sourceEvidenceChecksumSha256 !== draft.input.expectedEvidenceChecksumSha256
      || drill.sourceStateTreeDigestSha256 !== draft.input.expectedStateTreeDigestSha256) throw new Error("The passing Keel recovery drill changed after planning");
    const inspection = await helper.request("application.keel.promotion.inspect", {
      recoveryId: draft.input.recoveryId,
      drillId: draft.input.drillId,
      expectedEvidenceChecksumSha256: draft.input.expectedEvidenceChecksumSha256,
      expectedStateTreeDigestSha256: draft.input.expectedStateTreeDigestSha256,
    });
    if (inspection.ready !== true || inspection.installId !== draft.input.expectedInstallId) throw new Error(inspection.blockers?.join(" | ") || "The managed Keel production identity changed after planning");
    return inspection;
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "application.keel.promotion") throw new Error("Keel production promotion plan not found");
    if (draft.revision !== revision) throw new Error("Keel promotion plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "Keel promotion plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "application.keel.promotion",
      title: `Promote drilled Keel recovery ${draft.input.recoveryId}`,
      risk: "critical",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: true, reason: draft.output.recovery, manual: "If both promoted and restored production health fail, keep Keel stopped and inspect the root-only rollback checkpoint named in the job evidence." },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact stopped recovery, passing private startup drill, healthy managed installation, and same-filesystem rollback boundary validated" },
        { name: "checkpoint", state: "pending", detail: "The static promotion unit will stop only Keel and atomically retain the entire previous production state before activation" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "application.keel.promotion") throw new Error("Unsupported Keel production promotion job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged Keel promotion plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(staged.input) !== JSON.stringify(job.parameters.input)) throw new Error("The Keel promotion job inputs do not match the approved plan");
    await revalidate(staged);
    return staged;
  }

  function recordResult(job, result) {
    const input = job.parameters.input;
    if (result?.schemaVersion !== 1 || result?.passed !== true || result?.promotionId !== input.promotionId
      || result?.recoveryId !== input.recoveryId || result?.drillId !== input.drillId || result?.applicationId !== "keel"
      || result?.releaseVersion !== "1.2.6" || result?.previousInstallId !== input.expectedInstallId
      || result?.sourceEvidenceChecksumSha256 !== input.expectedEvidenceChecksumSha256
      || result?.sourceStateTreeDigestSha256 !== input.expectedStateTreeDigestSha256
      || result?.promotedStateTreeDigestSha256 !== input.expectedStateTreeDigestSha256 || !shaPattern.test(result?.previousStateTreeDigestSha256 ?? "")
      || typeof result?.rollbackPath !== "string" || !result.rollbackPath.endsWith(`/keel-promotion-rollbacks/${input.promotionId}/state`)
      || typeof result?.rollbackEvidencePath !== "string" || !result.rollbackEvidencePath.endsWith(`/keel-promotion-rollbacks/${input.promotionId}/rollback.json`)
      || result?.rollbackAvailable !== true || result?.healthIdentityVerified !== true || result?.databaseIntegrity !== "ok"
      || result?.foreignKeyIssues !== 0 || result?.schemaVerified !== true || result?.productionStateReplaced !== true
      || result?.sourceRecoveryUnchanged !== true || result?.registrationStateRestoredFromRecovery !== true
      || result?.claimStateRestoredFromRecovery !== true || result?.ownerLoginTested !== false
      || result?.network !== "host-loopback-only" || result?.publishedPortsChanged !== false
      || result?.tailscaleChanged !== false || result?.firewallChanged !== false || result?.routerChanged !== false
      || result?.browserPathAccepted !== false || result?.browserCommandAccepted !== false || result?.browserTokenAccepted !== false) throw new Error("Keel production promotion evidence validation failed");
    return store.recordApplicationRecoveryPromotion({
      id: input.promotionId, recoveryId: input.recoveryId, drillId: input.drillId, applicationId: "keel", releaseVersion: result.releaseVersion,
      previousInstallId: result.previousInstallId, sourceEvidenceChecksumSha256: result.sourceEvidenceChecksumSha256,
      sourceStateTreeDigestSha256: result.sourceStateTreeDigestSha256, previousStateTreeDigestSha256: result.previousStateTreeDigestSha256,
      promotedStateTreeDigestSha256: result.promotedStateTreeDigestSha256, rollbackPath: result.rollbackPath,
      rollbackEvidencePath: result.rollbackEvidencePath, healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0,
      schemaVerified: true, rollbackAvailable: true, sourceRecoveryUnchanged: true, ownerLoginTested: false, createdBy: job.createdBy,
    });
  }

  function list() {
    return store.listApplicationRecoveryPromotions().filter((entry) => entry.applicationId === "keel");
  }

  return { plan, stage, validateJob, recordResult, list };
}
