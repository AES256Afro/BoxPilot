import { describe, expect, it, vi } from "vitest";
import { appendSample, createDiskSampler, evaluateDiskForecast, forecastEntriesFromInventory, projectDaysToFull } from "./disk-forecast.mjs";

const GB = 1024 ** 3;
const day0 = Date.parse("2026-08-01T00:00:00.000Z");
const at = (dayOffset) => new Date(day0 + dayOffset * 86_400_000).toISOString();
const now = day0 + 10 * 86_400_000;

/** A series losing `perDay` bytes of free space each day for `days` days, ending with `endFree`. */
function fallingSeries(days, endFree, perDay) {
  return Array.from({ length: days }, (_unused, index) => ({ at: at(index), availableBytes: endFree + (days - 1 - index) * perDay }));
}

describe("projectDaysToFull", () => {
  it("projects a steadily filling disk", () => {
    // 10 days, ends with 20 GB free, losing 10 GB/day → ~2 days left.
    const days = projectDaysToFull(fallingSeries(10, 20 * GB, 10 * GB), { now: Date.parse(at(9)) });
    expect(days).toBeGreaterThan(1.5);
    expect(days).toBeLessThan(2.5);
  });

  it("returns null for a disk that is not filling", () => {
    const flat = Array.from({ length: 8 }, (_u, i) => ({ at: at(i), availableBytes: 100 * GB }));
    expect(projectDaysToFull(flat, { now })).toBeNull();
    const freeing = Array.from({ length: 8 }, (_u, i) => ({ at: at(i), availableBytes: (50 + i * 5) * GB }));
    expect(projectDaysToFull(freeing, { now })).toBeNull();
  });

  it("needs enough samples and enough spread", () => {
    expect(projectDaysToFull([{ at: at(0), availableBytes: 50 * GB }, { at: at(1), availableBytes: 40 * GB }], { now })).toBeNull(); // <3 samples
    const sameDay = [{ at: at(0), availableBytes: 50 * GB }, { at: at(0), availableBytes: 49 * GB }, { at: at(0), availableBytes: 48 * GB }];
    expect(projectDaysToFull(sameDay, { now: day0 })).toBeNull(); // no span
  });
});

describe("appendSample", () => {
  it("keeps one sample per day and prunes old ones", () => {
    let history = {};
    history = appendSample(history, { at: at(0), entries: [{ target: "/mnt/media", availableBytes: 100 * GB, totalBytes: 200 * GB }] });
    history = appendSample(history, { at: `${at(0).slice(0, 10)}T18:00:00.000Z`, entries: [{ target: "/mnt/media", availableBytes: 95 * GB }] }); // same day: replaces
    history = appendSample(history, { at: at(1), entries: [{ target: "/mnt/media", availableBytes: 90 * GB }] });
    expect(history["/mnt/media"]).toHaveLength(2);
    expect(history["/mnt/media"][0].availableBytes).toBe(95 * GB); // the later same-day reading won
    // A very old sample ages out.
    history = appendSample(history, { at: at(40), entries: [{ target: "/mnt/media", availableBytes: 10 * GB }] }, { maxDays: 30 });
    expect(history["/mnt/media"].every((s) => Date.parse(at(40)) - Date.parse(s.at) <= 30 * 86_400_000)).toBe(true);
  });
});

describe("evaluateDiskForecast", () => {
  it("alerts within the window, escalating when nearly full", () => {
    const soon = { "/mnt/media": fallingSeries(10, 20 * GB, 10 * GB) }; // ~2 days → high
    const alerts = evaluateDiskForecast(soon, { now: Date.parse(at(9)), warnWithinDays: 14 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe("storage.forecast:/mnt/media");
    expect(alerts[0].priority).toBe("high");
    // A disk with months of runway does not alert.
    const slow = { "/": fallingSeries(10, 500 * GB, 1 * GB) };
    expect(evaluateDiskForecast(slow, { now: Date.parse(at(9)), warnWithinDays: 14 })).toEqual([]);
  });
});

describe("forecastEntriesFromInventory", () => {
  it("takes writable mounts and the root, skipping read-only", () => {
    const entries = forecastEntriesFromInventory({ storage: {
      root: { freeBytes: 30 * GB, totalBytes: 100 * GB },
      filesystems: { mounts: [
        { target: "/mnt/media", availableBytes: 500 * GB, totalBytes: 1000 * GB, readOnly: false },
        { target: "/mnt/ro", availableBytes: 10 * GB, readOnly: true },
      ] },
    } });
    expect(entries.map((e) => e.target).sort()).toEqual(["/", "/mnt/media"]);
  });
});

describe("the sampler", () => {
  it("records one reading and persists it", async () => {
    const settings = new Map();
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value) };
    const inventory = { inspect: vi.fn(async () => ({ storage: { root: { freeBytes: 30 * GB, totalBytes: 100 * GB }, filesystems: { mounts: [] } } })) };
    const sampler = createDiskSampler({ inventory, store, now: () => new Date(now) });
    expect(await sampler.sample()).toEqual({ sampled: 1 });
    expect(settings.get("diskUsageHistory")["/"]).toHaveLength(1);
  });
});
