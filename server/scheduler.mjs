import { registry as defaultRegistry } from "./ops/index.mjs";

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

export function createSchedulerService({ store, jobs, registry = defaultRegistry, now = () => new Date() }) {
  function create({ operationId, parameters = {}, frequency, minute, hour = null, weekday = null, createdBy }) {
    const operation = registry.get(operationId);
    if (!operation) throw new Error("Operation is not registered");
    if (operation.readOnly) throw new Error("Read-only operations run on demand; they are not scheduled");
    if (operation.risk === "high") throw new Error(`${operation.title} is high risk and cannot run unattended`);
    const parameterError = registry.validate(operationId, parameters ?? {});
    if (parameterError) throw new Error(parameterError);
    const cadenceError = validateCadence({ frequency, minute, hour, weekday });
    if (cadenceError) throw new Error(cadenceError);
    const nextDueAt = computeNextRun({ frequency, minute, hour, weekday }, now()).toISOString();
    return store.createSchedule({ operationId, parameters, frequency, minute, hour: frequency === "hourly" ? null : hour, weekday: frequency === "weekly" ? weekday : null, createdBy, nextDueAt });
  }

  function list() {
    return store.listSchedules().map((schedule) => ({ ...schedule, title: registry.get(schedule.operationId)?.title ?? schedule.operationId, cadence: describeCadence(schedule) }));
  }

  function setEnabled(id, enabled, actorId) {
    const schedule = store.getSchedule(id);
    if (!schedule) throw new Error("Schedule not found");
    // Re-enabled schedules start from the next occurrence, not a backlog of missed runs.
    const nextDueAt = enabled ? computeNextRun(schedule, now()).toISOString() : null;
    return store.setScheduleEnabled(id, enabled, { actorId, nextDueAt });
  }

  function remove(id, actorId) {
    return store.deleteSchedule(id, { actorId });
  }

  /** Run everything due. Failures advance the schedule and are recorded — never retried in a loop. */
  async function tick() {
    const due = store.listDueSchedules(now().toISOString());
    for (const schedule of due) {
      const nextDueAt = computeNextRun(schedule, now()).toISOString();
      try {
        const job = jobs.createOperationJob(schedule.operationId, schedule.parameters ?? {}, schedule.createdBy);
        await jobs.approveAndStart(job.id, schedule.createdBy, {});
        store.markScheduleRun(schedule.id, { jobId: job.id, result: "started", nextDueAt });
        store.recordAudit("schedule.run", { actorId: schedule.createdBy, subjectId: schedule.id, details: { operationId: schedule.operationId, jobId: job.id } });
      } catch (error) {
        const blocked = /reauthentication/i.test(error.message);
        store.markScheduleRun(schedule.id, { jobId: null, result: blocked ? "blocked-by-approval-mode" : `error: ${error.message}`.slice(0, 200), nextDueAt });
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
