import { describe, expect, it } from "vitest";
import { describeOverdue, evaluateScheduleFreshness, overdueScheduleIds, scheduleIntervalMs } from "./schedule-freshness.mjs";

const now = Date.parse("2026-08-28T12:00:00.000Z");
const at = (isoOffsetMs) => new Date(now + isoOffsetMs).toISOString();
const schedule = (extra) => ({ id: "s1", operationId: "backup.cloud.sync", frequency: "daily", enabled: true, ...extra });

describe("schedule intervals", () => {
  it("maps frequencies to a cycle length and falls back to a day", () => {
    expect(scheduleIntervalMs("hourly")).toBe(3_600_000);
    expect(scheduleIntervalMs("daily")).toBe(86_400_000);
    expect(scheduleIntervalMs("weekly")).toBe(604_800_000);
    expect(scheduleIntervalMs("nonsense")).toBe(86_400_000);
  });
});

describe("describeOverdue", () => {
  it("reads naturally", () => {
    expect(describeOverdue(90 * 60_000)).toBe("2 hours");
    expect(describeOverdue(50 * 60_000)).toBe("50 minutes");
    expect(describeOverdue(3 * 24 * 3_600_000)).toBe("3 days");
  });
});

describe("evaluateScheduleFreshness", () => {
  it("does not alert on a schedule whose next run is still in the future", () => {
    expect(evaluateScheduleFreshness([schedule({ nextDueAt: at(6 * 3_600_000) })], { now })).toEqual([]);
  });

  it("does not alert until a schedule is more than a full interval overdue", () => {
    // A daily schedule 6 hours overdue is just a late/off morning, not a stopped backup.
    expect(evaluateScheduleFreshness([schedule({ nextDueAt: at(-6 * 3_600_000) })], { now })).toEqual([]);
    // 30 hours overdue (> one day) is a skipped cycle.
    const alerts = evaluateScheduleFreshness([schedule({ nextDueAt: at(-30 * 3_600_000) })], { now });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe("schedule.overdue:s1");
    expect(alerts[0].title).toContain("backup.cloud.sync");
  });

  it("uses a human title when one is provided", () => {
    const alerts = evaluateScheduleFreshness([schedule({ nextDueAt: at(-30 * 3_600_000) })], { now, titleFor: () => "Mirror backups to the cloud" });
    expect(alerts[0].title).toBe("Scheduled task overdue: Mirror backups to the cloud");
    expect(alerts[0].message).toContain("was due 30 hours ago");
  });

  it("ignores disabled schedules and ones with no due time", () => {
    expect(evaluateScheduleFreshness([schedule({ enabled: false, nextDueAt: at(-100 * 3_600_000) })], { now })).toEqual([]);
    expect(evaluateScheduleFreshness([schedule({ nextDueAt: null })], { now })).toEqual([]);
    expect(evaluateScheduleFreshness([schedule({ nextDueAt: "not a date" })], { now })).toEqual([]);
  });

  it("respects each frequency's own interval", () => {
    // An hourly schedule 90 minutes overdue is behind (>1h); a weekly one 90 minutes overdue is not.
    expect(evaluateScheduleFreshness([schedule({ frequency: "hourly", nextDueAt: at(-90 * 60_000) })], { now })).toHaveLength(1);
    expect(evaluateScheduleFreshness([schedule({ frequency: "weekly", nextDueAt: at(-90 * 60_000) })], { now })).toEqual([]);
  });
});

describe("overdueScheduleIds", () => {
  it("returns the set of behind schedule ids", () => {
    const ids = overdueScheduleIds([
      schedule({ id: "a", nextDueAt: at(-30 * 3_600_000) }),
      schedule({ id: "b", nextDueAt: at(3_600_000) }),
      schedule({ id: "c", enabled: false, nextDueAt: at(-100 * 3_600_000) }),
    ], { now });
    expect([...ids]).toEqual(["a"]);
  });
});
