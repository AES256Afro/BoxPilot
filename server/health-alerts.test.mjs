import { describe, expect, it, vi } from "vitest";
import { collectorAvailability, createHealthAlerts, evaluateHealth } from "./health-alerts.mjs";

const healthy = {
  storage: { root: { usedPercent: 40 }, filesystems: { mounts: [{ target: "/", usedPercent: 40, capacityState: "healthy" }, { target: "/mnt/media", usedPercent: 60, capacityState: "healthy" }] }, smart: { disks: [{ device: "/dev/nvme0n1", health: "healthy", temperatureCelsius: 35, mediaErrors: 0 }] } },
  power: { ups: { available: true, state: "online", batteryChargePercent: 100, estimatedRuntimeSeconds: 3000 } },
  maintenance: { system: { failedServiceCount: 0 }, reboot: { required: false } },
  docker: { containers: [{ name: "bp-jellyfin", health: "healthy" }] },
};

describe("a mount whose drive has gone", () => {
  // 06:46 on a real server: a USB drive dropped off the bus and returned two seconds later as
  // /dev/sdb, while /mnt/the-dump stayed mounted from the /dev/sda2 that no longer existed. Every
  // check short of a real read passed, and the Windows share showed an empty folder for hours.
  const detached = {
    storage: {
      root: { usedPercent: 32 },
      filesystems: { available: true, mounts: [
        { target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv", usedPercent: 32, capacityState: "healthy" },
        { target: "/mnt/the-dump", source: "/dev/sda2", usedPercent: 13, capacityState: "healthy" },
      ] },
      blockDevices: { available: true, devices: [{ name: "/dev/sdb" }, { name: "/dev/sdb2" }, { name: "/dev/mapper/ubuntu--vg-ubuntu--lv" }] },
    },
  };

  it("announces it, because nothing else on the box will", () => {
    const alerts = evaluateHealth(detached);
    // Only the dead mount, and NOT the LVM root: /dev/mapper/ubuntu--vg-ubuntu--lv is both the
    // root's source and a device lsblk --paths reports, so a false "root disk lost its drive" high
    // alert every 15 minutes is exactly what this asserts against. Confirmed against the real box.
    expect(alerts.map((alert) => alert.key)).toEqual(["storage.mount.detached:/mnt/the-dump"]);
    expect(alerts.some((alert) => alert.key.includes("/"))).toBe(true);
    expect(alerts.some((alert) => alert.key === "storage.mount.detached:/")).toBe(false);
    expect(alerts[0].priority).toBe("high");
    expect(alerts[0].message).toContain("/dev/sda2");
    expect(alerts[0].message).toContain("shares");
  });

  it("says nothing once the drive is back under its new name", () => {
    const back = structuredClone(detached);
    back.storage.filesystems.mounts[1].source = "/dev/sdb2";
    expect(evaluateHealth(back)).toEqual([]);
  });

  it("stays quiet about network and virtual mounts, which have no device to lose", () => {
    const other = structuredClone(detached);
    other.storage.filesystems.mounts[1] = { target: "/mnt/nas", source: "[remote-or-virtual-source]", capacityState: "healthy" };
    expect(evaluateHealth(other)).toEqual([]);
  });

  it("does not claim every mount is detached when the device names are not paths", () => {
    // If lsblk ever stops being called with --paths, the names arrive unusable. Reporting every
    // drive on the server as detached at once would be worse than reporting nothing.
    const unusable = structuredClone(detached);
    unusable.storage.blockDevices.devices = [{ name: "[unavailable]" }, { name: "[unavailable]" }];
    expect(evaluateHealth(unusable)).toEqual([]);
  });

  it("does not claim every mount is detached when the device list is missing", () => {
    // Without the block-device half, absent evidence would read as "every drive has gone".
    const blind = structuredClone(detached);
    blind.storage.blockDevices = { available: false, devices: [] };
    expect(evaluateHealth(blind)).toEqual([]);
    expect(collectorAvailability(blind)["storage.mount.detached"]).toBe(false);
    expect(collectorAvailability(detached)["storage.mount.detached"]).toBe(true);
  });
});

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

  it("alerts on a crash-looping container instead of (not as well as) unhealthy", () => {
    const alerts = evaluateHealth({ docker: { containers: [
      { name: "bp-sonarr", state: "restarting", status: "Restarting (1) 3 seconds ago", health: "none" },
      { name: "bp-radarr", state: "running", health: "unhealthy" },
      { name: "bp-jellyfin", state: "running", health: "healthy" },
      { name: "bp-paused", state: "exited", status: "Exited (0) 2 hours ago", health: "none" }, // intentionally stopped: no alert
    ] } });
    expect(alerts.map((a) => a.key)).toEqual(["docker.restarting:bp-sonarr", "docker.unhealthy:bp-radarr"]);
    expect(alerts[0].message).toContain("crash-looping");
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
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ title: "BoxPilot: resolved. Root disk is 92% full" }));
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

  it("alerts when a filesystem is projected to fill soon", async () => {
    const settings = new Map();
    const GB = 1024 ** 3;
    // Ten daily samples losing 10 GB/day, ending near empty: fills in a couple of days.
    const start = Date.parse("2026-08-18T12:00:00Z");
    const samples = Array.from({ length: 10 }, (_u, i) => ({ at: new Date(start + i * 86_400_000).toISOString(), availableBytes: (100 - i * 10) * GB + 20 * GB }));
    settings.set("diskUsageHistory", { "/mnt/media": samples });
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn(), listSchedules: () => [] };
    const send = vi.fn(async () => ({ sent: true }));
    const notifications = { getTarget: () => ({ kind: "ntfy" }), send };
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications, store, now: () => new Date("2026-08-28T12:00:00Z") });
    const result = await alerts.check();
    expect(result.sent).toEqual(["storage.forecast:/mnt/media"]);
    expect(send).toHaveBeenCalledWith({ title: expect.stringContaining("/mnt/media"), message: expect.stringContaining("runs out of free space"), priority: "high" });
  });

  it("alerts when a disk's SMART errors are climbing", async () => {
    const settings = new Map();
    const start = Date.parse("2026-08-08T12:00:00Z");
    const samples = Array.from({ length: 20 }, (_u, i) => ({ at: new Date(start + i * 86_400_000).toISOString(), mediaErrors: i < 15 ? 0 : (i - 14) * 3, percentageUsed: null }));
    settings.set("smartHistory", { "/dev/sda": samples });
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn(), listSchedules: () => [] };
    const send = vi.fn(async () => ({ sent: true }));
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications: { getTarget: () => ({ kind: "ntfy" }), send }, store, now: () => new Date("2026-08-28T12:00:00Z") });
    expect((await alerts.check()).sent).toEqual(["smart.errors:/dev/sda"]);
    expect(send).toHaveBeenCalledWith({ title: expect.stringContaining("/dev/sda"), message: expect.stringContaining("errors are rising"), priority: "high" });
  });

  it("alerts when a scheduled backup falls behind, and clears when it catches up", async () => {
    const settings = new Map();
    const overdue = { id: "sch-1", operationId: "backup.cloud.sync", frequency: "daily", enabled: true, nextDueAt: "2026-08-20T04:00:00Z" };
    let schedules = [overdue];
    const store = {
      getSetting: (key, fallback) => settings.get(key) ?? fallback,
      setSetting: (key, value) => settings.set(key, value),
      recordAudit: vi.fn(),
      listSchedules: () => schedules,
    };
    const send = vi.fn(async () => ({ sent: true }));
    const notifications = { getTarget: () => ({ kind: "ntfy" }), send };
    const inventory = { inspect: async () => ({}) };
    const alerts = createHealthAlerts({ inventory, notifications, store, now: () => new Date("2026-08-28T12:00:00Z"), resolveScheduleTitle: () => "Mirror backups to the cloud" });

    const first = await alerts.check();
    expect(first.sent).toEqual(["schedule.overdue:sch-1"]);
    expect(send).toHaveBeenCalledWith({ title: "BoxPilot: Scheduled task overdue: Mirror backups to the cloud", message: expect.stringContaining("has stopped protecting you"), priority: "default" });
    expect(await alerts.check()).toMatchObject({ sent: [] }); // still overdue: no repeat

    // The scheduler catches up (next run in the future): the alert resolves.
    schedules = [{ ...overdue, nextDueAt: "2026-08-29T04:00:00Z" }];
    expect((await alerts.check()).sent).toEqual(["resolved:schedule.overdue:sch-1"]);
  });
});
