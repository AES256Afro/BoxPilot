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

  async function plan(backupId, targetName, ownerId) {
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
    const output = {
      executable: inspection.ready,
      targetDomainName,
      destination: "managed-libvirt-recovery",
      network: "none",
      persistent: true,
      initialState: "stopped",
      autostart: false,
      memoryMiB: inspection.memoryMiB,
      vcpus: inspection.vcpus,
      blockers: inspection.blockers,
      changes: [
        "Restore and reverify the exact protected restic snapshot in a server-generated staging workspace",
        "Move only the verified standalone qcow2 disks and evidence into a new server-generated libvirt recovery directory",
        `Define a new persistent domain named ${targetDomainName} with 2 vCPUs and 2048 MiB`,
        "Keep the recovered domain stopped, disable autostart, and attach no network interface",
        "Preserve the source VM, local export, protected snapshot, repository history, and existing domains unchanged",
      ],
      verification: [
        "Protected backup and passing isolated restore-drill evidence",
        "Exact repository, snapshot path, server-generated tags, manifest checksum, logical size, and qcow2 structure",
        "Generated domain XML with only fixed recovered disks, no network interface, and a guest-agent channel",
        "Persistent stopped domain, disabled autostart, zero interfaces, exact disk paths, and new libvirt UUID",
      ],
      warnings: [
        "This creates a new persistent VM and allocates storage. It never overwrites or deletes the source VM.",
        "The recovery clone starts with no network interface to prevent hostname, IP, DNS, or service conflicts.",
        "Use the existing guarded Start action and a private Cockpit console to inspect it. Network attachment remains a separate future workflow.",
        "A helper or host crash after libvirt definition may leave a stopped recovery domain for manual inspection; BoxPilot never guesses that it is safe to delete.",
      ],
      recovery: "Before libvirt definition, failures preserve root-only restic staging evidence. After definition begins, BoxPilot undefines only the newly named stopped no-network domain and removes only its server-generated recovery directory when exact rollback validation passes.",
    };
    return store.createPlan({ type: "virtualization.backup.recovery", subjectId: backup.id, input, output, createdBy: ownerId });
  }

  async function revalidate(draft) {
    const { backup, artifact } = evidence(draft.input.backupId);
    if (backup.exportId !== draft.input.exportId || backup.domainName !== draft.input.sourceDomainName || backup.domainUuid !== draft.input.sourceDomainUuid
      || backup.restoreDrill.drillId !== draft.input.restoreDrillId || backup.repositoryId !== draft.input.repositoryId
      || backup.snapshotId !== draft.input.snapshotId || backup.sizeBytes !== draft.input.expectedSizeBytes
      || artifact.manifestChecksumSha256 !== draft.input.expectedManifestChecksumSha256) {
      throw new Error("The selected protected backup evidence changed after planning");
    }
    const inspection = await helper.request("virtualization.backup.recovery.inspect", draft.input);
    if (!inspection.ready || inspection.targetDomainName !== draft.input.targetDomainName || inspection.network !== "none"
      || inspection.persistent !== true || inspection.initialState !== "stopped" || inspection.autostart !== false) {
      throw new Error(inspection.blockers?.join(" | ") || "The guarded VM recovery target is unavailable or changed");
    }
    return { backup, artifact, inspection };
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.backup.recovery") throw new Error("VM recovery plan not found");
    if (draft.revision !== revision) throw new Error("VM recovery plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "VM recovery plan is not executable");
    await revalidate(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.backup.recovery.create",
      title: `Create stopped recovery clone ${draft.input.targetDomainName}`,
      risk: "high",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: true, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Protected restore evidence, exact repository and snapshot, target-name absence, capacity, and fixed stopped no-network domain policy validated" },
        { name: "checkpoint", state: "completed", detail: "Source VM, export, snapshot, repository history, and every existing domain remain unchanged; rollback is confined to one new name and server-generated disk directory" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.backup.recovery.create") throw new Error("Unsupported VM recovery job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged VM recovery plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The VM recovery job inputs do not match the approved plan");
    await revalidate(staged);
    return staged;
  }

  function recordResult(job, result) {
    const input = job.parameters.input;
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

  return { plan, stage, validateJob, recordResult, list };
}
