import { randomUUID } from "node:crypto";

const shaPattern = /^[a-f0-9]{64}$/;

export function createKeelRecoveryDrillService({ store, helper }) {
  function recovery(recoveryId) {
    const value = store.getApplicationRecovery(recoveryId);
    if (!value || value.applicationId !== "keel" || value.destination !== "managed-keel-recovery"
      || value.state !== "stopped" || value.network !== "none") throw new Error("Stopped Keel recovery clone not found");
    return value;
  }

  async function plan(recoveryId, ownerId) {
    recovery(recoveryId);
    const inspection = await helper.request("application.keel.recovery-drill.inspect", { recoveryId });
    if (!shaPattern.test(inspection.evidenceChecksumSha256 ?? "") || !shaPattern.test(inspection.stateTreeDigestSha256 ?? "")) throw new Error("Stopped Keel recovery evidence is incomplete");
    const input = {
      drillId: randomUUID(),
      recoveryId,
      expectedEvidenceChecksumSha256: inspection.evidenceChecksumSha256,
      expectedStateTreeDigestSha256: inspection.stateTreeDigestSha256,
    };
    const output = {
      executable: inspection.ready === true,
      mode: "isolated-keel-startup-health",
      releaseVersion: inspection.releaseVersion,
      network: inspection.drillNetwork,
      port: inspection.drillPort,
      blockers: inspection.blockers ?? [],
      changes: [
        "Copy the exact stopped recovery into one generated disposable workspace",
        "Run Keel 1.2.6 as its dedicated non-login account in a private network namespace",
        "Verify the fixed Keel health identity and restored SQLite integrity",
        "Stop the drill process and remove the disposable workspace",
      ],
      verification: [
        "Pinned recovery evidence checksum and complete state tree digest",
        "Loopback-only health response inside the private namespace with zero published ports",
        "Clean process stop, healthy SQLite, unchanged source recovery, and removed workspace",
      ],
      warnings: [
        "This starts a disposable copy of sensitive recovered data for health verification. It does not test owner login.",
        "The source recovery remains stopped and production is not promoted, replaced, registered, claimed, or reconfigured.",
        "Passing this drill is evidence for a later promotion decision, not authorization to promote.",
      ],
      recovery: "Failure terminates only the generated drill process and removes only its generated partial workspace. The stopped source recovery and production state remain read-only to the drill service.",
    };
    return store.createPlan({ type: "application.keel.recovery-drill", subjectId: recoveryId, input, output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    recovery(draft.input.recoveryId);
    const inspection = await helper.request("application.keel.recovery-drill.inspect", { recoveryId: draft.input.recoveryId });
    if (inspection.ready !== true || inspection.evidenceChecksumSha256 !== draft.input.expectedEvidenceChecksumSha256
      || inspection.stateTreeDigestSha256 !== draft.input.expectedStateTreeDigestSha256) throw new Error(inspection.blockers?.join(" | ") || "The stopped Keel recovery evidence changed after planning");
    return inspection;
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "application.keel.recovery-drill") throw new Error("Keel recovery drill plan not found");
    if (draft.revision !== revision) throw new Error("Keel recovery drill plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "Keel recovery drill plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "application.keel.recovery-drill.run",
      title: `Run isolated Keel startup rehearsal ${draft.input.drillId}`,
      risk: "high",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: true, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact stopped recovery identity, evidence hash, tree digest, release, and dedicated account validated" },
        { name: "checkpoint", state: "completed", detail: "Source recovery and production are read-only; the process and writable state exist only in one generated private-network workspace" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "application.keel.recovery-drill.run") throw new Error("Unsupported Keel recovery drill job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged Keel recovery drill plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(staged.input) !== JSON.stringify(job.parameters.input)) throw new Error("The Keel recovery drill job inputs do not match the approved plan");
    await revalidate(staged);
    return staged;
  }

  function recordResult(job, result) {
    const input = job.parameters.input;
    if (result?.schemaVersion !== 1 || result?.passed !== true || result?.drillId !== input.drillId || result?.recoveryId !== input.recoveryId
      || result?.applicationId !== "keel" || result?.releaseVersion !== "1.2.6"
      || result?.sourceEvidenceChecksumSha256 !== input.expectedEvidenceChecksumSha256
      || result?.sourceStateTreeDigestSha256 !== input.expectedStateTreeDigestSha256
      || result?.healthIdentityVerified !== true || result?.databaseIntegrity !== "ok" || result?.foreignKeyIssues !== 0 || result?.schemaVerified !== true
      || result?.processStarted !== true || result?.processStopped !== true || result?.network !== "private-loopback-only" || result?.publishedPorts !== 0
      || result?.workspaceRemoved !== true || result?.sourceRecoveryUnchanged !== true || result?.productionStateReplaced !== false
      || result?.productionServiceChanged !== false || result?.claimChanged !== false || result?.registrationChanged !== false
      || result?.loginTested !== false || result?.promotionPerformed !== false) throw new Error("Keel recovery drill evidence validation failed");
    return store.recordApplicationRecoveryDrill({
      id: input.drillId, recoveryId: input.recoveryId, applicationId: "keel", releaseVersion: result.releaseVersion,
      sourceEvidenceChecksumSha256: result.sourceEvidenceChecksumSha256, sourceStateTreeDigestSha256: result.sourceStateTreeDigestSha256,
      network: result.network, healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true,
      processStarted: true, processStopped: true, workspaceRemoved: true, sourceRecoveryUnchanged: true, passed: true, createdBy: job.createdBy,
    });
  }

  function list() {
    return store.listApplicationRecoveryDrills().filter((entry) => entry.applicationId === "keel");
  }

  return { plan, stage, validateJob, recordResult, list };
}
