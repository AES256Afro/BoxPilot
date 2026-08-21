import { randomUUID } from "node:crypto";

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern = /^[a-f0-9]{64}$/;
const safeDomainPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

function validateTargetName(name) {
  if (typeof name !== "string" || !safeDomainPattern.test(name)) throw new Error("Recovery domain name must use 1-63 letters, numbers, dots, underscores, or hyphens");
  if (name.toLowerCase().startsWith("boxpilot-drill-")) throw new Error("Recovery domain name uses the reserved restore-drill namespace");
  return name;
}

export function createVmRecoveryService({ store, helper }) {
  function evidence(backupId) {
    const backup = store.getVmBackup(backupId);
    if (!backup) throw new Error("VM backup not found");
    if (backup.retained === false) throw new Error("VM backup snapshot was forgotten by an approved retention run");
    const drill = backup.restoreDrill;
    if (!backup.protected || !backup.encrypted || !backup.independent || !backup.repositoryVerified || backup.destination !== "mounted-restic"
      || drill?.passed !== true || !uuidPattern.test(drill.drillId ?? "") || drill.network !== "none" || drill.transient !== true
      || drill.persistentDomainCreated !== false || drill.guestAgentPing !== true || drill.restoredChecksumsVerified !== true
      || drill.restoredDisksVerified !== true || drill.temporaryQemuDiskAccessRemoved !== true || drill.transientFirmwareStateRemoved !== true
      || drill.cleanupVerified !== true) {
      throw new Error("VM backup does not have complete protected restore-drill evidence");
    }
    const artifact = store.getVmExport(backup.exportId);
    if (!artifact || artifact.domainName !== backup.domainName || artifact.domainUuid !== backup.domainUuid || artifact.sizeBytes !== backup.sizeBytes
      || !shaPattern.test(artifact.manifestChecksumSha256 ?? "") || artifact.destination !== "local-managed") {
      throw new Error("The protected backup source evidence is unavailable or changed");
    }
    return { backup, artifact };
  }

  /** Pin the drilled-backup evidence and target name for the registry operation. */
  async function prepareOperation({ backupId, targetDomainName: targetName } = {}) {
    const targetDomainName = validateTargetName(targetName);
    const { backup, artifact } = evidence(backupId);
    const destination = await helper.request("virtualization.export.backup.inspect", {});
    const input = {
      restoreId: randomUUID(),
      backupId: backup.id,
      exportId: backup.exportId,
      sourceDomainName: backup.domainName,
      sourceDomainUuid: backup.domainUuid,
      targetDomainName,
      restoreDrillId: backup.restoreDrill.drillId,
      repositoryId: backup.repositoryId,
      snapshotId: backup.snapshotId,
      expectedManifestChecksumSha256: artifact.manifestChecksumSha256,
      expectedSizeBytes: backup.sizeBytes,
      expectedDestinationRevision: destination.destinationRevision ?? "0".repeat(64),
    };
    const inspection = await helper.request("virtualization.backup.recovery.inspect", input);
    if (!inspection.ready) throw new Error(inspection.blockers?.[0] ?? "The recovery clone is not currently executable");
    return input;
  }

  function recordOperation(job, result) {
    const input = job.parameters;
    if (result?.created !== true || result?.restoreId !== input.restoreId || result?.backupId !== input.backupId || result?.exportId !== input.exportId
      || result?.sourceDomain !== input.sourceDomainName || result?.sourceDomainUuid !== input.sourceDomainUuid || result?.domain !== input.targetDomainName
      || !uuidPattern.test(result?.domainUuid ?? "") || result?.repositoryId !== input.repositoryId || result?.snapshotId !== input.snapshotId
      || !shaPattern.test(result?.snapshotId ?? "") || result?.sizeBytes !== input.expectedSizeBytes
      || !Number.isSafeInteger(result?.fileCount) || result.fileCount < 3 || result.fileCount > 34
      || result?.persistent !== true || result?.state !== "stopped" || result?.network !== "none" || result?.autostart !== false
      || result?.encryptedSource !== true || result?.protectedSource !== true || result?.restoredChecksumsVerified !== true
      || result?.restoredDisksVerified !== true || result?.sourceUnchanged !== true || result?.snapshotUnchanged !== true) {
      throw new Error("VM recovery evidence validation failed");
    }
    return store.recordVmRecovery({
      id: input.restoreId,
      backupId: input.backupId,
      sourceDomainName: input.sourceDomainName,
      sourceDomainUuid: input.sourceDomainUuid,
      domainName: input.targetDomainName,
      domainUuid: result.domainUuid,
      destination: "managed-libvirt-recovery",
      sizeBytes: result.sizeBytes,
      state: "stopped",
      network: "none",
      autostart: false,
      createdBy: job.createdBy,
    });
  }

  function list() {
    return store.listVmRecoveries();
  }

  return { list, prepareOperation, recordOperation };
}
