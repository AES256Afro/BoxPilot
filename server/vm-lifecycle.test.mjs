import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";
import { createVmLifecycleService, validateVmLifecycleInput } from "./vm-lifecycle.mjs";

const directories = [];

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-vm-lifecycle-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const token = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(token.token, { username: "owner", passwordHash: await hashPassword("password password") });
  let domain = { name: "ubuntu-lab", managed: true, state: "running", autostart: false };
  const libvirt = { getDomain: vi.fn(async () => domain) };
  return { store, owner, libvirt, setDomain: (next) => { domain = next; }, service: createVmLifecycleService({ store, libvirt }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable VM lifecycle plans", () => {
  it("rejects destructive and malformed helper inputs", () => {
    expect(validateVmLifecycleInput({ name: "../../etc", action: "destroy", expectedState: "paused", expectedAutostart: "no" })).toEqual([
      "Invalid domain name", "Unsupported VM lifecycle action", "Expected VM state must be running or stopped", "Expected autostart state must be true or false",
    ]);
  });

  it("stores, revalidates, and stages a graceful shutdown job", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan("ubuntu-lab", "shutdown", owner.id);
    expect(plan).toMatchObject({ type: "virtualization.action", input: { expectedState: "running", expectedAutostart: false }, output: { desired: { state: "stopped" } } });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "virtualization.domain.action", state: "awaiting_approval", risk: "medium", parameters: { input: plan.input } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged" });
    store.close();
  });

  it("rejects state drift and no-op autostart plans", async () => {
    const { store, owner, service, setDomain } = await setup();
    const plan = await service.plan("ubuntu-lab", "reboot", owner.id);
    setDomain({ name: "ubuntu-lab", managed: true, state: "stopped", autostart: false });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("not valid while");
    await expect(service.plan("ubuntu-lab", "autostart-off", owner.id)).rejects.toThrow("already has the requested autostart state");
    store.close();
  });

  it("rejects lifecycle input substitution after staging", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan("ubuntu-lab", "shutdown", owner.id);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    const substituted = { ...job, parameters: { ...job.parameters, input: { ...job.parameters.input, action: "reboot" } } };
    await expect(service.validateJob(substituted)).rejects.toThrow("do not match the approved plan");
    store.close();
  });
});
