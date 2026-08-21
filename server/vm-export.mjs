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

  /** Pin the exact stopped-domain topology for the registry operation. */
  async function prepareOperation({ name } = {}) {
    const inspected = await inspect(name);
    if (inspected.helperInspection.destinationFreeBytes < inspected.helperInspection.requiredBytes) throw new Error("The local managed export destination does not report enough free space");
    if (inspected.domain.state !== "stopped") throw new Error(`${name} must be stopped before it can be exported`);
    return {
      exportId: randomUUID(),
      name,
      expectedUuid: inspected.domain.uuid,
      expectedState: "stopped",
      expectedDiskRevision: inspected.diskRevision,
      expectedSnapshotRevision: inspected.snapshotRevision,
    };
  }

  function recordOperation(job, result) {
    if (result?.exportId !== job.parameters.exportId || result?.domain !== job.parameters.name
      || result?.uuid !== job.parameters.expectedUuid || !result?.contentVerified
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

  return { list, prepareOperation, recordOperation };
}
