import { randomUUID } from "node:crypto";

const shaPattern = /^[a-f0-9]{64}$/;

export function createControllerProtectionService({ store, helper }) {
  async function destination() {
    try {
      return await helper.request("controller.database.protection.inspect", {});
    } catch {
      return {
        adapter: "mounted-restic-controller",
        ready: false,
        encrypted: false,
        independent: false,
        resticVersion: null,
        mount: null,
        repositoryId: null,
        destinationRevision: null,
        destinationFreeBytes: null,
        blockers: ["The restricted helper could not inspect controller disaster protection"],
        setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-controller-restic-setup.sh",
        recoveryKeyRequired: true,
      };
    }
  }

  async function list() {
    return { destination: await destination(), protections: store.listControllerBackupProtections() };
  }

  function backup(backupId) {
    return store.listBackups(200).find((candidate) => candidate.id === backupId && candidate.applicationId === "boxpilot-controller") ?? null;
  }

  function verifiedBackup(backupId) {
    const candidate = backup(backupId);
    if (!candidate || candidate.destination !== "local-managed" || candidate.restoreDrill?.passed !== true
      || candidate.restoreDrill?.mode !== "isolated-copy-open" || candidate.restoreDrill?.integrityCheck !== "ok"
      || candidate.restoreDrill?.foreignKeyIssues !== 0 || candidate.restoreDrill?.schemaVerified !== true
      || candidate.restoreDrill?.ownerStatePresent !== true || candidate.restoreDrill?.workspaceRemoved !== true
      || !shaPattern.test(candidate.checksumSha256 ?? "") || !shaPattern.test(candidate.restoreDrill?.manifestChecksumSha256 ?? "")
      || !Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes <= 0) {
      throw new Error("The selected local controller backup is unavailable or lacks complete restore verification");
    }
    return candidate;
  }

  async function plan(backupId, ownerId) {
    const source = verifiedBackup(backupId);
    if (store.getControllerBackupProtectionByBackup(source.id)) throw new Error("This controller backup already has durable independent protection evidence");
    const currentDestination = await destination();
    const capacityReady = Number.isSafeInteger(currentDestination.destinationFreeBytes)
      && currentDestination.destinationFreeBytes >= source.sizeBytes + 256 * 1024 ** 2;
    const blockers = [...(currentDestination.blockers ?? [])];
    if (currentDestination.ready && !capacityReady) blockers.push("The independent controller destination does not have enough free space");
    const input = {
      protectionId: randomUUID(),
      backupId: source.id,
      expectedArtifactChecksumSha256: source.checksumSha256,
      expectedManifestChecksumSha256: source.restoreDrill.manifestChecksumSha256,
      expectedSizeBytes: source.sizeBytes,
      expectedDestinationRevision: currentDestination.destinationRevision,
    };
    const output = {
      executable: currentDestination.ready === true && capacityReady,
      destination: "mounted-restic-controller",
      resticVersion: currentDestination.resticVersion,
      repositoryId: currentDestination.repositoryId,
      destinationFreeBytes: currentDestination.destinationFreeBytes,
      blockers,
      changes: [
        "Reverify the exact local controller database artifact, root-only manifest, hashes, schema, foreign keys, and owner state",
        "Write the complete generated backup directory into the separate encrypted controller restic repository on an independent mounted filesystem",
        "Tag the snapshot only with server-generated controller backup and protection identifiers",
        "Read every restic data pack and confirm the exact snapshot path and tags",
        "Restore that exact snapshot into a generated helper-owned no-network workspace",
        "Rehash the restored artifact and manifest, open the database, repeat integrity and schema checks, then remove the successful drill workspace",
        "Record immutable repository, snapshot, encryption, independence, and restore evidence without changing the live database or local backup",
      ],
      verification: ["Local artifact and manifest SHA-256", "SQLite integrity, foreign keys, required schema, and owner state", "Full restic repository data read", "Exact snapshot path and tag readback", "Exact restored hashes and isolated database copy-open"],
      warnings: [
        "The repository password is a controller recovery key. Keep a separate copy outside this server and outside the backup filesystem.",
        "A local USB disk is independent from this server's storage but is not offsite protection. A NAS or rotated encrypted disk is stronger.",
        "The complete repository read is deliberate and may take longer as repository history grows.",
        "BoxPilot does not forget, prune, overwrite, or delete restic snapshots in this workflow.",
      ],
      recovery: "The live controller database and verified local backup remain unchanged. If repository or restore verification fails, preserve the encrypted repository and generated root-only drill workspace for inspection. BoxPilot does not run retention or prune.",
      encrypted: currentDestination.encrypted === true,
      independent: currentDestination.independent === true,
      protected: false,
    };
    return store.createPlan({ type: "controller.database.protection", subjectId: source.id, input, output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    const source = verifiedBackup(draft.input.backupId);
    if (source.checksumSha256 !== draft.input.expectedArtifactChecksumSha256
      || source.restoreDrill.manifestChecksumSha256 !== draft.input.expectedManifestChecksumSha256
      || source.sizeBytes !== draft.input.expectedSizeBytes) throw new Error("The selected controller backup evidence changed after planning");
    if (store.getControllerBackupProtectionByBackup(source.id)) throw new Error("This controller backup already has durable independent protection evidence");
    const currentDestination = await destination();
    if (!currentDestination.ready || currentDestination.destinationRevision !== draft.input.expectedDestinationRevision
      || currentDestination.destinationFreeBytes < source.sizeBytes + 256 * 1024 ** 2) {
      throw new Error("The encrypted independent controller destination is unavailable or changed");
    }
    return { source, currentDestination };
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "controller.database.protection") throw new Error("Controller protection plan not found");
    if (draft.revision !== revision) throw new Error("Controller protection plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "Controller protection plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "controller.database.backup.protect",
      title: "Encrypt, independently copy, and restore-test BoxPilot controller state",
      risk: "medium",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact local backup hashes, restore evidence, independent mount, repository identity, separate recovery key, and capacity validated" },
        { name: "checkpoint", state: "completed", detail: "Live database and local backup remain immutable; repository forget, prune, and overwrite are unavailable" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "controller.database.backup.protect") throw new Error("Unsupported controller protection job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged controller protection plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The controller protection job inputs do not match the approved plan");
    await revalidate(staged);
    return staged;
  }

  function recordResult(job, result) {
    const input = job.parameters.input;
    if (result?.created !== true || result?.protectionId !== input.protectionId || result?.backupId !== input.backupId
      || result?.destination !== "mounted-restic-controller" || !shaPattern.test(result?.repositoryId ?? "") || !shaPattern.test(result?.snapshotId ?? "")
      || result?.sizeBytes !== input.expectedSizeBytes || result?.artifactChecksumSha256 !== input.expectedArtifactChecksumSha256
      || result?.manifestChecksumSha256 !== input.expectedManifestChecksumSha256 || result?.encrypted !== true || result?.independent !== true
      || result?.repositoryVerified !== true || result?.protected !== true || result?.restoreDrill?.passed !== true
      || result.restoreDrill.mode !== "exact-snapshot-isolated-copy-open" || result.restoreDrill.network !== "none"
      || result.restoreDrill.publishedPorts !== 0 || result.restoreDrill.artifactChecksumMatched !== true
      || result.restoreDrill.manifestChecksumMatched !== true || result.restoreDrill.integrityCheck !== "ok"
      || result.restoreDrill.foreignKeyIssues !== 0 || result.restoreDrill.schemaVerified !== true
      || result.restoreDrill.ownerStatePresent !== true || result.restoreDrill.workspaceRemoved !== true
      || result.restoreDrill.productionDatabaseReplaced !== false || result.restoreDrill.serviceStarted !== false
      || result.boundary?.browserPathAccepted !== false || result.boundary?.browserPasswordAccepted !== false
      || result.boundary?.repositorySelectorAccepted !== false || result.boundary?.productionDatabaseChanged !== false
      || result.boundary?.localBackupChanged !== false || result.boundary?.networkAccessRequired !== false
      || result.boundary?.retentionPerformed !== false || result.boundary?.prunePerformed !== false) {
      throw new Error("Controller protection evidence validation failed");
    }
    return store.recordControllerBackupProtection({
      id: result.protectionId,
      backupId: result.backupId,
      destination: result.destination,
      repositoryId: result.repositoryId,
      snapshotId: result.snapshotId,
      sizeBytes: result.sizeBytes,
      encrypted: true,
      independent: true,
      repositoryVerified: true,
      protected: true,
      restoreDrill: result.restoreDrill,
      createdBy: job.createdBy,
    });
  }

  return { list, plan, stage, validateJob, recordResult };
}
