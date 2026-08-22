import { randomUUID } from "node:crypto";

const dayMs = 24 * 60 * 60 * 1000;
const minimumAgeDays = 30;
const minimumCopiesPerDomain = 3;

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectRetentionCandidates({ backups, recoveries, activeConsumers = [], now }) {
  const active = backups.filter((backup) => backup.retained !== false);
  const recoverySources = new Set(recoveries.map((recovery) => recovery.backupId));
  const activeConsumerSources = new Set(activeConsumers.map((consumer) => consumer.backupId));
  const grouped = new Map();
  for (const backup of active) {
    const entries = grouped.get(backup.domainUuid) ?? [];
    entries.push(backup);
    grouped.set(backup.domainUuid, entries);
  }
  const candidates = [];
  const kept = [];
  for (const entries of grouped.values()) {
    entries.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    entries.forEach((backup, index) => {
      const created = new Date(backup.createdAt).getTime();
      const ageDays = Number.isFinite(created) ? Math.max(0, Math.floor((now.getTime() - created) / dayMs)) : 0;
      const reasons = [];
      if (index < minimumCopiesPerDomain) reasons.push("minimum-copies");
      if (ageDays < minimumAgeDays) reasons.push("minimum-age");
      if (!backup.protected || backup.restoreDrill?.passed !== true) reasons.push("not-restore-tested");
      if (recoverySources.has(backup.id)) reasons.push("recovery-source");
      if (activeConsumerSources.has(backup.id)) reasons.push("active-restore-or-recovery");
      const entry = {
        backupId: backup.id,
        snapshotId: backup.snapshotId,
        domainName: backup.domainName,
        domainUuid: backup.domainUuid,
        createdAt: backup.createdAt,
        ageDays,
        sizeBytes: backup.sizeBytes,
      };
      if (reasons.length === 0) candidates.push(entry);
      else kept.push({ ...entry, reasons });
    });
  }
  return {
    candidates: candidates.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.snapshotId.localeCompare(right.snapshotId)),
    kept: kept.sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)),
  };
}

export function createVmRetentionService({ store, helper, now = () => new Date() }) {
  async function buildPreview(retentionId = randomUUID()) {
    const inspection = await helper.request("virtualization.export.backup.retention.inspect", {});
    const backups = store.listAllVmBackups();
    const recoveries = store.listAllVmRecoveries();
    // Same shape as the controller side: "op:<operation id>", flat parameters. These are the
    // backups a drill or a recovery is using right now, which retention must not remove.
    const activeSnapshotConsumers = store.listActiveJobs()
      .filter((job) => ["op:vm.backup.restore-drill", "op:vm.recovery.create"].includes(job.type))
      .map((job) => ({ backupId: job.parameters?.backupId }))
      .filter((item) => typeof item.backupId === "string");
    const blockers = [...(inspection.blockers ?? [])];
    const active = backups.filter((backup) => backup.retained !== false && backup.repositoryId === inspection.repositoryId);
    const activeBySnapshot = new Map(active.map((backup) => [backup.snapshotId, backup]));
    const repositoryIds = new Set((inspection.snapshots ?? []).map((snapshot) => snapshot.id));
    const unknownSnapshots = (inspection.snapshots ?? []).filter((snapshot) => !activeBySnapshot.has(snapshot.id));
    const missingSnapshots = active.filter((backup) => !repositoryIds.has(backup.snapshotId));
    // An unattributable snapshot is usually one whose backup was written and then failed its
    // verification, so no local record exists. It blocks retention for ever with nothing in the UI
    // to clear it, so say what it is and what to do rather than reporting a bare count.
    if (unknownSnapshots.length) {
      const ids = unknownSnapshots.slice(0, 3).map((snapshot) => snapshot.id.slice(0, 8)).join(", ");
      blockers.push(`${unknownSnapshots.length} snapshot(s) in the repository (${ids}${unknownSnapshots.length > 3 ? ", …" : ""}) have no local record — usually a backup that was written and then failed its check. Retention will not remove what it cannot account for: run "Forget an unrecorded snapshot" from the Virtual Machines page, or remove them with restic yourself.`);
    }
    if (missingSnapshots.length) blockers.push(`${missingSnapshots.length} active local backup record(s) are missing from the repository`);
    const selection = selectRetentionCandidates({ backups: active, recoveries, activeConsumers: activeSnapshotConsumers, now: now() });
    if (selection.candidates.length === 0) blockers.push("No backup satisfies the fixed retention eligibility policy");
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
        policy: { minimumCopiesPerDomain, minimumAgeDays, requiresProtectedRestoreDrill: true, preserveRecoverySources: true },
        repositoryId: inspection.repositoryId,
        beforeCount: inspection.snapshots?.length ?? 0,
        unrecordedSnapshotIds: unknownSnapshots.map((snapshot) => snapshot.id),
        candidates,
        kept: [...selection.kept, ...deferred].sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)),
        blockers,
        changes: [
          `Forget exactly ${forgetSnapshotIds.length} reviewed restic snapshot metadata record(s)`,
          "Read and verify every remaining repository data pack after the mutation",
          "Record the exact forgotten backup and snapshot ids in durable state",
          "Keep local VM exports, source VMs, recovery clones, and all noncandidate snapshots unchanged",
        ],
        warnings: [
          "Forgetting removes the selected snapshot references and cannot be automatically undone.",
          "This release deliberately does not run restic prune, so unreferenced pack data is not reclaimed yet.",
          "A changed mount, repository identity, snapshot set, backup record, protection result, or recovery reference invalidates approval.",
          ...(deferred.length ? [`${deferred.length} additional eligible snapshot(s) are deferred to a later bounded batch.`] : []),
        ],
        verification: ["Exact pre-mutation snapshot-set revision", "Full post-forget repository data read", "Every approved id absent", "Every noncandidate id still present"],
        prunePerformed: false,
        spaceReclaimed: false,
        recovery: "The source VMs and local exports remain unchanged. Because restic prune is not run, pack data may still exist, but BoxPilot does not claim that a forgotten snapshot can be recovered. Restore from another retained protected snapshot.",
      },
    };
  }

  async function inspect() {
    const preview = await buildPreview();
    return { ...preview.output, retentionRuns: store.listVmRetentionRuns() };
  }

  /** Pin the eligible candidate set and repository revisions for the registry operation. */
  async function prepareOperation() {
    const preview = await buildPreview();
    if (!preview.output.executable) throw new Error(preview.output.blockers?.[0] ?? "VM backup retention is not currently executable");
    return { ...preview.input, candidates: preview.output.candidates, expectedBeforeCount: preview.output.beforeCount };
  }

  /** Pin the snapshot ids that do have local records, so the browser cannot widen what may go. */
  function prepareForget() {
    const backups = store.listVmBackups(500).filter((backup) => backup.retained !== false);
    return { knownSnapshotIds: [...new Set(backups.map((backup) => backup.snapshotId).filter(Boolean))].sort() };
  }

  function recordOperation(job, result) {
    const input = job.parameters;
    const approved = new Set(input.forgetSnapshotIds);
    const actualSnapshotIds = Array.isArray(result?.forgottenSnapshotIds) ? result.forgottenSnapshotIds : [];
    const actualSet = new Set(actualSnapshotIds);
    const forgotten = input.candidates
      .filter((candidate) => actualSet.has(candidate.snapshotId))
      .map((candidate) => ({ backupId: candidate.backupId, snapshotId: candidate.snapshotId, domainName: candidate.domainName }));
    if (result?.applied !== true || result?.retentionId !== input.retentionId || result?.repositoryId !== input.repositoryId
      || result?.beforeSnapshotSetRevision !== input.expectedSnapshotSetRevision || result?.beforeCount !== input.expectedBeforeCount
      || actualSnapshotIds.length < 1 || actualSet.size !== actualSnapshotIds.length || actualSnapshotIds.some((id) => !approved.has(id))
      || forgotten.length !== actualSnapshotIds.length || result?.prunePerformed !== false || result?.spaceReclaimed !== false
      || (result?.repositoryVerified === true && (result?.complete !== true || !sameArray(actualSnapshotIds, input.forgetSnapshotIds)
        || result?.afterCount !== result?.beforeCount - forgotten.length || typeof result?.afterSnapshotSetRevision !== "string"))) {
      throw new Error("VM retention evidence validation failed");
    }
    return store.recordVmRetention({
      id: result.retentionId,
      repositoryId: result.repositoryId,
      beforeSnapshotSetRevision: result.beforeSnapshotSetRevision,
      afterSnapshotSetRevision: result.afterSnapshotSetRevision,
      beforeCount: result.beforeCount,
      afterCount: result.afterCount,
      forgotten,
      keptSnapshotIds: result.keptSnapshotIds,
      repositoryVerified: result.repositoryVerified === true,
      prunePerformed: false,
      complete: result.complete === true,
      verification: result.verification ?? [],
      createdBy: job.createdBy,
    });
  }

  return { inspect, prepareOperation, prepareForget, recordOperation };
}

export const vmRetentionInternals = { minimumAgeDays, minimumCopiesPerDomain, selectRetentionCandidates };
