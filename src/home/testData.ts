import { vi } from "vitest";

/*
 * One fictional server for the Home and Ops tests, answering the endpoints the facts provider
 * reads, so the two views are tested against the same answers as they are drawn from the same
 * facts. Times are relative to the moment the tests run, like the loaders' own clock.
 */

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const GiB = 1024 ** 3;
const started = Date.now();
export const ago = (hours: number) => new Date(started - hours * 3_600_000).toISOString();

const job = (id: string, type: string, state: string, hours: number, extra: Record<string, unknown> = {}) => ({
  id, type, title: type === "op:app.backup" ? "Back up application data" : type.replace(/^op:/, ""), state, risk: "medium", error: null, result: null,
  steps: [], approvals: [], createdAt: ago(hours), updatedAt: ago(hours - 0.01), ...extra,
});

export const answers: Record<string, unknown> = {
  "/api/v1/catalog?view=summary": { host: { lanAddress: "192.0.2.10" }, liveError: null, applications: [
    { manifest: { id: "jellyfin", name: "Jellyfin", icon: "🎬", category: "Media" }, live: { installed: true, container: { running: true, status: "running", health: "healthy" }, updateAvailable: true, urls: [{ host: 8096, exposure: "lan" }] } },
    { manifest: { id: "vaultwarden", name: "Vaultwarden", icon: null, category: "Security" }, live: { installed: true, container: { running: false, status: "exited", health: "none" }, urls: [{ host: 8222, exposure: "lan" }] } },
    { manifest: { id: "mealie", name: "Mealie", category: "Food" }, live: null },
  ] },
  "/api/v1/operations/app.serve.inspect/inspect": { operation: "app.serve.inspect", result: { available: true, serves: [] } },
  "/api/v1/inventory": {
    host: { hostname: "homebox", operatingSystem: "Ubuntu 24.04 LTS", kernel: "6.8.0", uptimeSeconds: 90_000 },
    compute: { cpuCount: 8, cpuModel: "fixture", load1: 0.84, loadPercent: 11, totalMemoryBytes: 32 * GiB, usedMemoryBytes: 11 * GiB, memoryUsedPercent: 34 },
    storage: { root: { totalBytes: 100 * GiB, usedBytes: 20 * GiB, usedPercent: 20 }, filesystems: { mounts: [{ target: "/", source: "/dev/sda2", totalBytes: 100 * GiB, usedBytes: 20 * GiB, usedPercent: 20, capacityState: "healthy" }] } },
    network: { addresses: [{ interface: "eno1", address: "192.0.2.10" }], tailscale: { installed: true, connected: true, dnsName: null } },
  },
  "/api/v1/operations/apt.upgradable.inspect/inspect": { result: { count: 4, securityCount: 1, rebootRequired: false } },
  "/api/v1/operations/apt.unattended.inspect/inspect": { result: { installed: true, enabled: true } },
  "/api/v1/operations/service.list/inspect": { result: { counts: { total: 100, active: 80, failed: 0 } } },
  "/api/v1/settings/watch": { targetConfigured: true, conditions: [], notices: [] },
  "/api/v1/remediations": { findings: [], counts: { critical: 0, warning: 0, info: 0 }, unavailableChecks: [] },
  "/api/v1/schedules": { schedules: [] },
  "/api/v1/operations/app.backup.protection/inspect": { result: { available: true, apps: [
    { id: "jellyfin", name: "Jellyfin", protectable: true, backups: 3, newestAt: ago(10) },
    { id: "vaultwarden", name: "Vaultwarden", protectable: true, backups: 1, newestAt: ago(20) },
  ] } },
  "/api/v1/settings/cloud-destination": { destination: { provider: "b2" }, lastSync: { completedAt: ago(5) } },
  "/api/v1/settings/backup-destination": { destination: null, lastSync: null },
  "/api/v1/operations/host.snapshot.inspect/inspect": { result: { sync: { mount: { mounted: false }, lastSync: null } } },
  "/api/v1/backups": { backups: [{ applicationId: "boxpilot-controller", createdAt: ago(3) }] },
  "/api/v1/setup": { firstRun: false, installedApps: 2 },
  "/api/v1/setup/checklist": { done: 5, total: 5, items: [] },
  "/api/v1/virtualization/domains": { domains: [] },
  "/api/v1/jobs?limit=50": { jobs: [] },
  "/api/v1/jobs?limit=200": { jobs: [] },
};

/** The same server, busier: what Ops has more to show about. */
export const busier: Record<string, unknown> = {
  "/api/v1/operations/apt.upgradable.inspect/inspect": { result: { count: 4, securityCount: 1, rebootRequired: true } },
  "/api/v1/operations/service.list/inspect": { result: { counts: { total: 100, active: 80, failed: 1 } } },
  "/api/v1/virtualization/domains": { domains: [{ name: "dev-lab", state: "running", vcpus: 4, memoryKiB: 8 * 1024 * 1024 }, { name: "win11-test", state: "shut off", vcpus: 2, memoryKiB: 4 * 1024 * 1024 }] },
  "/api/v1/operations/system.performance.inspect/inspect": { result: {
    cpu: { model: "fixture", cores: 16, usagePercent: 27.4, perCore: [], load1: 2.31, load5: 1.84, load15: 1.42, loadPercent: 14 },
    memory: { totalBytes: 32 * GiB, usedBytes: 11 * GiB, availableBytes: 21 * GiB, usedPercent: 34 },
    swap: { totalBytes: 0, usedBytes: 0, usedPercent: 0 }, uptimeSeconds: 90_000,
    temps: [{ label: "k10temp: Tctl", celsius: 52.4 }],
    disks: [{ mount: "/", fstype: "ext4", totalBytes: 100 * GiB, usedBytes: 20 * GiB, availableBytes: 80 * GiB, usedPercent: 20 }],
    statsAvailable: true,
    apps: [{ id: "jellyfin", state: "running", running: true, cpuPercent: 34.2, memBytes: 412 * 1024 ** 2, containers: 1 }, { id: "vaultwarden", state: "exited", running: false, cpuPercent: 0, memBytes: 0, containers: 0 }],
  } },
  "/api/v1/jobs?limit=50": { jobs: [
    job("run1", "op:app.update", "applying", 0.05, { parameters: { id: "jellyfin" } }),
    job("wait1", "op:storage.remount", "awaiting_approval", 0.3, { parameters: { name: "media" }, title: "Reconnect a drive" }),
    job("done1", "op:apt.refresh", "completed", 2, { risk: "low" }),
  ] },
  "/api/v1/jobs?limit=200": { jobs: [
    job("b3", "op:app.backup", "completed", 11, { parameters: { id: "jellyfin" } }),
    job("b2", "op:app.backup", "completed", 35, { parameters: { id: "jellyfin" } }),
    job("b1", "op:app.backup", "completed", 59, { parameters: { id: "jellyfin" } }),
    job("v1", "op:app.backup", "failed", 16, { parameters: { id: "vaultwarden" }, error: "tar failed: No space left on device" }),
  ] },
};

/** A fetch that answers from the table; a POST that stages a job answers like the real route. */
export function stubFetch(overrides: Record<string, unknown> = {}, fail = false) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method === "POST" && url.endsWith("/jobs")) {
      const operation = url.split("/")[4];
      return json({ job: { id: "staged", type: `op:${operation}`, title: operation, state: "awaiting_approval", risk: "low", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "low", passwordRequired: false, elevated: false, mode: "tiered", reason: "" } }, 201);
    }
    if (fail && !url.startsWith("/api/v1/jobs")) return json({ error: "BoxPilot is not answering" }, 503);
    const table = { ...answers, ...overrides };
    return url in table ? json(table[url]) : json({ error: `unexpected ${url}` }, 404);
  });
}
