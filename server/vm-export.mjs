import { randomUUID } from "node:crypto";
import { validateDomainName } from "./libvirt.mjs";
import { snapshotDiskRevision, snapshotInventoryRevision } from "./vm-snapshot.mjs";

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function validateVmExportInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["A VM export request is required"];
  if (typeof input.exportId !== "string" || !uuidPattern.test(input.exportId)) errors.push("Export id must be a UUID");
  if (!validateDomainName(input.name)) errors.push("Invalid domain name");
  if (typeof input.expectedUuid !== "string" || !uuidPattern.test(input.expectedUuid)) errors.push("Expected domain UUID is invalid");
  if (input.expectedState !== "stopped") errors.push("Offline export requires a stopped VM");
  if (typeof input.expectedDiskRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedDiskRevision)) errors.push("Expected VM disk revision is invalid");
  if (typeof input.expectedSnapshotRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedSnapshotRevision)) errors.push("Expected snapshot inventory revision is invalid");
  return errors;
}

export function createVmExportService({ store, libvirt, helper }) {
  async function inspect(name) {
    if (!validateDomainName(name)) throw new Error("Invalid domain name");
    const domain = await libvirt.getDomain(name);
    if (!domain || !domain.managed || !domain.persistent) throw new Error("Managed persistent VM not found");
    if (!domain.uuid || !uuidPattern.test(domain.uuid)) throw new Error("The VM UUID is unavailable");
    if (domain.state !== "stopped") throw new Error("BoxPilot exports VMs only while they are stopped");
    if (!Array.isArray(domain.snapshots) || domain.snapshotCount === null) throw new Error("Snapshot inventory is unavailable");
    const writableDisks = domain.disks.filter((disk) => disk.device === "disk");
    if (!writableDisks.length) throw new Error("No writable VM disk was reported");
    const helperInspection = await helper.request("virtualization.domain.export.inspect", { name });
    const diskRevision = snapshotDiskRevision(writableDisks);
    const snapshotRevision = snapshotInventoryRevision(domain.snapshots);
    if (helperInspection.domain !== name || helperInspection.uuid !== domain.uuid || helperInspection.state !== "stopped"
      || helperInspection.diskRevision !== diskRevision || helperInspection.snapshotRevision !== snapshotRevision) {
      throw new Error("Helper and inventory state did not match for this VM export");
    }
    return { domain, writableDisks, diskRevision, snapshotRevision, helperInspection };
  }

  async function plan(name, ownerId) {
    const inspected = await inspect(name);
    const input = {
      exportId: randomUUID(),
      name,
      expectedUuid: inspected.domain.uuid,
      expectedState: "stopped",
      expectedDiskRevision: inspected.diskRevision,
      expectedSnapshotRevision: inspected.snapshotRevision,
    };
    const capacityReady = inspected.helperInspection.destinationFreeBytes >= inspected.helperInspection.requiredBytes;
    const output = {
      executable: capacityReady,
      destination: "local-managed",
      diskTargets: inspected.helperInspection.disks.map((disk) => disk.target),
      sourceAllocatedBytes: inspected.helperInspection.sourceAllocatedBytes,
      requiredBytes: inspected.helperInspection.requiredBytes,
      destinationFreeBytes: inspected.helperInspection.destinationFreeBytes,
      blockers: capacityReady ? [] : ["The local managed export destination does not report enough free space"],
      changes: [
        "Write a root-only inactive domain XML export without security-label secrets",
        "Convert each stopped managed qcow2 disk to a new standalone qcow2 file under a server-generated export id",
        "Run qemu-img check and byte-content comparison for every exported disk",
        "Record SHA-256 checksums and a manifest in Operations Core",
      ],
      verification: ["Domain XML checksum", "Per-disk qemu-img structural check", "Per-disk source comparison", "Per-file SHA-256 checksum"],
      protected: false,
      encrypted: false,
      restoreDrill: { passed: false, reason: "An isolated restore boot has not run" },
      warnings: [
        "This first destination is on Bigbox and does not protect against host or disk loss.",
        "The export is root-only but not encrypted at rest.",
        "Disk content is verified, but the VM is not protected until an independent encrypted copy and isolated restore boot pass.",
        "Existing internal snapshot history is flattened to the current disk state in the exported qcow2 files.",
      ],
      recovery: "If conversion or verification fails, the helper removes only the new server-generated export directory. It never changes the source domain or disks.",
    };
    return store.createPlan({ type: "virtualization.export.create", subjectId: name, input, output, createdBy: ownerId });
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.export.create") throw new Error("VM export plan not found");
    if (draft.revision !== revision) throw new Error("VM export plan revision does not match");
    if (!draft.output.executable) throw new Error(draft.output.blockers.join(" | ") || "VM export plan is not executable");
    const live = await inspect(draft.input.name);
    if (live.domain.uuid !== draft.input.expectedUuid || live.domain.state !== draft.input.expectedState
      || live.diskRevision !== draft.input.expectedDiskRevision || live.snapshotRevision !== draft.input.expectedSnapshotRevision
      || live.helperInspection.destinationFreeBytes < live.helperInspection.requiredBytes) {
      throw new Error("Host state changed: create a new VM export plan");
    }
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.domain.export.create",
      title: `Export stopped VM ${draft.input.name}`,
      risk: "medium",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: true, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact domain UUID, stopped state, disk topology, snapshot inventory, managed qcow2 constraints, and destination capacity validated" },
        { name: "checkpoint", state: "completed", detail: "Source remains unchanged; cleanup is confined to a new server-generated export directory" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.domain.export.create") throw new Error("Unsupported VM export job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged VM export plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The VM export job inputs do not match the approved plan");
    const live = await inspect(staged.input.name);
    if (live.domain.uuid !== staged.input.expectedUuid || live.domain.state !== staged.input.expectedState
      || live.diskRevision !== staged.input.expectedDiskRevision || live.snapshotRevision !== staged.input.expectedSnapshotRevision
      || live.helperInspection.destinationFreeBytes < live.helperInspection.requiredBytes) {
      throw new Error("Host state changed: the VM export plan is stale");
    }
    return staged;
  }

  function recordResult(job, result) {
    if (result?.exportId !== job.parameters.input.exportId || result?.domain !== job.parameters.input.name
      || result?.uuid !== job.parameters.input.expectedUuid || !result?.contentVerified
      || result?.protected !== false || result?.encrypted !== false || result?.restoreDrill?.passed !== false
      || !/^[a-f0-9]{64}$/.test(result?.manifestChecksumSha256 ?? "") || !Number.isSafeInteger(result?.sizeBytes) || result.sizeBytes <= 0) {
      throw new Error("VM export evidence validation failed");
    }
    return store.recordVmExport({
      id: result.exportId,
      domainName: result.domain,
      domainUuid: result.uuid,
      destination: result.destination,
      artifactPath: result.artifactPath,
      manifestChecksumSha256: result.manifestChecksumSha256,
      sizeBytes: result.sizeBytes,
      protected: false,
      encrypted: false,
      restoreDrill: result.restoreDrill,
      createdBy: job.createdBy,
    });
  }

  function list() {
    return { exports: store.listVmExports() };
  }

  return { plan, stage, validateJob, recordResult, list };
}
