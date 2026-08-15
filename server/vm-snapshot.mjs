import { createHash } from "node:crypto";
import { validateDomainName, validateSnapshotName } from "./libvirt.mjs";

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function snapshotInventoryRevision(snapshots = []) {
  const names = snapshots.map((snapshot) => typeof snapshot === "string" ? snapshot : snapshot.name).filter((name) => typeof name === "string").sort();
  return createHash("sha256").update(JSON.stringify(names)).digest("hex");
}

export function snapshotDiskRevision(disks = []) {
  const normalized = disks.map((disk) => ({ type: disk.type, device: disk.device, target: disk.target, source: disk.source }))
    .sort((left, right) => left.target.localeCompare(right.target));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function validateVmSnapshotInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["A VM snapshot request is required"];
  if (!validateDomainName(input.name)) errors.push("Invalid domain name");
  if (!validateSnapshotName(input.snapshotName)) errors.push("Snapshot name must use 1-63 letters, numbers, dots, underscores, or hyphens");
  if (typeof input.expectedUuid !== "string" || !uuidPattern.test(input.expectedUuid)) errors.push("Expected domain UUID is invalid");
  if (input.expectedState !== "stopped") errors.push("Offline snapshot creation requires a stopped VM");
  if (typeof input.expectedDiskRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedDiskRevision)) errors.push("Expected VM disk revision is invalid");
  if (typeof input.expectedSnapshotRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedSnapshotRevision)) errors.push("Expected snapshot inventory revision is invalid");
  return errors;
}

export function createVmSnapshotService({ store, libvirt }) {
  async function inspect(name, snapshotName) {
    if (!validateDomainName(name) || !validateSnapshotName(snapshotName)) throw new Error("Invalid domain or snapshot name");
    const domain = await libvirt.getDomain(name);
    if (!domain || !domain.managed || !domain.persistent) throw new Error("Managed persistent VM not found");
    if (!domain.uuid || !uuidPattern.test(domain.uuid)) throw new Error("The VM UUID is unavailable");
    if (domain.state !== "stopped") throw new Error("BoxPilot creates snapshots only while the VM is stopped");
    if (!Array.isArray(domain.snapshots) || domain.snapshotCount === null) throw new Error("Snapshot inventory is unavailable");
    if (domain.snapshots.some((snapshot) => snapshot.name === snapshotName)) throw new Error("A snapshot with that exact name already exists");
    const writableDisks = domain.disks.filter((disk) => disk.device === "disk");
    if (!writableDisks.length) throw new Error("No writable VM disk was reported");
    if (writableDisks.some((disk) => disk.type !== "file" || !disk.source.startsWith("/var/lib/libvirt/images/"))) {
      throw new Error("Offline snapshot creation is limited to file-backed disks in the managed default image directory");
    }
    return { domain, revision: snapshotInventoryRevision(domain.snapshots), writableDisks };
  }

  async function plan(name, snapshotName, ownerId) {
    const { domain, revision, writableDisks } = await inspect(name, snapshotName);
    const input = {
      name,
      snapshotName,
      expectedUuid: domain.uuid,
      expectedState: "stopped",
      expectedDiskRevision: snapshotDiskRevision(writableDisks),
      expectedSnapshotRevision: revision,
    };
    const output = {
      executable: true,
      consistency: "offline-consistent",
      independentBackup: false,
      currentSnapshotCount: domain.snapshotCount,
      diskTargets: writableDisks.map((disk) => disk.target),
      changes: [
        `Create one internal snapshot named ${snapshotName} for the stopped domain`,
        "Verify the snapshot is present, current, internal, and records a stopped guest state",
      ],
      warnings: [
        "A snapshot shares the VM disk and is not an independent backup.",
        "Snapshot growth depends on later writes. Monitor the default storage pool before starting the VM.",
        "Revert and delete are locked until BoxPilot has independent-backup evidence and chain-safe handlers.",
      ],
      recovery: "Snapshot creation is atomic but has no automatic delete rollback. If verification fails, leave the VM stopped and inspect snapshot metadata and disk state before any manual change.",
    };
    return store.createPlan({ type: "virtualization.snapshot.create", subjectId: `${name}/${snapshotName}`, input, output, createdBy: ownerId });
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.snapshot.create") throw new Error("VM snapshot plan not found");
    if (draft.revision !== revision) throw new Error("VM snapshot plan revision does not match");
    if (!draft.output.executable) throw new Error("VM snapshot plan is not executable");
    const live = await inspect(draft.input.name, draft.input.snapshotName);
    if (live.domain.uuid !== draft.input.expectedUuid || live.domain.state !== draft.input.expectedState || snapshotDiskRevision(live.writableDisks) !== draft.input.expectedDiskRevision || live.revision !== draft.input.expectedSnapshotRevision) {
      throw new Error("Host state changed: create a new VM snapshot plan");
    }
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.domain.snapshot.create",
      title: `Create offline snapshot ${draft.input.snapshotName} for ${draft.input.name}`,
      risk: "medium",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: false, reason: draft.output.recovery, manual: draft.output.recovery },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact domain UUID, stopped state, managed disk location, and snapshot-name absence validated" },
        { name: "checkpoint", state: "completed", detail: "Existing snapshot inventory revision recorded; revert and delete remain unavailable" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.domain.snapshot.create") throw new Error("Unsupported VM snapshot job");
    const staged = store.getPlan(job.parameters.planId);
    if (!staged || staged.status !== "staged" || staged.revision !== job.parameters.revision) throw new Error("The staged VM snapshot plan is unavailable or changed");
    if (staged.createdBy !== job.createdBy || JSON.stringify(job.parameters.input) !== JSON.stringify(staged.input)) throw new Error("The VM snapshot job inputs do not match the approved plan");
    const live = await inspect(staged.input.name, staged.input.snapshotName);
    if (live.domain.uuid !== staged.input.expectedUuid || live.domain.state !== staged.input.expectedState || snapshotDiskRevision(live.writableDisks) !== staged.input.expectedDiskRevision || live.revision !== staged.input.expectedSnapshotRevision) {
      throw new Error("Host state changed: the VM snapshot plan is stale");
    }
    return staged;
  }

  return { plan, stage, validateJob };
}
