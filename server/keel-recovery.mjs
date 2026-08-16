import { randomUUID } from "node:crypto";

const shaPattern = /^[a-f0-9]{64}$/;

export function createKeelRecoveryService({ store, helper }) {
  function evidence(backupId) {
    const backup = store.getBackup(backupId);
    if (!backup || backup.applicationId !== "keel" || backup.destination !== "local-managed") throw new Error("Verified local Keel backup not found");
    if (!shaPattern.test(backup.checksumSha256 ?? "") || !Number.isSafeInteger(backup.sizeBytes) || backup.sizeBytes < 1
      || backup.restoreDrill?.passed !== true || backup.restoreDrill?.mode !== "isolated-keel-export-open"
      || backup.restoreDrill?.databaseIntegrity !== "ok" || backup.restoreDrill?.foreignKeyIssues !== 0
      || backup.restoreDrill?.schemaVerified !== true || backup.restoreDrill?.treeDigestMatched !== true
      || !shaPattern.test(backup.restoreDrill?.manifestChecksumSha256 ?? "")
      || backup.restoreDrill?.applicationStarted !== false || backup.restoreDrill?.productionStateReplaced !== false) throw new Error("Keel backup does not have complete local recovery evidence");
    return backup;
  }

  async function plan(backupId, ownerId) {
    const backup = evidence(backupId);
    const input = {
      recoveryId: randomUUID(),
      backupId: backup.id,
      expectedArtifactChecksumSha256: backup.checksumSha256,
      expectedManifestChecksumSha256: backup.restoreDrill.manifestChecksumSha256,
      expectedSizeBytes: backup.sizeBytes,
    };
    const inspection = await helper.request("application.keel.recovery.inspect", input);
    const output = {
      executable: inspection.ready === true,
      destination: "managed-keel-recovery",
      initialState: "stopped",
      network: "none",
      blockers: inspection.blockers ?? [],
      changes: [
        "Rehash the exact BoxPilot-recorded Keel archive and revalidate its immutable result evidence",
        "List every archive member under the single fixed keel-export root before extraction",
        "Extract only into one generated root-only partial recovery directory",
        "Reverify the manifest, complete tree digest, managed-secret format, SQLite integrity, foreign keys, and required schema",
        "Transform portable export companions into a new Keel state layout and validate the clone again",
        "Atomically publish the recovery clone in stopped state without starting an application or attaching a network",
      ],
      verification: [
        "Exact source archive SHA-256, manifest SHA-256, byte size, backup ID, and passing local restore evidence",
        "No links, special files, multiply linked files, absolute paths, parent traversal, or entries outside keel-export",
        "Root-only 0700 directories and 0600 files in the generated recovery root",
        "Cloned database integrity, zero foreign-key issues, required Keel schema, and durable recovery evidence",
      ],
      warnings: [
        "The clone contains notes, users, sessions, credentials, uploads, and private configuration. Treat the entire recovery directory as sensitive.",
        "This is a stopped recovery state, not a production restore. It does not prove owner login or application startup.",
        "Promotion into /var/lib/keel is intentionally unavailable here and will require a separate high-risk plan, fresh backup, rollback checkpoint, and owner approval.",
      ],
      recovery: "Before atomic publication, failure removes only the generated partial directory. After publication the source archive and production /var/lib/keel remain unchanged; BoxPilot never guesses that a recovery clone is safe to delete.",
    };
    return store.createPlan({ type: "application.keel.recovery", subjectId: backup.id, input, output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    const backup = evidence(draft.input.backupId);
    if (backup.checksumSha256 !== draft.input.expectedArtifactChecksumSha256 || backup.sizeBytes !== draft.input.expectedSizeBytes
      || backup.restoreDrill.manifestChecksumSha256 !== draft.input.expectedManifestChecksumSha256) throw new Error("The selected Keel backup evidence changed after planning");
    const inspection = await helper.request("application.keel.recovery.inspect", draft.input);
    if (inspection.ready !== true || inspection.recoveryId !== draft.input.recoveryId || inspection.backupId !== draft.input.backupId
      || inspection.destination !== "managed-keel-recovery" || inspection.initialState !== "stopped" || inspection.network !== "none"
      || inspection.applicationStarted !== false || inspection.productionStateReplaced !== false) throw new Error(inspection.blockers?.join(" | ") || "The Keel recovery target is unavailable or changed");
    return { backup, inspection };
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "application.keel.recovery") throw new Error("Keel recovery plan not found");
    if (draft.revision !== revision) throw new Error("Keel recovery plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "Keel recovery plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "application.keel.recovery.create",
      title: `Create stopped Keel recovery clone ${draft.input.recoveryId}`,
      risk: "high",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: true, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact local backup identity, hash, manifest, byte size, and isolated restore evidence validated" },
        { name: "checkpoint", state: "completed", detail: "Production Keel, source archive, registration, claim, listener, and network remain unchanged; rollback is confined to one generated partial directory" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "application.keel.recovery.create") throw new Error("Unsupported Keel recovery job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged Keel recovery plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The Keel recovery job inputs do not match the approved plan");
    await revalidate(staged);
    return staged;
  }

  function recordResult(job, result) {
    const input = job.parameters.input;
    if (result?.created !== true || result?.recoveryId !== input.recoveryId || result?.backupId !== input.backupId
      || result?.destination !== "managed-keel-recovery" || typeof result?.statePath !== "string" || !result.statePath.endsWith(`/keel-recoveries/${input.recoveryId}/state`)
      || typeof result?.evidencePath !== "string" || !result.evidencePath.endsWith(`/keel-recoveries/${input.recoveryId}/recovery.json`)
      || result?.sourceArtifactChecksumSha256 !== input.expectedArtifactChecksumSha256 || result?.sourceManifestChecksumSha256 !== input.expectedManifestChecksumSha256
      || result?.sourceSizeBytes !== input.expectedSizeBytes || !Number.isSafeInteger(result?.archiveMemberCount) || result.archiveMemberCount < 3 || result.archiveMemberCount > 100000
      || !Number.isSafeInteger(result?.restoredRegularFiles) || result.restoredRegularFiles < 2 || !Number.isSafeInteger(result?.restoredDirectories) || result.restoredDirectories < 1
      || !Number.isSafeInteger(result?.restoredLogicalBytes) || result.restoredLogicalBytes < 1
      || !shaPattern.test(result?.restoredTreeDigestSha256 ?? "") || result?.databaseIntegrity !== "ok" || result?.foreignKeyIssues !== 0 || result?.schemaVerified !== true
      || result?.environmentIncluded !== true || result?.initialState !== "stopped" || result?.network !== "none"
      || result?.applicationStarted !== false || result?.productionStateReplaced !== false || result?.sourceArtifactChanged !== false
      || result?.browserPathAccepted !== false || result?.browserCommandAccepted !== false || result?.promotionPerformed !== false) throw new Error("Keel recovery evidence validation failed");
    return store.recordApplicationRecovery({
      id: input.recoveryId,
      backupId: input.backupId,
      applicationId: "keel",
      destination: "managed-keel-recovery",
      statePath: result.statePath,
      evidencePath: result.evidencePath,
      sizeBytes: result.restoredLogicalBytes,
      state: "stopped",
      network: "none",
      createdBy: job.createdBy,
    });
  }

  function list() {
    return store.listApplicationRecoveries().filter((entry) => entry.applicationId === "keel");
  }

  return { plan, stage, validateJob, recordResult, list };
}
