import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";
import { createVmExportService, validateVmExportInput } from "./vm-export.mjs";
import { snapshotDiskRevision, snapshotInventoryRevision } from "./vm-snapshot.mjs";

const directories = [];
const uuid = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-vm-export-"));
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
  const inspect = () => ({
    domain: domain.name,
    uuid: domain.uuid,
    state: domain.state,
    diskRevision: snapshotDiskRevision(domain.disks.filter((disk) => disk.device === "disk")),
    snapshotRevision: snapshotInventoryRevision(domain.snapshots),
    disks: [{ target: "vda", actualSizeBytes: 4096, virtualSizeBytes: 1024 ** 3 }],
    sourceAllocatedBytes: 4096,
    requiredBytes: 1024 ** 3 + 4916,
    destinationFreeBytes: 10 * 1024 ** 3,
  });
  const helper = { request: vi.fn(async () => inspect()) };
  return {
    store,
    owner,
    helper,
    setDomain: (next) => { domain = next; },
    service: createVmExportService({ store, libvirt, helper }),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("guarded stopped VM exports", () => {
  it("validates only exact immutable helper inputs", () => {
    expect(validateVmExportInput({ name: "../../etc", exportId: "no", expectedUuid: "no", expectedState: "running", expectedDiskRevision: "x", expectedSnapshotRevision: "x" })).toEqual([
      "Export id must be a UUID", "Invalid domain name", "Expected domain UUID is invalid", "Offline export requires a stopped VM", "Expected VM disk revision is invalid", "Expected snapshot inventory revision is invalid",
    ]);
  });

  it("creates and stages a local export without claiming backup protection", async () => {
    const { store, owner, helper, service } = await setup();
    const plan = await service.plan("ubuntu-lab", owner.id);
    expect(plan).toMatchObject({
      type: "virtualization.export.create",
      input: { expectedUuid: uuid, expectedState: "stopped" },
      output: { executable: true, destination: "local-managed", protected: false, encrypted: false, restoreDrill: { passed: false } },
    });
    expect(plan.output.warnings.join(" ")).toContain("does not protect against host or disk loss");
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "virtualization.domain.export.create", state: "awaiting_approval", risk: "medium" });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged" });
    expect(helper.request).toHaveBeenCalledWith("virtualization.domain.export.inspect", { name: "ubuntu-lab" });
    store.close();
  });

  it("rejects state, disk, and capacity drift", async () => {
    const { store, owner, setDomain, service } = await setup();
    const plan = await service.plan("ubuntu-lab", owner.id);
    setDomain({
      name: "ubuntu-lab", uuid, managed: true, persistent: true, state: "running", snapshotCount: 1,
      snapshots: [{ name: "clean-install" }],
      disks: [{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/ubuntu-lab.qcow2" }],
    });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("only while they are stopped");
    setDomain({
      name: "ubuntu-lab", uuid, managed: true, persistent: true, state: "stopped", snapshotCount: 1,
      snapshots: [{ name: "clean-install" }],
      disks: [{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/substituted.qcow2" }],
    });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("Host state changed");
    store.close();
  });

  it("records only verified evidence and preserves honest protection flags", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan("ubuntu-lab", owner.id);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    const result = {
      exportId: plan.input.exportId,
      domain: "ubuntu-lab",
      uuid,
      destination: "local-managed",
      artifactPath: `/var/lib/boxpilot-managed/vm-exports/${plan.input.exportId}`,
      manifestChecksumSha256: "a".repeat(64),
      sizeBytes: 8192,
      contentVerified: true,
      protected: false,
      encrypted: false,
      restoreDrill: { passed: false, reason: "not run" },
    };
    expect(service.recordResult(job, result)).toMatchObject({ protected: false, encrypted: false, restoreDrill: { passed: false } });
    expect(service.list().exports).toHaveLength(1);
    expect(() => service.recordResult(job, { ...result, protected: true })).toThrow("evidence validation failed");
    store.close();
  });
});
