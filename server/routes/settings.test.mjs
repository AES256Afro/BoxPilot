/**
 * The watch-status endpoint groups the health watcher's live state back to its condition families,
 * so Settings can show what BoxPilot is watching and what is currently active.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSettingsRouter } from "./settings.mjs";
import { createNotificationHistory, failureSettledFor } from "../notification-history.mjs";
import { createHealthAlerts } from "../health-alerts.mjs";
import { createStateStore } from "../state.mjs";

let server; let base; const settings = new Map();
// Role-aware stub: a request carries its role in x-test-role; owner satisfies any requireRole.
const auth = {
  requireRole: (...roles) => (request, response, next) => ((roles.includes(request.headers["x-test-role"]) || request.headers["x-test-role"] === "owner") ? next() : response.status(403).json({ error: "forbidden", code: "forbidden" })),
  requireCsrf: (_request, _response, next) => next(),
};
const notifications = { describe: () => ({ configured: true, kind: "ntfy" }), quietHours: () => ({ ...(settings.get("notificationQuietHours") ?? { enabled: false }), held: 2 }) };
const audits = [];
const state = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: (type, entry) => audits.push({ type, ...entry }) };
const report = { title: "Weekly report, nothing failed", message: "Sep 20 to Sep 27: 41 jobs ran, none failed." };
const weeklyReport = {
  status: vi.fn(() => ({ enabled: true, cadence: "Sundays at 09:00", nextDueAt: "2026-10-04T13:00:00.000Z", lastSentAt: null, lastResult: null, targetConfigured: true })),
  preview: vi.fn(async () => report),
  setEnabled: vi.fn((enabled) => ({ enabled })),
  sendNow: vi.fn(async () => ({ sent: true, ...report })),
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.boxpilotSession = { owner: { id: "owner-1", role: request.headers["x-test-role"] ?? "owner" } }; next(); });
  app.use("/api/v1", createSettingsRouter({ state, notifications, weeklyReport, auth }));
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

describe("GET /settings/watch", () => {
  it("reports every watched condition, marking the active ones from the watcher's state", async () => {
    settings.set("healthAlertsState", {
      "storage.smart:/dev/sda": { title: "Disk /dev/sda reports SMART problems", since: "2026-08-27T00:00:00Z", notified: true },
      "smart.errors:/dev/sda": { title: "/dev/sda is developing errors", since: "2026-08-28T00:00:00Z", notified: true },
      "schedule.overdue:s1": { title: "not yet announced", notified: false }, // live, but never sent anywhere
    });
    const body = await (await fetch(`${base}/api/v1/settings/watch`)).json();
    expect(body.targetConfigured).toBe(true);
    // All three are live conditions. The unannounced one used to be hidden here too, which meant a
    // condition BoxPilot knew about was shown to nobody until the owner stumbled on its effect.
    expect(body.activeCount).toBe(3);
    const byKey = Object.fromEntries(body.conditions.map((condition) => [condition.key, condition]));
    expect(byKey["storage.smart"].active).toBe(true);
    expect(byKey["storage.smart"].details[0].announced).toBe(true);
    expect(byKey["smart.errors"].active).toBe(true);
    expect(byKey["schedule.overdue"].active).toBe(true);
    expect(byKey["schedule.overdue"].details[0].announced).toBe(false); // live, and the page can say it was never sent
    expect(byKey["docker.unhealthy"].active).toBe(false); // nothing wrong
    expect(byKey["storage.smart"].details[0].title).toContain("/dev/sda");
    // Every condition family from the watcher is present.
    expect(body.conditions.length).toBeGreaterThanOrEqual(12);
    expect(body.unannouncedCount).toBe(1);
  });

  it("counts failed schedules, automations and unsaved results that reached no one (M27.2)", async () => {
    settings.set("healthAlertsState", {
      "schedule.failed:s1": { title: "Scheduled task failed: Back up application data (jellyfin)", since: "2026-09-27T03:00:00Z", message: "disk full", notified: false },
      "flow.failed:f1": { title: "Automation stopped: Nightly", since: "2026-09-27T03:10:00Z", notified: true },
      "record.failed:vm.export.create:lab": { title: "Result not saved: Export a stopped VM (lab)", since: "2026-09-27T03:20:00Z", message: "UNIQUE constraint failed", notified: false },
      "system.reboot": { title: "A restart is required", since: "2026-09-26T00:00:00Z", notified: false },
    });
    const body = await (await fetch(`${base}/api/v1/settings/watch`)).json();
    expect(body.activeCount).toBe(4);
    expect(body.unannouncedCount).toBe(3);
    const byKey = Object.fromEntries(body.conditions.map((condition) => [condition.key, condition]));
    expect(byKey["schedule.failed"].details).toEqual([{ title: "Scheduled task failed: Back up application data (jellyfin)", since: "2026-09-27T03:00:00Z", announced: false }]);
    expect(byKey["flow.failed"].details[0].announced).toBe(true);
    expect(byKey["record.failed"].active).toBe(true);
    // The words kept for a later send are not handed to every signed-in viewer; the title is enough here.
    expect(JSON.stringify(body)).not.toContain("UNIQUE constraint");
  });

  it("counts news that reached no one with the rest, without calling it a condition (M27.2)", async () => {
    settings.set("healthAlertsState", {
      "system.reboot": { title: "A restart is required", since: "2026-09-26T00:00:00Z", notified: true },
      "signin.new:owner-1:100.64.0.20": { title: "New sign-in from 100.64.0.20", since: "2026-09-27T08:00:00Z", message: "alex signed in from 100.64.0.20", notified: false },
      "release.available": { title: "Version 1.127.0 is available", since: "2026-09-27T09:00:00Z", message: "You are running 1.126.0.", notified: false },
      "job.interrupted:apt.upgrade": { title: "Install all package updates was interrupted", since: "2026-09-27T10:00:00Z", message: "m", notified: false },
    });
    const body = await (await fetch(`${base}/api/v1/settings/watch`)).json();
    expect(body.activeCount).toBe(1); // a release or a sign-in is not something wrong with the server
    expect(body.unannouncedCount).toBe(3);
    expect(body.notices).toEqual([
      { key: "signin.new", label: "A sign-in from a new address", title: "New sign-in from 100.64.0.20", since: "2026-09-27T08:00:00Z", announced: false },
      { key: "release.available", label: "A new BoxPilot release", title: "Version 1.127.0 is available", since: "2026-09-27T09:00:00Z", announced: false },
      { key: "job.interrupted", label: "A job was cut off by a restart", title: "Install all package updates was interrupted", since: "2026-09-27T10:00:00Z", announced: false },
    ]);
    expect(body.conditions.map((condition) => condition.key)).not.toContain("signin.new");
    expect(JSON.stringify(body)).not.toContain("You are running");
  });
});

describe("Check again (M88)", () => {
  it("runs a health round now for an operator or the owner, not a viewer, says when it finished, and starts no other inside a minute of the last start", async () => {
    // The button used to re-read what the last round stored, which could be 15 minutes old.
    const stored = new Map();
    const store = { getSetting: (key, fallback) => stored.get(key) ?? fallback, setSetting: (key, value) => stored.set(key, value), recordAudit: vi.fn() };
    let clock = Date.parse("2026-11-25T08:00:00Z");
    const inspect = vi.fn(async () => ({ storage: {}, maintenance: {}, docker: { containers: [] } }));
    const healthAlerts = createHealthAlerts({ inventory: { inspect }, notifications: { getTarget: () => null, send: vi.fn() }, store, now: () => new Date(clock) });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.boxpilotSession = { owner: { id: "someone", role: request.headers["x-test-role"] ?? "owner" } }; next(); });
    app.use("/api/v1", createSettingsRouter({ state: store, notifications: { describe: () => ({ configured: false }) }, healthAlerts, auth }));
    const local = app.listen(0);
    await new Promise((resolve) => local.once("listening", resolve));
    const url = `http://127.0.0.1:${local.address().port}/api/v1/settings`;
    const press = async (role) => { const response = await fetch(`${url}/watch/check`, { method: "POST", headers: { "x-test-role": role } }); return { status: response.status, body: await response.json() }; };
    try {
      expect((await (await fetch(`${url}/watch`)).json()).checkedAt).toBeNull();
      // A viewer gets the cached answer only: a round can push to the owner's phone.
      expect((await press("viewer")).status).toBe(403);
      expect(inspect).not.toHaveBeenCalled();
      expect(await press("operator")).toEqual({ status: 200, body: { checkedAt: "2026-11-25T08:00:00.000Z", fresh: true } });
      expect((await (await fetch(`${url}/watch`, { headers: { "x-test-role": "viewer" } })).json()).checkedAt).toBe("2026-11-25T08:00:00.000Z");
      clock += 20_000;
      expect(await press("operator")).toEqual({ status: 200, body: { checkedAt: "2026-11-25T08:00:00.000Z", fresh: false } });
      expect(inspect).toHaveBeenCalledTimes(1);
      clock += 60_000;
      expect(await press("owner")).toEqual({ status: 200, body: { checkedAt: "2026-11-25T08:01:20.000Z", fresh: true } });
      expect(inspect).toHaveBeenCalledTimes(2);
      // A round that cannot read the box says so, and records no time.
      clock += 60_000;
      inspect.mockRejectedValueOnce(new Error("the helper did not answer"));
      expect(await press("owner")).toEqual({ status: 502, body: { error: "The check did not finish: the helper did not answer", code: "health_check_failed" } });
      expect((await (await fetch(`${url}/watch`)).json()).checkedAt).toBe("2026-11-25T08:01:20.000Z");
      // The failed round still counts as a start: pressing again at once starts nothing, so a round
      // that keeps failing cannot be driven without limit; a minute after that start, one goes.
      clock += 5_000;
      expect(await press("operator")).toEqual({ status: 200, body: { checkedAt: "2026-11-25T08:01:20.000Z", fresh: false } });
      expect(inspect).toHaveBeenCalledTimes(3);
      clock += 56_000;
      expect(await press("operator")).toEqual({ status: 200, body: { checkedAt: "2026-11-25T08:03:21.000Z", fresh: true } });
      expect(inspect).toHaveBeenCalledTimes(4);
    } finally {
      local.close();
    }
  });
});

describe("the weekly report in Settings (M30.4)", () => {
  it("says whether it is on and when it goes, to anyone signed in", async () => {
    const response = await fetch(`${base}/api/v1/settings/weekly-report`, { headers: { "x-test-role": "viewer" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true, cadence: "Sundays at 09:00" });
  });

  it("previews to the owner only: it names every account's jobs", async () => {
    expect((await fetch(`${base}/api/v1/settings/weekly-report/preview`, { headers: { "x-test-role": "operator" } })).status).toBe(403);
    const response = await fetch(`${base}/api/v1/settings/weekly-report/preview`, { headers: { "x-test-role": "owner" } });
    expect(await response.json()).toEqual(report);
  });

  it("turns on and off with a real boolean, and sends now or says why it could not", async () => {
    const put = (body) => fetch(`${base}/api/v1/settings/weekly-report`, { method: "PUT", headers: { "Content-Type": "application/json", "x-test-role": "owner" }, body: JSON.stringify(body) });
    expect((await fetch(`${base}/api/v1/settings/weekly-report`, { method: "PUT", headers: { "Content-Type": "application/json", "x-test-role": "operator" }, body: JSON.stringify({ enabled: false }) })).status).toBe(403);
    expect((await put({ enabled: "no" })).status).toBe(400);
    expect(await (await put({ enabled: false })).json()).toEqual({ enabled: false });
    expect(weeklyReport.setEnabled).toHaveBeenCalledWith(false, { updatedBy: "owner-1" });

    const send = () => fetch(`${base}/api/v1/settings/weekly-report/send`, { method: "POST", headers: { "x-test-role": "owner" } });
    expect(await (await send()).json()).toMatchObject({ sent: true, title: report.title });
    expect(weeklyReport.sendNow).toHaveBeenCalledWith({ actorId: "owner-1" });
    weeklyReport.sendNow.mockRejectedValueOnce(new Error("No notification target is configured"));
    const refused = await send();
    expect(refused.status).toBe(502);
    expect((await refused.json()).error).toBe("No notification target is configured");
  });
});

describe("GET /settings/notifications", () => {
  it("shows where alerts go to the owner only; others see that a target is set and its kind", async () => {
    const original = notifications.describe;
    notifications.describe = () => ({ configured: true, kind: "ntfy", url: "https://ntfy.example.org", topic: "private-topic-7f3a", hasToken: false });
    try {
      const at = async (role) => (await fetch(`${base}/api/v1/settings/notifications`, { headers: { "x-test-role": role } })).json();
      expect(await at("owner")).toMatchObject({ configured: true, kind: "ntfy", url: "https://ntfy.example.org", topic: "private-topic-7f3a" });
      for (const role of ["operator", "viewer"]) expect(await at(role)).toEqual({ configured: true, kind: "ntfy", url: null, topic: null, hasToken: false });
    } finally {
      notifications.describe = original;
    }
  });
});

describe("GET /settings/vpn-profile role gate", () => {
  it("serves the owner but refuses viewer and operator (it names the VPN account and exempted LAN ranges)", async () => {
    settings.set("vpnProfile", { configured: true, provider: "protonvpn", openvpnUser: "acct-9931", outboundSubnets: "192.168.1.0/24" });
    const at = (role) => fetch(`${base}/api/v1/settings/vpn-profile`, { headers: { "x-test-role": role } });
    expect((await at("viewer")).status).toBe(403);
    expect((await at("operator")).status).toBe(403);
    const ownerResponse = await at("owner");
    expect(ownerResponse.status).toBe(200);
    expect((await ownerResponse.json()).profile.openvpnUser).toBe("acct-9931");
    // A sibling GET with no per-route gate stays open to lower roles, proving the gate is specific.
    expect((await fetch(`${base}/api/v1/settings/cloud-destination`, { headers: { "x-test-role": "viewer" } })).status).toBe(200);
  });
});

describe("where the copies go", () => {
  it("shows the SSH and cloud destinations to an operator or the owner, and to a viewer only that one is set", async () => {
    settings.set("backupDestination", { host: "backup.example", port: 22, user: "boxpilot", path: "/srv/copies" });
    settings.set("backupDestinationLastSync", { completedAt: "2026-10-18T02:00:00.000Z", filesTransferred: 3, destination: "boxpilot@backup.example:/srv/copies" });
    settings.set("cloudDestination", { provider: "b2", account: "0012abc", bucket: "home-copies", path: "box" });
    settings.set("cloudDestinationLastSync", { completedAt: "2026-10-18T03:00:00.000Z", filesTransferred: 2, destination: "boxpilot:home-copies/box" });
    const read = async (path, role) => (await fetch(`${base}/api/v1/settings/${path}`, { headers: { "x-test-role": role } })).json();
    for (const role of ["owner", "operator"]) {
      expect((await read("backup-destination", role)).destination).toMatchObject({ host: "backup.example", user: "boxpilot" });
      expect((await read("cloud-destination", role)).destination).toMatchObject({ account: "0012abc", bucket: "home-copies" });
    }
    const ssh = await read("backup-destination", "viewer");
    expect(ssh).toEqual({ destination: { hidden: true }, lastSync: { completedAt: "2026-10-18T02:00:00.000Z", filesTransferred: 3, destination: null } });
    const cloud = await read("cloud-destination", "viewer");
    expect(cloud).toEqual({ destination: { provider: "b2" }, lastSync: { completedAt: "2026-10-18T03:00:00.000Z", filesTransferred: 2, destination: null } });
    expect(JSON.stringify([ssh, cloud])).not.toMatch(/backup\.example|0012abc|home-copies/);
    for (const key of ["backupDestination", "backupDestinationLastSync", "cloudDestination", "cloudDestinationLastSync"]) settings.delete(key);
    expect(await read("backup-destination", "viewer")).toEqual({ destination: null, lastSync: null });
  });
});

describe("the weekly read of a sleeping drive (M36)", () => {
  it("is off until the owner turns it on, and only the owner changes it", async () => {
    const read = async (role) => (await fetch(`${base}/api/v1/settings/storage-wake`, { headers: { "x-test-role": role } })).json();
    const put = (role, body) => fetch(`${base}/api/v1/settings/storage-wake`, { method: "PUT", headers: { "Content-Type": "application/json", "x-test-role": role }, body: JSON.stringify(body) });
    expect(await read("viewer")).toEqual({ enabled: false });
    expect((await put("operator", { enabled: true })).status).toBe(403);
    expect((await put("owner", { enabled: "yes" })).status).toBe(400);
    expect(await (await put("owner", { enabled: true })).json()).toEqual({ enabled: true });
    expect(settings.get("storageWeeklyWake")).toEqual({ enabled: true });
    expect(await read("viewer")).toEqual({ enabled: true });
    settings.delete("storageWeeklyWake");
  });
});

describe("the notification centre (M36)", () => {
  it("lists what was said, whether it arrived and whether it is still going, and marks it seen for the caller", async () => {
    const stored = new Map();
    const store = { getSetting: (key, fallback) => stored.get(key) ?? fallback, setSetting: (key, value) => stored.set(key, value), getJob: () => null };
    let clock = Date.parse("2026-09-29T08:00:00Z");
    const history = createNotificationHistory({ store, now: () => new Date(clock) });
    history.record({ key: "storage.root.full", kind: "alert", title: "Root disk is 91% full", message: "Free space on / is running out.", delivered: false, reason: "no-target" });
    stored.set("healthAlertsState", { "storage.root.full": { title: "Root disk is 91% full", since: "2026-09-29T08:00:00Z", notified: false } });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.boxpilotSession = { owner: { id: request.headers["x-test-owner"] ?? "owner-1", role: "owner" } }; next(); });
    app.use("/api/v1", createSettingsRouter({ state: store, notifications: { describe: () => ({ configured: false }) }, notificationHistory: history, auth }));
    const local = app.listen(0);
    await new Promise((resolve) => local.once("listening", resolve));
    const url = `http://127.0.0.1:${local.address().port}/api/v1`;
    try {
      const listed = await (await fetch(`${url}/notifications`)).json();
      expect(listed).toMatchObject({ unseen: 1, seenAt: null, targetConfigured: false, entries: [{ kind: "alert", title: "Root disk is 91% full", delivered: false, reason: "no-target", live: true, resolvedAt: null }] });
      clock += 60_000;
      expect((await (await fetch(`${url}/notifications/seen`, { method: "POST" })).json()).seenAt).toBe("2026-09-29T08:01:00.000Z");
      expect((await (await fetch(`${url}/notifications`)).json()).unseen).toBe(0);
      // Another account's marker is its own.
      expect((await (await fetch(`${url}/notifications`, { headers: { "x-test-owner": "operator-1" } })).json()).unseen).toBe(1);

      // Closing the bell marks seen up to when its list was read (M88), not up to now: an entry that
      // arrived after the list was read stays unseen. A future or unreadable `upTo` means now.
      const seen = (owner, body) => fetch(`${url}/notifications/seen`, { method: "POST", headers: { "x-test-owner": owner, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
      const readAt = new Date(clock).toISOString();                                  // 08:01:00, the list as read
      clock += 30_000;
      history.record({ key: "release.available:v1.200.0", kind: "notice", title: "BoxPilot v1.200.0 is out", delivered: true }); // 08:01:30
      clock += 30_000;                                                                // closed at 08:02:00
      expect(await seen("operator-1", { upTo: readAt })).toEqual({ seenAt: "2026-09-29T08:01:00.000Z" });
      const after = await (await fetch(`${url}/notifications`, { headers: { "x-test-owner": "operator-1" } })).json();
      expect(after.unseen).toBe(1);
      expect(after.entries.filter((entry) => !after.seenAt || entry.at > after.seenAt).map((entry) => entry.title)).toEqual(["BoxPilot v1.200.0 is out"]);
      expect(await seen("operator-2", { upTo: "2027-01-01T00:00:00.000Z" })).toEqual({ seenAt: "2026-09-29T08:02:00.000Z" });
      expect(await seen("operator-3", { upTo: "yesterday-ish" })).toEqual({ seenAt: "2026-09-29T08:02:00.000Z" });
      expect(await seen("operator-4", { upTo: 12 })).toEqual({ seenAt: "2026-09-29T08:02:00.000Z" });
    } finally {
      local.close();
    }
  });

  it("gives an automation's failure in full only to the owner and to whoever ran the run it describes (sweeps 2 and 3)", async () => {
    // The message carries the step's job error, which GET /flows keeps from anyone but the owner and
    // the account whose run it was; the notification centre handed it to every role. Who ran it is
    // recorded with the words, so a later run by someone else does not hand them over (sweep 3).
    const stored = new Map();
    const store = { getSetting: (key, fallback) => stored.get(key) ?? fallback, setSetting: (key, value) => stored.set(key, value), getJob: () => null, getFlow: () => null, getSchedule: () => null };
    const history = createNotificationHistory({ store, now: () => new Date("2026-10-05T03:00:00Z") });
    const said = history.record({ key: "flow.failed:flow-1", kind: "alert", title: "Automation stopped: Tidy", message: "Tidy stopped at step 2 (Back up application data): tar failed: /srv/private/ledger.db changed as we read it", delivered: true, actorId: "operator-1" });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.boxpilotSession = { owner: { id: request.headers["x-test-owner"] ?? "owner-1", role: request.headers["x-test-role"] ?? "owner" } }; next(); });
    app.use("/api/v1", createSettingsRouter({ state: store, notifications: { describe: () => ({ configured: true }) }, notificationHistory: history, auth }));
    const local = app.listen(0);
    await new Promise((resolve) => local.once("listening", resolve));
    const url = `http://127.0.0.1:${local.address().port}/api/v1`;
    const entryFor = async (owner, role) => (await (await fetch(`${url}/notifications`, { headers: { "x-test-owner": owner, "x-test-role": role } })).json()).entries[0];
    const full = { key: "flow.failed:flow-1", title: "Automation stopped: Tidy", message: expect.stringContaining("ledger.db") };
    const label = { key: "flow.failed", title: "An automation stopped or did not run", message: null };
    try {
      expect(await entryFor("owner-1", "owner")).toMatchObject(full);
      expect(await entryFor("viewer-1", "viewer")).toMatchObject(label);
      expect(await entryFor("operator-2", "operator")).toMatchObject(label);
      expect(await entryFor("operator-1", "operator")).toMatchObject(full);   // whose run it was
      // The response never says who ran it.
      expect(JSON.stringify(await entryFor("owner-1", "owner"))).not.toContain("operator-1");
      said.actorId = "owner-1";                                                // the owner's run
      stored.set("notificationHistory", [said]);
      expect(await entryFor("operator-1", "operator")).toMatchObject(label);
    } finally {
      local.close();
    }
  });
});

describe("a failure the bell no longer needs to raise (M88)", () => {
  it("marks a failed or cut-off job settled once it was dismissed, run again, or the same work completed since", async () => {
    // The bell kept every job.failed and job.interrupted entry as "Needs a look" for 30 days, after
    // it had been dismissed or the same backup had gone through the next night.
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-m88-settled-"));
    let clock = Date.parse("2026-11-24T01:00:00Z");
    const now = () => new Date(clock);
    const state = createStateStore({ stateDirectory: directory, now: () => new Date((clock += 1_000)) });
    const owner = state.createOwnerAccount({ username: "ada", passwordHash: "x", role: "owner", createdBy: null });
    const viewer = state.createOwnerAccount({ username: "vic", passwordHash: "x", role: "viewer", createdBy: null });
    const history = createNotificationHistory({ store: state, now });
    const run = (type, parameters, end, error) => {
      const job = state.createJob({ type, title: `Run ${type}`, parameters, createdBy: owner.id });
      state.transitionJob(job.id, "awaiting_approval", "applying");
      return state.transitionJob(job.id, "applying", end, end === "failed" ? { error } : {});
    };
    const failed = (job) => history.record({ key: `job.failed:${job.id}`, kind: "job", title: `${job.title} failed`, delivered: true });
    // Failed, then the same work on the same app completed: settled.
    const backup = run("op:app.backup", { id: "jellyfin" }, "failed", "tar failed");
    failed(backup);
    run("op:app.backup", { id: "jellyfin" }, "completed");
    // Failed, and only other apps' backups went through since: still needs a look.
    const other = run("op:app.backup", { id: "immich" }, "failed", "tar failed");
    failed(other);
    run("op:app.backup", { id: "nextcloud" }, "completed");
    // Failed, then dismissed: settled.
    const dismissed = run("op:apt.update", {}, "failed", "dpkg lock");
    state.addJobStep(dismissed.id, "dismissed", "completed", "Let go by the owner");
    failed(dismissed);
    // Failed, and the same work failed again later: not settled.
    const twice = run("op:app.update", { id: "gitea" }, "failed", "pull failed");
    failed(twice);
    run("op:app.update", { id: "gitea" }, "failed", "pull failed");
    // Cut off by a restart and run again by BoxPilot: settled. Cut off, nothing since: not.
    const cut = run("op:app.deploy", { id: "pihole" }, "failed", "BoxPilot restarted");
    state.addJobStep(cut.id, "rerun", "started", "Ran again");
    history.record({ key: "job.interrupted:app.deploy:pihole", kind: "notice", title: "Deploy pihole was interrupted", delivered: true });
    run("op:app.deploy", { id: "vaultwarden" }, "failed", "BoxPilot restarted");
    history.record({ key: "job.interrupted:app.deploy:vaultwarden", kind: "notice", title: "Deploy vaultwarden was interrupted", delivered: true });
    // Cut off, and the same work completed after it was told: settled.
    run("op:app.restore", { id: "paperless" }, "failed", "BoxPilot restarted");
    history.record({ key: "job.interrupted:app.restore:paperless", kind: "notice", title: "Restore paperless was interrupted", delivered: true });
    run("op:app.restore", { id: "paperless" }, "completed");
    // Not a job's: no settled field at all.
    history.record({ key: "storage.root.full", kind: "alert", title: "Root disk is 91% full", delivered: true });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.boxpilotSession = { owner: request.headers["x-test-role"] === "viewer" ? { id: viewer.id, role: "viewer" } : { id: owner.id, role: "owner" } }; next(); });
    app.use("/api/v1", createSettingsRouter({ state, notifications: { describe: () => ({ configured: true }) }, notificationHistory: history, auth }));
    const local = app.listen(0);
    await new Promise((resolve) => local.once("listening", resolve));
    const url = `http://127.0.0.1:${local.address().port}/api/v1/notifications`;
    try {
      const entries = (await (await fetch(url)).json()).entries;
      const settledOf = Object.fromEntries(entries.map((entry) => [entry.key, entry.settled]));
      expect(settledOf).toEqual({
        [`job.failed:${backup.id}`]: true,
        [`job.failed:${other.id}`]: false,
        [`job.failed:${dismissed.id}`]: true,
        [`job.failed:${twice.id}`]: false,
        "job.interrupted:app.deploy:pihole": true,
        "job.interrupted:app.deploy:vaultwarden": false,
        "job.interrupted:app.restore:paperless": true,
        "storage.root.full": undefined,
      });
      expect(Object.hasOwn(entries.find((entry) => entry.key === "storage.root.full"), "settled")).toBe(false);
      // A viewer is told the kind of another account's failure, not which job; whether it was dealt
      // with comes with it, and nothing more.
      const masked = (await (await fetch(url, { headers: { "x-test-role": "viewer" } })).json()).entries.filter((entry) => entry.family === "job.failed");
      expect(masked.map((entry) => [entry.key, entry.title, entry.settled])).toEqual([
        ["job.failed", "A job failed", false], ["job.failed", "A job failed", true], ["job.failed", "A job failed", false], ["job.failed", "A job failed", true],
      ]);
    } finally {
      local.close();
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("one rule for settled, the client's (M88)", () => {
  it("settles a failure on a later run of the same work that completed, is running or awaits approval, a retry, or the share a drive reconnect names; not on a later failure or cancel", async () => {
    // The bell settled a failure only on a later run that COMPLETED, while Today (src/jobStatus.ts
    // failureSettled) also counted one running or waiting for approval: the two disagreed for as
    // long as the retry ran or waited.
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-m88-rule-"));
    let clock = Date.parse("2026-11-24T01:00:00Z");
    const state = createStateStore({ stateDirectory: directory, now: () => new Date((clock += 1_000)) });
    const owner = state.createOwnerAccount({ username: "ada", passwordHash: "x", role: "owner", createdBy: null });
    const run = (type, parameters, end, error) => {
      const job = state.createJob({ type, title: `Run ${type}`, parameters, createdBy: owner.id });
      if (end === "awaiting_approval") return job;
      state.transitionJob(job.id, "awaiting_approval", "applying");
      if (end === "applying") return state.getJob(job.id);
      return state.transitionJob(job.id, "applying", end, end === "failed" ? { error } : {});
    };
    const settledFor = failureSettledFor(state);
    const settled = (job) => settledFor({ key: `job.failed:${job.id}`, at: new Date(clock).toISOString() });
    const cases = {};
    cases.running = run("op:app.update", { id: "gitea" }, "failed", "pull failed");
    run("op:app.update", { id: "gitea" }, "applying");
    cases.awaiting = run("op:app.backup", { id: "immich" }, "failed", "tar failed");
    run("op:app.backup", { id: "immich" }, "awaiting_approval");
    cases.failedAgain = run("op:app.backup", { id: "jellyfin" }, "failed", "tar failed");
    run("op:app.backup", { id: "jellyfin" }, "failed", "tar failed");
    cases.cancelledSince = run("op:app.deploy", { id: "pihole" }, "failed", "pull failed");
    const cancelled = run("op:app.deploy", { id: "pihole" }, "awaiting_approval");
    state.transitionJob(cancelled.id, "awaiting_approval", "cancelled");
    cases.driveThenShare = run("op:storage.remount", { name: "share-backups" }, "failed", "mount error(13)");
    run("op:share.reconnect", { name: "backups" }, "completed");
    cases.shareThenDrive = run("op:share.reconnect", { name: "media" }, "failed", "mount error(13)");
    run("op:storage.remount", { name: "share-media" }, "applying");
    cases.otherShare = run("op:storage.remount", { name: "share-photos" }, "failed", "mount error(13)");
    run("op:share.reconnect", { name: "music" }, "completed");
    cases.retried = run("op:app.restore", { id: "paperless" }, "failed", "timed out");
    const retry = state.createJob({ type: "op:app.restore", title: "Retry", parameters: { id: "paperless", other: true }, recovery: { retryOf: cases.retried.id }, createdBy: owner.id });
    state.transitionJob(retry.id, "awaiting_approval", "applying");
    state.transitionJob(retry.id, "applying", "failed", { error: "timed out again" });
    try {
      expect(Object.fromEntries(Object.entries(cases).map(([name, job]) => [name, settled(job)]))).toEqual({
        running: true, awaiting: true, failedAgain: false, cancelledSince: false,
        driveThenShare: true, shareThenDrive: true, otherShare: false, retried: true,
      });
    } finally {
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads jobs by type through an index, only the work since the failure, one row at a time up to the first that settles it, and only the columns the rule needs (M88)", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-m88-index-"));
    let clock = Date.parse("2026-11-24T01:00:00Z");
    const state = createStateStore({ stateDirectory: directory, now: () => new Date((clock += 1_000)) });
    try {
      const reader = new DatabaseSync(state.databasePath, { readOnly: true });
      const plan = reader.prepare("EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE type IN (?) AND created_at > ? ORDER BY created_at DESC LIMIT 5").all("op:app.backup", "2026-11-24T00:00:00Z");
      reader.close();
      expect(plan.map((row) => row.detail).join(" | ")).toMatch(/USING INDEX idx_jobs_type/);
      const owner = state.createOwnerAccount({ username: "ada", passwordHash: "x", role: "owner", createdBy: null });
      const first = state.createJob({ type: "op:app.backup", title: "Back up", parameters: { id: "a" }, createdBy: owner.id });
      state.addJobStep(first.id, "dismissed", "completed", "Let go");
      state.addJobStep(first.id, "pull", "completed", "a long step the rule never reads");
      const second = state.createJob({ type: "op:app.backup", title: "Back up", parameters: { id: "b" }, createdBy: owner.id });
      state.createJob({ type: "op:app.update", title: "Update", parameters: { id: "a" }, createdBy: owner.id });
      const third = state.createJob({ type: "op:app.backup", title: "Back up", parameters: { id: "c" }, createdBy: owner.id });
      const seen = [];
      const look = (job) => { seen.push(job.id); return job.parameters.id !== "a"; };
      // After a time: oldest first, stopping at the first that passes - the next run is the likeliest answer.
      expect(state.findJobOfType("op:app.backup", { after: first.createdAt }, look)?.id).toBe(second.id);
      expect(seen).toEqual([second.id]);
      expect(state.findJobOfType("op:app.backup", { after: third.createdAt }, () => true)).toBeNull();
      // Before a time: newest first. The row found carries its marker steps, and no more than the rule reads.
      expect(state.findJobOfType(["op:app.backup"], { before: second.createdAt }, (job) => job.parameters.id === "a")).toEqual({ id: first.id, type: "op:app.backup", state: "awaiting_approval", createdAt: first.createdAt, parameters: { id: "a" }, recovery: {}, steps: [{ name: "dismissed", state: "completed" }] });
      expect(state.findJobOfType("op:app.backup", { before: third.createdAt }, () => true)?.id).toBe(third.id);
    } finally {
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("quiet hours for pushes", () => {
  it("are read by anyone signed in and changed only by the owner, with times that make sense", async () => {
    const read = await fetch(`${base}/api/v1/settings/quiet-hours`, { headers: { "x-test-role": "viewer" } });
    expect(await read.json()).toMatchObject({ enabled: false, held: 2 });
    const put = (role, body) => fetch(`${base}/api/v1/settings/quiet-hours`, { method: "PUT", headers: { "Content-Type": "application/json", "x-test-role": role }, body: JSON.stringify(body) });
    expect((await put("operator", { enabled: true, start: "22:00", end: "07:00" })).status).toBe(403);
    expect((await put("owner", { enabled: true, start: "22:00", end: "22:00" })).status).toBe(400);
    expect((await put("owner", { enabled: true, start: "10pm", end: "07:00" })).status).toBe(400);
    const saved = await put("owner", { enabled: true, start: "22:30", end: "06:45", holdHigh: true, extra: "ignored" });
    expect(saved.status).toBe(200);
    expect(settings.get("notificationQuietHours")).toEqual({ enabled: true, start: "22:30", end: "06:45", holdHigh: true });
    expect(audits.at(-1)).toMatchObject({ type: "notifications.quiet-hours", actorId: "owner-1" });
  });
});
