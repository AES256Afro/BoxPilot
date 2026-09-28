/**
 * The weekly self-report (M30.4): what it says, built from what BoxPilot recorded, and when it goes -
 * Sunday 09:00 server time, through the scheduler's own next-run arithmetic, so daylight saving
 * cannot move it. Every clock is injected: the store's timestamps and the report's "now" alike.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeWeeklyReport, createWeeklyReport, gatherWeek, reportKey, uncovered } from "./weekly-report.mjs";
import { createHealthAlerts } from "./health-alerts.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const stores = [];
afterEach(async () => {
  // Closed before the directory goes: an open database cannot be deleted on Windows.
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// Pinned to a zone with DST so dates and transitions are the same wherever the tests run.
const withZone = (zone, test) => async () => {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { return await test(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
};

const titles = { "app.backup": "Back up application data", "backup.cloud.sync": "Mirror backups to the cloud destination", "docker.prune": "Clean up Docker disk space", "apt.upgrade": "Install all package updates" };
const registry = { get: (id) => (titles[id] ? { id, title: titles[id] } : null) };

async function world(start) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-weekly-"));
  directories.push(directory);
  let clock = new Date(start);
  const store = createStateStore({ stateDirectory: directory, now: () => clock });
  stores.push(store);
  const owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "alex", passwordHash: "hash" });
  return { store, owner, at: (value) => { clock = new Date(value); }, now: () => clock };
}

function job(store, owner, { type, title, parameters = {}, state, error }) {
  const created = store.createJob({ type: `op:${type}`, title, risk: "medium", parameters, createdBy: owner.id, initialSteps: [] });
  store.transitionJob(created.id, "awaiting_approval", "applying");
  store.transitionJob(created.id, "applying", state, state === "failed" ? { error } : {});
  return created;
}

describe("what the weekly report says", () => {
  it("is a verdict and a couple of lines when the week went well", () => {
    const report = composeWeeklyReport({
      from: new Date(2026, 8, 20, 9), to: new Date(2026, 8, 27, 9),
      jobs: { ran: 41, failed: 0, failedNames: [], more: false },
      backups: { appBackups: 7, databaseAt: new Date(2026, 8, 27, 3, 15).toISOString() },
      gaps: [],
    });
    expect(report.title).toBe("Weekly report, nothing failed");
    expect(report.message).toBe("Sep 20 to Sep 27: 41 jobs ran, none failed.\nBackups: 7 app backups this week; database backed up today.");
  });

  it("stays phone-sized however bad the week was", () => {
    const many = (prefix, count) => Array.from({ length: count }, (_value, index) => `${prefix} ${index + 1}`);
    const report = composeWeeklyReport({
      from: new Date(2026, 8, 20, 9), to: new Date(2026, 8, 27, 9),
      jobs: { ran: 200, failed: 37, failedNames: many("Back up application data", 37), more: true },
      skipped: many("Scheduled thing", 9).map((name) => ({ name, why: "x".repeat(300) })),
      paused: 3, stopped: many("Automation", 6), open: many("Condition", 12), unannounced: 14,
      backups: { appBackups: 0, databaseAt: null },
      gaps: many("gap", 8),
    });
    expect(report.title).toBe("Weekly report, 37 failed and 9 did not run");
    const lines = report.message.split("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(report.message.length).toBeLessThanOrEqual(1000);
    expect(lines[0]).toBe("Sep 20 to Sep 27: 200+ jobs ran, 37 failed: Back up application data 1, Back up application data 2, Back up application data 3 and 34 more.");
    expect(lines[1]).toMatch(/^Did not run: Scheduled thing 1 \(x+…\); Scheduled thing 2 \(x+…\) and 7 more\. 3 schedules or automations paused\.$/);
    expect(lines).toContain("Automations that stopped: Automation 1, Automation 2, Automation 3 and 3 more.");
    expect(lines).toContain("Still open: Condition 1 and 11 more; 14 things not announced, listed on the Overview.");
    expect(lines).toContain("Backups: no app backups this week; no database backup yet.");
    expect(lines).toContain("Not covered yet: gap 1; gap 2; gap 3 and 5 more.");
  });

  it("names what is not covered from the checklist and the apps with nothing scheduled, leaving out what it could not check", () => {
    const checklist = { items: [
      { id: "tailscale", optional: false, done: true, known: true },
      { id: "firewall", optional: false, done: false, known: false }, // could not be read: not claimed
      { id: "backups", optional: false, done: false, known: true },
      { id: "dns", optional: true, done: false, known: true }, // optional: not a gap
    ] };
    const protection = { available: true, apps: [
      { id: "immich", name: "Immich", protectable: true },
      { id: "jellyfin", name: "Jellyfin", protectable: true },
      { id: "dozzle", name: "Dozzle", protectable: false },
    ] };
    const schedules = [{ operationId: "app.backup", enabled: true, parameters: { id: "jellyfin" } }, { operationId: "app.backup", enabled: false, parameters: { id: "immich" } }];
    expect(uncovered({ checklist, protection, schedules })).toEqual(["no second copy of the backups", "no backup schedule for Immich"]);
    // A backup folder that could not be read is unknown, not "every app unprotected".
    expect(uncovered({ protection: { available: false, apps: protection.apps }, schedules })).toEqual([]);
  });

  it("is read from the jobs, schedules, automations, ledger and backups BoxPilot recorded", withZone("America/New_York", async () => {
    const { store, owner, at, now } = await world("2026-09-19T12:00:00Z");
    job(store, owner, { type: "apt.upgrade", title: titles["apt.upgrade"], state: "failed", error: "last week" }); // before the week
    at("2026-09-22T07:00:00Z");
    job(store, owner, { type: "app.backup", title: titles["app.backup"], parameters: { id: "jellyfin" }, state: "completed" });
    job(store, owner, { type: "app.backup", title: titles["app.backup"], parameters: { id: "immich" }, state: "failed", error: "tar failed: disk full" });
    job(store, owner, { type: "apt.upgrade", title: titles["apt.upgrade"], state: "completed" });

    const due = "2026-09-28T07:00:00.000Z";
    const mirror = store.createSchedule({ operationId: "backup.cloud.sync", parameters: {}, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id, nextDueAt: due });
    store.markScheduleRun(mirror.id, { result: "blocked-by-approval-mode", nextDueAt: due });
    const tidy = store.createSchedule({ operationId: "docker.prune", parameters: {}, frequency: "weekly", minute: 0, hour: 4, weekday: 0, createdBy: owner.id, nextDueAt: due });
    store.setScheduleEnabled(tidy.id, false, { actorId: owner.id });
    store.createSchedule({ operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id, nextDueAt: due });
    const skipped = store.createFlow({ name: "Night shift", steps: [{ operationId: "docker.prune", parameters: {} }], createdBy: owner.id, frequency: "daily", minute: 0, hour: 2, nextDueAt: due });
    store.markFlowRun(skipped.id, { result: "skipped: alex can no longer approve jobs", jobIds: [] });
    const stopped = store.createFlow({ name: "Update night", steps: [{ operationId: "apt.upgrade", parameters: {} }], createdBy: owner.id, frequency: "weekly", minute: 0, hour: 1, weekday: 6, nextDueAt: due });
    store.markFlowRun(stopped.id, { result: "stopped at step 1 (Install all package updates): apt lock", jobIds: [] });

    store.setSetting("healthAlertsState", {
      "storage.root.full": { title: "Root disk is 92% full", since: "2026-09-21T00:00:00Z", notified: true },
      "signin.new:o:100.64.0.20": { title: "New sign-in from 100.64.0.20", since: "2026-09-23T00:00:00Z", message: "m", notified: false },
      [reportKey]: { title: "Weekly report, nothing failed", since: "2026-09-20T13:00:00Z", message: "m", notified: false }, // last week's own: not counted
    }, { updatedBy: null });
    at("2026-09-26T07:15:00Z");
    store.recordBackup({ id: "b1", applicationId: "boxpilot-controller", destination: "local-managed", artifactPath: "/x", checksumSha256: "a".repeat(64), sizeBytes: 1, downtimeMs: 0, restoreDrill: {}, createdBy: owner.id });

    at("2026-09-27T13:00:30Z"); // Sunday 09:00 in New York
    const coverage = vi.fn(async () => ({ checklist: { items: [{ id: "backups", optional: false, done: false, known: true }] }, protection: { available: true, apps: [{ id: "immich", name: "Immich", protectable: true }, { id: "jellyfin", name: "Jellyfin", protectable: true }] } }));
    const week = await gatherWeek({ store, registry, now, coverage });
    expect(week.jobs).toMatchObject({ ran: 3, failed: 1, failedNames: ["Back up application data (immich)"], more: false });
    expect(week.skipped).toEqual([
      { name: "Mirror backups to the cloud destination", why: "Approvals are set to always ask" },
      { name: "Night shift", why: "alex can no longer approve jobs" },
    ]);
    expect(week.paused).toBe(1);
    expect(week.stopped).toEqual(["Update night"]);
    expect(week.open).toEqual(["Root disk is 92% full"]);
    expect(week.unannounced).toBe(1);
    expect(week.gaps).toEqual(["no second copy of the backups", "no backup schedule for Immich"]);

    const report = composeWeeklyReport(week);
    expect(report.title).toBe("Weekly report, 1 failed and 2 did not run");
    expect(report.message.split("\n")).toEqual([
      "Sep 20 to Sep 27: 3 jobs ran, 1 failed: Back up application data (immich).",
      "Did not run: Mirror backups to the cloud destination (Approvals are set to always ask); Night shift (alex can no longer approve jobs). 1 schedule or automation paused.",
      "Automations that stopped: Update night.",
      "Still open: Root disk is 92% full; 1 thing not announced, listed on the Overview.",
      "Backups: 1 app backup this week; database backed up 1 day ago.",
      "Not covered yet: no second copy of the backups; no backup schedule for Immich.",
    ]);

    // Coverage that cannot answer leaves its line out rather than guessing.
    const unsure = await gatherWeek({ store, registry, now, coverage: async () => { throw new Error("helper down"); } });
    expect(unsure.gaps).toBeNull();
    expect(composeWeeklyReport(unsure).message).not.toContain("Not covered yet");
  }));
});

describe("when the weekly report goes", () => {
  async function service({ start, target = { kind: "ntfy" }, send = vi.fn(async () => ({ sent: true })) }) {
    const { store, at, now } = await world(start);
    let current = target;
    // Like the real service: sending with no target throws rather than pretending.
    const notifications = { getTarget: () => current, send: async (payload) => { if (!current) throw new Error("No notification target is configured"); return send(payload); } };
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications, store, now });
    const report = createWeeklyReport({ store, alerts, notifications, registry, now });
    return { store, at, report, alerts, send, setTarget: (value) => { current = value; }, settings: () => store.getSetting("weeklyReport", null), ledger: () => store.getSetting("healthAlertsState", {}) };
  }

  it("goes once a week, Sunday 09:00 server time, on by default", withZone("America/New_York", async () => {
    const { at, report, send, settings } = await service({ start: "2026-09-23T16:00:00Z" }); // a Wednesday
    expect(report.status()).toMatchObject({ enabled: true, cadence: "Sundays at 09:00", nextDueAt: "2026-09-27T13:00:00.000Z" });
    expect(await report.tick()).toMatchObject({ sent: false, reason: "scheduled" }); // the first look only sets the time
    expect(settings().nextDueAt).toBe("2026-09-27T13:00:00.000Z");
    at("2026-09-27T12:59:00Z");
    expect(await report.tick()).toMatchObject({ reason: "not-due" });
    at("2026-09-27T13:00:30Z");
    expect(await report.tick()).toMatchObject({ sent: true, reason: "sent", title: "Weekly report, nothing failed" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ title: "BoxPilot: Weekly report, nothing failed", message: expect.stringContaining("Sep 20 to Sep 27"), priority: "default" });
    expect(settings()).toMatchObject({ nextDueAt: "2026-10-04T13:00:00.000Z", lastSentAt: "2026-09-27T13:00:30.000Z", lastResult: "sent" });
    at("2026-09-27T13:01:30Z");
    expect(await report.tick()).toMatchObject({ reason: "not-due" }); // once, not once a minute
    expect(send).toHaveBeenCalledTimes(1);
  }));

  it("keeps its hour across both daylight-saving changes", withZone("America/New_York", async () => {
    // Spring: 1 March is 09:00 EST (14:00Z); 8 March, after the clocks go forward, is 09:00 EDT (13:00Z).
    const spring = await service({ start: "2026-02-28T12:00:00Z" });
    await spring.report.tick();
    expect(spring.settings().nextDueAt).toBe("2026-03-01T14:00:00.000Z");
    spring.at("2026-03-01T14:00:10Z");
    expect(await spring.report.tick()).toMatchObject({ sent: true });
    expect(spring.settings().nextDueAt).toBe("2026-03-08T13:00:00.000Z");
    // Autumn: 25 October is 09:00 EDT (13:00Z); 1 November, the morning the clocks go back, is 09:00 EST (14:00Z).
    const autumn = await service({ start: "2026-10-24T12:00:00Z" });
    await autumn.report.tick();
    expect(autumn.settings().nextDueAt).toBe("2026-10-25T13:00:00.000Z");
    autumn.at("2026-10-25T13:00:10Z");
    await autumn.report.tick();
    expect(autumn.settings().nextDueAt).toBe("2026-11-01T14:00:00.000Z");
    autumn.at("2026-11-01T13:30:00Z"); // 08:30 EST: an hour-early report would already have gone
    expect(await autumn.report.tick()).toMatchObject({ reason: "not-due" });
    autumn.at("2026-11-01T14:00:10Z");
    expect(await autumn.report.tick()).toMatchObject({ sent: true });
  }));

  it("skips a week the server was off for rather than buzzing at whatever hour it came back", withZone("America/New_York", async () => {
    const { at, report, send, settings, store } = await service({ start: "2026-09-26T12:00:00Z" });
    await report.tick();
    at("2026-09-29T07:05:00Z"); // Tuesday 03:05, back from a long outage
    expect(await report.tick()).toMatchObject({ sent: false, reason: "missed" });
    expect(send).not.toHaveBeenCalled();
    expect(settings()).toMatchObject({ nextDueAt: "2026-10-04T13:00:00.000Z", lastResult: "missed" });
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "report.weekly.missed" })]));
    // Back a few hours late on the Sunday itself is still Sunday: it goes.
    at("2026-10-04T16:00:00Z");
    expect(await report.tick()).toMatchObject({ sent: true });
  }));

  it("becomes one not-announced entry without a target, not a pile, and goes once a target answers", withZone("America/New_York", async () => {
    const { at, report, alerts, send, ledger, setTarget, settings } = await service({ start: "2026-09-26T12:00:00Z", target: null });
    await report.tick();
    at("2026-09-27T13:00:30Z");
    expect(await report.tick()).toMatchObject({ sent: false, reason: "not-announced" });
    at("2026-10-04T13:00:30Z");
    await report.tick();
    at("2026-10-11T13:00:30Z");
    await report.tick();
    expect(Object.keys(ledger())).toEqual([reportKey]);
    expect(ledger()[reportKey]).toMatchObject({ notified: false, since: "2026-09-27T13:00:30.000Z", message: expect.stringContaining("Oct 4 to Oct 11") });
    expect(settings().lastResult).toBe("not-announced");
    expect(send).not.toHaveBeenCalled();

    setTarget({ kind: "ntfy" });
    expect((await alerts.check()).sent).toEqual([reportKey]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Oct 4 to Oct 11") }));
    expect(ledger()).toEqual({});
  }));

  it("can be turned off and on, and sent now from Settings", withZone("America/New_York", async () => {
    const { at, report, alerts, send, ledger, setTarget, store } = await service({ start: "2026-09-26T12:00:00Z", target: null });
    expect(report.setEnabled(false, { updatedBy: "owner-1" })).toMatchObject({ enabled: false, nextDueAt: null });
    at("2026-09-27T13:00:30Z");
    expect(await report.tick()).toMatchObject({ sent: false, reason: "off" });
    expect(report.setEnabled(true, { updatedBy: "owner-1" })).toMatchObject({ enabled: true, nextDueAt: "2026-10-04T13:00:00.000Z" }); // no catching up
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "settings.weekly-report.changed" })]));

    // Sending now with nowhere to send says so, to the person who asked, and keeps nothing.
    await expect(report.sendNow({ actorId: "owner-1" })).rejects.toThrow("No notification target");
    expect(ledger()).toEqual({});

    await alerts.tell({ key: reportKey, title: "Weekly report, nothing failed", message: "last week's" }); // one still waiting
    setTarget({ kind: "ntfy" });
    const sent = await report.sendNow({ actorId: "owner-1" });
    expect(sent).toMatchObject({ sent: true, title: "Weekly report, nothing failed" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger()).toEqual({}); // the newer report superseded the one waiting
    expect(report.status()).toMatchObject({ lastResult: "sent", lastSentAt: "2026-09-27T13:00:30.000Z", targetConfigured: true });
  }));
});
