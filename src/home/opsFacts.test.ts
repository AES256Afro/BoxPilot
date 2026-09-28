import { describe, expect, it } from "vitest";
import type { Job } from "../operations";
import type { AppFact } from "./facts";
import { reachOf } from "./needs";
import { backupMatrix, jobState, jobTarget, performanceFrom, shortReach, workloads, type Performance } from "./opsFacts";

const now = Date.parse("2026-09-28T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

function app(overrides: Partial<AppFact> = {}): AppFact {
  return {
    id: "jellyfin", name: "Jellyfin", icon: "🎬", category: "Media", running: true, paused: false, status: "running", health: "healthy",
    troubledSidecar: null, updateAvailable: false, folderProblems: 0, vpnLeaked: false, stoppedOnPurpose: false, url: null, port: 8096, exposure: "lan", served: false, drill: null, ...overrides,
  };
}

function job(overrides: Partial<Job>): Job {
  return { id: "j", type: "op:app.backup", title: "Back up application data", state: "completed", risk: "medium", error: null, result: null, steps: [], approvals: [], createdAt: hoursAgo(1), ...overrides };
}

const performance = (apps: Performance["apps"], statsAvailable = true): Performance => performanceFrom({
  cpu: { model: "x", cores: 8, usagePercent: 10, load1: 1, load5: 1, load15: 1, loadPercent: 12 }, memory: { totalBytes: 1, usedBytes: 1, availableBytes: 0, usedPercent: 50 },
  temps: [], disks: [], statsAvailable, apps, uptimeSeconds: 1,
});

describe("the containers table", () => {
  it("puts the busiest first, says each state in a word, and adds the VMs after", () => {
    const rows = workloads(
      [app(), app({ id: "immich", name: "Immich" }), app({ id: "vaultwarden", name: "Vaultwarden", running: false, status: "exited" }), app({ id: "open-webui", name: "Open WebUI", running: false, paused: true, status: "paused" })],
      performance([{ id: "jellyfin", state: "running", running: true, cpuPercent: 3.2, memBytes: 400, containers: 1 }, { id: "immich", state: "running", running: true, cpuPercent: 11.8, memBytes: 1400, containers: 4 }, { id: "open-webui", state: "paused", running: true, cpuPercent: 0, memBytes: 6100, containers: 2 }]),
      { domains: [{ name: "dev-lab", state: "running", vcpus: 4, memoryBytes: 8 }, { name: "win11-test", state: "shut off", vcpus: 2, memoryBytes: 4 }] },
      reachOf,
    );
    expect(rows.map((row) => [row.name, row.status, row.state, row.cpuPercent])).toEqual([
      ["Immich", "good", "up", 11.8],
      ["Jellyfin", "good", "up", 3.2],
      ["Open WebUI", "neutral", "paused", 0],
      ["Vaultwarden", "danger", "stopped", null],
      ["dev-lab", "good", "running", null],
      ["win11-test", "neutral", "shut off", null],
    ]);
    expect(rows[0].reach).toBe("On your network");
    expect(rows.at(-1)?.memBytes).toBeNull(); // a stopped VM holds no memory
  });

  it("does not call an app the owner stopped a problem, and says when there is no container at all", () => {
    const rows = workloads([
      app({ id: "plex", name: "Plex", running: false, status: "exited", stoppedOnPurpose: true }),
      app({ id: "dockge", name: "Dockge", running: false, status: "absent" }),
    ], null, null, reachOf);
    expect(rows.map((row) => [row.name, row.status, row.state])).toEqual([["Dockge", "warning", "no container"], ["Plex", "neutral", "stopped"]]);
  });

  it("says who can reach an app in one word", () => {
    expect(shortReach({ port: 8096, exposure: "lan", served: false })).toBe("LAN");
    expect(shortReach({ port: 8096, exposure: "lan", served: true })).toBe("tailnet");
    expect(shortReach({ port: 11434, exposure: "loopback", served: false })).toBe("local");
    expect(shortReach({ port: null, exposure: null, served: false })).toBe("—");
  });

  it("shows no numbers when Docker's stats are not answering, rather than zeroes", () => {
    const rows = workloads([app()], performance([{ id: "jellyfin", state: "running", running: true, cpuPercent: 0, memBytes: 0, containers: 1 }], false), null, reachOf);
    expect(rows[0]).toMatchObject({ cpuPercent: null, memBytes: null });
    expect(() => performanceFrom({ cpu: {} })).toThrow();
  });
});

describe("the job queue", () => {
  it("names what each job acted on, and its state as Activity does", () => {
    expect(jobTarget(job({ parameters: { id: "immich", keep: 5 } }))).toBe("immich");
    expect(jobTarget(job({ parameters: { name: "media" } }))).toBe("media");
    expect(jobTarget(job({ parameters: { packages: ["htop", "tmux"] } }))).toBe("2 packages");
    expect(jobTarget(job({ parameters: {} }))).toBe("—");
    expect(jobState(job({ state: "failed" }))).toEqual({ status: "danger", label: "Failed" });
    expect(jobState(job({ state: "applying" }))).toEqual({ status: "warning", label: "Running" });
    expect(jobState(job({ state: "awaiting_approval" }))).toEqual({ status: "neutral", label: "Awaiting approval" });
    expect(jobState(job({ state: "completed" }))).toEqual({ status: "good", label: "Completed" });
  });
});

describe("the backup matrix", () => {
  const protection = [
    { id: "jellyfin", name: "Jellyfin", protectable: true, backups: 9, newestAt: hoursAgo(11) },
    { id: "immich", name: "Immich", protectable: true, backups: 2, newestAt: hoursAgo(24 * 63) },
    { id: "vaultwarden", name: "Vaultwarden", protectable: true, backups: 0, newestAt: null },
    { id: "cache-only", name: "Cache only", protectable: false, backups: 0, newestAt: null },
  ];

  it("lists each app worth backing up with its last runs, newest first", () => {
    const jobs = [
      ...[11, 35, 59, 83, 107, 131].map((hours, index) => job({ id: `j${index}`, parameters: { id: "jellyfin" }, createdAt: hoursAgo(hours) })),
      job({ id: "x", state: "cancelled", parameters: { id: "jellyfin" }, createdAt: hoursAgo(1) }),
      job({ id: "i1", state: "failed", parameters: { id: "immich" }, createdAt: hoursAgo(16) }),
      job({ id: "i0", state: "completed", parameters: { id: "immich" }, createdAt: hoursAgo(40) }),
      job({ id: "n1", parameters: { id: "nextcloud" }, createdAt: hoursAgo(5) }),
      job({ id: "other", type: "op:app.update", parameters: { id: "vaultwarden" } }),
    ];
    const rows = backupMatrix({ protection, jobs, apps: [app({ drill: { verified: true, checkedAt: hoursAgo(10) } })], now });
    expect(rows.map((row) => row.id)).toEqual(["immich", "jellyfin", "nextcloud", "vaultwarden"]);
    const [immich, jellyfin, nextcloud, vaultwarden] = rows;
    expect(jellyfin.runs.map((run) => run.jobId)).toEqual(["j0", "j1", "j2", "j3", "j4"]);
    expect(jellyfin).toMatchObject({ status: "good", summary: "Covered", drill: { verified: true } });
    expect(immich).toMatchObject({ status: "danger", summary: "Last run failed" });
    expect(immich.runs.map((run) => run.state)).toEqual(["failed", "ok"]);
    expect(vaultwarden).toMatchObject({ status: "warning", summary: "No backup yet", runs: [] });
    // Backed up by a job, but not in what the protection read reported: not known, never "Covered".
    expect(nextcloud).toMatchObject({ status: "unknown", summary: "Not known", backups: null });
  });

  it("calls a backup that is weeks old stale", () => {
    const [immich] = backupMatrix({ protection: protection.slice(1, 2), jobs: [], apps: [], now });
    expect(immich).toMatchObject({ status: "warning", summary: "63 days old" });
  });
});
