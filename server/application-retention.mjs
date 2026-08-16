import { randomUUID } from "node:crypto";

const dayMs = 24 * 60 * 60 * 1000;
const minimumAgeDays = 30;
const minimumCopiesPerApplication = 3;

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectRetentionCandidates({ protections, activeConsumers = [], preservedBackupIds = [], now }) {
  const activeBackupIds = new Set(activeConsumers.map((consumer) => consumer.backupId).filter(Boolean));
  const activeProtectionIds = new Set(activeConsumers.map((consumer) => consumer.protectionId).filter(Boolean));
  const activeSnapshotIds = new Set(activeConsumers.flatMap((consumer) => consumer.snapshotIds ?? []).filter(Boolean));
  const preserved = new Set(preservedBackupIds);
  const groups = new Map();
  for (const protection of protections.filter((item) => item.retained !== false)) {
    if (!groups.has(protection.applicationId)) groups.set(protection.applicationId, []);
    groups.get(protection.applicationId).push(protection);
  }
  const candidates = [];
  const kept = [];
  for (const group of groups.values()) {
    group.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    group.forEach((protection, index) => {
      const created = new Date(protection.createdAt).getTime();
      const ageDays = Number.isFinite(created) ? Math.max(0, Math.floor((now.getTime() - created) / dayMs)) : 0;
      const reasons = [];
      if (index < minimumCopiesPerApplication) reasons.push("minimum-copies-per-application");
      if (ageDays < minimumAgeDays) reasons.push("minimum-age");
      if (!protection.protected || protection.restoreDrill?.passed !== true || protection.restoreDrill?.artifactChecksumMatched !== true) reasons.push("not-restore-tested");
      if (preserved.has(protection.backupId)) reasons.push("recovery-reference");
      if (activeBackupIds.has(protection.backupId) || activeProtectionIds.has(protection.id) || activeSnapshotIds.has(protection.snapshotId)) reasons.push("active-application-operation");
      const entry = {
        protectionId: protection.id,
        backupId: protection.backupId,
        applicationId: protection.applicationId,
        snapshotId: protection.snapshotId,
        createdAt: protection.createdAt,
        ageDays,
        sizeBytes: protection.sizeBytes,
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

export function createApplicationRetentionService({ store, helper, now = () => new Date() }) {
  async function buildPreview(retentionId = randomUUID()) {
    const inspection = await helper.request("application.backup.protection.retention.inspect", {});
    const protections = store.listAllApplicationBackupProtections();
    const activeConsumers = store.listActiveJobs()
      .filter((job) => ["application.backup.protect", "application.backup.retention.apply", "application.keel.recovery.create", "application.keel.recovery-drill.run", "application.keel.promotion", "application.keel.rollback"].includes(job.type))
      .map((job) => ({
        backupId: job.parameters?.input?.backupId,
        protectionId: job.parameters?.input?.protectionId,
        snapshotIds: job.type === "application.backup.retention.apply" ? job.parameters?.input?.forgetSnapshotIds : [],
      }));
    const preservedBackupIds = store.listAllApplicationRecoveries().map((recovery) => recovery.backupId);
    const blockers = [...(inspection.blockers ?? [])];
    const active = protections.filter((protection) => protection.retained !== false && protection.repositoryId === inspection.repositoryId);
    const activeBySnapshot = new Map(active.map((protection) => [protection.snapshotId, protection]));
    const repositoryIds = new Set((inspection.snapshots ?? []).map((snapshot) => snapshot.id));
    const unknownSnapshots = (inspection.snapshots ?? []).filter((snapshot) => !activeBySnapshot.has(snapshot.id));
    const missingSnapshots = active.filter((protection) => !repositoryIds.has(protection.snapshotId));
    const mismatchedSnapshots = (inspection.snapshots ?? []).filter((snapshot) => {
      const protection = activeBySnapshot.get(snapshot.id);
      return protection && (!snapshot.tags.includes(`boxpilot-application-${protection.applicationId}`)
        || !snapshot.tags.includes(`boxpilot-application-backup-${protection.backupId}`)
        || !snapshot.tags.includes(`boxpilot-application-protection-${protection.id}`));
    });
    if (unknownSnapshots.length) blockers.push(`${unknownSnapshots.length} BoxPilot-tagged application snapshot(s) are not attributable to active protection records`);
    if (missingSnapshots.length) blockers.push(`${missingSnapshots.length} active application protection record(s) are missing from the repository`);
    if (mismatchedSnapshots.length) blockers.push(`${mismatchedSnapshots.length} application snapshot(s) do not match their recorded application, backup, and protection tags`);
    const selection = selectRetentionCandidates({ protections: active, activeConsumers, preservedBackupIds, now: now() });
    if (selection.candidates.length === 0) blockers.push("No application snapshot satisfies the fixed retention eligibility policy");
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
        policy: { minimumCopiesPerApplication, minimumAgeDays, requiresProtectedRestoreDrill: true, preserveRecoveryReferences: true, preserveActiveApplicationOperations: true },
        repositoryId: inspection.repositoryId,
        beforeCount: inspection.snapshots?.length ?? 0,
        candidates,
        kept: [...selection.kept, ...deferred].sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)),
        retentionRuns: store.listApplicationRetentionRuns(),
        blockers,
        changes: [
          `Forget exactly ${forgetSnapshotIds.length} reviewed application restic snapshot metadata record(s)`,
          "Read and verify every remaining application repository data pack after the mutation",
          "Record the exact forgotten application, backup, protection, and snapshot ids in durable state",
          "Keep every running application, local archive, recovery object, and noncandidate snapshot unchanged",
        ],
        warnings: [
          "Forgetting removes the selected snapshot references and cannot be automatically undone.",
          "This release deliberately does not run restic prune, so unreferenced pack data is not reclaimed yet.",
          "A changed mount, repository identity, snapshot set, protection record, restore result, recovery reference, or active application job invalidates approval.",
          ...(deferred.length ? [`${deferred.length} additional eligible snapshot(s) are deferred to a later bounded batch.`] : []),
        ],
        verification: ["Exact pre-mutation snapshot-set revision", "Full post-forget repository data read", "Every approved id absent", "Every noncandidate id still present"],
        prunePerformed: false,
        spaceReclaimed: false,
        recovery: "Running applications, local verified archives, and recovery objects remain unchanged. Because restic prune is not run, pack data may still exist, but BoxPilot does not claim that a forgotten snapshot can be recovered. Restore from another retained protected snapshot for that application.",
      },
    };
  }

  async function inspect() {
    return (await buildPreview()).output;
  }

  async function plan(ownerId) {
    const preview = await buildPreview();
    return store.createPlan({ type: "application.backup.retention", subjectId: preview.input.repositoryId ?? "unavailable", input: preview.input, output: preview.output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    const current = await buildPreview(draft.input.retentionId);
    if (current.input.repositoryId !== draft.input.repositoryId
      || current.input.expectedDestinationRevision !== draft.input.expectedDestinationRevision
      || current.input.expectedSnapshotSetRevision !== draft.input.expectedSnapshotSetRevision
      || !sameArray(current.input.forgetSnapshotIds, draft.input.forgetSnapshotIds)
      || !sameArray(current.output.candidates, draft.output.candidates)
      || !current.output.executable) {
      throw new Error("The application repository, protection evidence, recovery references, active jobs, or retention candidate set changed after planning");
    }
    return current;
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "application.backup.retention") throw new Error("Application retention plan not found");
    if (draft.revision !== revision) throw new Error("Application retention plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "Application retention plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "application.backup.retention.apply",
      title: `Apply guarded retention to ${draft.output.candidates.length} application snapshot(s)`,
      risk: "high",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Repository identity, exact snapshot set, per-application copy floors, restore evidence, recovery references, and active application jobs validated" },
        { name: "checkpoint", state: "completed", detail: "Exact candidate ids recorded; applications, local archives, and recovery objects remain unchanged; prune is disabled" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "application.backup.retention.apply") throw new Error("Unsupported application retention job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged application retention plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The application retention job inputs do not match the approved plan");
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
      .map((candidate) => ({ protectionId: candidate.protectionId, backupId: candidate.backupId, applicationId: candidate.applicationId, snapshotId: candidate.snapshotId }));
    if (result?.applied !== true || result?.retentionId !== input.retentionId || result?.repositoryId !== input.repositoryId
      || result?.beforeSnapshotSetRevision !== input.expectedSnapshotSetRevision || result?.beforeCount !== staged.output.beforeCount
      || actualSnapshotIds.length < 1 || actualSet.size !== actualSnapshotIds.length || actualSnapshotIds.some((id) => !approved.has(id))
      || forgotten.length !== actualSnapshotIds.length || result?.prunePerformed !== false || result?.spaceReclaimed !== false
      || (result?.repositoryVerified === true && (result?.complete !== true || !sameArray(actualSnapshotIds, input.forgetSnapshotIds)
        || result?.afterCount !== result?.beforeCount - forgotten.length || typeof result?.afterSnapshotSetRevision !== "string"))) {
      throw new Error("Application retention evidence validation failed");
    }
    return store.recordApplicationRetention({
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

  return { inspect, plan, stage, validateJob, recordResult };
}

export const applicationRetentionInternals = { minimumAgeDays, minimumCopiesPerApplication, selectRetentionCandidates };
