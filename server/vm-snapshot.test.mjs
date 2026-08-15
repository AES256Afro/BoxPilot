import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";
import { createVmSnapshotService, snapshotDiskRevision, snapshotInventoryRevision, validateVmSnapshotInput } from "./vm-snapshot.mjs";

const directories = [];
const uuid = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-vm-snapshot-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: await hashPassword("password password") });
  let domain = {
    name: "ubuntu-lab", uuid, managed: true, persistent: true, state: "stopped", snapshotCount: 1,
    snapshots: [{ name: "clean-install" }],
    disks: [{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/ubuntu-lab.qcow2" }],
  };
  const libvirt = { getDomain: vi.fn(async () => domain) };
  return { store, owner, setDomain: (next) => { domain = next; }, service: createVmSnapshotService({ store, libvirt }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("guarded offline VM snapshots", () => {
  it("validates exact stopped-state helper inputs", () => {
    expect(validateVmSnapshotInput({ name: "../../etc", snapshotName: "bad name", expectedUuid: "no", expectedState: "running", expectedDiskRevision: "x", expectedSnapshotRevision: "x" })).toEqual([
      "Invalid domain name", "Snapshot name must use 1-63 letters, numbers, dots, underscores, or hyphens", "Expected domain UUID is invalid", "Offline snapshot creation requires a stopped VM", "Expected VM disk revision is invalid", "Expected snapshot inventory revision is invalid",
    ]);
  });

  it("creates, revalidates, and stages an immutable snapshot plan", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan("ubuntu-lab", "pre-upgrade", owner.id);
    expect(plan).toMatchObject({ type: "virtualization.snapshot.create", input: { expectedUuid: uuid, expectedState: "stopped" }, output: { consistency: "offline-consistent", independentBackup: false } });
    expect(plan.input.expectedSnapshotRevision).toBe(snapshotInventoryRevision([{ name: "clean-install" }]));
    expect(plan.input.expectedDiskRevision).toBe(snapshotDiskRevision([{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/ubuntu-lab.qcow2" }]));
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "virtualization.domain.snapshot.create", state: "awaiting_approval", risk: "medium" });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged" });
    store.close();
  });

  it("rejects running guests, duplicates, unmanaged paths, and drift", async () => {
    const { store, owner, setDomain, service } = await setup();
    const plan = await service.plan("ubuntu-lab", "pre-upgrade", owner.id);
    setDomain({ name: "ubuntu-lab", uuid, managed: true, persistent: true, state: "running", snapshotCount: 1, snapshots: [{ name: "clean-install" }], disks: [{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/ubuntu-lab.qcow2" }] });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("only while the VM is stopped");
    setDomain({ name: "ubuntu-lab", uuid, managed: true, persistent: true, state: "stopped", snapshotCount: 1, snapshots: [{ name: "clean-install" }], disks: [{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/substituted.qcow2" }] });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("Host state changed");
    setDomain({ name: "ubuntu-lab", uuid, managed: true, persistent: true, state: "stopped", snapshotCount: 1, snapshots: [{ name: "pre-upgrade" }], disks: [{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/ubuntu-lab.qcow2" }] });
    await expect(service.plan("ubuntu-lab", "pre-upgrade", owner.id)).rejects.toThrow("already exists");
    setDomain({ name: "ubuntu-lab", uuid, managed: true, persistent: true, state: "stopped", snapshotCount: 0, snapshots: [], disks: [{ type: "block", device: "disk", target: "vda", source: "/dev/sda" }] });
    await expect(service.plan("ubuntu-lab", "safe", owner.id)).rejects.toThrow("managed default image directory");
    store.close();
  });
});
