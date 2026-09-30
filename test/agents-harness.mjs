/**
 * A whole agents setup for tests (M37): a real state store and agent store in a temporary
 * directory, the real registry, a stub helper and inventory, a stand-in model on a loopback port,
 * and the real runner loop talking straight to the service. Each test reads what the model was
 * sent (`fake.prompts()`), what the helper was asked (`helperCalls`) and what was stored.
 *
 * The clock is the harness's: `advance(ms)` moves the service, the store and the runner together.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenAiClient } from "../server/assistant/model-client.mjs";
import { createKnowledgeIndex } from "../server/assistant/knowledge.mjs";
import { startFakeModel } from "../server/agents/fake-model.mjs";
import { createRunner, directRunnerApi } from "../server/agents/runner.mjs";
import { createRuntime } from "../server/agents/runtime.mjs";
import { agentsRuntimeKey, createAgentService, defaultRuntimeSettings } from "../server/agents/service.mjs";
import { createAgentStore } from "../server/agents/store.mjs";
import { registry } from "../server/ops/index.mjs";
import { createRedactor } from "../server/redaction.mjs";
import { createStateStore } from "../server/state.mjs";

export const documents = {
  "AGENTS.md": "# Working on BoxPilot\n\n## Copy\n\nSay what the action does.\n",
  "docs/BACKUPS.md": "# Backups\n\n## Restore\n\nTo restore an app from a backup, open its card, pick a backup archive and approve the restore.\n",
};

export function defaultHelperAnswers() {
  return {
    "app.inspect": () => ({ applications: [
      { id: "pi-hole", name: "Pi-hole", installed: true, container: { running: true, status: "running", health: "healthy", restarts: 0 }, urls: [] },
      { id: "jellyfin", name: "Jellyfin", installed: true, container: { running: true, status: "running", health: "unhealthy", restarts: 3 }, urls: [] },
    ] }),
    "service.list": () => ({ units: [{ unit: "docker.service", active: "active", sub: "running", enabled: "enabled" }, { unit: "smartd.service", active: "failed", sub: "failed", enabled: "enabled" }], counts: { total: 2, active: 1, failed: 1 } }),
    "logs.read": (parameters) => ({ kind: parameters.kind, target: parameters.target, lines: ["2026-09-29T09:00:00 boxpilot: started", "2026-09-29T09:01:00 boxpilot: token=SENTINEL-LOG-1 refused"] }),
    "app.pihole.inspect": () => ({ placement: "boxpilot-app", container: "bp-pi-hole", running: true, available: true, blocking: true, last24h: { queries: 1000, blocked: 150, blockedPercent: 15 }, gravity: { domains: 90_000, updatedAt: "2026-09-27T00:00:00.000Z", ageDays: 2.4 }, upstreams: [{ upstream: "9.9.9.9#53", queries: 800, share: 100, averageReplyMs: 14 }], topBlocked: [{ domain: "ads.example.com", count: 40 }] }),
    "agents.runtime.inspect": () => ({ runtime: { installed: false, version: null }, service: { active: "inactive" }, models: [], diskFreeBytes: 100e9 }),
    // M40: the runner's processors, set at each run as the root helper does (server/agents/cpu.mjs).
    "agents.runtime.cpu": (parameters) => ({ processors: parameters.processors, background: parameters.background, quotaPercent: parameters.processors * 100, perSecond: `${parameters.processors}s`, resetAt: parameters.processors > parameters.background ? "2026-09-29T10:30:00.000Z" : null }),
  };
}

export async function createAgentsHarness({ limits = {}, runnerOptions = {}, serviceOptions = {}, start = new Date(2026, 8, 29, 10, 0, 0) } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-agents-"));
  const clock = { at: start.getTime() };
  const now = () => new Date(clock.at);
  const state = createStateStore({ stateDirectory: directory, now });
  const store = createAgentStore({ databasePath: state.databasePath, now });
  const accounts = {};
  accounts.owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "owner", passwordHash: "x" });
  accounts.operator = state.createOwnerAccount({ username: "operator", passwordHash: "x", role: "operator", createdBy: accounts.owner.id });
  accounts.viewer = state.createOwnerAccount({ username: "viewer", passwordHash: "x", role: "viewer", createdBy: accounts.owner.id });
  const caller = (role) => ({ id: accounts[role].id, role });

  const helperCalls = [];
  const helperAnswers = defaultHelperAnswers();
  const helper = {
    request: async (operation, parameters) => {
      helperCalls.push({ operation, parameters });
      const answer = helperAnswers[operation];
      if (!answer) throw new Error(`no stub for ${operation}`);
      return answer(parameters);
    },
  };
  const snapshot = {
    host: { hostname: "testbox", operatingSystem: "Ubuntu 24.04.3 LTS", kernel: "6.8.0-50-generic", architecture: "x64", uptimeSeconds: 90_000 },
    compute: { cpuCount: 16, cpuModel: "Example 8-core processor", load1: 0.4, loadPercent: 3, totalMemoryBytes: 32e9, usedMemoryBytes: 8e9, memoryUsedPercent: 25 },
    network: { addresses: [{ interface: "eth0", address: "192.168.1.20" }], tailscale: { installed: true, connected: true, dnsName: "testbox.example.ts.net" } },
    services: [{ unit: "docker.service", active: "active" }],
    storage: { root: { usedPercent: 42, freeBytes: 400e9, totalBytes: 700e9 }, filesystems: { available: true, mounts: [] }, smart: { available: true, status: "ok", summary: { healthy: 2 } } },
    docker: { containers: [{ name: "portainer", image: "portainer/portainer-ce", state: "running", health: "none", app: null }] },
  };
  const inventory = { inspect: async () => snapshot };
  const told = [];
  const healthAlerts = { tell: async (entry) => { told.push(entry); return { key: entry.key, notified: true }; } };
  const knowledge = createKnowledgeIndex({
    registry, catalog: null, root: "/repo",
    readDirectory: async () => Object.keys(documents).filter((name) => name.startsWith("docs/")).map((name) => name.slice(5)),
    readText: async (file) => {
      const relative = path.relative("/repo", file).replaceAll("\\", "/");
      if (!(relative in documents)) throw new Error("missing");
      return documents[relative];
    },
  });
  const fetched = [];
  const newerListing = { value: [] };
  const service = createAgentService({
    state, store, registry, helper, inventory, knowledge, healthAlerts, now,
    redactor: createRedactor({ additionalLiterals: ["SENTINEL-LITERAL-9"] }),
    tokenPath: path.join(directory, "agents", "runner.token"),
    fetchJson: async (url) => { fetched.push(url); return url.includes("?author=") ? newerListing.value : { siblings: [{ rfilename: "Qwen3.6-4B-UD-Q4_K_XL.gguf" }, { rfilename: "mmproj-F16.gguf" }] }; },
    hostLoad: () => 0,
    limits,
    // The owner's machine (a Ryzen 7 7800X3D: 16 processors, 8 cores), whatever runs the tests: a
    // person's run gets 8 processors and threads, the background 4 (M40).
    processors: 16, physicalCoreCount: 8,
    ...serviceOptions,
  });

  const fake = await startFakeModel({});
  state.setSetting(agentsRuntimeKey, { ...defaultRuntimeSettings(), driver: "external", endpoint: fake.url });
  const client = createOpenAiClient({ loopbackOnly: true });
  const runtime = createRuntime({ client });
  const runnerId = randomUUID();
  const runner = createRunner({ api: directRunnerApi(service, runnerId), runtime, client, now: () => clock.at, options: runnerOptions });

  /** Hand out the next run and carry it out, as the runner would; null when nothing was handed out. */
  async function runNext() {
    const claim = await service.runnerNext(runnerId, { waitMs: 0 });
    if (!claim) return null;
    await runner.execute(claim);
    return service.getRun(caller("owner"), claim.run.id);
  }

  return {
    directory, state, store, service, fake, helper, helperCalls, helperAnswers, inventory, snapshot, told, fetched, newerListing, accounts, caller, runnerId, runner, runtime, client, runNext,
    now, advance: (ms) => { clock.at += ms; }, setTime: (date) => { clock.at = date.getTime(); },
    enable: () => service.saveModule(caller("owner"), { enabled: true }),
    close: async () => { await fake.close(); await runtime.stop("test over"); store.close(); state.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
