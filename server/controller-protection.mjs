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

  /** Pin the expected evidence for one verified local backup (staging-time, server-derived). */
  async function prepareOperation({ backupId } = {}) {
    const source = verifiedBackup(backupId);
    if (store.getControllerBackupProtectionByBackup(source.id)) throw new Error("This controller backup already has durable independent protection evidence");
    const currentDestination = await destination();
    if (currentDestination.ready !== true) throw new Error(currentDestination.blockers?.[0] ?? "The encrypted independent controller destination is not ready");
    if (!(Number.isSafeInteger(currentDestination.destinationFreeBytes) && currentDestination.destinationFreeBytes >= source.sizeBytes + 256 * 1024 ** 2)) throw new Error("The independent controller destination does not have enough free space");
    return {
      protectionId: randomUUID(),
      backupId: source.id,
      expectedArtifactChecksumSha256: source.checksumSha256,
      expectedManifestChecksumSha256: source.restoreDrill.manifestChecksumSha256,
      expectedSizeBytes: source.sizeBytes,
      expectedDestinationRevision: currentDestination.destinationRevision,
    };
  }

  function recordOperation(job, result) {
    const input = job.parameters;
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

  return { list, prepareOperation, recordOperation };
}
