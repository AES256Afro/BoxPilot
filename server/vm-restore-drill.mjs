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

  async function plan(backupId, ownerId) {
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
    const output = {
      executable: inspection.ready,
      drillDomain: inspection.drillDomain,
      network: "none",
      transient: true,
      memoryMiB: inspection.memoryMiB,
      vcpus: inspection.vcpus,
      restoreFreeBytes: inspection.restoreFreeBytes,
      requiredBytes: inspection.requiredBytes,
      blockers: inspection.blockers,
      changes: [
        "Restore the exact encrypted restic snapshot into a new root-only server-generated temporary workspace",
        "Reverify the restored manifest, every SHA-256 checksum, exact logical size, and every qcow2 disk structure",
        "Boot the restored disks as a fixed transient libvirt domain with no network interface",
        "Require two QEMU guest-agent pings while the isolated guest remains running",
        "Destroy the transient domain, remove the successful temporary workspace, and verify both are absent",
        "Promote only this durable backup record to protected after all restore evidence passes",
      ],
      verification: [
        "Exact repository and snapshot id, source path, and server-generated tags",
        "Restic restore with content verification",
        "Manifest and per-file SHA-256 plus qemu-img structural checks",
        "Transient libvirt state with zero attached network interfaces",
        "Repeated QEMU guest-agent health signal",
        "Domain and workspace cleanup",
      ],
      protected: false,
      protectedOnSuccess: true,
      warnings: [
        "The source guest must contain and enable qemu-guest-agent or this drill will fail safely.",
        "The drill uses 2 vCPUs and 2048 MiB temporarily and can run for hours while restic restores the disks.",
        "A failed drill never promotes protection and preserves the restored workspace for operator inspection.",
        "The drill domain has no network interface, so application-level network health is not tested in this slice.",
      ],
      recovery: "On failure, BoxPilot force-stops only the server-generated transient drill domain. It preserves restored files for inspection and never changes the source VM, local export, restic snapshot, or repository retention.",
    };
    return store.createPlan({ type: "virtualization.export.backup.restore-drill", subjectId: backup.id, input, output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    const { backup, artifact } = recordedEvidence(draft.input.backupId);
    if (backup.exportId !== draft.input.exportId || backup.domainName !== draft.input.domainName || backup.domainUuid !== draft.input.domainUuid
      || backup.repositoryId !== draft.input.repositoryId || backup.snapshotId !== draft.input.snapshotId || backup.sizeBytes !== draft.input.expectedSizeBytes
      || artifact.manifestChecksumSha256 !== draft.input.expectedManifestChecksumSha256) {
      throw new Error("The selected VM backup or export evidence changed after planning");
    }
    const inspection = await helper.request("virtualization.export.backup.restore-drill.inspect", draft.input);
    if (!inspection.ready || inspection.drillDomain !== restoreDrillDomainName(draft.input.drillId)) {
      throw new Error(inspection.blockers?.join(" | ") || "The isolated restore drill is unavailable or changed");
    }
    return { backup, artifact, inspection };
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.export.backup.restore-drill") throw new Error("VM restore drill plan not found");
    if (draft.revision !== revision) throw new Error("VM restore drill plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "VM restore drill plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.export.backup.restore-drill",
      title: `Run isolated restore drill for ${draft.input.domainName}`,
      risk: "medium",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: true, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Backup evidence, exact repository and snapshot identity, temporary capacity, generated domain name, libvirt access, and fixed no-network policy validated" },
        { name: "checkpoint", state: "completed", detail: "Source VM, export, restic snapshot, repository history, and existing domains remain unchanged; cleanup is confined to one server-generated transient domain" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.export.backup.restore-drill") throw new Error("Unsupported VM restore drill job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged VM restore drill plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The VM restore drill job inputs do not match the approved plan");
    await revalidate(staged);
    return staged;
  }

  function recordResult(job, result) {
    const input = job.parameters.input;
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

  return { plan, stage, validateJob, recordResult };
}
