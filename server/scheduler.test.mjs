import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeNextRun, createSchedulerService, describeCadence, validateCadence, chooseQuietSlot } from "./scheduler.mjs";
import { createStateStore } from "./state.mjs";
import { createHealthAlerts } from "./health-alerts.mjs";

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
