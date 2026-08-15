import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationService, listApplicationManifests } from "./applications.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup({ statuses = {}, portInUse = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-apps-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const token = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(token.token, { username: "operator", passwordHash: "hash" });
  const checks = ["runtime.node", "storage.state", "helper.boundary", "containers.docker", "dns.port53"].map((id) => ({ id, status: statuses[id] ?? "ready", summary: `${id} status`, repair: null }));
  const service = createApplicationService({
    store,
    prerequisites: { inspect: vi.fn(async () => ({ checks })) },
    helper: { request: vi.fn(async () => ({ installed: false, state: "not-installed", detail: "Ready to plan" })) },
    inspectPort: vi.fn(async () => portInUse),
  });
  return { store, owner, service };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("application manifests and plans", () => {
  it("publishes integrity-addressed curated manifests", () => {
    const catalog = listApplicationManifests();
    expect(catalog.map((item) => item.id)).toEqual(["uptime-kuma", "pi-hole"]);
    expect(catalog[0]).toMatchObject({ image: { version: "2.5.0", digestPinned: true }, integrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(catalog[1]).toMatchObject({ execution: "planning-only", risk: "network-critical" });
  });

  it("creates and stages an executable Uptime Kuma plan only when checks pass", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan("uptime-kuma", { target: "docker", hostPort: 3101 }, owner.id);
    expect(plan.output).toMatchObject({ executable: true, hostPort: 3101, blockers: [] });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.uptime-kuma.deploy", state: "awaiting_approval", parameters: { hostPort: 3101 } });
    store.close();
  });

  it("blocks staging when Docker or the selected port is unavailable", async () => {
    const { store, owner, service } = await setup({ statuses: { "containers.docker": "missing" }, portInUse: true });
    const plan = await service.plan("uptime-kuma", { hostPort: 3001 }, owner.id);
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers.map((item) => item.id)).toEqual(["containers.docker", "port.3001"]);
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("unresolved blockers");
    store.close();
  });

  it("keeps Pi-hole planning-only and adds DNS recovery warnings", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan("pi-hole", { target: "docker", hostPort: 8080 }, owner.id);
    expect(plan.output.executable).toBe(false);
    expect(plan.output.warnings.join(" ")).toContain("Flint 2 AdGuard Home");
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("planning-only");
    store.close();
  });
});
