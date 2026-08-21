import { randomUUID } from "node:crypto";

const dayMs = 24 * 60 * 60 * 1000;
const minimumAgeDays = 30;
const minimumCopies = 3;

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectRetentionCandidates({ protections, activeConsumers = [], now }) {
  const activeBackupIds = new Set(activeConsumers.map((consumer) => consumer.backupId).filter(Boolean));
  const activeProtectionIds = new Set(activeConsumers.map((consumer) => consumer.protectionId).filter(Boolean));
  const activeSnapshotIds = new Set(activeConsumers.flatMap((consumer) => consumer.snapshotIds ?? []).filter(Boolean));
  const active = protections.filter((protection) => protection.retained !== false)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const candidates = [];
  const kept = [];
  active.forEach((protection, index) => {
    const created = new Date(protection.createdAt).getTime();
    const ageDays = Number.isFinite(created) ? Math.max(0, Math.floor((now.getTime() - created) / dayMs)) : 0;
    const reasons = [];
    if (index < minimumCopies) reasons.push("minimum-copies");
    if (ageDays < minimumAgeDays) reasons.push("minimum-age");
    if (!protection.protected || protection.restoreDrill?.passed !== true) reasons.push("not-restore-tested");
    if (activeBackupIds.has(protection.backupId) || activeProtectionIds.has(protection.id) || activeSnapshotIds.has(protection.snapshotId)) reasons.push("active-controller-operation");
    const entry = {
      protectionId: protection.id,
      backupId: protection.backupId,
      snapshotId: protection.snapshotId,
      createdAt: protection.createdAt,
      ageDays,
      sizeBytes: protection.sizeBytes,
    };
    if (reasons.length === 0) candidates.push(entry);
    else kept.push({ ...entry, reasons });
  });
  return {
    candidates: candidates.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.snapshotId.localeCompare(right.snapshotId)),
    kept: kept.sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)),
  };
}

export function createControllerRetentionService({ store, helper, now = () => new Date() }) {
  async function buildPreview(retentionId = randomUUID()) {
    const inspection = await helper.request("controller.database.protection.retention.inspect", {});
    const protections = store.listAllControllerBackupProtections();
    const activeConsumers = store.listActiveJobs()
      .filter((job) => ["controller.database.backup.protect", "controller.database.backup.retention.apply"].includes(job.type))
      .map((job) => ({
        backupId: job.parameters?.input?.backupId,
        protectionId: job.parameters?.input?.protectionId,
        snapshotIds: job.type === "controller.database.backup.retention.apply" ? job.parameters?.input?.forgetSnapshotIds : [],
      }));
    const blockers = [...(inspection.blockers ?? [])];
    const active = protections.filter((protection) => protection.retained !== false && protection.repositoryId === inspection.repositoryId);
    const activeBySnapshot = new Map(active.map((protection) => [protection.snapshotId, protection]));
    const repositoryIds = new Set((inspection.snapshots ?? []).map((snapshot) => snapshot.id));
    const unknownSnapshots = (inspection.snapshots ?? []).filter((snapshot) => !activeBySnapshot.has(snapshot.id));
    const missingSnapshots = active.filter((protection) => !repositoryIds.has(protection.snapshotId));
    if (unknownSnapshots.length) blockers.push(`${unknownSnapshots.length} BoxPilot-tagged controller snapshot(s) are not attributable to active protection records`);
    if (missingSnapshots.length) blockers.push(`${missingSnapshots.length} active controller protection record(s) are missing from the repository`);
    const selection = selectRetentionCandidates({ protections: active, activeConsumers, now: now() });
    if (selection.candidates.length === 0) blockers.push("No controller snapshot satisfies the fixed retention eligibility policy");
    const candidates = selection.candidates.slice(0, 100);
    const deferred = selection.candidates.slice(100).map((candidate) => ({ ...candidate, reasons: ["batch-limit"] }));
    const forgetSnapshotIds = candidates.map((candidate) => candidate.snapshotId).sort();
    const input = {
      retentionId,
      repositoryId: inspection.repositoryId,
      expectedDestinationRevision: inspection.destinationRevision,
      expectedSnapshotSetRevision: inspection.snapshotSetRevision,
      forgetSnapshotIds,
    };
    return {
      input,
      output: {
        executable: inspection.ready === true && blockers.length === 0 && forgetSnapshotIds.length > 0,
        policy: { minimumCopies, minimumAgeDays, requiresProtectedRestoreDrill: true, preserveActiveControllerOperations: true },
        repositoryId: inspection.repositoryId,
        beforeCount: inspection.snapshots?.length ?? 0,
        candidates,
        kept: [...selection.kept, ...deferred].sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)),
        retentionRuns: store.listControllerRetentionRuns(),
        blockers,
        changes: [
          `Forget exactly ${forgetSnapshotIds.length} reviewed controller restic snapshot metadata record(s)`,
          "Read and verify every remaining controller repository data pack after the mutation",
          "Record the exact forgotten protection and snapshot ids in durable state",
          "Keep the live database, every local controller artifact, and all noncandidate snapshots unchanged",
        ],
        warnings: [
          "Forgetting removes the selected snapshot references and cannot be automatically undone.",
          "This release deliberately does not run restic prune, so unreferenced pack data is not reclaimed yet.",
          "A changed mount, repository identity, snapshot set, protection record, restore result, or active controller job invalidates approval.",
          "BoxPilot does not yet execute a controller production restore, so no recovery-object retention claim is made.",
          ...(deferred.length ? [`${deferred.length} additional eligible snapshot(s) are deferred to a later bounded batch.`] : []),
        ],
        verification: ["Exact pre-mutation snapshot-set revision", "Full post-forget repository data read", "Every approved id absent", "Every noncandidate id still present"],
        prunePerformed: false,
        spaceReclaimed: false,
        recovery: "The live controller database and local verified artifacts remain unchanged. Because restic prune is not run, pack data may still exist, but BoxPilot does not claim that a forgotten snapshot can be recovered. Restore from another retained protected snapshot.",
      },
    };
  }

  async function inspect() {
    return (await buildPreview()).output;
  }

  /** Pin the current candidate set and repository revisions (staging-time, server-derived). */
  async function prepareOperation() {
    const preview = await buildPreview();
    if (!preview.output.executable) throw new Error(preview.output.blockers?.[0] ?? "Controller retention is not currently executable");
    return { ...preview.input, candidates: preview.output.candidates, expectedBeforeCount: preview.output.beforeCount };
  }

  function recordOperation(job, result) {
    const input = job.parameters;
    const approved = new Set(input.forgetSnapshotIds);
    const actualSnapshotIds = Array.isArray(result?.forgottenSnapshotIds) ? result.forgottenSnapshotIds : [];
    const actualSet = new Set(actualSnapshotIds);
    const forgotten = input.candidates
      .filter((candidate) => actualSet.has(candidate.snapshotId))
      .map((candidate) => ({ protectionId: candidate.protectionId, backupId: candidate.backupId, snapshotId: candidate.snapshotId }));
    if (result?.applied !== true || result?.retentionId !== input.retentionId || result?.repositoryId !== input.repositoryId
      || result?.beforeSnapshotSetRevision !== input.expectedSnapshotSetRevision || result?.beforeCount !== input.expectedBeforeCount
      || actualSnapshotIds.length < 1 || actualSet.size !== actualSnapshotIds.length || actualSnapshotIds.some((id) => !approved.has(id))
      || forgotten.length !== actualSnapshotIds.length || result?.prunePerformed !== false || result?.spaceReclaimed !== false
      || (result?.repositoryVerified === true && (result?.complete !== true || !sameArray(actualSnapshotIds, input.forgetSnapshotIds)
        || result?.afterCount !== result?.beforeCount - forgotten.length || typeof result?.afterSnapshotSetRevision !== "string"))) {
      throw new Error("Controller retention evidence validation failed");
    }
    return store.recordControllerRetention({
      id: result.retentionId,
      repositoryId: result.repositoryId,
      beforeSnapshotSetRevision: result.beforeSnapshotSetRevision,
      afterSnapshotSetRevision: result.afterSnapshotSetRevision,
      beforeCount: result.beforeCount,
      afterCount: result.afterCount,
      forgotten,
      keptSnapshotIds: result.keptSnapshotIds,
      repositoryVerified: result.repositoryVerified === true,
      complete: result.complete === true,
      prunePerformed: false,
      verification: result.verification ?? [],
      createdBy: job.createdBy,
    });
  }

  return { inspect, prepareOperation, recordOperation };
}

export const controllerRetentionInternals = { minimumAgeDays, minimumCopies, selectRetentionCandidates };
