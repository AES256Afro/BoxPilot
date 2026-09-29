/**
 * The notification centre's record (M36): one entry per thing said, whether it arrived, when a
 * condition cleared, bounded by count and age; and the ledger writing to it as it announces.
 */
import { describe, expect, it, vi } from "vitest";
import { createHealthAlerts } from "./health-alerts.mjs";
import { createNotificationHistory } from "./notification-history.mjs";

function memoryStore() {
  const settings = new Map();
  return {
    getSetting: (key, fallback) => (settings.has(key) ? structuredClone(settings.get(key)) : fallback),
    setSetting: (key, value) => { settings.set(key, structuredClone(value)); return value; },
    recordAudit: () => {},
    listSchedules: () => [],
    listFlows: () => [],
  };
}

describe("what BoxPilot said", () => {
  it("keeps one entry per thing said, and marks it delivered when a later try gets through", () => {
    let clock = Date.parse("2026-09-29T08:00:00Z");
    const history = createNotificationHistory({ store: memoryStore(), now: () => new Date(clock) });
    history.record({ key: "storage.root.full", kind: "alert", title: "Root disk is 91% full", delivered: false, reason: "no-target" });
    clock += 15 * 60_000;
    history.record({ key: "storage.root.full", kind: "alert", title: "Root disk is 93% full", delivered: false, reason: "no-target" });
    expect(history.list()).toMatchObject([{ title: "Root disk is 93% full", delivered: false, reason: "no-target", at: "2026-09-29T08:00:00.000Z" }]);
    clock += 15 * 60_000;
    history.record({ key: "storage.root.full", kind: "alert", title: "Root disk is 93% full", delivered: true });
    expect(history.list()).toMatchObject([{ delivered: true, reason: null, deliveredAt: "2026-09-29T08:30:00.000Z" }]);
    // Said again once it had arrived: a new entry.
    history.record({ key: "storage.root.full", kind: "alert", title: "Root disk is 95% full", delivered: true });
    expect(history.list()).toHaveLength(2);
  });

  it("says when a condition cleared, and starts a new entry if it comes back", () => {
    let clock = Date.parse("2026-09-29T08:00:00Z");
    const history = createNotificationHistory({ store: memoryStore(), now: () => new Date(clock) });
    history.record({ key: "docker.unhealthy:bp-immich", kind: "alert", title: "Container bp-immich is unhealthy", delivered: false, reason: "no-target" });
    clock += 60 * 60_000;
    expect(history.resolve("docker.unhealthy:bp-immich")).toBe(true);
    expect(history.resolve("docker.unhealthy:bp-immich")).toBe(false);
    history.record({ key: "docker.unhealthy:bp-immich", kind: "alert", title: "Container bp-immich is unhealthy", delivered: false, reason: "no-target" });
    expect(history.list().map((entry) => entry.resolvedAt ?? null)).toEqual([null, "2026-09-29T09:00:00.000Z"]);
  });

  it("keeps at most the newest hundred, none older than thirty days", () => {
    let clock = Date.parse("2026-09-01T00:00:00Z");
    const history = createNotificationHistory({ store: memoryStore(), now: () => new Date(clock) });
    for (let index = 0; index < 120; index += 1) { history.record({ key: `release.available:v1.${index}.0`, kind: "notice", title: `v1.${index}.0`, delivered: true }); clock += 60_000; }
    expect(history.list()).toHaveLength(100);
    expect(history.list()[0].title).toBe("v1.119.0");
    clock += 31 * 24 * 60 * 60_000;
    expect(history.list()).toEqual([]);
  });

  it("keeps each account's own seen marker", () => {
    const history = createNotificationHistory({ store: memoryStore(), now: () => new Date("2026-09-29T10:00:00Z") });
    expect(history.seenAt("alex")).toBeNull();
    history.markSeen("alex");
    expect(history.seenAt("alex")).toBe("2026-09-29T10:00:00.000Z");
    expect(history.seenAt("sam")).toBeNull();
  });

  it("is written by the ledger as it raises, retries, tells and clears", async () => {
    const store = memoryStore();
    const history = createNotificationHistory({ store, now: () => new Date("2026-09-29T10:00:00Z") });
    let target = null;
    const notifications = { getTarget: () => target, send: vi.fn(async () => ({ sent: true })) };
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications, store, history, now: () => new Date("2026-09-29T10:00:00Z") });
    await alerts.raise({ key: "schedule.failed:s1", title: "Scheduled task failed: Back up Immich", message: "tar failed" });
    await alerts.tell({ key: "release.available", title: "BoxPilot v1.139.0 is out", message: "Update from the System page." });
    expect(history.list().map((entry) => [entry.kind, entry.delivered, entry.reason])).toEqual([["notice", false, "no-target"], ["alert", false, "no-target"]]);
    target = { kind: "ntfy" };
    await alerts.check();
    expect(history.list().map((entry) => [entry.kind, entry.delivered])).toEqual([["notice", true], ["alert", true]]);
    await alerts.clear("schedule.failed:s1");
    expect(history.list().find((entry) => entry.kind === "alert").resolvedAt).toBe("2026-09-29T10:00:00.000Z");
  });
});
