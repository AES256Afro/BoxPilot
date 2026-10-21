/**
 * Quiet hours for pushes (M36): between two times of day, pushes wait instead of buzzing a phone at
 * 3 a.m., and one summary goes out when the quiet ends. Urgent ones (a disk failing, a drive gone, the
 * UPS running out, a failed job) still go through unless the owner holds those too.
 *
 * Times are the server's own clock (its time zone), which is the one the rest of BoxPilot shows.
 */

export const quietHoursKey = "notificationQuietHours";
export const heldKey = "notificationHeld";
export const heldLimit = 100;

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const defaults = Object.freeze({ enabled: false, start: "22:00", end: "07:00", holdHigh: false });

/** What is saved, with anything missing or unreadable at its default. */
export function normalizeQuietHours(value) {
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: saved.enabled === true,
    start: timePattern.test(saved.start ?? "") ? saved.start : defaults.start,
    end: timePattern.test(saved.end ?? "") ? saved.end : defaults.end,
    holdHigh: saved.holdHigh === true,
  };
}

/** Why a requested setting is refused, or null. */
export function quietHoursProblem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Send enabled, start, end and holdHigh";
  if (typeof input.enabled !== "boolean") return "enabled must be true or false";
  if (!timePattern.test(input.start ?? "") || !timePattern.test(input.end ?? "")) return "start and end must be times like 22:00";
  if (input.start === input.end) return "start and end must differ";
  if (input.holdHigh !== undefined && typeof input.holdHigh !== "boolean") return "holdHigh must be true or false";
  return null;
}

const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Minutes past midnight at `date` on the server's clock, or in `timeZone` when one is given. */
export function minutesIn(date, timeZone = undefined) {
  if (!timeZone) return date.getHours() * 60 + date.getMinutes();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/** Whether `date` falls inside the quiet hours; a window that passes midnight wraps. */
export function isQuiet(settings, date, timeZone = undefined) {
  const quiet = normalizeQuietHours(settings);
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  const at = minutesIn(date, timeZone);
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** Whether a push waits now: quiet, and not an urgent one the owner lets through. */
export function holds(settings, priority, date, timeZone = undefined) {
  return isQuiet(settings, date, timeZone) && (priority !== "high" || normalizeQuietHours(settings).holdHigh);
}

/** The one push that says what waited, newest last, within what a phone shows. */
export function summaryOf(held) {
  const items = Array.isArray(held) ? held : [];
  const lines = items.slice(-12).map((item) => `- ${String(item.title ?? "").replace(/^BoxPilot: /, "")}`);
  const more = items.length > 12 ? `\n…and ${items.length - 12} earlier` : "";
  return {
    title: `BoxPilot: ${items.length} notification${items.length === 1 ? "" : "s"} during quiet hours`,
    message: `${lines.join("\n")}${more}\nThe notification centre has each of them.`.slice(0, 1500),
    priority: items.some((item) => item.priority === "high") ? "high" : "default",
  };
}
