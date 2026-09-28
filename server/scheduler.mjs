import { registry as defaultRegistry } from "./ops/index.mjs";
import { secretPaths } from "./ops/registry.mjs";
import { overdueScheduleIds } from "./schedule-freshness.mjs";
import { asSentence } from "./health-alerts.mjs";
import { recordFailed } from "./jobs.mjs";

/**
 * Operation scheduler (M6.1): runs registered low/medium-risk operations on a cadence,
 * approved as the owner who created the schedule. High-risk operations cannot be scheduled,
 * and while approvals are set to "Always ask" due runs are skipped and recorded, not forced.
 */

export const frequencies = Object.freeze(["hourly", "daily", "weekly"]);

/**
 * Next local-time occurrence strictly after `from`. Weekday: 0 = Sunday.
 *
 * Across a daylight-saving change: an hourly run moves on by elapsed time, so the hour the clocks
 * repeat in autumn runs twice rather than being skipped. A daily or weekly run picks the day first
 * and only then sets the time on it; setting the time first and then moving the date carried a
 * time the spring change had shifted (02:30 -> 03:30) into every later run.
 */
export function computeNextRun({ frequency, minute, hour = null, weekday = null }, from) {
  if (frequency === "hourly") {
    const next = new Date(from.getTime());
    next.setMinutes(minute, 0, 0);
    return next <= from ? new Date(next.getTime() + 60 * 60_000) : next;
  }
  // Noon is never inside a DST transition, so moving the date from there cannot slip a day.
  const onDay = (days) => {
    const next = new Date(from.getTime());
    next.setHours(12, 0, 0, 0);
    next.setDate(next.getDate() + days);
    next.setHours(hour ?? 3, minute, 0, 0);
    return next;
  };
  const offset = frequency === "daily" ? 0 : ((weekday ?? 0) - from.getDay() + 7) % 7;
  const next = onDay(offset);
  return next <= from ? onDay(offset + (frequency === "daily" ? 1 : 7)) : next;
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

const terminalStates = new Set(["completed", "failed", "cancelled"]);

/** What a finished job means for its schedule's record: the words the Schedules panel reads. */
function endingOf(job) {
  if (job.state === "completed") return "completed";
  if (job.state === "failed") return `failed: ${job.error ?? "the job failed"}`.slice(0, 200);
  return `cancelled: ${job.error ?? "the job was withdrawn"}`.slice(0, 200);
}

/**
 * What a schedule's last run came to: ran, failed, did not run, still running, or not run yet.
 *
 * The schedule used to record only that it had started a job, so a nightly backup whose job failed
 * an hour later still read "ran". The ending is now written when the job finishes; a run recorded as
 * started before that (an older release, or an ending this process never saw) is read from its job.
 * `result` is the record's own words, `reason` the part worth showing beside the verdict.
 */
export function scheduleOutcome(schedule, job = null) {
  let result = schedule?.lastResult ?? null;
  if (result === "started" && job && job.id === schedule.lastJobId && terminalStates.has(job.state)) result = endingOf(job);
  if (!result) return { outcome: null, result: null, reason: null };
  const after = (prefix) => result.slice(prefix.length).trim() || null;
  if (result === "completed") return { outcome: "ran", result, reason: null };
  if (result === "starting") return { outcome: "running", result, reason: null };
  // Started and not yet settled: still going, or its job has since been pruned and nobody can say.
  if (result === "started") return { outcome: job && job.id === schedule.lastJobId ? "running" : "unknown", result, reason: null };
  if (result === "blocked-by-approval-mode") return { outcome: "did-not-run", result, reason: "Approvals are set to always ask" };
  for (const prefix of ["error:", "paused:", "cancelled:"]) if (result.startsWith(prefix)) return { outcome: "did-not-run", result, reason: after(prefix) };
  return { outcome: "failed", result, reason: result.startsWith("failed:") ? after("failed:") : result };
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
    // reduce rather than Math.min(...spread): `taken` grows with every hourly schedule, which
    // occupies a hundred and sixty-eight minutes of the week on its own.
    const room = taken.reduce((closest, other) => Math.min(closest, separation(at, other)), minutesInWeek);
    const closeness = separation(at, wanted);
    if (best === null || room > best.room || (room === best.room && closeness < best.closeness)) best = { candidate, room, closeness };
  }
  return { frequency: "weekly", ...best.candidate };
}

export function createSchedulerService({ store, jobs, secretEnvNamesFor = async () => [], registry = defaultRegistry, now = () => new Date(), alerts = null }) {
  // Jobs a schedule started, so their outcome is the schedule's to announce (and not also a failed-job
  // push). An entry stays after the job finishes - null once handled - so the notifier, which sees
  // the same event, can still tell the job was ours. Bounded like the notifier's own memory.
  const started = new Map();
  const remember = (jobId, scheduleId) => {
    started.set(jobId, scheduleId);
    if (started.size > 500) started.delete(started.keys().next().value);
  };
  const alertKey = (id) => `schedule.failed:${id}`;
  const label = (schedule) => {
    const subject = describeParameters(schedule.parameters).subject;
    return `${registry.get(schedule.operationId)?.title ?? schedule.operationId}${subject ? ` (${subject})` : ""}`;
  };
  /**
   * A schedule that fails every run is one announcement until it next succeeds, through the
   * health-alert ledger, and kept there as not announced when nothing can be sent.
   */
  function announce(schedule, headline, message) {
    if (!alerts) return;
    try { Promise.resolve(alerts.raise({ key: alertKey(schedule.id), title: `${headline}: ${label(schedule)}`, message, priority: "high" })).catch(() => {}); } catch { /* the schedule's own record stands */ }
  }
  function settle(scheduleId, options) {
    if (!alerts) return;
    try { Promise.resolve(alerts.clear(alertKey(scheduleId), options)).catch(() => {}); } catch { /* nothing to clear */ }
  }

  async function create({ operationId, parameters = {}, frequency, minute, hour = null, weekday = null, spread = false, createdBy }) {
    const operation = registry.get(operationId);
    if (!operation) throw new Error("Operation is not registered");
    if (operation.readOnly) throw new Error("Read-only operations run on demand; they are not scheduled");
    if (operation.risk === "high") throw new Error(`${operation.title} is high risk and cannot run unattended`);
    if (operation.minimumRole === "owner" && (store.findOwnerById?.(createdBy)?.role ?? "owner") !== "owner") throw new Error(`Only the owner can schedule ${operation.title}`);
    // A schedule is stored, so a credential given to it would sit in the database and in every
    // backup: a top-level password, or an app's token nested in values.env alike (M29.1).
    if ((await secretPaths(operation, parameters ?? {}, { secretEnvNamesFor })).length) throw new Error(`${operation.title} needs a password or key each time, so it cannot run unattended`);
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
      .map((schedule) => {
        // The job is read only while the record still says "started": for a run whose ending was written, the record is the answer.
        const { outcome, result, reason } = scheduleOutcome(schedule, schedule.lastResult === "started" && schedule.lastJobId ? store.getJob(schedule.lastJobId) : null);
        return { ...schedule, lastResult: result, lastOutcome: outcome, lastReason: reason, parameters: describeParameters(schedule.parameters), title: registry.get(schedule.operationId)?.title ?? schedule.operationId, cadence: describeCadence(schedule), overdue: behind.has(schedule.id) };
      });
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
    const removed = store.deleteSchedule(id, { actorId });
    settle(id, { quietly: true }); // deleted, not fixed: nothing to announce, and nothing left to tell
    return removed;
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
      // Schedules stored before credentials were refused still carry one: stop them rather than run
      // them. That includes an app's token in values.env, which this check once looked straight past.
      let carried;
      try {
        carried = await secretPaths(registry.get(schedule.operationId), schedule.parameters ?? {}, { secretEnvNamesFor });
      } catch (error) {
        // The catalog could not be read: skip this run rather than guess, and let the others go ahead.
        store.markScheduleRun(schedule.id, { jobId: schedule.lastJobId ?? null, result: `error: ${error.message}`.slice(0, 200), nextDueAt: computeNextRun(schedule, now()).toISOString() });
        continue;
      }
      if (carried.length) {
        store.setScheduleEnabled(schedule.id, false, { actorId: schedule.createdBy, nextDueAt: null });
        store.markScheduleRun(schedule.id, { jobId: schedule.lastJobId ?? null, result: "paused: it holds a password, which schedules no longer store", nextDueAt: null });
        store.recordAudit("schedule.paused", { actorId: schedule.createdBy, subjectId: schedule.id, details: { reason: "stored credential" } });
        announce(schedule, "Scheduled task paused", "It held a password, which schedules no longer store, so it was switched off. Create it again without the password.");
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
        if (jobs.approvalPolicy && store.getSetting?.("approvalMode", null) === "always-password") throw new Error("Enter the owner password to run this: approvals are set to always ask");
        job = await jobs.createOperationJob(schedule.operationId, schedule.parameters ?? {}, schedule.createdBy, { role: creatorRole });
        // Before it starts: a job can fail before approveAndStart has even returned.
        remember(job.id, schedule.id);
        await jobs.approveAndStart(job.id, schedule.createdBy, {});
        store.markScheduleRun(schedule.id, { jobId: job.id, result: "started", nextDueAt });
        // A job that already finished told onJob before "started" was written, so its ending found
        // nothing to replace: write it now, or the record would say started for good.
        const already = store.getJob(job.id);
        if (already && terminalStates.has(already.state)) store.settleScheduleRun?.(schedule.id, { jobId: job.id, result: endingOf(already) });
        store.recordAudit("schedule.run", { actorId: schedule.createdBy, subjectId: schedule.id, details: { operationId: schedule.operationId, jobId: job.id } });
      } catch (error) {
        // A job that was staged but could not start is withdrawn rather than left awaiting approval forever.
        if (job && typeof jobs.cancelJob === "function") { try { jobs.cancelJob(job.id, schedule.createdBy, { role: "owner", reason: `Scheduled run could not start: ${error.message}`.slice(0, 200) }); } catch { /* already moved on */ } }
        // A password-gated approval is a condition, not a sentence: test the code the job layer
        // attaches, so rewording the message for the owner cannot turn a skip into a forced run.
        const blocked = error?.code === "password_required" || error?.code === "wrong_password";
        // Keep the pointer to the last real job: it is what the "still running" guard reads next tick.
        store.markScheduleRun(schedule.id, { jobId: job?.id ?? schedule.lastJobId ?? null, result: blocked ? "blocked-by-approval-mode" : `error: ${error.message}`.slice(0, 200), nextDueAt });
        store.recordAudit("schedule.skipped", { actorId: schedule.createdBy, subjectId: schedule.id, details: { operationId: schedule.operationId, reason: blocked ? "always-password approval mode" : error.message } });
        // No job ran, so no failed job carries the news. A skip under always-ask approvals is a
        // choice the owner made, but its effect - nothing scheduled runs - is easy to miss.
        if (job) started.set(job.id, null);
        announce(schedule, "Scheduled task did not run", blocked
          ? "Approvals are set to always ask for the owner password, so scheduled tasks cannot start on their own. Change the approval mode in Settings to let them run."
          : `It could not start: ${asSentence(error.message)} It tries again at its next time.`);
      }
    }
    return due.length;
  }

  /** Job-event listener: a started run that finished decides whether the schedule is failing. */
  function onJob(job) {
    const scheduleId = started.get(job?.id);
    if (!scheduleId || !terminalStates.has(job.state)) return;
    started.set(job.id, null); // handled once; the entry stays so owns() still answers
    const schedule = store.getSchedule(scheduleId);
    if (!schedule) return;
    // The panel shows how the run ended, not only that it started (M27.2).
    store.settleScheduleRun?.(schedule.id, { jobId: job.id, result: endingOf(job) });
    if (job.state === "completed") settle(schedule.id);
    // The task ran and only saving its result failed. The job layer has already raised that as its
    // own condition, in better words; raising the schedule's too made one run two alerts. An older
    // failure of this schedule no longer describes its latest run, so it goes, without a "resolved".
    else if (job.state === "failed" && recordFailed(job)) settle(schedule.id, { quietly: true });
    else if (job.state === "failed") announce(schedule, "Scheduled task failed", `${asSentence(job.error ?? "The job failed")} The job log is in Activity.`);
  }

  /** Whether a job was started by a schedule, so its failure is announced here and not twice. */
  const owns = (jobId) => started.has(jobId);

  /**
   * Scheduled runs a BoxPilot restart cut off. They were marked failed before anything was
   * listening, so they are announced here, as their schedule's failure. Returns the job ids taken.
   */
  function recover(interrupted = []) {
    const ids = new Set(interrupted.map((job) => job.id));
    const taken = [];
    for (const schedule of store.listSchedules()) {
      if (!schedule.lastJobId || !ids.has(schedule.lastJobId)) continue;
      remember(schedule.lastJobId, null);
      taken.push(schedule.lastJobId);
      store.settleScheduleRun?.(schedule.id, { jobId: schedule.lastJobId, result: "failed: interrupted by a BoxPilot restart" });
      announce(schedule, "Scheduled task was interrupted", "BoxPilot restarted while it was running, so it is marked failed. It may still have finished on its own; check what it changed before running it again.");
    }
    return taken;
  }

  function start(intervalMs = 60_000) {
    const unsubscribe = typeof store.subscribeJobs === "function" ? store.subscribeJobs(onJob) : () => {};
    const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    timer.unref?.();
    return () => { clearInterval(timer); unsubscribe(); };
  }

  return { create, list, setEnabled, remove, tick, start, onJob, owns, recover };
}
