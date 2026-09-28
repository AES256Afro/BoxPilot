// @vitest-environment node
/**
 * The services server/index.mjs starts, started together in its order, with fakes only where
 * BoxPilot meets the outside: the root helper, the notification target, the inventory and the job
 * logs. Each feature has its own tests; these walk what happens between them - a restart in the
 * middle of a job, a schedule that fails and then succeeds, a result that is not saved, a drive
 * that drops, one that drops while it is being checked, and a restart during a reconnect - and
 * count what reaches the owner's phone.
 *
 * The first opens a database as v1.121.0 left it, since upgrading one is what the 1.130
 * deployment does to the live server.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutoReconnect } from "./auto-reconnect.mjs";
import { createFlowService } from "./flows.mjs";
import { createHealthAlerts, jobNoticeKey, tellInterrupted } from "./health-alerts.mjs";
import { planInterruptedReruns } from "./job-reruns.mjs";
import { createJobService, recordFailed } from "./jobs.mjs";
import { createNotificationService } from "./notifications.mjs";
import { registry } from "./ops/index.mjs";
import { createSchedulerService } from "./scheduler.mjs";
import { scrubStoredSecrets } from "./secret-scrub.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const cleanups = [];
afterEach(async () => {
  // Services stop before the store closes, and the store closes before its directory goes.
  for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup(); } catch { /* already stopped */ } }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function databaseFile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-together-"));
  directories.push(directory);
  return path.join(directory, "boxpilot.sqlite3");
}

function clock(start) {
  let current = new Date(start);
  return { now: () => current, at: (value) => { current = new Date(value); } };
}

function openStore(databasePath, now) {
  const store = createStateStore({ databasePath, now });
  cleanups.push(() => store.close());
  return store;
}

const ownerOf = (store) => store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "alex", passwordHash: "hash" });
const webhookTarget = (store) => store.setSetting("notifications", { kind: "webhook", url: "http://127.0.0.1:9/boxpilot", topic: null, token: null }, { updatedBy: null });
const columnsOf = (databasePath, table) => {
  const database = new DatabaseSync(databasePath);
  try { return database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name); } finally { database.close(); }
};
const finished = (store, jobId) => vi.waitFor(() => {
  const state = store.getJob(jobId)?.state;
  if (!["completed", "failed", "cancelled"].includes(state)) throw new Error(`job ${jobId} is still ${state}`);
}, { timeout: 5000, interval: 5 });

/** The root helper: each operation answers as `answers` says - a value, an Error, or a function. */
function fakeHelper(answers = {}) {
  const calls = [];
  return {
    calls, answers,
    invalidate: () => {},
    async request(operation, parameters = {}, options = {}) {
      calls.push({ operation, parameters, options });
      if (operation === "job.output.release") return { released: true };
      const answer = answers[operation];
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function") return answer(parameters, options);
      return answer ?? {};
    },
  };
}
const remounts = (helper) => helper.calls.filter((call) => call.operation === "storage.remount").length;

// A job that printed nothing has no log, which is neither readable nor unreadable.
const quietLogs = { read: async () => ({ text: "", exists: false }), check: async () => ({ state: "absent" }) };

/**
 * Start the services as server/index.mjs does, in its order: recover the interrupted jobs, mask
 * stored secrets, let the scheduler claim its runs, plan the reruns and tell the rest, then the
 * automations, the drive reconnects, the notifier and the scheduler, and last the reruns.
 */
async function startServices(store, { helper = fakeHelper(), inventory = { inspect: async () => ({}) }, now, recordHooks = {} } = {}) {
  const pushes = [];
  const fetcher = async (_url, options) => { pushes.push(JSON.parse(options.body).title); return { ok: true, status: 200 }; };
  let scheduler = null;
  let flows = null;
  const notifications = createNotificationService({ store, fetcher, now, claimed: (job) => scheduler.owns(job.id) || flows.owns(job.id) || recordFailed(job) });
  const alerts = createHealthAlerts({ inventory, notifications, store, now, resolveScheduleTitle: (operationId) => registry.get(operationId)?.title ?? operationId });
  const jobs = createJobService(store, helper, {
    alerts, jobLog: quietLogs, now: () => now().getTime(),
    operationRecordHooks: {
      // As in index.mjs: a drive check's verdict is what the reconnect reads.
      "storage.check": (_job, result) => store.updateSetting("driveChecks", {}, (entries) => ({ value: { ...(entries ?? {}), [result.name]: { checkedAt: result.checkedAt, clean: result.clean, checker: result.checker, summary: result.summary } } })),
      ...recordHooks,
    },
  });
  const interrupted = store.recoverInterruptedJobs();
  await scrubStoredSecrets({ store, secretEnvNamesFor: async () => [], holdsStagedSecrets: jobs.holdsStagedSecrets });
  scheduler = createSchedulerService({ store, jobs, alerts, now });
  const scheduled = new Set(scheduler.recover(interrupted));
  const tellOne = (job) => { void tellInterrupted({ alerts, store, interrupted: [job], owned: scheduled }); };
  const reruns = planInterruptedReruns(interrupted, { store, jobs, scheduled, announce: tellOne });
  const told = tellInterrupted({ alerts, store, interrupted: interrupted.filter((job) => !reruns.has(job.id)), owned: scheduled });
  cleanups.push(store.subscribeJobs((job) => { if (job.state === "completed") alerts.clear(jobNoticeKey("job.interrupted", job), { quietly: true }).catch(() => {}); }));
  flows = createFlowService({ store, jobs, alerts, now, pollMs: 2, retryDelayMs: 2 });
  const autoReconnect = createAutoReconnect({ store, flows, alerts, now });
  cleanups.push(notifications.start(), flows.start(3_600_000), autoReconnect.start(), scheduler.start(3_600_000));
  const reran = await reruns.start();
  await told;
  return {
    jobs, alerts, scheduler, flows, autoReconnect, interrupted, reran, pushes,
    /** Everything handed to the ledger so far has been done, pushes included. */
    settled: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await alerts.clear("sweep.settled"); },
  };
}

// /mnt/media on its drive, and the same mount after the drive dropped and came back as sdc.
const mediaMount = { target: "/mnt/media", source: "/dev/sdc1", fstype: "exfat", readOnly: false, optionNames: [] };
const devices = { available: true, devices: [{ name: "/dev/sda" }, { name: "/dev/sda1" }, { name: "/dev/sdc1" }] };
const healthy = { storage: { filesystems: { available: true, mounts: [mediaMount] }, blockDevices: devices } };
const dropped = { storage: { filesystems: { available: true, mounts: [{ ...mediaMount, source: "/dev/sdb1" }] }, blockDevices: devices } };
const reconnected = { remounted: true, name: "media", mountpoint: "/mnt/media", source: "/dev/sdc1", previousSource: "/dev/sdb1", deviceChanged: true, restarted: ["bp-jellyfin"], restartFailed: [] };

describe("upgrading a database v1.121.0 left", () => {
  // v1.121.0's tables, as its state.mjs created and migrated them. 1.130 adds jobs.timeout_json and
  // flows.trigger_drive, and its CREATE TABLE statements are otherwise the same as v1.121.0's.
  const v121Columns = {
    jobs: ["id", "type", "title", "state", "risk", "parameters_json", "recovery_json", "result_json", "error", "created_by", "created_at", "updated_at"],
    flows: ["id", "name", "steps_json", "created_by", "created_at", "updated_at", "last_run_at", "last_result", "last_job_ids_json", "frequency", "minute", "hour", "weekday", "enabled", "next_due_at", "trigger_flow_id", "webhook_hash"],
  };

  /** The live server at the moment it updates: schedules v1.121.0 recorded only as "started", and jobs still running. */
  async function databaseAsV121LeftIt() {
    const databasePath = await databaseFile();
    const store = createStateStore({ databasePath, now: clock("2026-09-27T03:00:00Z").now });
    const owner = ownerOf(store);
    const job = ({ type, parameters = {}, state, error }) => {
      const created = store.createJob({ type: `op:${type}`, title: registry.get(type).title, risk: registry.get(type).risk, parameters, createdBy: owner.id, initialSteps: [] });
      store.transitionJob(created.id, "awaiting_approval", "applying");
      if (state !== "applying") store.transitionJob(created.id, "applying", state, state === "failed" ? { error } : { result: {} });
      return created.id;
    };
    const due = "2026-09-29T03:00:00.000Z";
    const schedule = (operationId, parameters, jobId) => {
      const created = store.createSchedule({ operationId, parameters, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id, nextDueAt: due });
      store.markScheduleRun(created.id, { jobId, result: "started", nextDueAt: due });
      return created.id;
    };
    const ids = {};
    ids.backedUp = schedule("app.backup", { id: "jellyfin" }, job({ type: "app.backup", parameters: { id: "jellyfin" }, state: "completed" }));
    ids.failed = schedule("app.backup", { id: "immich" }, job({ type: "app.backup", parameters: { id: "immich" }, state: "failed", error: "tar failed: disk full" }));
    ids.pruned = schedule("docker.prune", {}, "0f5d8a36-2b1e-4c7a-9d42-6b0e5f3a1c88"); // its job long since pruned
    ids.syncJob = job({ type: "backup.sync", state: "applying" });
    ids.sync = schedule("backup.sync", {}, ids.syncJob);
    ids.homepageJob = job({ type: "homepage.sync", parameters: { host: "127.0.0.1" }, state: "applying" });
    ids.refreshJob = job({ type: "apt.refresh", state: "applying" });
    ids.stepJob = job({ type: "docker.prune", state: "applying" });
    const flow = store.createFlow({ name: "Nightly tidy", steps: [{ operationId: "docker.prune", parameters: {} }], createdBy: owner.id, frequency: "daily", minute: 0, hour: 2, nextDueAt: due });
    store.markFlowRun(flow.id, { result: "running step 1 of 1 (Clean up Docker disk space)", jobIds: [ids.stepJob] });
    ids.flow = flow.id;
    store.setSetting("healthAlertsState", {
      "storage.root.full": { since: "2026-09-20T00:00:00.000Z", title: "Root disk is 92% full", notified: true },
      "system.reboot": { since: "2026-09-21T00:00:00.000Z", title: "A reboot is required" }, // from before the ledger had the flag
    }, { updatedBy: null });
    webhookTarget(store);
    store.close();
    const raw = new DatabaseSync(databasePath);
    raw.exec("ALTER TABLE jobs DROP COLUMN timeout_json; ALTER TABLE flows DROP COLUMN trigger_drive;");
    raw.close();
    expect(columnsOf(databasePath, "jobs")).toEqual(v121Columns.jobs);
    expect(columnsOf(databasePath, "flows")).toEqual(v121Columns.flows);
    return { databasePath, owner, ids };
  }

  it("adds the new columns once, reads every old row, and tells each job the update cut off exactly once", async () => {
    const { databasePath, owner, ids } = await databaseAsV121LeftIt();
    const { now } = clock("2026-09-28T10:00:00Z");
    const store = openStore(databasePath, now);
    expect(columnsOf(databasePath, "jobs").filter((name) => name === "timeout_json")).toHaveLength(1);
    expect(columnsOf(databasePath, "flows").filter((name) => name === "trigger_drive")).toHaveLength(1);
    expect(store.getJob(ids.refreshJob)).toMatchObject({ state: "applying", timeout: null });
    expect(store.getFlow(ids.flow)).toMatchObject({ triggerDrive: null, lastResult: "running step 1 of 1 (Clean up Docker disk space)" });

    const inventory = { inspect: async () => ({ storage: { root: { usedPercent: 92 } }, maintenance: { available: true, system: { failedServiceCount: 0 }, reboot: { required: true } } }) };
    const services = await startServices(store, { now, inventory });
    expect(services.interrupted.map((job) => job.id).sort()).toEqual([ids.syncJob, ids.homepageJob, ids.refreshJob, ids.stepJob].sort());

    // Syncing Homepage is safe to repeat and was started by hand: it runs again, as its own job.
    expect(services.reran).toHaveLength(1);
    await finished(store, services.reran[0].id);
    expect(store.getJob(services.reran[0].id)).toMatchObject({ type: "op:homepage.sync", state: "completed", recovery: expect.objectContaining({ rerunOf: ids.homepageJob }) });
    // Copying to the backup drive is safe to repeat too, but its schedule runs it at its next time.
    expect(store.getJob(ids.syncJob).steps).toEqual(expect.arrayContaining([expect.objectContaining({ name: "rerun", state: "skipped", detail: "Not run again: its schedule runs it again at the next time" })]));

    // The rest is one push each: the schedule's run, the job started by hand, the automation's step.
    await services.settled();
    expect(services.pushes).toEqual([
      "BoxPilot: Scheduled task was interrupted: Copy backups to the backup drive",
      "BoxPilot: Refresh package lists was interrupted",
      "BoxPilot: Automation was interrupted: Nightly tidy",
    ]);
    expect(store.getFlow(ids.flow).lastResult).toMatch(/^interrupted by a BoxPilot restart while running step 1 of 1/);

    // Runs v1.121.0 recorded only as "started" read as how they ended.
    const outcomes = Object.fromEntries(services.scheduler.list().map((schedule) => [schedule.id, [schedule.lastOutcome, schedule.lastReason]]));
    expect(outcomes).toEqual({
      [ids.backedUp]: ["ran", null],
      [ids.failed]: ["failed", "tar failed: disk full"],
      [ids.pruned]: ["unknown", null],
      [ids.sync]: ["failed", "interrupted by a BoxPilot restart"],
    });

    // Conditions v1.121.0 announced, with the flag or from before it, are not announced again.
    expect((await services.alerts.check()).sent).toEqual([]);
    expect(Object.keys(store.getSetting("healthAlertsState", {})).sort()).toEqual([`flow.failed:${ids.flow}`, `schedule.failed:${ids.sync}`, "storage.root.full", "system.reboot"]);

    // What 1.130 adds works on the upgraded database.
    const armed = await services.autoReconnect.arm("media", owner.id);
    expect(store.getFlow(armed.id)).toMatchObject({ triggerDrive: "media", steps: [{ operationId: "storage.remount", parameters: { name: "media" } }] });
    const ranOut = store.createJob({ type: "op:apt.upgrade", title: "Install package updates", risk: "medium", parameters: {}, createdBy: owner.id, initialSteps: [] });
    store.transitionJob(ranOut.id, "awaiting_approval", "applying");
    store.transitionJob(ranOut.id, "applying", "failed", { error: "ran out of time", timeout: { scope: "operation", budgetMs: 60_000, elapsedMs: 60_000, phase: "running", step: null, lastOutput: null, moreTimeMs: 120_000 } });
    expect(store.getJob(ranOut.id).timeout).toMatchObject({ budgetMs: 60_000, moreTimeMs: 120_000 });

    // Every later start opens it again and changes nothing.
    createStateStore({ databasePath, now }).close();
    expect(columnsOf(databasePath, "jobs").filter((name) => name === "timeout_json")).toHaveLength(1);
    expect(columnsOf(databasePath, "flows").filter((name) => name === "trigger_drive")).toHaveLength(1);
    await services.settled();
  });
});

// Real services on real timers, with waits of their own of up to 5 s inside a test: the default
// 5 s test limit is the same size, and a loaded runner ran one test out of it while every
// assertion would have held. The limit is for the whole walk, not any one step.
describe("the services together", { timeout: 30_000 }, () => {
  async function server(start, options = {}) {
    const { now, at } = clock(start);
    const store = openStore(await databaseFile(), now);
    const owner = ownerOf(store);
    webhookTarget(store);
    const services = await startServices(store, { now, ...options });
    return { store, owner, at, now, ...services };
  }

  it("a scheduled task that fails, fails again and then succeeds is one push for the failure and one when it is fixed", async () => {
    const helper = fakeHelper({ "docker.prune": new Error("docker system prune failed: permission denied") });
    const { store, owner, at, scheduler, pushes, settled } = await server("2026-09-28T01:00:00Z", { helper });
    const schedule = await scheduler.create({ operationId: "docker.prune", parameters: {}, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id });
    const runOnce = async () => {
      at(new Date(Date.parse(store.getSchedule(schedule.id).nextDueAt) + 60_000));
      await scheduler.tick();
      const jobId = store.getSchedule(schedule.id).lastJobId;
      await finished(store, jobId);
      await settled();
      return store.getJob(jobId).state;
    };
    expect(await runOnce()).toBe("failed");
    expect(pushes).toEqual(["BoxPilot: Scheduled task failed: Clean up Docker disk space"]);
    expect(await runOnce()).toBe("failed");
    expect(pushes).toHaveLength(1); // failing every night is not a push every night
    helper.answers["docker.prune"] = { pruned: true, reclaimed: "1.2GB" };
    expect(await runOnce()).toBe("completed");
    expect(pushes).toEqual(["BoxPilot: Scheduled task failed: Clean up Docker disk space", "BoxPilot: resolved. Scheduled task failed: Clean up Docker disk space"]);
    expect(scheduler.list()).toMatchObject([{ lastOutcome: "ran" }]);
    expect(store.getSetting("healthAlertsState", {})).toEqual({});
  });

  it("a scheduled run whose result is not saved is one push, the job's, and its next clean run says it is fixed", async () => {
    let saving = "fails";
    const helper = fakeHelper({ "docker.prune": { pruned: true, reclaimed: "1.2GB" } });
    // An asynchronous hook, awaited by the job layer: its rejection fails the job instead of escaping.
    const recordHooks = { "docker.prune": async () => { await new Promise((resolve) => setTimeout(resolve, 2)); if (saving === "fails") throw new Error("database is locked"); } };
    const { store, owner, at, scheduler, pushes, settled } = await server("2026-09-28T01:00:00Z", { helper, recordHooks });
    const schedule = await scheduler.create({ operationId: "docker.prune", parameters: {}, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id });
    const runOnce = async () => {
      at(new Date(Date.parse(store.getSchedule(schedule.id).nextDueAt) + 60_000));
      await scheduler.tick();
      const jobId = store.getSchedule(schedule.id).lastJobId;
      await finished(store, jobId);
      await settled();
      return store.getJob(jobId);
    };
    const unsaved = await runOnce();
    expect(unsaved.state).toBe("failed");
    expect(recordFailed(unsaved)).toBe(true);
    expect(pushes).toEqual(["BoxPilot: Result not saved: Clean up Docker disk space"]);
    expect(scheduler.list()).toMatchObject([{ lastOutcome: "failed" }]);
    saving = "works";
    expect((await runOnce()).state).toBe("completed");
    expect(pushes).toEqual(["BoxPilot: Result not saved: Clean up Docker disk space", "BoxPilot: resolved. Result not saved: Clean up Docker disk space"]);
    expect(store.getSetting("healthAlertsState", {})).toEqual({});
  });

  it("a drive that drops is reconnected by its automation and told once; one that drops while it is being checked waits for the check", async () => {
    let snapshot = healthy;
    let finishCheck = null;
    const helper = fakeHelper({ "storage.remount": reconnected, "storage.check": () => new Promise((resolve) => { finishCheck = resolve; }) });
    const { store, owner, at, now, jobs, alerts, autoReconnect, pushes, settled } = await server("2026-09-28T03:00:00Z", { helper, inventory: { inspect: async () => snapshot } });
    const armed = await autoReconnect.arm("media", owner.id);

    // The drive drops: the round says so, and the automation armed for it reconnects it.
    snapshot = dropped;
    await alerts.check();
    await vi.waitFor(() => expect(pushes).toHaveLength(2), { timeout: 5000, interval: 5 });
    await settled();
    expect(pushes).toEqual(["BoxPilot: /mnt/media lost its drive", "BoxPilot: Reconnected /mnt/media and restarted 1 app"]);
    expect(remounts(helper)).toBe(1);
    expect(store.getFlow(armed.id).lastResult).toBe("completed");
    expect(store.getSetting("healthAlertsState", {})).toEqual({}); // the reconnect was the resolution
    snapshot = healthy;
    expect((await alerts.check()).sent).toEqual([]); // so no "resolved" follows it

    // It drops again while somebody is checking it: the reconnect leaves the drive to the check.
    const check = await jobs.createOperationJob("storage.check", { name: "media" }, owner.id);
    await jobs.approveAndStart(check.id, owner.id, {});
    at("2026-09-28T04:00:00Z"); // well past the cooldown
    snapshot = dropped;
    await alerts.check();
    await settled();
    expect(remounts(helper)).toBe(1);
    expect(pushes.slice(2)).toEqual(["BoxPilot: /mnt/media lost its drive"]);

    // The check could not read a drive that went away under it and reports problems: writing to it
    // again is now a person's call, and the automation says so once, not every round.
    finishCheck({ checked: true, name: "media", mountpoint: "/mnt/media", device: "/dev/sdc1", fstype: "exfat", checker: "fsck.exfat", clean: false, exitCode: 8, summary: "read error", restarted: [], restartFailed: [], checkedAt: now().toISOString() });
    await finished(store, check.id);
    for (let round = 0; round < 2; round += 1) { await alerts.check(); await settled(); }
    expect(remounts(helper)).toBe(1);
    expect(pushes.slice(3)).toEqual(["BoxPilot: Did not reconnect /mnt/media"]);
  });

  it("trying a job again with more time after a restart does not push its old failure again", async () => {
    const databasePath = await databaseFile();
    const { now } = clock("2026-09-28T09:00:00Z");
    // Before the restart: an update ran out of its 40 minutes, and its failure was pushed then.
    const before = createStateStore({ databasePath, now });
    const owner = ownerOf(before);
    webhookTarget(before);
    const ranOut = before.createJob({ type: "op:app.update", title: "Update application", risk: "medium", parameters: { id: "jellyfin" }, createdBy: owner.id, initialSteps: [] });
    before.transitionJob(ranOut.id, "awaiting_approval", "applying");
    before.transitionJob(ranOut.id, "applying", "failed", { error: "Update application did not finish within 40 minutes.", timeout: { scope: "operation", budgetMs: 2_400_000, elapsedMs: 2_400_000, phase: "running", step: null, lastOutput: null, moreTimeMs: 4_800_000 } });
    before.close();

    const store = openStore(databasePath, now);
    const { jobs, pushes, settled } = await startServices(store, { now });
    const retry = await jobs.retryWithMoreTime(ranOut.id, owner.id);
    await settled();
    expect(retry).toMatchObject({ state: "awaiting_approval", recovery: expect.objectContaining({ retryOf: ranOut.id, budgetMs: 4_800_000 }) });
    expect(store.getJob(ranOut.id).steps.at(-1)).toMatchObject({ name: "retry", state: "staged" });
    expect(pushes).toEqual([]);
  });

  it("a restart during an automatic reconnect is told once, by the automation, and the drive waits for a person", async () => {
    const databasePath = await databaseFile();
    const { now } = clock("2026-09-28T03:10:00Z");
    // What the last run left: the automation mid-step, the step's job running, the attempt counted.
    const before = createStateStore({ databasePath, now });
    const owner = ownerOf(before);
    webhookTarget(before);
    const flow = before.createFlow({ name: "Reconnect /mnt/media when it drops", steps: [{ operationId: "storage.remount", parameters: { name: "media" } }], createdBy: owner.id, triggerDrive: "media" });
    const step = before.createJob({ type: "op:storage.remount", title: "Reconnect a drive", risk: "medium", parameters: { name: "media" }, createdBy: owner.id, initialSteps: [] });
    before.transitionJob(step.id, "awaiting_approval", "applying");
    before.markFlowRun(flow.id, { result: "running step 1 of 1 (Reconnect a drive)", jobIds: [step.id] });
    before.setSetting("driveReconnects", { media: { attempts: [{ at: "2026-09-28T03:05:00.000Z", outcome: "running" }] } }, { updatedBy: null });
    before.close();

    const store = openStore(databasePath, now);
    let snapshot = dropped;
    const helper = fakeHelper({ "storage.remount": reconnected });
    const { jobs, alerts, autoReconnect, reran, pushes, settled } = await startServices(store, { now, helper, inventory: { inspect: async () => snapshot } });
    await settled();
    expect(reran).toEqual([]);
    expect(pushes).toEqual(["BoxPilot: Automation was interrupted: Reconnect /mnt/media when it drops"]);
    expect(autoReconnect.status().drives.media).toMatchObject({ held: true, heldBecause: "BoxPilot restarted while it was reconnecting the drive" });

    // Still gone at the next round: said once, and not reconnected on its own.
    await alerts.check();
    await settled();
    expect(pushes.slice(1)).toEqual(["BoxPilot: /mnt/media lost its drive"]);
    expect(remounts(helper)).toBe(0);

    // A person reconnects it from Repair: the hold lifts and the automation's failure is answered.
    const byHand = await jobs.createOperationJob("storage.remount", { name: "media" }, owner.id);
    await jobs.approveAndStart(byHand.id, owner.id, {});
    await finished(store, byHand.id);
    await settled();
    expect(autoReconnect.status().drives.media).toMatchObject({ held: false });
    snapshot = healthy;
    await alerts.check();
    await settled();
    expect(pushes.slice(2)).toEqual(["BoxPilot: resolved. Automation was interrupted: Reconnect /mnt/media when it drops", "BoxPilot: resolved. /mnt/media lost its drive"]);
  });
});
