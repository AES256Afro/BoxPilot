import { describe, expect, it } from "vitest";
import type { Job } from "../operations";
import type { AppFact, FactValues } from "./facts";
import { appFactsFrom, inventoryFactsFrom, watchFactsFrom } from "./facts";
import { elapsed, greeting, relativeTime, shortAge, size } from "./format";
import { appHealth, buildNeeds, groupByTier, needsLabel, reachOf, sortNeeds, verdictFor, type Need } from "./needs";

const now = Date.parse("2026-09-28T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

const none: FactValues = {
  catalog: null, inventory: null, updates: null, unattended: null, services: null, watch: null, repairs: null, jobs: null,
  schedules: null, protection: null, offBox: null, database: null, setup: null, checklist: null, vms: null, rebuild: null,
};
const facts = (overrides: Partial<FactValues>): FactValues => ({ ...none, ...overrides });

function app(overrides: Partial<AppFact> = {}): AppFact {
  return {
    id: "jellyfin", name: "Jellyfin", icon: "🎬", category: "Media", running: true, paused: false, status: "running", health: "healthy",
    troubledSidecar: null, updateAvailable: false, folderProblems: 0, vpnLeaked: false, stoppedOnPurpose: false, url: "http://192.0.2.10:8096", port: 8096,
    exposure: "lan", served: false, drill: null, ...overrides,
  };
}

function job(overrides: Partial<Job>): Job {
  return { id: "j", type: "op:apt.upgrade", title: "Install package updates", state: "completed", risk: "medium", error: null, result: null, steps: [], approvals: [], createdAt: hoursAgo(1), ...overrides };
}

const ids = (needs: Need[]) => needs.map((need) => need.id);

describe("what needs you", () => {
  it("says nothing when every source answered and nothing is wrong", () => {
    const needs = buildNeeds(facts({
      catalog: { apps: [app()], total: 160, liveKnown: true }, updates: { count: 0, security: 0, rebootRequired: false }, unattended: { enabled: true },
      services: { failed: 0 }, watch: { targetConfigured: true, alerts: [], notices: [] }, repairs: { findings: [], unavailableChecks: [] }, jobs: [],
      database: { lastBackupAt: hoursAgo(3) },
    }), { now, role: "owner" });
    expect(needs).toEqual([]);
  });

  it("puts problems before things to look at, and suggestions last", () => {
    const needs = buildNeeds(facts({
      catalog: { apps: [app({ id: "vaultwarden", name: "Vaultwarden", running: false, status: "exited" }), app({ id: "open-webui", name: "Open WebUI", running: false, paused: true, status: "paused" }), app({ updateAvailable: true })], total: 160, liveKnown: true },
      updates: { count: 4, security: 1, rebootRequired: false },
      watch: { targetConfigured: true, alerts: [{ family: "flow.failed", title: "Automation stopped: Update night", since: hoursAgo(30), announced: true }], notices: [] },
      repairs: { findings: [{ id: "stale-mount:media", severity: "critical", title: "/mnt/media is mounted from a drive that is gone", detail: "", evidence: ["mounted from /dev/sda2"], fix: { operationId: "storage.remount", parameters: { name: "media" }, label: "Reconnect the drive", preview: "Mounts it again." }, manual: null }], unavailableChecks: [] },
      jobs: [job({ id: "s1", type: "op:storage.remount", title: "Reconnect a drive", state: "awaiting_approval", risk: "medium" })],
    }), { now, role: "owner" });
    expect(ids(needs)).toEqual([
      "app-down:vaultwarden", "repair:stale-mount:media", // danger: health first, then Repair
      "alert:flow.failed:0", "approval:s1", "updates", // warning: alerts, approvals, updates
      "app-paused:open-webui", "app-update:jellyfin", // neutral
    ]);
    const repair = needs.find((need) => need.id === "repair:stale-mount:media")!;
    expect(repair.action).toMatchObject({ operationId: "storage.remount", label: "Reconnect the drive", risk: "medium", parameters: { name: "media" } });
    expect(repair.view).toBe("repairs");
    expect(needs.find((need) => need.id === "approval:s1")).toMatchObject({ risk: "medium", action: null, view: "repairs" });
    expect(needs.find((need) => need.id === "alert:flow.failed:0")).toMatchObject({ view: "automations", detail: "Since 30 hours ago" });
    expect(needs.find((need) => need.id === "updates")).toMatchObject({ title: "4 updates available", detail: "1 security fix among them", action: { operationId: "apt.upgrade", risk: "medium" } });
  });

  it("offers only the fixes the role may start, and none to a viewer", () => {
    const input = facts({
      catalog: { apps: [app({ running: false, status: "exited" })], total: 1, liveKnown: true },
      updates: { count: 2, security: 0, rebootRequired: true },
    });
    const owner = buildNeeds(input, { now, role: "owner" });
    expect(owner.find((need) => need.id === "reboot")?.action?.risk).toBe("high");
    const operator = buildNeeds(input, { now, role: "operator" });
    expect(operator.find((need) => need.id === "reboot")?.action).toBeNull();
    expect(operator.find((need) => need.id === "app-down:jellyfin")?.action?.risk).toBe("low");
    const viewer = buildNeeds(input, { now, role: "viewer" });
    expect(viewer.every((need) => need.action === null)).toBe(true);
    // The facts stay: a viewer still sees what is wrong, and where it is.
    expect(ids(viewer)).toEqual(ids(owner));
  });

  it("counts what reached nobody, and says why", () => {
    const needs = buildNeeds(facts({ watch: watchFactsFrom({ targetConfigured: false, conditions: [{ key: "storage.smart", active: true, details: [{ title: "sda reports SMART problems", announced: false }] }], notices: [{ key: "release.available", title: "BoxPilot 2.0 is out" }] }) }), { now, role: "owner" });
    expect(needs[0]).toMatchObject({ id: "alert:storage.smart:0", severity: "danger" });
    expect(needs.find((need) => need.id === "unannounced")).toMatchObject({ title: "BoxPilot could not tell you about 2 things", detail: "No notification target is set", view: "settings" });
  });

  it("says a failed app backup once, with a way to run it again, and leaves one that ran again alone", () => {
    const needs = buildNeeds(facts({
      catalog: { apps: [app({ id: "immich", name: "Immich" })], total: 1, liveKnown: true },
      jobs: [
        job({ id: "b2", type: "op:app.backup", state: "failed", parameters: { id: "immich" }, error: "tar failed: No space left on device", createdAt: hoursAgo(16) }),
        job({ id: "b1", type: "op:app.backup", state: "completed", parameters: { id: "immich" }, createdAt: hoursAgo(40) }),
        job({ id: "x", type: "op:homepage.sync", state: "failed", error: "restarted", createdAt: hoursAgo(2), steps: [{ name: "rerun", state: "started", detail: "", createdAt: hoursAgo(2) }] }),
      ],
      schedules: [{ id: "s1", operationId: "app.backup", title: "Back up application data", parameters: { subject: "immich" }, enabled: true, overdue: false, cadence: "daily at 03:00", lastRunAt: hoursAgo(16), lastOutcome: "failed", lastReason: "tar failed" }],
    }), { now, role: "owner" });
    expect(ids(needs)).toEqual(["backup-failed:immich"]);
    expect(needs[0]).toMatchObject({ title: "The last backup of Immich failed", detail: "tar failed: No space left on device", appId: "immich", action: { operationId: "app.backup", parameters: { id: "immich" }, label: "Back up again" } });
  });

  it("carries over what the Classic overview warned about: backups, the database, a failed job, setup", () => {
    const needs = buildNeeds(facts({
      protection: [{ id: "vaultwarden", name: "Vaultwarden", protectable: true, backups: 0, newestAt: null }],
      schedules: [],
      offBox: { verdict: { configured: false, lastSyncAt: null, ageDays: null, where: [], state: "none", behindHours: null }, inputs: {} },
      database: { lastBackupAt: hoursAgo(24 * 9) },
      jobs: [job({ id: "f", type: "op:app.update", title: "Update Immich", state: "failed", error: "pull failed" })],
      setup: { firstRun: true },
      checklist: { done: 1, total: 4, items: [
        { id: "firewall", title: "Turn on the firewall with a profile", detail: "Block everything you did not ask for.", done: false, optional: false, view: "firewall" },
        { id: "backups", title: "Keep a copy of your backups off this box", detail: "", done: false, optional: false, view: "backups" },
        { id: "ups", title: "Protect against power cuts", detail: "", done: false, optional: true, view: "system" },
        { id: "tailscale", title: "Reach BoxPilot from anywhere", detail: "", done: true, optional: false, view: "network" },
      ] },
    }), { now, role: "owner" });
    expect(ids(needs)).toEqual(["unprotected", "off-box", "database", "job:f", "setup", "checklist:firewall"]);
    expect(needs.find((need) => need.id === "database")?.title).toBe("BoxPilot's database was last backed up 9 days ago");
    expect(needs.find((need) => need.id === "database")?.action).toMatchObject({ operationId: "controller.backup.create", risk: "low" });
    expect(needs.find((need) => need.id === "off-box")?.action).toBeNull(); // nowhere to copy to yet
    expect(needs.find((need) => need.id === "job:f")?.title).toBe("Failed: Update Immich");
  });

  // M36: a failure fixed or tried again since used to stay on Home as something that needs you.
  it("lets a failure go once it has been dealt with, and points at its job", () => {
    const failed = job({ id: "f", type: "op:app.update", title: "Update Immich", state: "failed", error: "pull failed", parameters: { id: "immich" }, createdAt: hoursAgo(3) });
    const shown = (jobs: Job[]) => buildNeeds(facts({ jobs }), { now, role: "owner" }).filter((need) => need.kind === "job");
    expect(shown([failed])).toMatchObject([{ id: "job:f", jobId: "f", detail: "pull failed" }]);
    // Tried again on the same app, and it worked, or is still going, or waits for approval.
    for (const state of ["completed", "applying", "awaiting_approval"]) {
      expect(shown([job({ id: "g", type: "op:app.update", state, parameters: { id: "immich" }, createdAt: hoursAgo(1) }), failed]), state).toEqual([]);
    }
    // The same operation on another app, or a cancelled retry, settles nothing.
    expect(shown([job({ id: "g", type: "op:app.update", state: "completed", parameters: { id: "jellyfin" }, createdAt: hoursAgo(1) }), failed])).toHaveLength(1);
    expect(shown([job({ id: "g", type: "op:app.update", state: "cancelled", parameters: { id: "immich" }, createdAt: hoursAgo(1) }), failed])).toHaveLength(1);
    // Tried again with more time: the retry names it.
    expect(shown([job({ id: "g", type: "op:app.update", state: "completed", parameters: { id: "immich" }, recovery: { retryOf: "f" }, createdAt: hoursAgo(1) }), failed])).toEqual([]);
    // Dismissed by the owner, or a week old: Activity keeps it, Home lets it go.
    expect(shown([{ ...failed, steps: [{ name: "dismissed", state: "completed", detail: "Dismissed by alex", createdAt: hoursAgo(2) }] }])).toEqual([]);
    expect(shown([{ ...failed, createdAt: hoursAgo(24 * 8) }])).toEqual([]);
  });

  it("shows the newest failure still open, and counts the rest", () => {
    const needs = buildNeeds(facts({ jobs: [
      job({ id: "a", type: "op:apt.upgrade", state: "failed", title: "Install package updates", error: "dpkg lock", createdAt: hoursAgo(1) }),
      job({ id: "b", type: "op:app.update", state: "failed", title: "Update Immich", error: "pull failed", parameters: { id: "immich" }, createdAt: hoursAgo(2) }),
      job({ id: "c", type: "op:homepage.sync", state: "failed", title: "Sync Homepage", createdAt: hoursAgo(3), steps: [{ name: "dismissed", state: "completed", detail: "", createdAt: hoursAgo(2) }] }),
    ] }), { now, role: "owner" });
    expect(needs.filter((need) => need.kind === "job")).toMatchObject([{ id: "job:a", title: "Failed: Install package updates", detail: "dpkg lock · 1 more failed job in Activity" }]);
  });

  it("opens a job waiting for approval at that job", () => {
    const needs = buildNeeds(facts({ jobs: [job({ id: "s", type: "op:storage.remount", title: "Reconnect a drive", state: "awaiting_approval" })] }), { now, role: "owner" });
    expect(needs.find((need) => need.kind === "approval")).toMatchObject({ jobId: "s", risk: "medium", action: null });
  });

  it("offers to copy the backups off the box when a destination is set up but behind", () => {
    const needs = buildNeeds(facts({ offBox: { verdict: { configured: true, lastSyncAt: hoursAgo(24 * 10), ageDays: 10, where: ["another machine"], state: "stale", behindHours: null }, inputs: { ssh: { configured: true, lastSyncAt: hoursAgo(240) } } } }), { now, role: "owner" });
    expect(needs[0]).toMatchObject({ id: "off-box", title: "The off-box copy of your backups is 10 days old", action: { operationId: "backup.remote.sync", label: "Copy now", risk: "medium" } });
  });

  it("leaves an app's folder problem to Repair's finding when the scan answered", () => {
    const folder = app({ id: "qbittorrent", name: "qBittorrent", folderProblems: 1 });
    expect(ids(buildNeeds(facts({ catalog: { apps: [folder], total: 1, liveKnown: true } }), { now, role: "owner" }))).toEqual(["app-folder:qbittorrent"]);
    const withScan = buildNeeds(facts({ catalog: { apps: [folder], total: 1, liveKnown: true }, repairs: { findings: [{ id: "app-folder:qbittorrent", severity: "warning", title: "qBittorrent cannot write to its data folder", detail: "", evidence: [], fix: null, manual: "Fix it." }], unavailableChecks: [] } }), { now, role: "owner" });
    expect(ids(withScan)).toEqual(["repair:app-folder:qbittorrent"]);
  });

  it("groups by the tier of the fix for Ops, and keeps what has none to look at", () => {
    const needs = buildNeeds(facts({
      catalog: { apps: [app({ running: false, status: "exited" })], total: 1, liveKnown: true },
      updates: { count: 3, security: 0, rebootRequired: true },
      services: { failed: 2 },
    }), { now, role: "owner" });
    const tiers = groupByTier(needs);
    expect(ids(tiers.high)).toEqual(["reboot"]);
    expect(ids(tiers.medium)).toEqual(["updates"]);
    expect(ids(tiers.low)).toEqual(["app-down:jellyfin"]);
    expect(ids(tiers.look)).toEqual(["services"]);
  });

  it("sorts stably by severity, then kind", () => {
    const need = (id: string, kind: Need["kind"], severity: Need["severity"]): Need => ({ id, kind, severity, title: id, detail: null, view: "home", action: null });
    expect(ids(sortNeeds([need("a", "setup", "neutral"), need("b", "backup", "danger"), need("c", "alert", "warning"), need("d", "alert", "danger"), need("e", "alert", "danger")]))).toEqual(["d", "e", "b", "c", "a"]);
  });
});

describe("apps that are not running, on the owner's real server", () => {
  // Home on bigbox the evening it shipped: three apps the owner had stopped from BoxPilot, and six
  // listed as installed with no container, each called a problem of its own.
  const catalog = (apps: AppFact[]) => facts({ catalog: { apps, total: 160, liveKnown: true } });

  it("says an app stopped from BoxPilot is stopped, quietly, with Start", () => {
    const plex = app({ id: "plex", name: "Plex Media Server", running: false, status: "exited", stoppedOnPurpose: true });
    const [need] = buildNeeds(catalog([plex]), { now, role: "owner" });
    expect(need).toMatchObject({ id: "app-stopped:plex", severity: "neutral", title: "Plex Media Server is stopped", appId: "plex", action: { operationId: "app.action", label: "Start", parameters: { id: "plex", action: "start" } } });
    expect(appHealth(plex, undefined, now)).toMatchObject({ status: "neutral", label: "Stopped" });
  });

  it("still calls an app that stopped by itself, or keeps restarting, a problem", () => {
    const crashed = app({ id: "plex", name: "Plex Media Server", running: false, status: "exited" });
    const looping = app({ id: "immich", name: "Immich", running: false, status: "restarting", stoppedOnPurpose: true });
    expect(buildNeeds(catalog([crashed, looping]), { now, role: "owner" }).map((need) => [need.id, need.severity])).toEqual([["app-down:plex", "danger"], ["app-down:immich", "danger"]]);
  });

  it("says once which apps have no container, rather than a problem each", () => {
    const absent = ["AnythingLLM", "AuDHDMAP", "Dockge", "Homepage", "IT-Tools", "Open WebUI"].map((name) => app({ id: name.toLowerCase(), name, running: false, status: "absent" }));
    const needs = buildNeeds(catalog(absent), { now, role: "owner" });
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ id: "apps-missing", severity: "warning", view: "catalog", title: "AnythingLLM, AuDHDMAP and 4 more have no container", action: null });
    expect(needs[0].appId).toBeUndefined();
    expect(appHealth(absent[0], undefined, now)).toMatchObject({ status: "warning", label: "No container" });
    const [one] = buildNeeds(catalog([absent[2]]), { now, role: "owner" });
    expect(one).toMatchObject({ title: "Dockge has no container", appId: "dockge" });
  });
});

describe("the verdict", () => {
  it("never calls a server healthy that it could not read", () => {
    expect(verdictFor([], { hostname: "homebox", checking: false, unread: ["Repair's problem scan"] })).toEqual({ status: "unknown", label: "Not fully checked", sentence: "Nothing wrong found, but BoxPilot could not read Repair's problem scan." });
    expect(verdictFor([], { hostname: "homebox", checking: true, unread: [] }).status).toBe("unknown");
    expect(verdictFor([], { hostname: "homebox", checking: false, unread: [] })).toEqual({ status: "good", label: "Healthy", sentence: "homebox is healthy. Nothing needs you." });
  });

  it("names the problems first, and does not wait for slow sources to say them", () => {
    const danger: Need = { id: "x", kind: "alert", severity: "danger", title: "x", detail: null, view: "home", action: null };
    const warning: Need = { ...danger, id: "y", severity: "warning" };
    const neutral: Need = { ...danger, id: "z", severity: "neutral" };
    expect(verdictFor([danger, warning], { hostname: "homebox", checking: true, unread: [] })).toMatchObject({ status: "danger", sentence: "homebox needs you: 1 problem and 1 thing to look at." });
    expect(verdictFor([warning, warning], { hostname: "homebox", checking: false, unread: [] })).toMatchObject({ status: "warning", sentence: "homebox is running. 2 things need a look." });
    expect(verdictFor([neutral], { hostname: "homebox", checking: false, unread: [] }).sentence).toBe("homebox is healthy. One small thing can wait.");
  });

  it("counts what can wait in the same sentence, so the headline adds up to the list", () => {
    // The owner saw "2 to look at" over a "What needs you" of 4: two could wait, and nothing said so.
    const danger: Need = { id: "x", kind: "alert", severity: "danger", title: "x", detail: null, view: "home", action: null };
    const warning: Need = { ...danger, id: "y", severity: "warning" };
    const neutral: Need = { ...danger, id: "z", severity: "neutral" };
    const needs = [warning, warning, neutral, neutral];
    const verdict = verdictFor(needs, { hostname: "homebox", checking: false, unread: [] });
    expect(verdict).toMatchObject({ label: "2 to look at", sentence: "homebox is running. 2 things need a look. 2 more can wait." });
    expect(needsLabel(needs, verdict)).toBe("2 to look at");
    expect(verdictFor([danger, neutral], { hostname: "homebox", checking: false, unread: [] }).sentence).toBe("homebox needs you: 1 problem. One more thing can wait.");
    expect(needsLabel([neutral, neutral], verdictFor([neutral, neutral], { hostname: "homebox", checking: false, unread: [] }))).toBe("2 can wait");
  });
});

describe("an app's tile", () => {
  it("says the worst thing about it, and never green for a stopped app", () => {
    expect(appHealth(app({ running: false, status: "exited" }), undefined, now)).toMatchObject({ status: "danger", detail: "Not running" });
    expect(appHealth(app({ running: false, paused: true, status: "paused" }), undefined, now).status).toBe("neutral");
    expect(appHealth(app({ troubledSidecar: { id: "database", status: "restarting" } }), undefined, now)).toMatchObject({ status: "warning", detail: "database restarting" });
    expect(appHealth(app(), { id: "jellyfin", name: "Jellyfin", protectable: true, backups: 0, newestAt: null }, now)).toMatchObject({ status: "warning", detail: "Never backed up" });
    expect(appHealth(app(), { id: "jellyfin", name: "Jellyfin", protectable: true, backups: 2, newestAt: hoursAgo(24 * 63) }, now)).toMatchObject({ status: "warning", detail: "Backup 63d old" });
    expect(appHealth(app({ updateAvailable: true }), undefined, now)).toMatchObject({ status: "good", detail: "Update ready" });
    expect(appHealth(app(), undefined, now)).toMatchObject({ status: "good", label: "Healthy", detail: "On your network" });
  });

  it("says who can reach it", () => {
    expect(reachOf({ port: 8096, exposure: "lan", served: true })).toBe("On your tailnet");
    expect(reachOf({ port: 11434, exposure: "loopback", served: false })).toBe("This server only");
    expect(reachOf({ port: null, exposure: null, served: false })).toBe("No web page");
  });
});

describe("reading the answers", () => {
  it("takes installed apps from the catalog, frozen ones as paused, and a looping helper as trouble", () => {
    const facts = appFactsFrom({ host: { lanAddress: "192.0.2.10" }, liveError: null, applications: [
      { manifest: { id: "jellyfin", name: "Jellyfin", icon: "🎬", category: "Media" }, live: { installed: true, container: { running: true, status: "running", health: "healthy" }, urls: [{ host: 8096, exposure: "lan" }] } },
      { manifest: { id: "open-webui", name: "Open WebUI", icon: "", category: "AI" }, live: { installed: true, container: { running: true, status: "paused", health: "none" }, urls: [] } },
      { manifest: { id: "immich", name: "Immich", category: "Photos" }, live: { installed: true, container: { running: true, status: "running" }, sidecars: [{ id: "database", running: true, status: "restarting" }], urls: [] } },
      { manifest: { id: "mealie", name: "Mealie" }, live: null },
    ] }, [{ dnsName: "homebox.example.ts.net", port: 8096 }]);
    expect(facts.apps.map((entry) => entry.id)).toEqual(["immich", "jellyfin", "open-webui"]);
    expect(facts.total).toBe(4);
    expect(facts.liveKnown).toBe(true);
    const [immich, jellyfin, webui] = facts.apps;
    expect(jellyfin).toMatchObject({ served: true, url: "https://homebox.example.ts.net:8096", icon: "🎬" });
    expect(webui).toMatchObject({ running: false, paused: true, icon: null });
    expect(immich.troubledSidecar).toEqual({ id: "database", status: "restarting" });
    expect(() => appFactsFrom({ status: "ok" } as never, [])).toThrow();
  });

  it("refuses an inventory it does not recognise rather than reading it as empty", () => {
    expect(() => inventoryFactsFrom({} as never)).toThrow();
    const inventory = inventoryFactsFrom({ host: { hostname: "homebox", uptimeSeconds: 90_000 }, compute: { cpuCount: 8, loadPercent: 11, memoryUsedPercent: 34 }, storage: { root: { totalBytes: 100, usedBytes: 20, usedPercent: 20 }, filesystems: { mounts: [{ target: "/", usedPercent: 20, capacityState: "healthy" }, { usedPercent: 1 }] } } });
    expect(inventory).toMatchObject({ hostname: "homebox", cpuCount: 8, root: { percent: 20 } });
    expect(inventory.mounts.map((mount) => mount.target)).toEqual(["/"]);
  });
});

describe("the words", () => {
  it("says how long ago, and how long", () => {
    expect(relativeTime(hoursAgo(0.001), now)).toBe("just now");
    expect(relativeTime(hoursAgo(0.5), now)).toBe("30 minutes ago");
    expect(relativeTime(hoursAgo(30), now)).toBe("30 hours ago");
    expect(relativeTime(hoursAgo(24 * 3), now)).toBe("3 days ago");
    expect(relativeTime(hoursAgo(-4), now)).toBe("in 4 hours");
    expect(relativeTime("not a time", now)).toBeNull();
    expect(shortAge(hoursAgo(3), now)).toBe("3h");
    expect(shortAge(hoursAgo(24 * 5), now)).toBe("5d");
    expect(elapsed(41_000)).toBe("41s");
    expect(elapsed(192_000)).toBe("3m 12s");
    expect(size(11 * 1024 ** 3)).toBe("11.0 GB");
    expect(size(412 * 1024 ** 2)).toBe("412 MB");
    expect(size(null)).toBe("—");
  });

  it("greets by the hour", () => {
    expect(greeting(new Date(2026, 8, 28, 9).getTime())).toBe("Good morning");
    expect(greeting(new Date(2026, 8, 28, 14).getTime())).toBe("Good afternoon");
    expect(greeting(new Date(2026, 8, 28, 22).getTime())).toBe("Good evening");
  });
});
