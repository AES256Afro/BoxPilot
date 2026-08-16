// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationLifecycleService } from "./application-lifecycle.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-application-lifecycle-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: "hash" });
  const state = {
    installed: true, managed: true, state: "running", running: true, healthy: true, port: 3101,
    revision: "a".repeat(64), allowedActions: ["stop", "restart"], detail: "Managed Uptime Kuma is healthy",
    ...overrides,
  };
  const helper = { request: vi.fn(async () => state) };
  const service = createApplicationLifecycleService({ store, helper });
  return { store, owner, state, helper, service };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable managed-application lifecycle plans", () => {
  it("creates and stages an exact revision-bound restart plan", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan("uptime-kuma", "restart", owner.id);
    expect(plan).toMatchObject({ type: "application.action", subjectId: "uptime-kuma", input: { applicationId: "uptime-kuma", action: "restart", expectedRevision: "a".repeat(64) }, output: { executable: true, label: "Restart", current: { state: "running", port: 3101 }, desired: { state: "running", port: 3101 } } });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.uptime-kuma.action", state: "awaiting_approval", parameters: { planId: plan.id, revision: plan.revision, input: plan.input }, recovery: { automaticRollback: false } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged" });
    store.close();
  });

  it("creates a network-critical Pi-hole lifecycle plan with independent-resolver recovery", async () => {
    const { store, owner, service, helper } = await setup({
      port: 8080,
      lanAddress: "192.168.8.10",
      dnsTcpBound: true,
      dnsUdpBound: true,
      detail: "Managed Pi-hole is healthy",
    });
    const plan = await service.plan("pi-hole", "stop", owner.id);
    expect(plan).toMatchObject({
      type: "application.action",
      subjectId: "pi-hole",
      input: { applicationId: "pi-hole", action: "stop", expectedRevision: "a".repeat(64) },
      output: {
        executable: true, applicationName: "Pi-hole", label: "Stop",
        current: { state: "running", port: 8080, lanAddress: "192.168.8.10", dnsTcpBound: true, dnsUdpBound: true },
        desired: { state: "stopped", healthy: false, port: 8080, lanAddress: "192.168.8.10" },
        recovery: expect.stringContaining("independently tested resolver"),
        boundaries: expect.arrayContaining([expect.stringContaining("interrupt DNS service")]),
      },
    });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.pi-hole.action", title: "Stop Pi-hole", risk: "network-critical-service-availability", recovery: { automaticRollback: false } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged" });
    expect(helper.request).toHaveBeenCalledWith("application.pi-hole.lifecycle.inspect", {});
    store.close();
  });

  it("rejects unsupported actions, identity failures, and state drift", async () => {
    const invalid = await setup();
    await expect(invalid.service.plan("unknown", "restart", invalid.owner.id)).rejects.toThrow("adapter not found");
    await expect(invalid.service.plan("uptime-kuma", "remove", invalid.owner.id)).rejects.toThrow("Unsupported");
    invalid.state.managed = false;
    await expect(invalid.service.plan("uptime-kuma", "restart", invalid.owner.id)).rejects.toThrow("Managed Uptime Kuma is healthy");
    invalid.store.close();

    const stale = await setup();
    const plan = await stale.service.plan("uptime-kuma", "stop", stale.owner.id);
    stale.state.revision = "b".repeat(64);
    await expect(stale.service.stage(plan.id, plan.revision, stale.owner.id)).rejects.toThrow("Host state changed");
    stale.store.close();
  });
});
