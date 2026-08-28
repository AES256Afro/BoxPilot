/**
 * The "behind" detector for scheduled tasks (M20.1).
 *
 * A backup you set up and forgot is only a backup if it keeps running. The scheduler advances a
 * schedule's next-due time every time it runs it (on success or failure), so a healthy schedule's
 * next-due time is always in the future. If it slips more than a whole interval into the past, the
 * scheduler has skipped an entire cycle — the box was off for a long time, or the scheduler stopped —
 * and a quietly-dead nightly mirror should be loud, not silent.
 *
 * Pure and clock-injected so it can be checked without waiting on wall-clock time.
 */

const INTERVAL_MS = { hourly: 60 * 60 * 1000, daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };

/** How long one cycle of a frequency is, in ms; unknown frequencies fall back to a day. */
export function scheduleIntervalMs(frequency) {
  return INTERVAL_MS[frequency] ?? INTERVAL_MS.daily;
}

/** A rough, friendly "2 days" / "5 hours" / "40 minutes" for how long something has been overdue. */
export function describeOverdue(ms) {
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 1.5) return `${Math.round(hours)} hours`;
  return `${Math.max(1, Math.round(ms / (60 * 1000)))} minutes`;
}

/**
 * Alerts for enabled schedules that have slipped more than a full interval past their due time.
 * `titleFor(schedule)` turns a schedule into a human label (defaults to its operation id).
 * Returns the same alert shape health checks use: { key, priority, title, message }.
 */
export function evaluateScheduleFreshness(schedules, { now, titleFor = (schedule) => schedule.operationId } = {}) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const alerts = [];
  for (const schedule of schedules ?? []) {
    if (!schedule?.enabled || typeof schedule.nextDueAt !== "string") continue;
    const due = Date.parse(schedule.nextDueAt);
    if (!Number.isFinite(due)) continue;
    const overdueMs = at - due;
    if (overdueMs <= scheduleIntervalMs(schedule.frequency)) continue;
    const label = titleFor(schedule) || schedule.operationId;
    alerts.push({
      key: `schedule.overdue:${schedule.id}`,
      priority: "default",
      title: `Scheduled task overdue: ${label}`,
      message: `"${label}" was due ${describeOverdue(overdueMs)} ago and has not run since. If this is a backup, it has stopped protecting you. Check it on the Automations page — the server may have been off, or the task may be failing every time.`,
    });
  }
  return alerts;
}

/** The subset of schedules that are behind right now (for the UI to badge). */
export function overdueScheduleIds(schedules, { now } = {}) {
  const at = now instanceof Date ? now.getTime() : Number(now ?? Date.now());
  const behind = new Set();
  for (const schedule of schedules ?? []) {
    if (!schedule?.enabled || typeof schedule.nextDueAt !== "string") continue;
    const due = Date.parse(schedule.nextDueAt);
    if (Number.isFinite(due) && at - due > scheduleIntervalMs(schedule.frequency)) behind.add(schedule.id);
  }
  return behind;
}
