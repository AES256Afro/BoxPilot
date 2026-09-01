import { registry as defaultRegistry } from "./ops/index.mjs";
import { secretFields } from "./ops/registry.mjs";
import { overdueScheduleIds } from "./schedule-freshness.mjs";

/**
 * Operation scheduler (M6.1): runs registered low/medium-risk operations on a cadence,
 * approved as the owner who created the schedule. High-risk operations cannot be scheduled,
 * and while approvals are set to "Always ask" due runs are skipped and recorded, not forced.
 */

export const frequencies = Object.freeze(["hourly", "daily", "weekly"]);

/** Next local-time occurrence strictly after `from`. Weekday: 0 = Sunday. */
export function computeNextRun({ frequency, minute, hour = null, weekday = null }, from) {
  const next = new Date(from.getTime());
  next.setSeconds(0, 0);
  if (frequency === "hourly") {
    next.setMinutes(minute);
    if (next <= from) next.setHours(next.getHours() + 1);
    return next;
  }
  next.setHours(hour ?? 3, minute, 0, 0);
  if (frequency === "daily") {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  const targetDay = weekday ?? 0;
  next.setDate(next.getDate() + ((targetDay - next.getDay() + 7) % 7));
  if (next <= from) next.setDate(next.getDate() + 7);
  return next;
}

export function describeCadence({ frequency, minute, hour, weekday }) {
  const clock = `${String(hour ?? 0).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (frequency === "hourly") return `hourly at :${String(minute).padStart(2, "0")}`;
  if (frequency === "daily") return `daily at ${clock}`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `${days[weekday ?? 0]}s at ${clock}`;
}

export function validateCadence({ frequency, minute, hour = null, weekday = null }) {
  if (!frequencies.includes(frequency)) return `frequency must be one of ${frequencies.join(", ")}`;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return "minute must be 0-59";
  if (frequency !== "hourly" && (!Number.isInteger(hour) || hour < 0 || hour > 23)) return "hour must be 0-23";
  if (frequency === "weekly" && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) return "weekday must be 0-6 (Sunday-Saturday)";
  return null;
}

const minutesInWeek = 7 * 24 * 60;

/** Every minute of the week a schedule occupies: a daily one lands on all seven days, hourly on all. */
function occupiedMinutes(schedule) {
  const minute = schedule.minute ?? 0;
  if (schedule.frequency === "hourly") return Array.from({ length: 7 * 24 }, (_value, index) => index * 60 + minute);
  const hour = schedule.hour ?? 0;
  if (schedule.frequency === "daily") return Array.from({ length: 7 }, (_value, day) => (day * 24 + hour) * 60 + minute);
  return [((schedule.weekday ?? 0) * 24 + hour) * 60 + minute];
}

/** How far apart two minutes of the week are, going the short way round. */
function separation(left, right) {
  const gap = Math.abs(left - right) % minutesInWeek;
  return Math.min(gap, minutesInWeek - gap);
}

/**
 * Put a heavy weekly job where it will not land on top of another one.
 *
 * Restore rehearsals were all being created at Monday 03:30, so a server with eighteen apps
 * downloaded and decompressed eighteen full archives in the same minute - inside the window the
 * nightly database backup and the off-box mirror already run in. They are weekly jobs with ten
 * thousand minutes to choose from; there is no reason for them to queue up on one.
 *
 * Every candidate in the quiet hours is scored by how far it sits from the nearest thing already
 * scheduled, and the roomiest wins. Existing schedules are the only thing avoided, which means the
 * backup at 03:15 and the mirror at 04:15 are avoided for free, without naming them here and
 * without going stale when the owner moves them.
 */
export function chooseQuietSlot({ schedules = [], hours = [1, 2, 3, 4, 5], minutes = [0, 15, 30, 45], preferred = null } = {}) {
  const taken = schedules.flatMap(occupiedMinutes);
  const candidates = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (const hour of hours) for (const minute of minutes) candidates.push({ weekday, hour, minute });
  }
  // Preferring the requested slot keeps the first one where the owner asked for it, and makes the
  // choice deterministic rather than dependent on which app happened to be scheduled first.
  const wanted = preferred ? ((preferred.weekday ?? 0) * 24 + (preferred.hour ?? 0)) * 60 + (preferred.minute ?? 0) : 0;
  let best = null;
  for (const candidate of candidates) {
    const at = ((candidate.weekday * 24) + candidate.hour) * 60 + candidate.minute;
    const room = taken.length ? Math.min(...taken.map((other) => separation(at, other))) : minutesInWeek;
    const closeness = separation(at, wanted);
    if (best === null || room > best.room || (room === best.room && closeness < best.closeness)) best = { candidate, room, closeness };
  }
  return { frequency: "weekly", ...best.candidate };
}

export function createSchedulerService({ store, jobs, registry = defaultRegistry, now = () => new Date() }) {
  async function create({ operationId, parameters = {}, frequency, minute, hour = null, weekday = null, spread = false, createdBy }) {
    const operation = registry.get(operationId);
    if (!operation) throw new Error("Operation is not registered");
    if (operation.readOnly) throw new Error("Read-only operations run on demand; they are not scheduled");
    if (operation.risk === "high") throw new Error(`${operation.title} is high risk and cannot run unattended`);
    if (operation.minimumRole === "owner" && (store.findOwnerById?.(createdBy)?.role ?? "owner") !== "owner") throw new Error(`Only the owner can schedule ${operation.title}`);
    // A schedule is stored, so a credential given to it would sit in the database and in every backup.
    const secrets = secretFields(operation.parameters).filter((name) => parameters?.[name] !== undefined && parameters?.[name] !== null && parameters?.[name] !== "");
    if (secrets.length) throw new Error(`${operation.title} needs a password or key each time, so it cannot run unattended`);
    // A typed confirmation is a person promising they meant it; a schedule cannot make that promise.
    // Without this the job would be staged every tick and refused at approval every tick, forever.
    if (typeof operation.confirm === "function") throw new Error(`${operation.title} asks you to type a confirmation each time, so it cannot run on a schedule`);
    // Destination-pinning hooks supply host/provider fields at run time; validate the same way here.
    const prepared = typeof jobs.prepareParameters === "function" ? await jobs.prepareParameters(operationId, parameters ?? {}) : parameters ?? {};
    const parameterError = registry.validate(operationId, prepared);
    if (parameterError) throw new Error(parameterError);
    // `spread` means "somewhere quiet near here" rather than "exactly here": the caller is creating
    // one of many identical heavy jobs and does not care about the minute, only the night.
    if (spread && frequency === "weekly") {
      ({ minute, hour, weekday } = chooseQuietSlot({ schedules: store.listSchedules(), preferred: { weekday, hour, minute } }));
    }
    const cadenceError = validateCadence({ frequency, minute, hour, weekday });
    if (cadenceError) throw new Error(cadenceError);
    const nextDueAt = computeNextRun({ frequency, minute, hour, weekday }, now()).toISOString();
    // The same person scheduling the same operation on the same target twice is a mistake every
    // time: two backups a night means two container stops and twice the downtime, and it is easy
    // to reach by clicking "schedule everything" before the list on screen has caught up. Two
    // *accounts* each keeping their own copy is left alone — that is theirs to decide.
    const already = store.listSchedules().find((schedule) => schedule.operationId === operationId
      && schedule.createdBy === createdBy
      && JSON.stringify(schedule.parameters ?? {}) === JSON.stringify(parameters ?? {}));
    if (already) throw new Error(`${operation.title} is already scheduled ${describeCadence(already)}. Delete that one first if you want a different time.`);
    return store.createSchedule({ operationId, parameters, frequency, minute, hour: frequency === "hourly" ? null : hour, weekday: frequency === "weekly" ? weekday : null, createdBy, nextDueAt });
  }

  /** Schedules for one account (the owner sees all). Parameters are summarised, never echoed whole. */
  function list({ createdBy = null } = {}) {
    const all = store.listSchedules();
    // "Behind" means the scheduler has skipped a whole cycle: a nightly backup that stopped (M20.1).
    const behind = overdueScheduleIds(all, { now: now() });
    return all
      .filter((schedule) => !createdBy || schedule.createdBy === createdBy)
      .map((schedule) => ({ ...schedule, parameters: describeParameters(schedule.parameters), title: registry.get(schedule.operationId)?.title ?? schedule.operationId, cadence: describeCadence(schedule), overdue: behind.has(schedule.id) }));
  }

  /** What the schedule acts on, for the panel to show — the subject, not the whole parameter set. */
  function describeParameters(parameters) {
    const subject = parameters?.id ?? parameters?.name ?? parameters?.unit ?? parameters?.device ?? parameters?.share ?? null;
    return subject === null ? {} : { subject: String(subject).slice(0, 64) };
  }

  /** A schedule belongs to whoever created it; the owner may manage every schedule. */
  function assertMayManage(schedule, actorId) {
    if (!schedule) throw new Error("Schedule not found");
    const role = store.findOwnerById?.(actorId)?.role ?? "owner";
    if (schedule.createdBy !== actorId && role !== "owner") throw new Error("Schedule not found");
  }

  function setEnabled(id, enabled, actorId) {
    const schedule = store.getSchedule(id);
    assertMayManage(schedule, actorId);
    // Re-enabled schedules start from the next occurrence, not a backlog of missed runs.
    const nextDueAt = enabled ? computeNextRun(schedule, now()).toISOString() : null;
    return store.setScheduleEnabled(id, enabled, { actorId, nextDueAt });
  }

  function remove(id, actorId) {
    assertMayManage(store.getSchedule(id), actorId);
    return store.deleteSchedule(id, { actorId });
  }

  /** Run everything due. Failures advance the schedule and are recorded — never retried in a loop. */
  let running = false;
  async function tick() {
    if (running) return 0; // a slow prepare hook must not let the next tick fire the same schedule again
    running = true;
    try { return await runDue(); } finally { running = false; }
  }

  async function runDue() {
    const due = store.listDueSchedules(now().toISOString());
    for (const schedule of due) {
      // Schedules stored before credentials were refused still carry one: stop them rather than run them.
      const carried = secretFields(registry.get(schedule.operationId)?.parameters ?? {}).filter((name) => schedule.parameters?.[name]);
      if (carried.length) {
        store.setScheduleEnabled(schedule.id, false, { actorId: schedule.createdBy, nextDueAt: null });
        store.markScheduleRun(schedule.id, { jobId: schedule.lastJobId ?? null, result: "paused: it holds a password, which schedules no longer store", nextDueAt: null });
        store.recordAudit("schedule.paused", { actorId: schedule.createdBy, subjectId: schedule.id, details: { reason: "stored credential" } });
        continue;
      }
      const nextDueAt = computeNextRun(schedule, now()).toISOString();
      // Advance first so nothing fires twice; the final mark below records what happened.
      store.markScheduleRun(schedule.id, { jobId: schedule.lastJobId ?? null, result: "starting", nextDueAt });
      let job = null;
      try {
        const previous = schedule.lastJobId ? store.getJob(schedule.lastJobId) : null;
        if (previous && ["applying", "verifying"].includes(previous.state)) throw new Error("previous run still active");
        const creator = store.findOwnerById?.(schedule.createdBy) ?? null;
        if (creator && ["viewer", "disabled"].includes(creator.role)) throw new Error(`${creator.username} can no longer approve jobs`);
        const creatorRole = creator?.role ?? "owner";
        if (jobs.approvalPolicy && store.getSetting?.("approvalMode", null) === "always-password") throw new Error("Approval reauthentication required: approvals are set to always ask");
        job = await jobs.createOperationJob(schedule.operationId, schedule.parameters ?? {}, schedule.createdBy, { role: creatorRole });
        await jobs.approveAndStart(job.id, schedule.createdBy, {});
        store.markScheduleRun(schedule.id, { jobId: job.id, result: "started", nextDueAt });
        store.recordAudit("schedule.run", { actorId: schedule.createdBy, subjectId: schedule.id, details: { operationId: schedule.operationId, jobId: job.id } });
      } catch (error) {
        // A job that was staged but could not start is withdrawn rather than left awaiting approval forever.
        if (job && typeof jobs.cancelJob === "function") { try { jobs.cancelJob(job.id, schedule.createdBy, { role: "owner", reason: `Scheduled run could not start: ${error.message}`.slice(0, 200) }); } catch { /* already moved on */ } }
        const blocked = /reauthentication/i.test(error.message);
        // Keep the pointer to the last real job: it is what the "still running" guard reads next tick.
        store.markScheduleRun(schedule.id, { jobId: job?.id ?? schedule.lastJobId ?? null, result: blocked ? "blocked-by-approval-mode" : `error: ${error.message}`.slice(0, 200), nextDueAt });
        store.recordAudit("schedule.skipped", { actorId: schedule.createdBy, subjectId: schedule.id, details: { operationId: schedule.operationId, reason: blocked ? "always-password approval mode" : error.message } });
      }
    }
    return due.length;
  }

  function start(intervalMs = 60_000) {
    const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { create, list, setEnabled, remove, tick, start };
}
