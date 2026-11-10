import { describe, expect, it } from "vitest";
import type { AgentSummary, Run } from "../agents/api";
import type { Flow } from "./flows";
import type { Schedule } from "./SchedulesPanel";
import {
  browserClock, cellCount, clockIn, clockWords, defaultRunMs, durationWords, jobsFromAgents, jobsFromFlows, jobsFromSchedules, lastRunWords,
  movedCadence, nightOf, planTonight, verdictOf, type Clock, type JobTimes, type LastRun, type PlannedJob,
} from "./tonight";

// Every time here is an instant and a named zone's clock, so the tests read the same wherever they run.
const utc = clockIn("Etc/UTC") as Clock;
const at = (iso: string) => Date.parse(iso);
/** Tuesday evening, eight minutes before the night begins. */
const now = at("2026-11-10T19:52:00Z");
const minutes = (count: number) => count * 60_000;
const took = (count: number, failed = false): LastRun => ({ known: "took", ms: minutes(count), failed });

let counter = 0;
const job = (name: string, nextAt: string, last: LastRun = { known: "never" }, more: Partial<PlannedJob> = {}): PlannedJob => {
  counter += 1;
  return { id: `schedule:${counter}`, kind: "schedule", name, enabled: true, nextAt, last, ...more };
};
const plan = (jobs: PlannedJob[], more: Partial<Parameters<typeof planTonight>[0]> = {}) => planTonight({ jobs, quiet: null, now, clock: utc, ...more });
/** Column 0 is 20:00, so 02:00 is column 12. */
const column = (time: string) => { const [hour, minute] = time.split(":").map(Number); return (((hour + 4) % 24) * 60 + minute) / 30; };

describe("the night", () => {
  it("is the coming one by day and the one under way from 20:00 to 08:00", () => {
    const tonight = { start: at("2026-11-10T20:00:00Z"), end: at("2026-11-11T08:00:00Z") };
    expect(nightOf(at("2026-11-10T09:15:30Z"), utc)).toEqual(tonight);
    expect(nightOf(now, utc)).toEqual(tonight);
    expect(nightOf(at("2026-11-10T20:00:00Z"), utc)).toEqual(tonight);
    expect(nightOf(at("2026-11-10T23:10:00Z"), utc)).toEqual(tonight);
    expect(nightOf(at("2026-11-11T03:00:00Z"), utc)).toEqual(tonight);
    expect(nightOf(at("2026-11-11T07:59:59Z"), utc)).toEqual(tonight);
    // At 08:00 it is over, and the next one is shown.
    expect(nightOf(at("2026-11-11T08:00:00Z"), utc).start).toBe(at("2026-11-11T20:00:00Z"));
  });

  it("is the server's night, on the server's clock", () => {
    const berlin = clockIn("Europe/Berlin") as Clock;
    const night = planTonight({ jobs: [job("Backup", "2026-11-11T02:00:00Z", took(14))], quiet: null, now: at("2026-11-10T12:00:00Z"), clock: berlin });
    expect(night.start).toBe(at("2026-11-10T19:00:00Z")); // 20:00 in Berlin
    expect(night.columns).toHaveLength(cellCount);
    expect(night.columns[0].label).toBe("20:00");
    expect(night.columns[23].label).toBe("07:30");
    expect(night.hours.map((hour) => hour.label)).toEqual(["20", "21", "22", "23", "00", "01", "02", "03", "04", "05", "06", "07"]);
    // 02:00 UTC is 03:00 there.
    expect(night.rows[0].startsLabel).toBe("03:00");
    expect(night.rows[0].cells[column("03:00")]?.label).toBe("03:00 to 03:14");
  });

  it("labels each column from its own instant, so the night the clocks change still reads true", () => {
    const berlin = clockIn("Europe/Berlin") as Clock;
    // 27 to 28 March 2027: 02:00 becomes 03:00 in Berlin.
    const night = planTonight({ jobs: [], quiet: null, now: at("2027-03-27T15:00:00Z"), clock: berlin });
    const labels = night.columns.map((entry) => entry.label);
    expect(labels[0]).toBe("20:00");
    expect(labels.slice(10, 14)).toEqual(["01:00", "01:30", "03:00", "03:30"]);
    expect(labels.some((label) => label.startsWith("02:"))).toBe(false);
    expect(labels[23]).toBe("08:30");
  });

  it("knows no clock for a zone the browser cannot name, and has the browser's own to fall back on", () => {
    expect(clockIn(null)).toBeNull();
    expect(clockIn("Not/AZone")).toBeNull();
    expect(clockWords(browserClock(now))).toMatch(/^\d\d:\d\d$/);
  });
});

describe("the rows", () => {
  it("has none when nothing is due, and says so without calling it good or bad", () => {
    const night = plan([]);
    expect(night.rows).toEqual([]);
    expect(night.overlaps).toEqual([]);
    expect(night.first).toBeNull();
    expect(night.last).toBeNull();
    expect(night.quiet).toBeNull();
    expect(verdictOf(night, false)).toEqual({ status: "neutral", label: "Nothing is due tonight" });
  });

  it("places one job in the half hour it starts in, as long as its last run took", () => {
    const night = plan([job("App backups", "2026-11-11T02:00:00Z", took(14))]);
    expect(night.rows).toHaveLength(1);
    const [row] = night.rows;
    expect(row.startsLabel).toBe("02:00");
    expect(row.cells).toHaveLength(cellCount);
    expect(row.cells[column("02:00")]).toEqual({ kind: "planned", from: 0, to: 14 / 30, label: "02:00 to 02:14" });
    expect(row.cells.filter(Boolean)).toHaveLength(1);
    expect(row.ranLong).toBe(false);
    expect(row.clashes).toBe(false);
    expect([night.first, night.last]).toEqual(["02:00", "02:00"]);
    expect(verdictOf(night, false)).toEqual({ status: "good", label: "Nothing overlaps tonight" });
  });

  it("starts a cell part-way for a job that starts part-way through the half hour", () => {
    const cell = plan([job("Machine snapshot", "2026-11-11T02:20:00Z", took(5))]).rows[0].cells[column("02:00")];
    expect(cell?.from).toBeCloseTo(20 / 30);
    expect(cell?.to).toBeCloseTo(25 / 30);
    expect(cell?.label).toBe("02:20 to 02:25");
  });

  it("draws a job that has never run at its start, without hatching what no run did", () => {
    const [row] = plan([job("New thing", "2026-11-11T02:25:00Z")]).rows;
    const cell = row.cells[column("02:00")];
    expect(cell?.kind).toBe("planned");
    expect(cell?.label).toBe("starts 02:25");
    expect(cell?.to).toBe(1); // ten minutes from 02:25 would leave the cell; nothing is drawn beyond it
    expect(row.cells[column("02:30")]).toBeNull();
    expect(row.ranLong).toBe(false);
  });

  it("hatches the cells a job's last run spilled into", () => {
    const [row] = plan([job("Copy off this server", "2026-11-11T02:30:00Z", took(41))]).rows;
    expect(row.cells[column("02:30")]).toEqual({ kind: "planned", from: 0, to: 1, label: "02:30 to 03:11" });
    expect(row.cells[column("03:00")]?.kind).toBe("spill");
    expect(row.cells[column("03:00")]?.to).toBeCloseTo(11 / 30);
    expect(row.cells[column("03:00")]?.label).toBe("its last run went on until 03:11");
    expect(row.cells[column("03:30")]).toBeNull();
    expect(row.ranLong).toBe(true);
  });

  it("treats a length that is not a time as no length, and still draws the row", () => {
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, -5000]) {
      const [row] = plan([job("Odd", "2026-11-11T02:00:00Z", { known: "took", ms, failed: false })]).rows;
      expect(row.cells[column("02:00")]).toEqual({ kind: "planned", from: 0, to: 1 / 3, label: "starts 02:00" });
      expect(lastRunWords(row.last)).toBe("length not known");
    }
  });

  it("follows a job across midnight", () => {
    const [row] = plan([job("Late copy", "2026-11-10T23:50:00Z", took(25))]).rows;
    expect(row.startsLabel).toBe("23:50");
    expect(row.cells[column("23:30")]?.label).toBe("23:50 to 00:15");
    expect(row.cells[column("23:30")]?.from).toBeCloseTo(20 / 30);
    expect(row.cells[column("00:00")]).toEqual({ kind: "spill", from: 0, to: 0.5, label: "its last run went on until 00:15" });
  });

  it("leaves out a paused schedule, and one whose next run is outside the night", () => {
    const night = plan([
      job("Paused", "2026-11-11T02:00:00Z", took(5), { enabled: false }),
      job("This afternoon", "2026-11-10T15:00:00Z"),
      job("Tomorrow evening", "2026-11-11T21:00:00Z"),
      job("At eight exactly", "2026-11-11T08:00:00Z"),
      job("No time", "not a date"),
      job("Kept", "2026-11-10T20:00:00Z"),
    ]);
    expect(night.rows.map((row) => row.name)).toEqual(["Kept"]);
  });

  it("orders the rows by when they start", () => {
    const night = plan([job("Third", "2026-11-11T05:30:00Z"), job("First", "2026-11-10T22:00:00Z"), job("Second", "2026-11-11T02:00:00Z")]);
    expect(night.rows.map((row) => row.name)).toEqual(["First", "Second", "Third"]);
    expect([night.first, night.last]).toEqual(["22:00", "05:30"]);
  });

  it("repeats an hourly job through the night from the server's next run", () => {
    const [row] = plan([job("Refresh", "2026-11-10T14:17:00Z", took(2), { everyMinutes: 60 })]).rows;
    expect(row.starts).toHaveLength(12);
    expect(row.starts[0]).toBe(at("2026-11-10T20:17:00Z"));
    expect(row.starts[11]).toBe(at("2026-11-11T07:17:00Z"));
    expect(row.startsLabel).toBe("20:17, then hourly");
    expect(row.cells.filter(Boolean)).toHaveLength(12);
  });

  it("draws an agent's run as queued, with what it waits for", () => {
    const [row] = plan([job("Server Keeper", "2026-11-11T05:30:00Z", took(9), { kind: "agent", note: "waits for the agents' quiet hours, 22:00 to 07:00" })]).rows;
    expect(row.cells[column("05:30")]).toEqual({ kind: "queued", from: 0, to: 0.3, label: "05:30 to 05:39, queued then, waits for the agents' quiet hours, 22:00 to 07:00" });
    const [fresh] = plan([job("New agent", "2026-11-11T05:30:00Z", { known: "never" }, { kind: "agent" })]).rows;
    expect(fresh.cells[column("05:30")]?.label).toBe("queued at 05:30");
  });
});

describe("overlaps", () => {
  it("finds two jobs that overlap because the first one's last run was long", () => {
    const night = plan([
      job("Security updates", "2026-11-11T03:00:00Z", took(18)),
      job("Copy off this server", "2026-11-11T02:30:00Z", took(41)),
    ]);
    expect(night.overlaps).toHaveLength(1);
    const [overlap] = night.overlaps;
    expect(overlap.earlier.name).toBe("Copy off this server");
    expect(overlap.later.name).toBe("Security updates");
    expect(overlap.atLabel).toBe("03:00");
    expect(overlap.earlierAtLabel).toBe("02:30");
    expect(overlap.earlierTookMs).toBe(minutes(41));
    expect(overlap.times).toBe(1);
    // The first half hour after 03:11 with room for eighteen minutes.
    expect(overlap.move).toEqual({ at: at("2026-11-11T03:30:00Z"), label: "03:30", deltaMinutes: 30 });
    expect(night.rows.map((row) => row.clashes)).toEqual([true, true]);
    const start = night.rows[1].cells[column("03:00")];
    expect(start?.clash).toBe(true);
    expect(start?.label).toBe("03:00 to 03:18, while Copy off this server is still running");
    expect(verdictOf(night, false)).toEqual({ status: "warning", label: "Two jobs will run into each other at 03:00" });
  });

  it("does not call two jobs in the same half hour an overlap when the first is done before the second starts", () => {
    const night = plan([job("App backups", "2026-11-11T02:00:00Z", took(14)), job("Machine snapshot", "2026-11-11T02:20:00Z", took(5))]);
    expect(night.overlaps).toEqual([]);
    // Both are drawn in the 02:00 column, each in its own part of it.
    expect(night.rows[0].cells[column("02:00")]?.to).toBeCloseTo(14 / 30);
    expect(night.rows[1].cells[column("02:00")]?.from).toBeCloseTo(20 / 30);
    expect(verdictOf(night, false).status).toBe("good");
  });

  it("gives a job with no run to measure ten minutes, so two starting together are caught", () => {
    expect(defaultRunMs).toBe(minutes(10));
    const close = plan([job("One", "2026-11-11T02:00:00Z"), job("Two", "2026-11-11T02:05:00Z")]);
    expect(close.overlaps.map((overlap) => [overlap.earlier.name, overlap.later.name, overlap.atLabel, overlap.earlierTookMs])).toEqual([["One", "Two", "02:05", null]]);
    // A two-minute last run still gets the ten.
    expect(plan([job("One", "2026-11-11T02:00:00Z", took(2)), job("Two", "2026-11-11T02:05:00Z")]).overlaps).toHaveLength(1);
    expect(plan([job("One", "2026-11-11T02:00:00Z"), job("Two", "2026-11-11T02:11:00Z")]).overlaps).toEqual([]);
  });

  it("counts a start at the very moment the other's last run ended", () => {
    expect(plan([job("One", "2026-11-11T02:00:00Z", took(30)), job("Two", "2026-11-11T02:30:00Z")]).overlaps).toHaveLength(1);
    expect(plan([job("One", "2026-11-11T02:00:00Z", took(30)), job("Two", "2026-11-11T02:31:00Z")]).overlaps).toEqual([]);
  });

  it("reports two jobs with the same start once", () => {
    const night = plan([job("Beta", "2026-11-11T03:00:00Z", took(5)), job("Alpha", "2026-11-11T03:00:00Z", took(5))]);
    expect(night.overlaps).toHaveLength(1);
    expect([night.overlaps[0].earlier.name, night.overlaps[0].later.name, night.overlaps[0].atLabel]).toEqual(["Alpha", "Beta", "03:00"]);
  });

  it("reports each pair once, earliest first", () => {
    const night = plan([
      job("Long", "2026-11-11T02:00:00Z", took(120)),
      job("Middle", "2026-11-11T02:30:00Z", took(45)),
      job("Short", "2026-11-11T03:00:00Z", took(1)),
      job("Clear", "2026-11-11T05:00:00Z", took(1)),
    ]);
    expect(night.overlaps.map((overlap) => `${overlap.earlier.name}+${overlap.later.name}@${overlap.atLabel}`)).toEqual(["Long+Middle@02:30", "Long+Short@03:00", "Middle+Short@03:00"]);
    expect(night.rows.map((row) => row.clashes)).toEqual([true, true, true, false]);
    expect(verdictOf(night, false)).toEqual({ status: "warning", label: "3 pairs of jobs will run into each other, the first at 02:30" });
  });

  it("counts an hourly job meeting a long one as one overlap, however many times they meet, and offers no single move for it", () => {
    const night = plan([job("Big copy", "2026-11-11T03:00:00Z", took(90)), job("Refresh", "2026-11-10T14:17:00Z", took(2), { everyMinutes: 60 })]);
    expect(night.overlaps).toHaveLength(1);
    expect(night.overlaps[0].later.name).toBe("Refresh");
    expect(night.overlaps[0].atLabel).toBe("03:17");
    expect(night.overlaps[0].times).toBe(2);
    expect(night.overlaps[0].move).toBeNull();
  });

  it("does not set a job against its own next run", () => {
    expect(plan([job("Slow refresh", "2026-11-10T14:17:00Z", took(75), { everyMinutes: 60 })]).overlaps).toEqual([]);
  });

  it("moves the later job past whatever else is in the way", () => {
    const night = plan([
      job("Copy", "2026-11-11T02:30:00Z", took(41)),
      job("Updates", "2026-11-11T03:00:00Z", took(18)),
      job("Snapshot", "2026-11-11T03:40:00Z", took(5)), // 03:30 plus eighteen minutes would run into this
    ]);
    expect(night.overlaps[0].move?.label).toBe("04:00");
    expect(night.overlaps[0].move?.deltaMinutes).toBe(60);
  });

  it("offers no move when the rest of the night has no free half hour", () => {
    const night = plan([job("All night", "2026-11-10T20:00:00Z", took(12 * 60)), job("Updates", "2026-11-11T03:00:00Z", took(18))]);
    expect(night.overlaps).toHaveLength(1);
    expect(night.overlaps[0].move).toBeNull();
  });

  it("is not read when anything it stands on was not read, whatever the rows say", () => {
    const night = plan([job("App backups", "2026-11-11T02:00:00Z", took(14))]);
    expect(verdictOf(night, true)).toEqual({ status: "unknown", label: "Not read" });
    expect(verdictOf(null, false)).toEqual({ status: "unknown", label: "Not read" });
  });
});

describe("quiet hours", () => {
  it("covers the half hours of a window that passes midnight", () => {
    const quiet = plan([], { quiet: { enabled: true, start: "22:00", end: "07:00", holdHigh: false, held: 3 } }).quiet;
    expect(quiet?.start).toBe("22:00");
    expect(quiet?.end).toBe("07:00");
    expect(quiet?.held).toBe(3);
    const covered = quiet?.cells.map((cell) => Boolean(cell));
    expect(covered?.slice(0, column("22:00"))).toEqual([false, false, false, false]);
    expect(covered?.slice(column("22:00"), column("07:00")).every(Boolean)).toBe(true);
    expect(covered?.slice(column("07:00"))).toEqual([false, false]);
    // Said once, on the first cell.
    expect(quiet?.cells.filter((cell) => cell?.label).map((cell) => cell?.label)).toEqual(["quiet from 22:00 to 07:00"]);
    expect(quiet?.cells[column("22:00")]).toEqual({ from: 0, to: 1, label: "quiet from 22:00 to 07:00" });
  });

  it("covers part of a half hour when the quiet starts or ends inside it", () => {
    const quiet = plan([], { quiet: { enabled: true, start: "22:15", end: "06:45" } }).quiet;
    expect(quiet?.cells[column("22:00")]).toEqual({ from: 0.5, to: 1, label: "quiet from 22:15 to 06:45" });
    expect(quiet?.cells[column("06:30")]).toEqual({ from: 0, to: 0.5, label: null });
    expect(quiet?.cells[column("07:00")]).toBeNull();
    expect(quiet?.held).toBe(0);
  });

  it("covers a window inside the small hours", () => {
    const covered = plan([], { quiet: { enabled: true, start: "01:00", end: "05:00" } }).quiet?.cells.map((cell) => Boolean(cell));
    expect(covered?.indexOf(true)).toBe(column("01:00"));
    expect(covered?.lastIndexOf(true)).toBe(column("04:30"));
  });

  it("has no row when the quiet hours are off, unread or not times", () => {
    expect(plan([], { quiet: { enabled: false, start: "22:00", end: "07:00" } }).quiet).toBeNull();
    expect(plan([], { quiet: null }).quiet).toBeNull();
    expect(plan([], { quiet: { enabled: true, start: "late", end: "07:00" } }).quiet).toBeNull();
    expect(plan([], { quiet: { enabled: true, start: "22:00", end: "99:99" } }).quiet).toBeNull();
  });

  it("is laid on the server's clock", () => {
    const berlin = clockIn("Europe/Berlin") as Clock;
    const night = planTonight({ jobs: [], quiet: { enabled: true, start: "22:00", end: "07:00" }, now: at("2026-11-10T12:00:00Z"), clock: berlin });
    expect(night.columns[night.quiet?.cells.findIndex(Boolean) ?? -1].label).toBe("22:00");
  });
});

describe("moving a cadence", () => {
  it("adds the minutes to the hour and minute the schedule is kept in", () => {
    expect(movedCadence({ frequency: "daily", hour: 3, minute: 0, weekday: null }, 60)).toEqual({ frequency: "daily", hour: 4, minute: 0, weekday: null });
    expect(movedCadence({ frequency: "daily", hour: 3, minute: 15, weekday: null }, 45)).toEqual({ frequency: "daily", hour: 4, minute: 0, weekday: null });
    expect(movedCadence({ frequency: "daily", hour: 23, minute: 30, weekday: null }, 60)).toEqual({ frequency: "daily", hour: 0, minute: 30, weekday: null });
  });

  it("takes a weekly one to the next weekday when the move passes midnight", () => {
    expect(movedCadence({ frequency: "weekly", hour: 23, minute: 30, weekday: 6 }, 60)).toEqual({ frequency: "weekly", hour: 0, minute: 30, weekday: 0 });
    expect(movedCadence({ frequency: "weekly", hour: 3, minute: 0, weekday: 2 }, 30)).toEqual({ frequency: "weekly", hour: 3, minute: 30, weekday: 2 });
    expect(movedCadence({ frequency: "weekly", hour: 0, minute: 10, weekday: 0 }, -30)).toEqual({ frequency: "weekly", hour: 23, minute: 40, weekday: 6 });
  });
});

describe("the words", () => {
  it("says how long a run took", () => {
    expect(durationWords(20_000)).toBe("under a minute");
    expect(durationWords(minutes(41) + 20_000)).toBe("41 min");
    expect(durationWords(minutes(60))).toBe("1 h");
    expect(durationWords(minutes(72))).toBe("1 h 12 min");
  });

  it("says what is known of the last run, and what is not", () => {
    expect(lastRunWords(took(41))).toBe("41 min");
    expect(lastRunWords(took(2, true))).toBe("failed after 2 min");
    expect(lastRunWords({ known: "never" })).toBe("not run yet");
    expect(lastRunWords({ known: "running" })).toBe("running now");
    expect(lastRunWords({ known: "unknown" })).toBe("length not known");
    expect(lastRunWords({ known: "unread" })).toBe("not read");
  });
});

describe("from the page's lists", () => {
  const history = (...jobs: JobTimes[]) => new Map(jobs.map((entry) => [entry.id, entry]));
  const schedule: Schedule = {
    id: "s1", operationId: "backup.remote.sync", parameters: {}, frequency: "daily", minute: 30, hour: 2, weekday: null, enabled: true,
    nextDueAt: "2026-11-11T02:30:00.000Z", lastRunAt: "2026-11-10T02:30:01.000Z", lastJobId: "j1", lastResult: "completed", lastOutcome: "ran",
    title: "Mirror backups to the SSH destination", cadence: "daily at 02:30",
  };

  it("reads a schedule's length from its last job: staged to finished", () => {
    const [planned] = jobsFromSchedules([schedule], history({ id: "j1", state: "completed", createdAt: "2026-11-10T02:30:01.000Z", updatedAt: "2026-11-10T03:11:01.000Z" }));
    expect(planned).toEqual({ id: "schedule:s1", kind: "schedule", name: "Mirror backups to the SSH destination", detail: null, enabled: true, nextAt: "2026-11-11T02:30:00.000Z", everyMinutes: null, last: { known: "took", ms: minutes(41), failed: false } });
  });

  it("says what it cannot tell about a schedule's last run", () => {
    const lastOf = (entry: Partial<Schedule>, jobs: ReturnType<typeof history> | null) => jobsFromSchedules([{ ...schedule, ...entry }], jobs)[0].last;
    expect(lastOf({}, history({ id: "j1", state: "failed", createdAt: "2026-11-10T02:30:00Z", updatedAt: "2026-11-10T02:32:00Z" }))).toEqual({ known: "took", ms: minutes(2), failed: true });
    expect(lastOf({ lastRunAt: null, lastJobId: null, lastOutcome: null }, history())).toEqual({ known: "never" });
    expect(lastOf({ lastOutcome: "running" }, history())).toEqual({ known: "running" });
    expect(lastOf({}, history({ id: "j1", state: "applying", createdAt: "2026-11-10T02:30:00Z", updatedAt: "2026-11-10T02:30:05Z" }))).toEqual({ known: "running" });
    // Its job is older than the history that was read, was withdrawn, or has no times.
    expect(lastOf({}, history())).toEqual({ known: "unknown" });
    expect(lastOf({}, history({ id: "j1", state: "cancelled", createdAt: "2026-11-10T02:30:00Z", updatedAt: "2026-11-10T02:30:05Z" }))).toEqual({ known: "unknown" });
    expect(lastOf({}, history({ id: "j1", state: "completed" }))).toEqual({ known: "unknown" });
    // The history could not be read.
    expect(lastOf({}, null)).toEqual({ known: "unread" });
  });

  it("carries a schedule's subject, its pause and an hourly cadence", () => {
    const [planned] = jobsFromSchedules([{ ...schedule, parameters: { subject: "jellyfin" }, enabled: false, frequency: "hourly" }], history());
    expect([planned.detail, planned.enabled, planned.everyMinutes]).toEqual(["jellyfin", false, 60]);
  });

  const flow: Flow = {
    id: "f1", name: "Nightly upkeep", steps: [{ operationId: "apt.refresh" }, { operationId: "docker.prune" }], createdBy: "o", risk: "medium", running: false,
    lastRunAt: "2026-11-10T03:00:00Z", lastResult: "completed", lastJobIds: ["a", null, "b"],
    frequency: "daily", minute: 0, hour: 3, weekday: null, enabled: true, nextDueAt: "2026-11-11T03:00:00.000Z", triggerFlowId: null, webhookEnabled: false,
  };

  it("lists automations that run on a cadence, measured from the first step staged to the last ended", () => {
    const jobs = history({ id: "a", state: "completed", createdAt: "2026-11-10T03:00:00Z", updatedAt: "2026-11-10T03:04:00Z" }, { id: "b", state: "completed", createdAt: "2026-11-10T03:04:01Z", updatedAt: "2026-11-10T03:18:00Z" });
    const planned = jobsFromFlows([flow, { ...flow, id: "f2", name: "By hand", frequency: null, nextDueAt: null }], jobs);
    expect(planned).toEqual([{ id: "automation:f1", kind: "automation", name: "Nightly upkeep", detail: "automation", enabled: true, nextAt: "2026-11-11T03:00:00.000Z", everyMinutes: null, last: { known: "took", ms: minutes(18), failed: false } }]);
  });

  it("says what it cannot tell about an automation's last run", () => {
    const lastOf = (entry: Partial<Flow>, jobs: ReturnType<typeof history> | null) => jobsFromFlows([{ ...flow, ...entry }], jobs)[0].last;
    expect(lastOf({ lastRunAt: null, lastJobIds: [] }, history())).toEqual({ known: "never" });
    expect(lastOf({ running: true }, history())).toEqual({ known: "running" });
    expect(lastOf({ lastRunElsewhere: true, lastJobIds: [] }, history())).toEqual({ known: "unknown" });
    expect(lastOf({}, history({ id: "a", state: "completed", createdAt: "2026-11-10T03:00:00Z", updatedAt: "2026-11-10T03:04:00Z" }))).toEqual({ known: "unknown" }); // step b is not in the history
    expect(lastOf({}, null)).toEqual({ known: "unread" });
  });

  const agent = {
    id: "keeper", name: "Server Keeper", paused: false, pausedUntil: null, status: "idle", nextRunAt: "2026-11-11T05:30:00.000Z", waitsForQuietHours: true,
    triggers: { ask: true, schedule: { every: "daily", minute: 30, hour: 5, weekday: null, quietHours: true }, events: [], webhook: false },
  } as unknown as AgentSummary;
  const agentsModule: Parameters<typeof jobsFromAgents>[1] = { enabled: true, paused: false, pausedUntil: null, quietHours: { start: "22:00", end: "07:00" } };
  const run = (more: Partial<Run>) => ({ id: "r", agentId: "keeper", kind: "schedule", state: "completed", startedAt: "2026-11-10T05:30:10Z", finishedAt: "2026-11-10T05:39:10Z", ...more }) as Run;

  it("lists agents with a schedule, measured by their last scheduled run", () => {
    const asked = run({ id: "q", kind: "ask", startedAt: "2026-11-10T18:00:00Z", finishedAt: "2026-11-10T18:00:30Z" });
    const [planned] = jobsFromAgents([agent, { ...agent, id: "asked", name: "Only asked", nextRunAt: null, triggers: { ...agent.triggers, schedule: null } }], agentsModule, { keeper: [asked, run({})] });
    expect(planned).toEqual({
      id: "agent:keeper", kind: "agent", name: "Server Keeper", detail: "agent", note: "waits for the agents' quiet hours, 22:00 to 07:00",
      enabled: true, nextAt: "2026-11-11T05:30:00.000Z", everyMinutes: null, last: { known: "took", ms: minutes(9), failed: false },
    });
  });

  it("leaves an agent off the night when Agents is off or it is paused past its time", () => {
    const enabledWith = (entry: Partial<AgentSummary>, state: Partial<typeof agentsModule> = {}) => jobsFromAgents([{ ...agent, ...entry }], { ...agentsModule, ...state }, { keeper: [] })[0].enabled;
    expect(enabledWith({})).toBe(true);
    expect(enabledWith({}, { enabled: false })).toBe(false);
    expect(enabledWith({}, { paused: true, pausedUntil: null })).toBe(false);
    expect(enabledWith({}, { paused: true, pausedUntil: "2026-11-11T01:00:00Z" })).toBe(true);
    expect(enabledWith({ paused: true, pausedUntil: null })).toBe(false);
    expect(enabledWith({ paused: true, pausedUntil: "2026-11-11T07:00:00Z" })).toBe(false);
    expect(enabledWith({ paused: true, pausedUntil: "2026-11-11T05:00:00Z" })).toBe(true);
  });

  it("says what it cannot tell about an agent's last run, and how often it repeats", () => {
    const of = (runs: Run[] | null, entry: Partial<AgentSummary> = {}) => jobsFromAgents([{ ...agent, ...entry }], agentsModule, { keeper: runs })[0];
    expect(of([]).last).toEqual({ known: "never" });
    expect(of(null).last).toEqual({ known: "unread" });
    expect(of([run({ state: "running", finishedAt: null })]).last).toEqual({ known: "running" });
    expect(of([run({ state: "cancelled", startedAt: null, finishedAt: null })]).last).toEqual({ known: "unknown" });
    expect(of([run({ state: "timeout" })]).last).toEqual({ known: "took", ms: minutes(9), failed: true });
    expect(of([], { waitsForQuietHours: false }).note).toBeNull();
    expect(of([], { triggers: { ...agent.triggers, schedule: { every: "every-6-hours", minute: 17, hour: null, weekday: null, quietHours: false } } }).everyMinutes).toBe(360);
    expect(of([], { triggers: { ...agent.triggers, schedule: { every: "hourly", minute: 17, hour: null, weekday: null, quietHours: false } } }).everyMinutes).toBe(60);
  });
});
