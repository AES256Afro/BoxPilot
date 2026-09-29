/**
 * Time and budgets for agents (M37), pure and on an injected clock. Local time is the server's own:
 * "quiet hours" and "tomorrow" mean what they mean to the person asleep in the house.
 */

export const defaultQuietHours = Object.freeze({ start: "02:00", end: "06:00" });
const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClock(value) {
  const match = hhmm.exec(String(value ?? ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Quiet hours as stored: two HH:MM times, which may wrap past midnight. Refuses anything else. */
export function normalizeQuietHours(input) {
  if (input === undefined || input === null) return { ...defaultQuietHours };
  if (typeof input !== "object" || parseClock(input.start) === null || parseClock(input.end) === null) throw Object.assign(new Error("Quiet hours are two times, like 02:00 and 06:00"), { status: 400, code: "invalid_setting", expose: true });
  if (input.start === input.end) throw Object.assign(new Error("Quiet hours must not start and end at the same time"), { status: 400, code: "invalid_setting", expose: true });
  return { start: input.start, end: input.end };
}

const minutesOf = (date) => date.getHours() * 60 + date.getMinutes();

/** Whether `now` falls in the quiet hours [start, end). */
export function inQuietHours(now, quiet = defaultQuietHours) {
  const start = parseClock(quiet.start) ?? parseClock(defaultQuietHours.start);
  const end = parseClock(quiet.end) ?? parseClock(defaultQuietHours.end);
  const at = minutesOf(now);
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** The next moment quiet hours begin, at or after `now` (now itself when they already have). */
export function nextQuietStart(now, quiet = defaultQuietHours) {
  if (inQuietHours(now, quiet)) return new Date(now);
  const start = parseClock(quiet.start);
  const next = new Date(now);
  next.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

/** Local midnight at the start of `now`'s day: where "today" begins for a budget. */
export function startOfLocalDay(now) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day;
}

/**
 * "Pause until tomorrow": until 07:00 the next morning. Paused in the small hours (before 04:00),
 * "tomorrow" is the morning that is coming, not the one after it.
 */
export function tomorrowMorning(now, hour = 7) {
  const resume = new Date(now);
  if (now.getHours() >= 4) resume.setDate(resume.getDate() + 1);
  resume.setHours(hour, 0, 0, 0);
  return resume;
}

/**
 * The first time after `after` a schedule is due. Hourly at :minute; every six hours at
 * 00/06/12/18 plus :minute; daily at hour:minute; weekly on weekday (0 = Sunday) at hour:minute.
 */
export function nextScheduledRun(schedule, after) {
  if (!schedule) return null;
  const at = new Date(after);
  at.setSeconds(0, 0);
  const candidate = new Date(at);
  if (schedule.every === "hourly") {
    candidate.setMinutes(schedule.minute);
    if (candidate <= after) candidate.setHours(candidate.getHours() + 1);
    return candidate;
  }
  if (schedule.every === "every-6-hours") {
    candidate.setMinutes(schedule.minute);
    candidate.setHours(Math.floor(candidate.getHours() / 6) * 6);
    while (candidate <= after) candidate.setHours(candidate.getHours() + 6);
    return candidate;
  }
  candidate.setHours(schedule.hour ?? 0, schedule.minute, 0, 0);
  if (schedule.every === "daily") {
    if (candidate <= after) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }
  if (schedule.every === "weekly") {
    const ahead = ((schedule.weekday ?? 0) - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + ahead);
    if (candidate <= after) candidate.setDate(candidate.getDate() + 7);
    return candidate;
  }
  return null;
}

/**
 * What an agent may still spend today, from its runs since local midnight: runs started, model
 * milliseconds used. `refusal` says why a new run would be refused, or null.
 */
export function budgetState(budget, used) {
  const runsLeft = Math.max(0, budget.runsPerDay - (used.runs ?? 0));
  const modelMsLeft = Math.max(0, budget.modelSecondsPerDay * 1000 - (used.modelMs ?? 0));
  const refusal = runsLeft === 0 ? `It has used its ${budget.runsPerDay} runs for today`
    : modelMsLeft === 0 ? `It has used its ${Math.round(budget.modelSecondsPerDay / 60)} minutes of model time for today` : null;
  return { runsUsed: used.runs ?? 0, runsLeft, modelMsUsed: used.modelMs ?? 0, modelMsLeft, tokensUsed: used.tokens ?? 0, refusal };
}

/**
 * A token bucket: `take()` answers whether one more is allowed now. Used for the runner's API and
 * for how often a person may ask, so neither can flood the web process.
 */
export function createRateLimit({ capacity, refillPerSecond, now = () => Date.now() }) {
  const buckets = new Map();
  return {
    take(key = "") {
      const at = now();
      const bucket = buckets.get(key) ?? { tokens: capacity, at };
      bucket.tokens = Math.min(capacity, bucket.tokens + ((at - bucket.at) / 1000) * refillPerSecond);
      bucket.at = at;
      const allowed = bucket.tokens >= 1;
      if (allowed) bucket.tokens -= 1;
      buckets.set(key, bucket);
      if (buckets.size > 500) buckets.delete(buckets.keys().next().value);
      return allowed;
    },
  };
}
