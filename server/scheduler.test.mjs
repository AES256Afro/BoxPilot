import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeNextRun, createSchedulerService, describeCadence, validateCadence, chooseQuietSlot } from "./scheduler.mjs";
import { createStateStore } from "./state.mjs";
import { createHealthAlerts } from "./health-alerts.mjs";
import { createJobService } from "./jobs.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function setup({ now = () => new Date("2026-08-20T10:30:00") } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-sched-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
  const jobs = {
    createOperationJob: vi.fn((operationId, parameters, createdBy) => store.createJob({ type: `op:${operationId}`, title: operationId, risk: "medium", parameters, createdBy, initialSteps: [] })),
    approveAndStart: vi.fn(async () => ({ state: "applying" })),
  };
  const registry = {
    get: (id) => ({
      "app.backup": { id, title: "Back up application data", risk: "medium", readOnly: false },
      "apt.refresh": { id, title: "Refresh package lists", risk: "low", readOnly: false },
      "apt.purge": { id, title: "Purge packages", risk: "high", readOnly: false },
      "app.inspect": { id, title: "Inspect", risk: "low", readOnly: true },
      "snap.delete": { id, title: "Delete a snapshot", risk: "medium", readOnly: false, confirm: (p) => String(p.name ?? "") },
      "recycle.empty": { id, title: "Empty the recycle bin", risk: "medium", readOnly: false },
    })[id] ?? null,
    validate: (id, parameters) => (id === "app.backup" && !parameters.id ? "requires id" : null),
  };
  const scheduler = createSchedulerService({ store, jobs, registry, now });
  return { store, jobs, scheduler, owner, registry };
}

describe("operation scheduler", () => {
  it("computes the next local occurrence for each cadence", () => {
    const from = new Date("2026-08-20T10:30:00"); // a Thursday
    expect(computeNextRun({ frequency: "hourly", minute: 45 }, from).toISOString()).toBe(new Date("2026-08-20T10:45:00").toISOString());
    expect(computeNextRun({ frequency: "hourly", minute: 15 }, from).toISOString()).toBe(new Date("2026-08-20T11:15:00").toISOString());
    expect(computeNextRun({ frequency: "daily", minute: 0, hour: 3 }, from).toISOString()).toBe(new Date("2026-08-21T03:00:00").toISOString());
    expect(computeNextRun({ frequency: "daily", minute: 0, hour: 23 }, from).toISOString()).toBe(new Date("2026-08-20T23:00:00").toISOString());
    expect(computeNextRun({ frequency: "weekly", minute: 0, hour: 4, weekday: 0 }, from).toISOString()).toBe(new Date("2026-08-23T04:00:00").toISOString());
    expect(computeNextRun({ frequency: "weekly", minute: 0, hour: 4, weekday: 4 }, from).toISOString()).toBe(new Date("2026-08-27T04:00:00").toISOString());
    expect(validateCadence({ frequency: "daily", minute: 61, hour: 3 })).toContain("minute");
    expect(validateCadence({ frequency: "weekly", minute: 0, hour: 3, weekday: 9 })).toContain("weekday");
    expect(describeCadence({ frequency: "weekly", minute: 30, hour: 4, weekday: 0 })).toBe("Sundays at 04:30");
  });

  it("refuses high-risk, read-only, unknown, and invalid-parameter schedules", async () => {
    const { store, scheduler, owner } = await setup();
    const base = { frequency: "daily", minute: 0, hour: 3, createdBy: owner.id };
    await expect(scheduler.create({ ...base, operationId: "apt.purge" })).rejects.toThrow("high risk");
    await expect(scheduler.create({ ...base, operationId: "app.inspect" })).rejects.toThrow("Read-only");
    await expect(scheduler.create({ ...base, operationId: "nope" })).rejects.toThrow("not registered");
    await expect(scheduler.create({ ...base, operationId: "app.backup", parameters: {} })).rejects.toThrow("requires id");
    await expect(scheduler.create({ ...base, operationId: "apt.refresh", minute: 99 })).rejects.toThrow("minute");
    // A typed-confirm op would be staged and refused every tick, forever, if it could be scheduled.
    // storage.fs-snapshot.delete is the one medium op that carries a confirm; it must be refused.
    await expect(scheduler.create({ ...base, operationId: "snap.delete", parameters: { name: "nightly" } })).rejects.toThrow("type a confirmation");
    // The ops that ARE meant to run unattended (no confirm) still schedule fine.
    await expect(scheduler.create({ ...base, operationId: "recycle.empty", parameters: { share: "media" } })).resolves.toBeTruthy();
    store.close();
  });

  it("runs due schedules as their creator and advances the next occurrence", async () => {
    let clock = new Date("2026-08-20T02:59:00");
    const { store, jobs, scheduler, owner } = await setup({ now: () => clock });
    const schedule = await scheduler.create({ operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id });
    expect(schedule.nextDueAt).toBe(new Date("2026-08-20T03:00:00").toISOString());

    expect(await scheduler.tick()).toBe(0); // not due yet
    clock = new Date("2026-08-20T03:00:30");
    expect(await scheduler.tick()).toBe(1);
    expect(jobs.createOperationJob).toHaveBeenCalledWith("app.backup", { id: "jellyfin" }, owner.id, { role: "owner" });
    expect(jobs.approveAndStart).toHaveBeenCalledTimes(1);
    const after = store.getSchedule(schedule.id);
    expect(after.lastResult).toBe("started");
    expect(after.lastJobId).toBeTruthy();
    expect(after.nextDueAt).toBe(new Date("2026-08-21T03:00:00").toISOString());
    expect(await scheduler.tick()).toBe(0); // advanced, not re-run
    store.close();
  });

  it("records a skipped run instead of forcing one when approvals demand a password", async () => {
    let clock = new Date("2026-08-20T03:00:30");
    const { store, jobs, scheduler, owner } = await setup({ now: () => clock });
    // The job layer marks a password-gated approval with a code; the scheduler reads the code, not the prose.
    jobs.approveAndStart.mockRejectedValueOnce(Object.assign(new Error("Enter the owner password: medium-risk job needs the owner password"), { code: "password_required" }));
    store.setSetting("approvalMode", "always-password", { updatedBy: owner.id });
    const schedule = await scheduler.create({ operationId: "apt.refresh", parameters: {}, frequency: "hourly", minute: 0, createdBy: owner.id });
    clock = new Date("2026-08-20T04:00:30");
    await scheduler.tick();
    const after = store.getSchedule(schedule.id);
    expect(after.lastResult).toBe("blocked-by-approval-mode");
    expect(after.nextDueAt).toBe(new Date("2026-08-20T05:00:00").toISOString());
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "schedule.skipped" })]));

    scheduler.setEnabled(schedule.id, false, owner.id);
    clock = new Date("2026-08-20T09:00:30");
    expect(await scheduler.tick()).toBe(0); // disabled schedules never run
    scheduler.setEnabled(schedule.id, true, owner.id);
    expect(store.getSchedule(schedule.id).nextDueAt).toBe(new Date("2026-08-20T10:00:00").toISOString()); // fresh start, no backlog
    scheduler.remove(schedule.id, owner.id);
    expect(store.listSchedules()).toEqual([]);
    store.close();
  });

  it("says a password refusal under tiered approvals is an error, not the approval mode", async () => {
    // A job staged high for what it acts on wants the password whatever the mode; calling that
    // "blocked by approval mode" sent the owner to a setting that was not the cause.
    let clock = new Date("2026-08-20T03:00:30");
    const { store, jobs, scheduler, owner } = await setup({ now: () => clock });
    jobs.approveAndStart.mockRejectedValueOnce(Object.assign(new Error("Enter the owner password: high-risk job needs the owner password"), { code: "password_required" }));
    const schedule = await scheduler.create({ operationId: "apt.refresh", parameters: {}, frequency: "hourly", minute: 0, createdBy: owner.id });
    clock = new Date("2026-08-20T04:00:30");
    await scheduler.tick();
    expect(store.getSchedule(schedule.id).lastResult).toBe("error: Enter the owner password: high-risk job needs the owner password");
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "schedule.skipped", details: expect.objectContaining({ reason: "Enter the owner password: high-risk job needs the owner password" }) })]));
    store.close();
  });
});

describe("an operation whose tier depends on what it acts on", () => {
  it("cannot be scheduled where that makes it high risk", async () => {
    // app.install is medium, and staged as high for an app whose manifest says so (Pi-hole, the VPN):
    // every run failed asking for a password, and the record blamed the approval mode.
    const { store, owner } = await setup();
    const helper = { request: vi.fn() };
    const jobs = createJobService(store, helper, { operationRiskHooks: { "app.install": async ({ id }) => (id === "pi-hole" ? "high" : null) } });
    const scheduler = createSchedulerService({ store, jobs, now: () => new Date("2026-08-20T10:30:00") });
    const base = { operationId: "app.install", frequency: "weekly", minute: 0, hour: 3, weekday: 0, createdBy: owner.id };
    await expect(scheduler.create({ ...base, parameters: { id: "pi-hole" } })).rejects.toThrow("Install application is high risk here and cannot run unattended");
    expect(store.listSchedules()).toEqual([]);
    await expect(scheduler.create({ ...base, parameters: { id: "jellyfin" } })).resolves.toMatchObject({ operationId: "app.install" });
    store.close();
  });
});

describe("scheduler hygiene", () => {
  it("withdraws a job it could not start, skips while the previous run is active, and never overlaps ticks", async () => {
    const { store, jobs, scheduler, owner } = await setup();
    jobs.cancelJob = vi.fn((jobId) => store.transitionJob(jobId, "awaiting_approval", "cancelled", { error: "withdrawn" }));
    jobs.approveAndStart = vi.fn(async () => { throw new Error("helper is busy"); });
    const schedule = await scheduler.create({ operationId: "apt.refresh", parameters: {}, frequency: "hourly", minute: 0, createdBy: owner.id });
    store.setScheduleEnabled(schedule.id, true, { actorId: owner.id, nextDueAt: "2026-08-20T10:00:00.000Z" });
    expect(await scheduler.tick()).toBe(1);
    expect(jobs.cancelJob).toHaveBeenCalledTimes(1);
    const job = store.getJob(jobs.cancelJob.mock.calls[0][0]);
    expect(job.state).toBe("cancelled");
    expect(store.getSchedule(schedule.id).lastResult).toContain("helper is busy");
    // A schedule whose last job is still running is skipped, not stacked.
    jobs.approveAndStart = vi.fn(async () => ({ state: "applying" }));
    store.setScheduleEnabled(schedule.id, true, { actorId: owner.id, nextDueAt: "2026-08-20T10:00:00.000Z" });
    await scheduler.tick();
    const running = store.getSchedule(schedule.id).lastJobId;
    store.transitionJob(running, "awaiting_approval", "applying"); // the mocked approveAndStart does not move the job itself
    store.setScheduleEnabled(schedule.id, true, { actorId: owner.id, nextDueAt: "2026-08-20T10:00:00.000Z" });
    await scheduler.tick();
    expect(store.getSchedule(schedule.id).lastResult).toContain("previous run still active");
    // Overlapping ticks: the second call returns immediately while the first is in flight.
    let release;
    jobs.createOperationJob = vi.fn(() => new Promise((resolve) => { release = () => resolve(store.createJob({ type: "op:apt.refresh", title: "x", risk: "low", parameters: {}, createdBy: owner.id, initialSteps: [] })); }));
    store.transitionJob(running, "applying", "completed");
    store.setScheduleEnabled(schedule.id, true, { actorId: owner.id, nextDueAt: "2026-08-20T10:00:00.000Z" });
    const first = scheduler.tick();
    expect(await scheduler.tick()).toBe(0);
    release();
    await first;
    store.close();
  });
});

describe("schedules and secrets", () => {
  it("refuses to store a credential and shows an account only its own schedules", async () => {
    const { store, jobs, owner } = await setup();
    const registry = {
      get: (id) => ({
        "share.mount": { id, title: "Mount a network share", risk: "medium", readOnly: false, parameters: { fields: { host: { type: "string" }, password: { type: "string", optional: true, secret: true } } } },
        "apt.refresh": { id, title: "Refresh package lists", risk: "low", readOnly: false, parameters: { fields: {} } },
      })[id] ?? null,
      validate: () => null,
    };
    const scheduler = createSchedulerService({ store, jobs, registry, now: () => new Date("2026-08-20T10:30:00") });
    await expect(scheduler.create({ operationId: "share.mount", parameters: { host: "nas", password: "hunter2 hunter2" }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id }))
      .rejects.toThrow("cannot run unattended");
    expect(store.listSchedules()).toHaveLength(0);

    const helper = store.createOwnerAccount({ username: "helper", passwordHash: "x", role: "operator", createdBy: owner.id });
    await scheduler.create({ operationId: "apt.refresh", parameters: {}, frequency: "hourly", minute: 0, createdBy: owner.id });
    await scheduler.create({ operationId: "apt.refresh", parameters: {}, frequency: "hourly", minute: 30, createdBy: helper.id });
    // Clicking "schedule everything" twice used to make a second copy of every backup: two
    // container stops a night and twice the downtime, for no benefit.
    await expect(scheduler.create({ operationId: "apt.refresh", parameters: {}, frequency: "daily", minute: 5, hour: 4, createdBy: owner.id }))
      .rejects.toThrow("already scheduled");
    expect(scheduler.list()).toHaveLength(2); // the owner sees the whole box
    expect(scheduler.list({ createdBy: helper.id })).toHaveLength(1);
    // Someone else's schedule is not theirs to pause or delete.
    const ownerSchedule = scheduler.list({ createdBy: owner.id })[0];
    expect(() => scheduler.setEnabled(ownerSchedule.id, false, helper.id)).toThrow("not found");
    expect(() => scheduler.remove(ownerSchedule.id, helper.id)).toThrow("not found");
    expect(() => scheduler.setEnabled(ownerSchedule.id, false, owner.id)).not.toThrow();
    store.close();
  });
});

describe("placing a heavy weekly job", () => {
  it("keeps the first one where it was asked for", () => {
    const slot = chooseQuietSlot({ schedules: [], preferred: { weekday: 1, hour: 3, minute: 30 } });
    expect(slot).toEqual({ frequency: "weekly", weekday: 1, hour: 3, minute: 30 });
  });

  it("does not stack eighteen rehearsals on one minute", () => {
    const schedules = [];
    for (let index = 0; index < 18; index += 1) {
      const slot = chooseQuietSlot({ schedules, preferred: { weekday: 1, hour: 3, minute: 30 } });
      schedules.push(slot);
    }
    const stamps = schedules.map((slot) => `${slot.weekday}:${slot.hour}:${slot.minute}`);
    expect(new Set(stamps).size).toBe(18);
  });

  it("keeps clear of the nightly backup and the off-box mirror", () => {
    // The two that already run in these hours on a set-up server.
    const schedules = [
      { operationId: "controller.backup.create", frequency: "daily", hour: 3, minute: 15 },
      { operationId: "host.snapshot.sync", frequency: "daily", hour: 4, minute: 15 },
    ];
    for (let index = 0; index < 18; index += 1) {
      const slot = chooseQuietSlot({ schedules, preferred: { weekday: 1, hour: 3, minute: 30 } });
      expect(`${slot.hour}:${slot.minute}`).not.toBe("3:15");
      expect(`${slot.hour}:${slot.minute}`).not.toBe("4:15");
      schedules.push(slot);
    }
  });

  it("counts a daily job as occupying every day, not just one", () => {
    const schedules = [{ operationId: "controller.backup.create", frequency: "daily", hour: 3, minute: 30 }];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const slot = chooseQuietSlot({ schedules, preferred: { weekday, hour: 3, minute: 30 } });
      expect(`${slot.hour}:${slot.minute}`).not.toBe("3:30");
    }
  });

  it("stays inside the quiet hours", () => {
    const schedules = [];
    for (let index = 0; index < 30; index += 1) {
      const slot = chooseQuietSlot({ schedules, preferred: { weekday: 1, hour: 3, minute: 30 } });
      expect(slot.hour).toBeGreaterThanOrEqual(1);
      expect(slot.hour).toBeLessThanOrEqual(5);
      schedules.push(slot);
    }
  });
});

describe("a scheduled task that fails (M27.2)", () => {
  // The health-alert ledger over the same store the scheduler uses, with a stand-in target.
  function withLedger(store, { target = { kind: "ntfy" }, send = vi.fn(async () => ({ sent: true })), now }) {
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications: { getTarget: () => target, send }, store, now });
    // Announcing is fire-and-forget from the scheduler; anything queued after it waits for it.
    const drained = () => alerts.clear("nothing:pending");
    return { alerts, send, drained, state: () => store.getSetting("healthAlertsState", {}) };
  }

  it("is announced once, not once a run, and again only after it has worked", async () => {
    let clock = new Date("2026-08-20T02:59:00");
    const { store, jobs, owner, registry } = await setup();
    const { alerts, send, drained, state } = withLedger(store, { now: () => clock });
    const scheduler = createSchedulerService({ store, jobs, registry, now: () => clock, alerts });
    const schedule = await scheduler.create({ operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "hourly", minute: 0, createdBy: owner.id });
    const run = async (hour, outcome) => {
      clock = new Date(`2026-08-20T${hour}:00:30`);
      await scheduler.tick();
      const jobId = store.getSchedule(schedule.id).lastJobId;
      // The notifier asks this before pushing the job, so the job is not announced twice.
      expect(scheduler.owns(jobId)).toBe(true);
      store.transitionJob(jobId, "awaiting_approval", outcome, outcome === "failed" ? { error: "tar failed: disk full" } : {});
      scheduler.onJob(store.getJob(jobId));
      await drained();
    };

    await run("03", "failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ title: "BoxPilot: Scheduled task failed: Back up application data (jellyfin)", message: "tar failed: disk full. The job log is in Activity.", priority: "high" });
    await run("04", "failed");
    await run("05", "failed");
    expect(send).toHaveBeenCalledTimes(1); // three failed runs, one push
    expect(state()[`schedule.failed:${schedule.id}`]).toMatchObject({ notified: true, since: new Date("2026-08-20T03:00:30").toISOString() });

    await run("06", "completed");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ title: "BoxPilot: resolved. Scheduled task failed: Back up application data (jellyfin)" }));
    expect(state()).toEqual({});
    await run("07", "failed");
    expect(send).toHaveBeenCalledTimes(3); // failing again after it worked is news again
    store.close();
  });

  it("is kept as not announced when there is no target, including runs that never started", async () => {
    let clock = new Date("2026-08-20T03:00:30");
    const { store, jobs, owner, registry } = await setup();
    const { alerts, send, drained, state } = withLedger(store, { target: null, now: () => clock });
    const scheduler = createSchedulerService({ store, jobs, registry, now: () => clock, alerts });
    jobs.cancelJob = vi.fn((jobId) => store.transitionJob(jobId, "awaiting_approval", "cancelled", { error: "withdrawn" }));
    jobs.approveAndStart = vi.fn(async () => { throw new Error("helper is busy"); });
    const schedule = await scheduler.create({ operationId: "apt.refresh", parameters: {}, frequency: "hourly", minute: 0, createdBy: owner.id });
    const key = `schedule.failed:${schedule.id}`;

    clock = new Date("2026-08-20T04:00:30");
    await scheduler.tick();
    await drained();
    expect(send).not.toHaveBeenCalled();
    expect(state()[key]).toMatchObject({ notified: false, title: "Scheduled task did not run: Refresh package lists", since: new Date("2026-08-20T04:00:30").toISOString() });
    expect(state()[key].message).toContain("helper is busy");

    // Always-ask approvals skip every run: a choice, but one whose effect is easy to miss.
    store.setSetting("approvalMode", "always-password", { updatedBy: owner.id });
    jobs.approveAndStart = vi.fn(async () => { throw Object.assign(new Error("Enter the owner password"), { code: "password_required" }); });
    clock = new Date("2026-08-20T05:00:30");
    await scheduler.tick();
    await drained();
    expect(state()[key]).toMatchObject({ notified: false, since: new Date("2026-08-20T04:00:30").toISOString() }); // still since the first
    expect(state()[key].message).toContain("always ask");

    // Deleting the schedule is not a fix, and there is nothing left to tell.
    scheduler.remove(schedule.id, owner.id);
    await drained();
    expect(state()).toEqual({});
    expect(send).not.toHaveBeenCalled();
    store.close();
  });

  it("is kept as not announced when the target does not answer", async () => {
    let clock = new Date("2026-08-20T02:59:00");
    const { store, jobs, owner, registry } = await setup();
    const send = vi.fn(async () => { throw new Error("The notification target answered 502"); });
    const { alerts, drained, state } = withLedger(store, { send, now: () => clock });
    const scheduler = createSchedulerService({ store, jobs, registry, now: () => clock, alerts });
    const schedule = await scheduler.create({ operationId: "app.backup", parameters: { id: "immich" }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id });
    clock = new Date("2026-08-20T03:00:30");
    await scheduler.tick();
    const jobId = store.getSchedule(schedule.id).lastJobId;
    store.transitionJob(jobId, "awaiting_approval", "failed", { error: "pull failed" });
    scheduler.onJob(store.getJob(jobId));
    await drained();
    expect(send).toHaveBeenCalledTimes(1);
    expect(state()[`schedule.failed:${schedule.id}`]).toMatchObject({ notified: false, title: "Scheduled task failed: Back up application data (immich)" });
    store.close();
  });

  it("announces a scheduled run a restart cut off as its schedule's failure", async () => {
    let clock = new Date("2026-08-20T02:59:00");
    const { store, jobs, owner, registry } = await setup();
    const { alerts, drained, state } = withLedger(store, { target: null, now: () => clock });
    const scheduler = createSchedulerService({ store, jobs, registry, now: () => clock, alerts });
    const schedule = await scheduler.create({ operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id });
    clock = new Date("2026-08-20T03:00:30");
    await scheduler.tick();
    const jobId = store.getSchedule(schedule.id).lastJobId;
    // A fresh process: nothing remembers starting it, only the schedule's last job pointer.
    const restarted = createSchedulerService({ store, jobs, registry, now: () => clock, alerts });
    expect(restarted.recover([{ id: jobId, title: "Back up application data" }, { id: "someone-elses-job", title: "x" }])).toEqual([jobId]);
    expect(restarted.owns(jobId)).toBe(true);
    await drained();
    expect(state()[`schedule.failed:${schedule.id}`]).toMatchObject({ notified: false, title: "Scheduled task was interrupted: Back up application data (jellyfin)" });
    store.close();
  });
});

describe("what the Schedules panel says about the last run (M27.2)", () => {
  const outcomeOf = (scheduler, id) => scheduler.list().find((entry) => entry.id === id);

  it("says ran, failed or did not run from how the job ended, not from having started it", async () => {
    let clock = new Date("2026-08-20T02:59:00");
    const { store, jobs, owner, registry } = await setup();
    const scheduler = createSchedulerService({ store, jobs, registry, now: () => clock });
    const schedule = await scheduler.create({ operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "hourly", minute: 0, createdBy: owner.id });
    expect(outcomeOf(scheduler, schedule.id)).toMatchObject({ lastOutcome: null, lastResult: null });

    clock = new Date("2026-08-20T03:00:30");
    await scheduler.tick();
    const first = store.getSchedule(schedule.id).lastJobId;
    // Staged and not finished: running, not "ran".
    expect(outcomeOf(scheduler, schedule.id)).toMatchObject({ lastOutcome: "running", lastResult: "started" });
    store.transitionJob(first, "awaiting_approval", "failed", { error: "tar failed: disk full" });
    scheduler.onJob(store.getJob(first));
    expect(store.getSchedule(schedule.id)).toMatchObject({ lastResult: "failed: tar failed: disk full", lastRunAt: expect.any(String) });
    expect(outcomeOf(scheduler, schedule.id)).toMatchObject({ lastOutcome: "failed", lastReason: "tar failed: disk full" });

    clock = new Date("2026-08-20T04:00:30");
    await scheduler.tick();
    const second = store.getSchedule(schedule.id).lastJobId;
    store.transitionJob(second, "awaiting_approval", "completed", {});
    scheduler.onJob(store.getJob(second));
    expect(outcomeOf(scheduler, schedule.id)).toMatchObject({ lastOutcome: "ran", lastResult: "completed", lastReason: null });
    // A late event from the older run does not overwrite the newer run's ending.
    scheduler.onJob(store.getJob(first));
    expect(store.getSchedule(schedule.id).lastResult).toBe("completed");

    // Could not start: did not run, with the reason.
    jobs.approveAndStart = vi.fn(async () => { throw new Error("helper is busy"); });
    clock = new Date("2026-08-20T05:00:30");
    await scheduler.tick();
    expect(outcomeOf(scheduler, schedule.id)).toMatchObject({ lastOutcome: "did-not-run", lastReason: "helper is busy" });
    store.setSetting("approvalMode", "always-password", { updatedBy: owner.id });
    jobs.approveAndStart = vi.fn(async () => { throw Object.assign(new Error("Enter the owner password"), { code: "password_required" }); });
    clock = new Date("2026-08-20T06:00:30");
    await scheduler.tick();
    expect(outcomeOf(scheduler, schedule.id)).toMatchObject({ lastOutcome: "did-not-run", lastResult: "blocked-by-approval-mode", lastReason: "Approvals are set to always ask" });
    store.close();
  });

  it("reads a run recorded only as started from its job, after a restart or an upgrade", async () => {
    let clock = new Date("2026-08-20T02:59:00");
    const { store, jobs, owner, registry } = await setup();
    const scheduler = createSchedulerService({ store, jobs, registry, now: () => clock });
    const schedule = await scheduler.create({ operationId: "app.backup", parameters: { id: "immich" }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id });
    clock = new Date("2026-08-20T03:00:30");
    await scheduler.tick();
    const jobId = store.getSchedule(schedule.id).lastJobId;
    // The job failed while nothing was listening: the row still says "started".
    store.transitionJob(jobId, "awaiting_approval", "failed", { error: "pull failed" });
    const fresh = createSchedulerService({ store, jobs, registry, now: () => clock });
    expect(store.getSchedule(schedule.id).lastResult).toBe("started");
    expect(outcomeOf(fresh, schedule.id)).toMatchObject({ lastOutcome: "failed", lastResult: "failed: pull failed", lastReason: "pull failed" });
    store.close();
  });

  it("writes the ending of a job that finished before its start was recorded", async () => {
    let clock = new Date("2026-08-20T02:59:00");
    const { store, jobs, owner, registry } = await setup();
    const scheduler = createSchedulerService({ store, jobs, registry, now: () => clock });
    // A job that fails inside approveAndStart: its event arrives before the schedule says "started".
    jobs.approveAndStart = vi.fn(async (jobId) => {
      store.transitionJob(jobId, "awaiting_approval", "failed", { error: "refused at once" });
      scheduler.onJob(store.getJob(jobId));
      return store.getJob(jobId);
    });
    const schedule = await scheduler.create({ operationId: "apt.refresh", parameters: {}, frequency: "hourly", minute: 0, createdBy: owner.id });
    clock = new Date("2026-08-20T03:00:30");
    await scheduler.tick();
    expect(store.getSchedule(schedule.id).lastResult).toBe("failed: refused at once");
    store.close();
  });

  it("says a run a restart cut off failed", async () => {
    let clock = new Date("2026-08-20T02:59:00");
    const { store, jobs, owner, registry } = await setup();
    const scheduler = createSchedulerService({ store, jobs, registry, now: () => clock });
    const schedule = await scheduler.create({ operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id });
    clock = new Date("2026-08-20T03:00:30");
    await scheduler.tick();
    const jobId = store.getSchedule(schedule.id).lastJobId;
    createSchedulerService({ store, jobs, registry, now: () => clock }).recover([{ id: jobId, title: "Back up application data" }]);
    expect(outcomeOf(scheduler, schedule.id)).toMatchObject({ lastOutcome: "failed", lastReason: "interrupted by a BoxPilot restart" });
    store.close();
  });
});

describe("a scheduled run whose result was not saved (M27.2)", () => {
  // The real job service, so the record hook fails the way it does in production and raises its
  // own condition, and the real ledger, so what is counted is what the Overview would count.
  async function recording({ send = vi.fn(async () => ({ sent: true })) } = {}) {
    let clock = new Date("2026-08-20T02:59:00");
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-sched-record-"));
    directories.push(directory);
    const store = createStateStore({ stateDirectory: directory });
    const owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "operator", passwordHash: "hash" });
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications: { getTarget: () => ({ kind: "ntfy" }), send }, store, now: () => clock });
    let broken = true;
    const helper = { request: vi.fn(async () => ({ id: "jellyfin", verified: true })) };
    const jobs = createJobService(store, helper, { alerts, operationRecordHooks: { "app.backup.verify": () => { if (broken) throw new Error("database is locked"); } } });
    const scheduler = createSchedulerService({ store, jobs, now: () => clock, alerts });
    const stop = store.subscribeJobs(scheduler.onJob);
    const schedule = await scheduler.create({ operationId: "app.backup.verify", parameters: { id: "jellyfin" }, frequency: "hourly", minute: 0, createdBy: owner.id });
    const run = async (hour) => {
      clock = new Date(`2026-08-20T${hour}:00:30`);
      await scheduler.tick();
      const jobId = store.getSchedule(schedule.id).lastJobId;
      await vi.waitFor(() => expect(["completed", "failed"]).toContain(store.getJob(jobId).state));
      await new Promise((resolve) => setTimeout(resolve, 5)); // the job event is delivered on a microtask
      await alerts.clear("nothing:pending"); // and everything it queued on the ledger has settled
      return store.getJob(jobId);
    };
    return { store, send, alerts, schedule, run, fix: () => { broken = false; }, stop, state: () => store.getSetting("healthAlertsState", {}) };
  }

  it("is one condition, the unsaved result, not a failed schedule as well", async () => {
    const { store, send, schedule, run, fix, state, stop } = await recording();
    const job = await run("03");
    expect(job.state).toBe("failed");
    expect(Object.keys(state())).toEqual(["record.failed:app.backup.verify:jellyfin"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: "BoxPilot: Result not saved: Rehearse restoring a backup (jellyfin)" }));
    // The panel still says the run failed, and why.
    expect(store.getSchedule(schedule.id).lastResult).toBe("failed: database is locked");

    await run("04");
    expect(send).toHaveBeenCalledTimes(1); // failing the same way again is not news
    fix();
    await run("05");
    expect(state()).toEqual({});
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ title: "BoxPilot: resolved. Result not saved: Rehearse restoring a backup (jellyfin)" }));
    stop();
    store.close();
  });

  it("replaces an earlier failure of the same schedule quietly rather than standing beside it", async () => {
    const { store, send, alerts, schedule, run, state, stop } = await recording();
    await alerts.raise({ key: `schedule.failed:${schedule.id}`, title: "Scheduled task failed: Rehearse restoring a backup (jellyfin)", message: "earlier", priority: "high" });
    expect(send).toHaveBeenCalledTimes(1);
    await run("03");
    expect(Object.keys(state())).toEqual(["record.failed:app.backup.verify:jellyfin"]);
    // No "resolved" for the schedule: the task did not succeed, only its failure changed shape.
    expect(send.mock.calls.map(([payload]) => payload.title)).toEqual([
      "BoxPilot: Scheduled task failed: Rehearse restoring a backup (jellyfin)",
      "BoxPilot: Result not saved: Rehearse restoring a backup (jellyfin)",
    ]);
    stop();
    store.close();
  });
});

describe("a schedule due while approvals always ask, with the real job service", () => {
  // The fake job services above have no approvalPolicy, so the check that refuses before staging
  // never ran in a test; it threw without the code the skip is recognised by, and every run read
  // as an error ("could not start") rather than the approval mode the Schedules panel points at.
  it("is recorded as blocked by the approval mode, and nothing is staged or run", async () => {
    let clock = new Date("2026-08-20T02:59:00");
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-sched-always-"));
    directories.push(directory);
    const store = createStateStore({ stateDirectory: directory });
    try {
      const owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "operator", passwordHash: "hash" });
      const helper = { request: vi.fn(async () => ({ ok: true })) };
      const jobs = createJobService(store, helper);
      const messages = [];
      const scheduler = createSchedulerService({ store, jobs, now: () => clock, alerts: { raise: async (alert) => { messages.push(alert.message); }, clear: async () => {} } });
      const schedule = await scheduler.create({ operationId: "apt.refresh", parameters: {}, frequency: "hourly", minute: 0, createdBy: owner.id });
      store.setSetting("approvalMode", "always-password", { updatedBy: owner.id });
      clock = new Date("2026-08-20T03:00:30");
      await scheduler.tick();
      expect(store.getSchedule(schedule.id).lastResult).toBe("blocked-by-approval-mode");
      expect(scheduler.list().find((entry) => entry.id === schedule.id)).toMatchObject({ lastOutcome: "did-not-run", lastReason: "Approvals are set to always ask" });
      expect(messages).toEqual([expect.stringContaining("Approvals are set to always ask")]);
      expect(store.listAwaitingApproval()).toEqual([]);
      expect(helper.request).not.toHaveBeenCalled();
    } finally { store.close(); }
  });
});

describe("a schedule that would store an app's secret", () => {
  it("is refused, like a schedule carrying a top-level password", async () => {
    // values.env is where an app's token lives; a stored schedule would keep it in the database.
    const { store, owner } = await setup();
    const jobs = { approveAndStart: vi.fn(), prepareParameters: async (_id, parameters) => parameters };
    const scheduler = createSchedulerService({ store, jobs, secretEnvNamesFor: async () => ["CLOUDFLARE_API_TOKEN"] });
    await expect(scheduler.create({ operationId: "app.reconfigure", parameters: { id: "cloudflare-ddns", values: { env: { CLOUDFLARE_API_TOKEN: "cf-token" } } }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id }))
      .rejects.toThrow("needs a password or key each time");
    expect(store.listSchedules()).toHaveLength(0);
    store.close();
  });

  it("is refused when the secret is typed as a number", async () => {
    // The check asked only whether the value was a non-empty string; values.env also takes numbers.
    const { store, owner } = await setup();
    try {
      const jobs = { approveAndStart: vi.fn(), prepareParameters: async (_id, parameters) => parameters };
      const scheduler = createSchedulerService({ store, jobs, secretEnvNamesFor: async () => ["ADMIN_PIN"] });
      await expect(scheduler.create({ operationId: "app.reconfigure", parameters: { id: "pinned-app", values: { env: { ADMIN_PIN: 918273645546372 } } }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id }))
        .rejects.toThrow("needs a password or key each time");
      expect(store.listSchedules()).toHaveLength(0);
    } finally { store.close(); }
  });

  it("is refused when the catalog cannot say which settings of the app are secret", async () => {
    // A mistyped or retired app id: the catalog answers null, which used to read as "no secrets".
    const { store, owner } = await setup();
    try {
      const jobs = { approveAndStart: vi.fn(), prepareParameters: async (_id, parameters) => parameters };
      const scheduler = createSchedulerService({ store, jobs, secretEnvNamesFor: async (id) => (id === "cloudflared" ? ["TUNNEL_TOKEN"] : null) });
      await expect(scheduler.create({ operationId: "app.reconfigure", parameters: { id: "cloudfared", values: { env: { TUNNEL_TOKEN: "eyJ-typo-token" } } }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id }))
        .rejects.toThrow("needs a password or key each time");
      expect(JSON.stringify(store.listSchedules())).not.toContain("eyJ-typo-token");
    } finally { store.close(); }
  });
});

describe("a schedule stored before its secret was refused", () => {
  it("is paused rather than run, whether the secret is top-level or an app's own", async () => {
    // The pause checked only top-level fields, so a schedule holding an app's token in values.env
    // kept running from the database it should never have been written to.
    const { store, owner } = await setup({ now: () => new Date("2026-08-20T10:30:00.000Z") });
    try {
      const jobs = { createOperationJob: vi.fn(), approveAndStart: vi.fn() };
      const catalog = async (id) => { if (id === "broken") throw new Error("catalog unreadable"); return id === "cloudflared" ? ["TUNNEL_TOKEN"] : []; };
      const scheduler = createSchedulerService({ store, jobs, secretEnvNamesFor: catalog, now: () => new Date("2026-08-20T10:30:00.000Z") });
      const stored = (operationId, parameters) => store.createSchedule({ operationId, parameters, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id, nextDueAt: "2026-08-20T03:00:00.000Z" });
      const share = stored("share.mount", { kind: "smb", host: "nas", share: "Public", name: "nas", username: "jamie", password: "hunter2 hunter2" });
      const app = stored("app.reconfigure", { id: "cloudflared", values: { env: { TUNNEL_TOKEN: "eyJ-legacy-token" } } });
      const unreadable = stored("app.reconfigure", { id: "broken", values: { env: { SETTING: "x" } } });
      await scheduler.tick();
      for (const schedule of [share, app]) {
        expect(store.getSchedule(schedule.id)).toMatchObject({ enabled: false, lastResult: expect.stringMatching(/^paused/) });
      }
      // A catalog that cannot be read skips the run and leaves the schedule as it was.
      expect(store.getSchedule(unreadable.id)).toMatchObject({ enabled: true, lastResult: "error: catalog unreadable" });
      expect(jobs.createOperationJob).not.toHaveBeenCalled();
    } finally { store.close(); }
  });
});

describe("next runs across a daylight-saving change", () => {
  // Pinned to a zone with DST so the transitions are the same wherever the tests run. Node picks
  // up a change to process.env.TZ for every Date created afterwards.
  let previousZone;
  const zone = "America/New_York"; // 2026: clocks go forward on 8 March and back on 1 November
  const withZone = (test) => () => {
    previousZone = process.env.TZ;
    process.env.TZ = zone;
    try { return test(); } finally { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; }
  };

  it("runs a daily schedule at its own time the day after the clocks go forward", withZone(() => {
    // 02:30 does not exist on 8 March; that day's candidate became 03:30, and adding a day kept the
    // 03:30 instead of going back to 02:30.
    const from = new Date("2026-03-08T08:00:00.000Z"); // 04:00 EDT on the day of the change
    expect(computeNextRun({ frequency: "daily", minute: 30, hour: 2 }, from).toISOString()).toBe("2026-03-09T06:30:00.000Z"); // 02:30 EDT
  }));

  it("runs a weekly schedule at its own time the week after the clocks go forward", withZone(() => {
    const from = new Date("2026-03-08T08:00:00.000Z"); // Sunday 04:00 EDT
    expect(computeNextRun({ frequency: "weekly", minute: 30, hour: 2, weekday: 0 }, from).toISOString()).toBe("2026-03-15T06:30:00.000Z"); // Sunday 02:30 EDT
  }));

  it("runs an hourly schedule in the repeated hour when the clocks go back", withZone(() => {
    // Adding one to the local hour jumped from the first 01:50 straight to 02:15, skipping 01:15 EST.
    const from = new Date("2026-11-01T05:50:00.000Z"); // 01:50 EDT, before the clocks go back
    expect(computeNextRun({ frequency: "hourly", minute: 15 }, from).toISOString()).toBe("2026-11-01T06:15:00.000Z"); // 01:15 EST
    // And an ordinary hour, and the hour the clocks skip in spring, still come out right.
    expect(computeNextRun({ frequency: "hourly", minute: 15 }, new Date("2026-11-01T07:20:00.000Z")).toISOString()).toBe("2026-11-01T08:15:00.000Z");
    expect(computeNextRun({ frequency: "hourly", minute: 15 }, new Date("2026-03-08T06:50:00.000Z")).toISOString()).toBe("2026-03-08T07:15:00.000Z"); // 03:15 EDT
  }));

  it("keeps daily and weekly runs on the wall-clock time across the autumn change", withZone(() => {
    const from = new Date("2026-10-31T12:00:00.000Z"); // Saturday 08:00 EDT
    expect(computeNextRun({ frequency: "daily", minute: 0, hour: 3 }, from).toISOString()).toBe("2026-11-01T08:00:00.000Z"); // 03:00 EST
    expect(computeNextRun({ frequency: "weekly", minute: 0, hour: 4, weekday: 1 }, from).toISOString()).toBe("2026-11-02T09:00:00.000Z"); // Monday 04:00 EST
  }));
});
