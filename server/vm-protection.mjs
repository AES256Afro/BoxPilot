import { randomUUID } from "node:crypto";

const shaPattern = /^[a-f0-9]{64}$/;

export function createVmProtectionService({ store, helper }) {
  async function destination() {
    return helper.request("virtualization.export.backup.inspect", {});
  }

  async function list() {
    return { destination: await destination(), backups: store.listVmBackups() };
  }

  async function plan(exportId, ownerId) {
    const artifact = store.getVmExport(exportId);
    if (!artifact) throw new Error("VM export not found");
    if (artifact.protected || artifact.encrypted || artifact.restoreDrill?.passed) throw new Error("VM export metadata does not match the local unprotected export contract");
    const currentDestination = await destination();
    const capacityReady = Number.isSafeInteger(currentDestination.destinationFreeBytes)
      && currentDestination.destinationFreeBytes >= artifact.sizeBytes + 1024 ** 3;
    const blockers = [...(currentDestination.blockers ?? [])];
    if (currentDestination.ready && !capacityReady) blockers.push("The independent backup destination does not have enough free space");
    const input = {
      backupId: randomUUID(),
      exportId: artifact.id,
      domainName: artifact.domainName,
      domainUuid: artifact.domainUuid,
      expectedManifestChecksumSha256: artifact.manifestChecksumSha256,
      expectedSizeBytes: artifact.sizeBytes,
      expectedDestinationRevision: currentDestination.destinationRevision,
    };
    const output = {
      executable: currentDestination.ready && capacityReady,
      destination: "mounted-restic",
      resticVersion: currentDestination.resticVersion,
      repositoryId: currentDestination.repositoryId,
      destinationFreeBytes: currentDestination.destinationFreeBytes,
      blockers,
      changes: [
        "Reverify every file and checksum in the selected root-only local VM export",
        "Write an encrypted deduplicated restic snapshot to the configured independent mounted filesystem",
        "Tag the snapshot with server-generated export and backup identifiers",
        "Read all data in the restic repository and verify the exact new snapshot identity",
        "Record durable encryption, independence, repository, snapshot, and size evidence",
      ],
      verification: ["Local export manifest and file SHA-256", "Restic successful snapshot summary", "Full repository data check", "Exact snapshot path and tag readback"],
      encrypted: currentDestination.ready,
      independent: currentDestination.independent === true,
      repositoryVerified: false,
      protected: false,
      restoreDrill: { passed: false, reason: "An isolated restore boot has not run" },
      warnings: [
        "Repository encryption does not help if the password is lost. Keep a recovery copy outside Bigbox.",
        "This job reads the complete local export and every data pack in the repository, so it can run for hours and grows slower as the repository grows.",
        "The backup remains unprotected in BoxPilot until a later isolated restore boot and guest health check pass.",
        "BoxPilot never deletes an existing restic snapshot automatically when verification fails.",
      ],
      recovery: "The local export remains unchanged. Restic does not publish a successful snapshot when source reading fails. If post-backup verification fails, keep the repository and inspect it; BoxPilot does not run forget or prune automatically.",
    };
    return store.createPlan({ type: "virtualization.export.backup", subjectId: artifact.id, input, output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    const artifact = store.getVmExport(draft.input.exportId);
    if (!artifact || artifact.domainName !== draft.input.domainName || artifact.domainUuid !== draft.input.domainUuid
      || artifact.manifestChecksumSha256 !== draft.input.expectedManifestChecksumSha256 || artifact.sizeBytes !== draft.input.expectedSizeBytes) {
      throw new Error("The selected VM export evidence changed or is unavailable");
    }
    const currentDestination = await destination();
    if (!currentDestination.ready || currentDestination.destinationRevision !== draft.input.expectedDestinationRevision
      || currentDestination.destinationFreeBytes < artifact.sizeBytes + 1024 ** 3) {
      throw new Error("The encrypted independent backup destination is unavailable or changed");
    }
    return { artifact, currentDestination };
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.export.backup") throw new Error("VM protection plan not found");
    if (draft.revision !== revision) throw new Error("VM protection plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "VM protection plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.export.backup.create",
      title: `Encrypt and independently back up ${draft.input.domainName} export`,
      risk: "medium",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact export identity, manifest checksum, size, restic repository, independent mount, password-file policy, and destination capacity validated" },
        { name: "checkpoint", state: "completed", detail: "Local export remains unchanged; repository deletion, forget, and prune are unavailable" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.export.backup.create") throw new Error("Unsupported VM protection job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged VM protection plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The VM protection job inputs do not match the approved plan");
    await revalidate(staged);
    return staged;
  }

  function recordResult(job, result) {
    const input = job.parameters.input;
    if (result?.created !== true || result?.backupId !== input.backupId || result?.exportId !== input.exportId
      || result?.domain !== input.domainName || result?.domainUuid !== input.domainUuid || result?.destination !== "mounted-restic"
      || !shaPattern.test(result?.repositoryId ?? "") || !shaPattern.test(result?.snapshotId ?? "")
      || result?.sizeBytes !== input.expectedSizeBytes || result?.encrypted !== true || result?.independent !== true
      || result?.repositoryVerified !== true || result?.protected !== false || result?.restoreDrill?.passed !== false) {
      throw new Error("VM protection evidence validation failed");
    }
    return store.recordVmBackup({
      id: result.backupId,
      exportId: result.exportId,
      domainName: result.domain,
      domainUuid: result.domainUuid,
      destination: result.destination,
      repositoryId: result.repositoryId,
      snapshotId: result.snapshotId,
      sizeBytes: result.sizeBytes,
      encrypted: true,
      independent: true,
      repositoryVerified: true,
      protected: false,
      restoreDrill: result.restoreDrill,
      createdBy: job.createdBy,
    });
  }

  return { list, plan, stage, validateJob, recordResult };
}
