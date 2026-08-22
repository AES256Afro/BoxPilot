import { describe, expect, it, vi } from "vitest";
import { createHealthAlerts, evaluateHealth } from "./health-alerts.mjs";

const healthy = {
  storage: { root: { usedPercent: 40 }, filesystems: { mounts: [{ target: "/", usedPercent: 40, capacityState: "healthy" }, { target: "/mnt/media", usedPercent: 60, capacityState: "healthy" }] }, smart: { disks: [{ device: "/dev/nvme0n1", health: "healthy", temperatureCelsius: 35, mediaErrors: 0 }] } },
  power: { ups: { available: true, state: "online", batteryChargePercent: 100, estimatedRuntimeSeconds: 3000 } },
  maintenance: { system: { failedServiceCount: 0 }, reboot: { required: false } },
  docker: { containers: [{ name: "bp-jellyfin", health: "healthy" }] },
};

describe("health alerts", () => {
  it("derives conditions from the inventory", () => {
    expect(evaluateHealth(healthy)).toEqual([]);
    const bad = {
      storage: { root: { usedPercent: 96 }, filesystems: { mounts: [{ target: "/mnt/media", usedPercent: 88, capacityState: "warning" }] }, smart: { disks: [{ device: "/dev/sda", health: "failing", temperatureCelsius: 51, mediaErrors: 12 }] } },
      power: { ups: { available: true, state: "low-battery", batteryChargePercent: 8, estimatedRuntimeSeconds: 120 } },
      maintenance: { system: { failedServiceCount: 2 }, reboot: { required: true } },
      docker: { containers: [{ name: "bp-immich", health: "unhealthy" }] },
    };
    const alerts = evaluateHealth(bad);
    expect(alerts.map((alert) => [alert.key, alert.priority])).toEqual([
      ["storage.root.full", "high"], ["storage.mount.full:/mnt/media", "default"], ["storage.smart:/dev/sda", "high"], ["power.ups", "high"], ["system.services", "default"], ["system.reboot", "default"], ["docker.unhealthy:bp-immich", "default"],
    ]);
    expect(alerts[2].message).toContain("12 media errors");
    expect(alerts[3].message).toContain("about 2 min left");
    expect(evaluateHealth({})).toEqual([]);
  });

  it("sends once per new condition, announces resolution once, and persists state", async () => {
    const settings = new Map();
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn() };
    const send = vi.fn(async () => ({ sent: true }));
    const notifications = { getTarget: () => ({ kind: "ntfy" }), send };
    let snapshot = { ...healthy, storage: { ...healthy.storage, root: { usedPercent: 92 } } };
    const inventory = { inspect: async () => snapshot };
    const alerts = createHealthAlerts({ inventory, notifications, store, now: () => new Date("2026-08-21T21:00:00Z") });

    expect(await alerts.check()).toMatchObject({ active: ["storage.root.full"], sent: ["storage.root.full"] });
    expect(send).toHaveBeenCalledWith({ title: "BoxPilot: Root disk is 92% full", message: expect.stringContaining("Free space on /"), priority: "default" });
    expect(await alerts.check()).toMatchObject({ sent: [] }); // same condition: no repeat
    expect(send).toHaveBeenCalledTimes(1);

    snapshot = healthy;
    expect(await alerts.check()).toMatchObject({ active: [], sent: ["resolved:storage.root.full"] });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ title: "BoxPilot: resolved — Root disk is 92% full" }));
    expect(settings.get("healthAlertsState")).toEqual({});
    expect(store.recordAudit).toHaveBeenCalledWith("health.alert.resolved", expect.objectContaining({ subjectId: "storage.root.full" }));
  });

  it("tracks conditions without a target and retries a failed send next round", async () => {
    const settings = new Map();
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn() };
    const snapshot = { ...healthy, maintenance: { system: { failedServiceCount: 1 }, reboot: { required: false } } };
    const quiet = createHealthAlerts({ inventory: { inspect: async () => snapshot }, notifications: { getTarget: () => null, send: vi.fn() }, store });
    expect(await quiet.check()).toMatchObject({ active: ["system.services"], sent: [], target: false });
    expect(Object.keys(settings.get("healthAlertsState"))).toEqual(["system.services"]);

    settings.clear();
    const send = vi.fn().mockRejectedValueOnce(new Error("ntfy down")).mockResolvedValue({ sent: true });
    const flaky = createHealthAlerts({ inventory: { inspect: async () => snapshot }, notifications: { getTarget: () => ({ kind: "ntfy" }), send }, store });
    expect(await flaky.check()).toMatchObject({ sent: [] });
    expect(store.recordAudit).toHaveBeenCalledWith("health.alert.failed", expect.anything());
    expect(await flaky.check()).toMatchObject({ sent: ["system.services"] });
  });

  it("schedules the first check after a delay and repeats", () => {
    const timers = [];
    const alerts = createHealthAlerts({ inventory: { inspect: async () => healthy }, notifications: { getTarget: () => null, send: vi.fn() }, store: { getSetting: () => ({}), setSetting: vi.fn(), recordAudit: vi.fn() }, setTimeout: (fn, ms) => { timers.push(["timeout", ms]); return { unref() {} }; }, setInterval: (fn, ms) => { timers.push(["interval", ms]); return { unref() {} }; }, clearTimeout: vi.fn(), clearInterval: vi.fn() });
    alerts.start();
    expect(timers).toEqual([["timeout", 3 * 60 * 1000], ["interval", 15 * 60 * 1000]]);
  });
});

describe("health alerts with missing evidence", () => {
  it("carries an alert forward while its collector is unavailable instead of announcing a resolution", async () => {
    const settings = new Map();
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn() };
    const send = vi.fn(async () => ({ sent: true }));
    const notifications = { getTarget: () => ({ kind: "ntfy" }), send };
    const bad = { storage: { root: { usedPercent: 10 }, smart: { available: true, disks: [{ device: "/dev/sda", health: "critical", mediaErrors: 3 }] } } };
    let snapshot = bad;
    const alerts = createHealthAlerts({ inventory: { inspect: async () => snapshot }, notifications, store, now: () => new Date("2026-08-22T01:00:00Z") });
    expect(await alerts.check()).toMatchObject({ sent: ["storage.smart:/dev/sda"] });
    snapshot = { storage: { root: { usedPercent: 10 }, smart: { available: false, disks: [] } } }; // stale storage-health.json
    expect(await alerts.check()).toMatchObject({ sent: [] });
    expect(settings.get("healthAlertsState")).toHaveProperty("storage.smart:/dev/sda");
    snapshot = { storage: { root: { usedPercent: 10 }, smart: { available: true, disks: [{ device: "/dev/sda", health: "healthy" }] } } };
    expect(await alerts.check()).toMatchObject({ sent: ["resolved:storage.smart:/dev/sda"] });
  });
});
