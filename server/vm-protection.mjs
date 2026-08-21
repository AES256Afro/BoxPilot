import { randomUUID } from "node:crypto";

const shaPattern = /^[a-f0-9]{64}$/;

export function createVmProtectionService({ store, helper }) {
  async function destination() {
    return helper.request("virtualization.export.backup.inspect", {});
  }

  async function list() {
    return { destination: await destination(), backups: store.listVmBackups() };
  }

  /** Pin the export evidence and destination revision for the registry operation. */
  async function prepareOperation({ exportId } = {}) {
    const artifact = store.getVmExport(exportId);
    if (!artifact) throw new Error("VM export not found");
    if (artifact.protected || artifact.encrypted || artifact.restoreDrill?.passed) throw new Error("VM export metadata does not match the local unprotected export contract");
    const currentDestination = await destination();
    if (currentDestination.ready !== true) throw new Error(currentDestination.blockers?.[0] ?? "The encrypted independent backup destination is not ready");
    if (!(Number.isSafeInteger(currentDestination.destinationFreeBytes) && currentDestination.destinationFreeBytes >= artifact.sizeBytes + 1024 ** 3)) throw new Error("The independent backup destination does not have enough free space");
    return {
      backupId: randomUUID(),
      exportId: artifact.id,
      domainName: artifact.domainName,
      domainUuid: artifact.domainUuid,
      expectedManifestChecksumSha256: artifact.manifestChecksumSha256,
      expectedSizeBytes: artifact.sizeBytes,
      expectedDestinationRevision: currentDestination.destinationRevision,
    };
  }

  function recordOperation(job, result) {
    const input = job.parameters;
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

  return { list, prepareOperation, recordOperation };
}
