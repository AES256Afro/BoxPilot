import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlint2AdguardService, flint2AdguardInternals } from "./flint2-adguard.mjs";
import { createJobService } from "./jobs.mjs";
import { createRouterCheckpointService } from "./router-checkpoints.mjs";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const assertions = Object.fromEntries(flint2AdguardInternals.assertionKeys.map((key) => [key, true]));

async function setup({ connected = true, routes = [{ gateway: "192.168.8.1", interface: "eno1", protocol: "dhcp" }], checkpoint = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-flint2-adguard-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: await hashPassword("correct horse battery") });
  const routerCheckpoints = createRouterCheckpointService({ store });
  if (checkpoint) routerCheckpoints.record({ modelId: "glinet-flint-2", firmwareVersion: "4.8.2", checksumSha256: "a".repeat(64), sizeBytes: 4096, fileRetainedByOperator: true }, owner.id);
  const network = { inspect: vi.fn(async () => ({ generatedAt: "2026-08-16T07:00:00.000Z", collectors: { routes: true }, defaultRoutes: routes, tailscale: { connected } })) };
  const checks = dnsAcceptanceChecks();
  const probeResolver = vi.fn(async () => checks);
  return { store, owner, network, routerCheckpoints, probeResolver, service: createFlint2AdguardService({ store, network, routerCheckpoints, probeResolver }) };
}

function dnsAcceptanceChecks() {
  return [
    { id: "gateway-public-udp", protocol: "udp", name: "example.com", type: "A", expectedRcode: 0, rcode: 0, answers: 1, recursionAvailable: true, truncated: false, latencyMs: 4, passed: true },
    { id: "gateway-public-tcp", protocol: "tcp", name: "example.com", type: "A", expectedRcode: 0, rcode: 0, answers: 1, recursionAvailable: true, truncated: false, latencyMs: 5, passed: true },
    { id: "gateway-second-public-udp", protocol: "udp", name: "example.net", type: "A", expectedRcode: 0, rcode: 0, answers: 1, recursionAvailable: true, truncated: false, latencyMs: 4, passed: true },
    { id: "gateway-negative-udp", protocol: "udp", name: "boxpilot.invalid", type: "A", expectedRcode: 3, rcode: 3, answers: 0, recursionAvailable: true, truncated: false, latencyMs: 3, passed: true },
  ];
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Flint 2 AdGuard Home direct acceptance", () => {
  it("derives the only live gateway and stages an immutable no-write DNS job", async () => {
    const { store, owner, probeResolver, service } = await setup();
    const plan = await service.plan(owner.id, assertions);
    expect(plan).toMatchObject({ type: "network.flint2-adguard.acceptance", subjectId: "glinet-flint-2", output: { executable: true, resolverAddress: "192.168.8.1", modelIdentityVerified: false, boundary: { routerCredentialsAccepted: false, arbitraryTargetAccepted: false, routerMutationPerformed: false, dnsCutoverPerformed: false } } });
    expect(plan.output.tests.map((test) => `${test.protocol}:${test.name}`)).toEqual(["udp:example.com", "tcp:example.com", "udp:example.net", "udp:boxpilot.invalid"]);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "network.flint2-adguard.acceptance.run", state: "awaiting_approval", risk: "network-read", parameters: { resolverAddress: "192.168.8.1", checkpointId: plan.output.checkpointId } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id });
    const helper = { request: vi.fn() };
    const jobs = createJobService(store, helper, { validateFlint2AdguardJob: service.validateJob, executeFlint2AdguardJob: service.executeJob, recordFlint2AdguardResult: service.recordResult });
    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");
    expect(probeResolver).toHaveBeenCalledWith("192.168.8.1");
    expect(helper.request).not.toHaveBeenCalled();
    expect(completed).toMatchObject({ state: "completed", result: { passed: true, modelIdentityVerified: false, routerMutationPerformed: false, dnsCutoverPerformed: false, dhcpChanged: false, clientSettingsChanged: false } });
    expect(store.listRouterDnsAcceptances()[0]).toMatchObject({ resolverAddress: "192.168.8.1", checkpointId: plan.output.checkpointId, passed: true, origin: "boxpilot-controller" });
    store.close();
  });

  it("rejects extra fields and exposes blockers for missing declarations, checkpoint, route, or Tailscale", async () => {
    const { store, owner, service } = await setup({ connected: false, routes: [], checkpoint: false });
    const plan = await service.plan(owner.id, { ...assertions, command: "reboot" });
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers.map((item) => item.id)).toEqual(expect.arrayContaining(["operator-declaration", "gateway", "checkpoint", "tailscale"]));
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("unresolved blockers");
    store.close();
  });

  it("fails closed when the observed gateway changes after planning", async () => {
    const { store, owner, network, service } = await setup();
    const plan = await service.plan(owner.id, assertions);
    network.inspect.mockResolvedValue({ generatedAt: "2026-08-16T07:01:00.000Z", collectors: { routes: true }, defaultRoutes: [{ gateway: "192.168.8.254", interface: "eno1", protocol: "dhcp" }], tailscale: { connected: true } });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("changed after planning");
    store.close();
  });

  it("fails the durable job and stores no passing evidence when a fixed response is malformed", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan(owner.id, assertions);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    const malformed = dnsAcceptanceChecks();
    malformed[0] = { ...malformed[0], expectedRcode: 3 };
    const failingService = createFlint2AdguardService({
      store,
      network: { inspect: vi.fn(async () => ({ collectors: { routes: true }, defaultRoutes: [{ gateway: "192.168.8.1", interface: "eno1", protocol: "dhcp" }], tailscale: { connected: true } })) },
      routerCheckpoints: createRouterCheckpointService({ store }),
      probeResolver: vi.fn(async () => malformed),
    });
    const jobs = createJobService(store, { request: vi.fn() }, { validateFlint2AdguardJob: failingService.validateJob, executeFlint2AdguardJob: failingService.executeJob, recordFlint2AdguardResult: failingService.recordResult });
    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("checks failed");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed" });
    expect(store.listRouterDnsAcceptances()).toEqual([]);
    store.close();
  });
});
