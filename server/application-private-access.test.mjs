// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationPrivateAccessService } from "./application-private-access.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-private-access-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: "hash" });
  const state = {
    installed: true,
    managedApplication: true,
    connected: true,
    published: false,
    tailnetOnly: false,
    conflict: false,
    dnsName: "bigbox.example.ts.net",
    port: 3101,
    url: null,
    revision: "a".repeat(64),
    applicationRevision: "d".repeat(64),
    configurationBoundaryRevision: "b".repeat(64),
    allowedActions: ["publish"],
    detail: "Ready for private access",
    boundary: { fixedApplication: true, fixedLoopbackTarget: true, funnelEnabled: false, publicExposure: false, firewallChanged: false, routerChanged: false, dnsChanged: false, containerChanged: false, arbitraryTargetAccepted: false, arbitraryPortAccepted: false, mutationPerformed: false },
    ...overrides,
  };
  const helper = { request: vi.fn(async () => state) };
  const service = createApplicationPrivateAccessService({ store, helper });
  return { store, owner, state, helper, service };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable Uptime Kuma private access plans", () => {
  it("creates and stages a fixed tailnet-only publish plan", async () => {
    const { store, owner, helper, service } = await setup();
    const plan = await service.plan("uptime-kuma", "publish", owner.id);

    expect(plan).toMatchObject({
      type: "application.private-access",
      subjectId: "uptime-kuma",
      input: { applicationId: "uptime-kuma", action: "publish", expectedRevision: "a".repeat(64) },
      output: { executable: true, desired: { published: true, tailnetOnly: true, url: "https://bigbox.example.ts.net:3101/", port: 3101 }, boundaries: expect.arrayContaining([expect.stringContaining("Funnel")]) },
    });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.uptime-kuma.private-access", state: "awaiting_approval", risk: "private-network-exposure", parameters: { input: plan.input } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged" });
    expect(helper.request).toHaveBeenCalledWith("application.uptime-kuma.private-access.inspect", {});
    store.close();
  });

  it("fails closed on an unmanaged route, unsupported app, or revision drift", async () => {
    const conflict = await setup({ conflict: true, allowedActions: [] });
    await expect(conflict.service.plan("uptime-kuma", "publish", conflict.owner.id)).rejects.toThrow("Ready for private access");
    await expect(conflict.service.plan("pi-hole", "publish", conflict.owner.id)).rejects.toThrow("adapter not found");
    conflict.store.close();

    const stale = await setup();
    const plan = await stale.service.plan("uptime-kuma", "publish", stale.owner.id);
    stale.state.revision = "c".repeat(64);
    await expect(stale.service.stage(plan.id, plan.revision, stale.owner.id)).rejects.toThrow("Host state changed");
    stale.store.close();
  });
});
