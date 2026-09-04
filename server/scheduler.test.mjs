import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeNextRun, createSchedulerService, describeCadence, validateCadence, chooseQuietSlot } from "./scheduler.mjs";
import { createStateStore } from "./state.mjs";

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
  return { store, jobs, scheduler, owner };
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
    const { scheduler, owner } = await setup();
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
    jobs.approveAndStart.mockRejectedValueOnce(new Error("Approval reauthentication required: medium-risk job needs the owner password"));
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
