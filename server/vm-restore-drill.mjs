import { randomUUID } from "node:crypto";
import { restoreDrillDomainName } from "./vm-restore-drill-helper.mjs";

const shaPattern = /^[a-f0-9]{64}$/;

export function createVmRestoreDrillService({ store, helper }) {
  function recordedEvidence(backupId) {
    const backup = store.getVmBackup(backupId);
    if (!backup) throw new Error("VM backup not found");
    if (backup.retained === false) throw new Error("VM backup snapshot was forgotten by an approved retention run");
    if (backup.protected || backup.restoreDrill?.passed) throw new Error("VM backup already has passing restore evidence");
    if (!backup.encrypted || !backup.independent || !backup.repositoryVerified || backup.destination !== "mounted-restic") {
      throw new Error("VM backup does not have the required encrypted independent repository evidence");
    }
    const artifact = store.getVmExport(backup.exportId);
    if (!artifact || artifact.domainName !== backup.domainName || artifact.domainUuid !== backup.domainUuid || artifact.sizeBytes !== backup.sizeBytes
      || artifact.encrypted || artifact.protected || artifact.restoreDrill?.passed || artifact.destination !== "local-managed") {
      throw new Error("The source export evidence for this VM backup is unavailable or changed");
    }
    return { backup, artifact };
  }

  /** Pin the protected-backup evidence and current destination for the registry operation. */
  async function prepareOperation({ backupId } = {}) {
    const { backup, artifact } = recordedEvidence(backupId);
    const destination = await helper.request("virtualization.export.backup.inspect", {});
    const input = {
      drillId: randomUUID(),
      backupId: backup.id,
      exportId: backup.exportId,
      domainName: backup.domainName,
      domainUuid: backup.domainUuid,
      repositoryId: backup.repositoryId,
      snapshotId: backup.snapshotId,
      expectedManifestChecksumSha256: artifact.manifestChecksumSha256,
      expectedSizeBytes: backup.sizeBytes,
      expectedDestinationRevision: destination.destinationRevision ?? "0".repeat(64),
    };
    const inspection = await helper.request("virtualization.export.backup.restore-drill.inspect", input);
    if (!inspection.ready) throw new Error(inspection.blockers?.[0] ?? "The isolated restore drill is not currently executable");
    return input;
  }

  function recordOperation(job, result) {
    const input = job.parameters;
    if (result?.passed !== true || result?.drillId !== input.drillId || result?.backupId !== input.backupId || result?.exportId !== input.exportId
      || result?.domain !== input.domainName || result?.domainUuid !== input.domainUuid || result?.repositoryId !== input.repositoryId
      || result?.snapshotId !== input.snapshotId || result?.sizeBytes !== input.expectedSizeBytes || result?.network !== "none"
      || result?.transient !== true || result?.persistentDomainCreated !== false || result?.guestAgentPing !== true
      || result?.restoredChecksumsVerified !== true || result?.restoredDisksVerified !== true || result?.cleanupVerified !== true
      || result?.temporaryQemuDiskAccessGranted !== true || result?.temporaryQemuDiskAccessRemoved !== true
      || result?.transientFirmwareStateRemoved !== true
      || !Number.isSafeInteger(result?.fileCount) || result.fileCount < 3 || result.fileCount > 34
      || result?.protected !== true || !shaPattern.test(result?.snapshotId ?? "")) {
      throw new Error("VM restore drill evidence validation failed");
    }
    return store.recordVmRestoreDrill({
      backupId: input.backupId,
      restoreDrill: {
        passed: true,
        drillId: result.drillId,
        network: "none",
        transient: true,
        persistentDomainCreated: false,
        guestAgentPing: true,
        restoredChecksumsVerified: true,
        restoredDisksVerified: true,
        temporaryQemuDiskAccessGranted: true,
        temporaryQemuDiskAccessRemoved: true,
        transientFirmwareStateRemoved: true,
        cleanupVerified: true,
        fileCount: result.fileCount,
        sizeBytes: result.sizeBytes,
      },
      createdBy: job.createdBy,
    });
  }

  return { prepareOperation, recordOperation };
}
