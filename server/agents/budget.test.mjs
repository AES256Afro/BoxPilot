// @vitest-environment node
import { describe, expect, it } from "vitest";
import { budgetState, createRateLimit, inQuietHours, nextQuietStart, nextScheduledRun, normalizeQuietHours, startOfLocalDay, tomorrowMorning } from "./budget.mjs";

// Local times, so these hold in any time zone the tests run in.
const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute, 0, 0);

describe("quiet hours", () => {
  it("are a window that may wrap past midnight", () => {
    const night = { start: "02:00", end: "06:00" };
    expect(inQuietHours(at(29, 1, 59), night)).toBe(false);
    expect(inQuietHours(at(29, 2, 0), night)).toBe(true);
    expect(inQuietHours(at(29, 5, 59), night)).toBe(true);
    expect(inQuietHours(at(29, 6, 0), night)).toBe(false);
    const wrap = { start: "23:00", end: "05:00" };
    expect(inQuietHours(at(29, 23, 30), wrap)).toBe(true);
    expect(inQuietHours(at(29, 4, 0), wrap)).toBe(true);
    expect(inQuietHours(at(29, 12, 0), wrap)).toBe(false);
  });

  it("start next at the coming start time, or now when already in them", () => {
    expect(nextQuietStart(at(29, 12), { start: "02:00", end: "06:00" })).toEqual(at(30, 2));
    expect(nextQuietStart(at(29, 3), { start: "02:00", end: "06:00" })).toEqual(at(29, 3));
  });

  it("refuse times that are not times", () => {
    expect(normalizeQuietHours(undefined)).toEqual({ start: "02:00", end: "06:00" });
    expect(() => normalizeQuietHours({ start: "25:00", end: "06:00" })).toThrow();
    expect(() => normalizeQuietHours({ start: "02:00", end: "02:00" })).toThrow();
  });
});

describe("days and pauses", () => {
  it("counts a day from local midnight", () => {
    expect(startOfLocalDay(at(29, 15, 30))).toEqual(at(29, 0));
  });

  it("pauses until tomorrow morning, or this morning when it is still night", () => {
    expect(tomorrowMorning(at(29, 22))).toEqual(at(30, 7));
    expect(tomorrowMorning(at(29, 9))).toEqual(at(30, 7));
    expect(tomorrowMorning(at(29, 1, 30))).toEqual(at(29, 7));
  });
});

describe("schedules", () => {
  it("find the next run after a time", () => {
    expect(nextScheduledRun({ every: "hourly", minute: 15 }, at(29, 10, 20))).toEqual(at(29, 11, 15));
    expect(nextScheduledRun({ every: "hourly", minute: 15 }, at(29, 10, 5))).toEqual(at(29, 10, 15));
    expect(nextScheduledRun({ every: "every-6-hours", minute: 17 }, at(29, 7, 0))).toEqual(at(29, 12, 17));
    expect(nextScheduledRun({ every: "every-6-hours", minute: 17 }, at(29, 6, 10))).toEqual(at(29, 6, 17));
    expect(nextScheduledRun({ every: "daily", hour: 5, minute: 30 }, at(29, 5, 30))).toEqual(at(30, 5, 30));
    expect(nextScheduledRun({ every: "daily", hour: 5, minute: 30 }, at(29, 4))).toEqual(at(29, 5, 30));
    // 2026-09-29 is a Tuesday (2); Monday (1) comes six days later.
    expect(nextScheduledRun({ every: "weekly", weekday: 1, hour: 3, minute: 0 }, at(29, 12))).toEqual(new Date(2026, 9, 5, 3, 0));
    expect(nextScheduledRun(null, at(29, 1))).toBeNull();
  });

  // Pinned to a zone with daylight saving, as server/scheduler.test.mjs does: 2026's clocks go
  // forward on 8 March and back on 1 November there.
  const inNewYork = (test) => () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try { return test(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  };

  it("keep their own time the day and the week after the clocks go forward", inNewYork(() => {
    // 02:30 does not exist on 8 March; the run that day is at 03:30, and the next one was too.
    const ranAt = new Date("2026-03-08T07:30:00.000Z"); // 03:30 EDT, the day of the change
    expect(nextScheduledRun({ every: "daily", hour: 2, minute: 30 }, ranAt).toISOString()).toBe("2026-03-09T06:30:00.000Z"); // 02:30 EDT
    expect(nextScheduledRun({ every: "weekly", weekday: 0, hour: 2, minute: 30 }, ranAt).toISOString()).toBe("2026-03-15T06:30:00.000Z"); // Sunday 02:30 EDT
  }));

  it("run hourly in the hour the clocks repeat when they go back", inNewYork(() => {
    const from = new Date("2026-11-01T05:50:00.000Z"); // 01:50 EDT, before the clocks go back
    expect(nextScheduledRun({ every: "hourly", minute: 15 }, from).toISOString()).toBe("2026-11-01T06:15:00.000Z"); // 01:15 EST
  }));
});

describe("budgets", () => {
  const budget = { runsPerDay: 3, modelSecondsPerDay: 60 };
  it("say why a run is refused, and what is left", () => {
    expect(budgetState(budget, { runs: 1, modelMs: 10_000 })).toMatchObject({ runsLeft: 2, modelMsLeft: 50_000, refusal: null });
    expect(budgetState(budget, { runs: 3, modelMs: 0 }).refusal).toMatch(/3 runs for today/);
    expect(budgetState(budget, { runs: 1, modelMs: 60_000 }).refusal).toMatch(/1 minutes of model time/);
  });

  it("are enforced by a token bucket for how often someone may call", () => {
    let clock = 0;
    const limit = createRateLimit({ capacity: 2, refillPerSecond: 1, now: () => clock });
    expect([limit.take("a"), limit.take("a"), limit.take("a")]).toEqual([true, true, false]);
    expect(limit.take("b")).toBe(true);
    clock += 1_000;
    expect(limit.take("a")).toBe(true);
  });
});
