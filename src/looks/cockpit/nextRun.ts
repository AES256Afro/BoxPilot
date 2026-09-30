import type { ScheduleFact } from "../../home/facts";
import { backupOperation } from "../../home/needs";

/*
 * When the next backup runs (M41's cockpit memo: "NEXT RUN 03:00"), from the schedules' own words
 * ("daily at 03:00", "Sundays at 05:00", "hourly at :15", server/scheduler.mjs describeCadence).
 * Pure: the schedules and the clock come in. Null when no enabled backup schedule says a time.
 */

const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const pad = (value: number) => String(value).padStart(2, "0");

/** The next moment a cadence runs after `now`, in this browser's time; null for words it does not know. */
export function nextOccurrence(cadence: string | null, now: number): number | null {
  if (!cadence) return null;
  const from = new Date(now);
  const hourly = /^hourly at :(\d{2})$/i.exec(cadence);
  if (hourly) {
    const next = new Date(from);
    next.setMinutes(Number(hourly[1]), 0, 0);
    if (next.getTime() <= now) next.setHours(next.getHours() + 1);
    return next.getTime();
  }
  const daily = /^daily at (\d{2}):(\d{2})$/i.exec(cadence);
  const weekly = /^([a-z]+)s at (\d{2}):(\d{2})$/i.exec(cadence);
  const weekday = weekly ? days.indexOf(weekly[1].toLowerCase()) : -1;
  if (!daily && weekday < 0) return null;
  const [hour, minute] = daily ? [Number(daily[1]), Number(daily[2])] : [Number(weekly![2]), Number(weekly![3])];
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (daily) {
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  next.setDate(next.getDate() + ((weekday - from.getDay() + 7) % 7));
  if (next.getTime() <= now) next.setDate(next.getDate() + 7);
  return next.getTime();
}

/** The soonest backup run: "03:00" within a day, "SUN 05:00" further off. */
export function nextBackupRun(schedules: ScheduleFact[] | null, now: number): { at: number; words: string } | null {
  const runs = (schedules ?? [])
    .filter((schedule) => schedule.enabled && backupOperation.test(schedule.operationId))
    .map((schedule) => nextOccurrence(schedule.cadence, now))
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b);
  const at = runs[0];
  if (at === undefined) return null;
  const when = new Date(at);
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  return { at, words: at - now < 86_400_000 ? time : `${days[when.getDay()].slice(0, 3).toUpperCase()} ${time}` };
}
