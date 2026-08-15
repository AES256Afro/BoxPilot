import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";
import { createVmCreationService } from "./vm-creation.mjs";

const directories = [];
const input = { name: "ubuntu-lab", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu.iso", network: "default", firmware: "uefi", autostart: false };

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-vm-creation-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const token = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(token.token, { username: "owner", passwordHash: await hashPassword("password password") });
  const planner = { createPlan: vi.fn(async () => ({ ok: true, plan: { revision: "adapter-revision", executable: true, stageable: true, input, profile: { label: "Ubuntu", osVariant: "ubuntu24.04" }, media: { name: "ubuntu.iso", sizeBytes: 4096 }, warnings: [], command: { display: "virt-install" }, gates: [] } })) };
  const libvirt = {
    getDomain: vi.fn(async () => null),
    listResources: vi.fn(async () => ({ connected: true, networks: [{ name: "default", active: true }], pools: [{ name: "default", active: true, availableBytes: 100 * 1024 ** 3 }] })),
  };
  return { store, owner, planner, libvirt, service: createVmCreationService({ store, planner, libvirt }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable VM creation plans", () => {
  it("stores, revalidates, and stages an immutable awaiting-approval job", async () => {
    const { store, owner, service } = await setup();
    const result = await service.plan(input, owner.id);
    expect(result.plan).toMatchObject({ id: expect.any(String), revision: expect.any(String), adapterRevision: "adapter-revision", status: "draft", stageable: true });

    const job = await service.stage(result.plan.id, result.plan.revision, owner.id);
    expect(job).toMatchObject({ state: "awaiting_approval", type: "virtualization.domain.create", parameters: { input, planId: result.plan.id } });
    expect(store.getPlan(result.plan.id).status).toBe("staged");
    store.close();
  });

  it("fails staging when live host state changes", async () => {
    const { store, owner, service, libvirt } = await setup();
    const result = await service.plan(input, owner.id);
    libvirt.getDomain.mockResolvedValue({ name: input.name });
    await expect(service.stage(result.plan.id, result.plan.revision, owner.id)).rejects.toThrow("Host state changed");
    expect(store.getPlan(result.plan.id).status).toBe("draft");
    store.close();
  });

  it("refuses a mismatched revision and a non-executable profile", async () => {
    const { store, owner, service, planner } = await setup();
    const result = await service.plan(input, owner.id);
    await expect(service.stage(result.plan.id, "wrong", owner.id)).rejects.toThrow("revision does not match");
    planner.createPlan.mockResolvedValueOnce({ ok: true, plan: { revision: "windows", executable: false, stageable: false, input: { ...input, osProfile: "windows-11" } } });
    const windows = await service.plan({ ...input, osProfile: "windows-11" }, owner.id);
    await expect(service.stage(windows.plan.id, windows.plan.revision, owner.id)).rejects.toThrow("not executable");
    store.close();
  });

  it("rejects job input substitution after the plan is staged", async () => {
    const { store, owner, service } = await setup();
    const result = await service.plan(input, owner.id);
    const job = await service.stage(result.plan.id, result.plan.revision, owner.id);
    const substituted = { ...job, parameters: { ...job.parameters, input: { ...job.parameters.input, diskGiB: 400 } } };
    await expect(service.validateJob(substituted)).rejects.toThrow("do not match the approved plan");
    store.close();
  });
});
