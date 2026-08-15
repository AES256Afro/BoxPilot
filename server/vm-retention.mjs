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
    const activeSnapshotConsumers = store.listActiveJobs()
      .filter((job) => ["virtualization.export.backup.restore-drill", "virtualization.backup.recovery.create"].includes(job.type))
      .map((job) => ({ backupId: job.parameters?.input?.backupId }))
      .filter((item) => typeof item.backupId === "string");
    const blockers = [...(inspection.blockers ?? [])];
    const active = backups.filter((backup) => backup.retained !== false && backup.repositoryId === inspection.repositoryId);
    const activeBySnapshot = new Map(active.map((backup) => [backup.snapshotId, backup]));
    const repositoryIds = new Set((inspection.snapshots ?? []).map((snapshot) => snapshot.id));
    const unknownSnapshots = (inspection.snapshots ?? []).filter((snapshot) => !activeBySnapshot.has(snapshot.id));
    const missingSnapshots = active.filter((backup) => !repositoryIds.has(backup.snapshotId));
    if (unknownSnapshots.length) blockers.push(`${unknownSnapshots.length} BoxPilot-tagged repository snapshot(s) are not attributable to active local backup records`);
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

  async function plan(ownerId) {
    const preview = await buildPreview();
    return store.createPlan({ type: "virtualization.export.backup.retention", subjectId: preview.input.repositoryId ?? "unavailable", input: preview.input, output: preview.output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    const current = await buildPreview(draft.input.retentionId);
    if (current.input.repositoryId !== draft.input.repositoryId
      || current.input.expectedDestinationRevision !== draft.input.expectedDestinationRevision
      || current.input.expectedSnapshotSetRevision !== draft.input.expectedSnapshotSetRevision
      || !sameArray(current.input.forgetSnapshotIds, draft.input.forgetSnapshotIds)
      || !sameArray(current.output.candidates, draft.output.candidates)
      || !current.output.executable) {
      throw new Error("The repository, backup evidence, recovery references, or retention candidate set changed after planning");
    }
    return current;
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.export.backup.retention") throw new Error("VM retention plan not found");
    if (draft.revision !== revision) throw new Error("VM retention plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "VM retention plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.export.backup.retention.apply",
      title: `Apply guarded retention to ${draft.output.candidates.length} VM backup(s)`,
      risk: "high",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Repository identity, exact snapshot set, protected restore evidence, age, minimum-copy floor, and recovery references validated" },
        { name: "checkpoint", state: "completed", detail: "Exact candidate ids recorded; source VMs and local exports remain unchanged; prune is disabled" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.export.backup.retention.apply") throw new Error("Unsupported VM retention job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged VM retention plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The VM retention job inputs do not match the approved plan");
    await revalidate(staged);
    return staged;
  }

  function recordResult(job, result) {
    const staged = store.getPlan(job.parameters.planId);
    const input = job.parameters.input;
    const approved = new Set(input.forgetSnapshotIds);
    const actualSnapshotIds = Array.isArray(result?.forgottenSnapshotIds) ? result.forgottenSnapshotIds : [];
    const actualSet = new Set(actualSnapshotIds);
    const forgotten = staged.output.candidates
      .filter((candidate) => actualSet.has(candidate.snapshotId))
      .map((candidate) => ({ backupId: candidate.backupId, snapshotId: candidate.snapshotId, domainName: candidate.domainName }));
    if (result?.applied !== true || result?.retentionId !== input.retentionId || result?.repositoryId !== input.repositoryId
      || result?.beforeSnapshotSetRevision !== input.expectedSnapshotSetRevision || result?.beforeCount !== staged.output.beforeCount
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

  return { inspect, plan, stage, validateJob, recordResult };
}

export const vmRetentionInternals = { minimumAgeDays, minimumCopiesPerDomain, selectRetentionCandidates };
