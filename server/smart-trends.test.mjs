import { describe, expect, it, vi } from "vitest";
import { appendSmartSample, createSmartSampler, evaluateSmartTrends, smartEntriesFromInventory } from "./smart-trends.mjs";

const day0 = Date.parse("2026-08-01T00:00:00.000Z");
const at = (dayOffset) => new Date(day0 + dayOffset * 86_400_000).toISOString();
const now = day0 + 30 * 86_400_000;

function series(device, days, valueAt) {
  return { [device]: Array.from({ length: days }, (_u, i) => ({ at: at(i), ...valueAt(i) })) };
}

describe("smartEntriesFromInventory", () => {
  it("pulls the trendable numbers, skipping unavailable disks", () => {
    const entries = smartEntriesFromInventory({ storage: { smart: { disks: [
      { device: "/dev/nvme0n1", health: "healthy", mediaErrors: 0, percentageUsed: 12, temperatureCelsius: 40 },
      { device: "/dev/sdb", health: "unavailable" },
    ] } } });
    expect(entries).toEqual([{ device: "/dev/nvme0n1", mediaErrors: 0, percentageUsed: 12, temperatureCelsius: 40 }]);
  });
});

describe("evaluateSmartTrends", () => {
  it("alerts when media errors climb from zero", () => {
    const history = series("/dev/sda", 20, (i) => ({ mediaErrors: i < 15 ? 0 : (i - 14) * 2, percentageUsed: null }));
    const alerts = evaluateSmartTrends(history, { now: Date.parse(at(19)) });
    expect(alerts.map((a) => a.key)).toContain("smart.errors:/dev/sda");
    expect(alerts.find((a) => a.key === "smart.errors:/dev/sda").priority).toBe("high");
  });

  it("does not alert when media errors are a steady zero", () => {
    const history = series("/dev/sda", 20, () => ({ mediaErrors: 0, percentageUsed: null }));
    expect(evaluateSmartTrends(history, { now: Date.parse(at(19)) })).toEqual([]);
  });

  it("alerts on SSD wear projected to reach the limit soon", () => {
    // Wear climbing ~0.5%/day from ~85%: hits 100 in ~30 days.
    const history = series("/dev/nvme0n1", 20, (i) => ({ mediaErrors: 0, percentageUsed: 85 + i * 0.5 }));
    const alerts = evaluateSmartTrends(history, { now: Date.parse(at(19)) });
    const wear = alerts.find((a) => a.key === "smart.wear:/dev/nvme0n1");
    expect(wear).toBeTruthy();
    expect(wear.message).toMatch(/rated write endurance/);
  });

  it("alerts when wear is already high even if barely moving", () => {
    const history = series("/dev/nvme0n1", 20, () => ({ mediaErrors: 0, percentageUsed: 92 }));
    expect(evaluateSmartTrends(history, { now: Date.parse(at(19)) }).some((a) => a.key === "smart.wear:/dev/nvme0n1")).toBe(true);
  });

  it("stays quiet for a young, healthy SSD", () => {
    const history = series("/dev/nvme0n1", 20, (i) => ({ mediaErrors: 0, percentageUsed: 8 + i * 0.02 }));
    expect(evaluateSmartTrends(history, { now: Date.parse(at(19)) })).toEqual([]);
  });
});

describe("appendSmartSample", () => {
  it("keeps one reading per day and prunes old ones", () => {
    let history = {};
    history = appendSmartSample(history, { at: at(0), entries: [{ device: "/dev/sda", mediaErrors: 0, percentageUsed: 10, temperatureCelsius: 38 }] });
    history = appendSmartSample(history, { at: `${at(0).slice(0, 10)}T20:00:00.000Z`, entries: [{ device: "/dev/sda", mediaErrors: 1, percentageUsed: 10, temperatureCelsius: 39 }] });
    expect(history["/dev/sda"]).toHaveLength(1);
    expect(history["/dev/sda"][0].mediaErrors).toBe(1); // later same-day reading replaced it
  });
});

describe("the sampler", () => {
  it("records and persists a reading", async () => {
    const settings = new Map();
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value) };
    const inventory = { inspect: vi.fn(async () => ({ storage: { smart: { disks: [{ device: "/dev/sda", health: "healthy", mediaErrors: 0, percentageUsed: 5, temperatureCelsius: 35 }] } } })) };
    const sampler = createSmartSampler({ inventory, store, now: () => new Date(now) });
    expect(await sampler.sample()).toEqual({ sampled: 1 });
    expect(settings.get("smartHistory")["/dev/sda"]).toHaveLength(1);
  });
});
