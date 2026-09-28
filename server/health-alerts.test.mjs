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


describe("a filesystem that turned itself read-only", () => {
  // The 2026-09-05 incident as the storage scan recorded it: the-dump still mounted from the device
  // that had gone, and exFAT holding it read-only after errors. Saving from another computer failed
  // with an I/O error while every listing still showed the folder.
  const snapshot = {
    storage: {
      filesystems: { available: true, mounts: [
        { target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv", readOnly: false, optionNames: ["rw", "relatime"] },
        { target: "/mnt/the-dump", source: "/dev/sdb2", readOnly: true, optionNames: ["ro", "relatime", "uid=1000", "errors=remount-ro"] },
      ] },
      blockDevices: { available: true, devices: [{ name: "/dev/mapper/ubuntu--vg-ubuntu--lv" }, { name: "/dev/sdb2" }] },
    },
  };

  it("is a high alert that says what to do", () => {
    const alerts = evaluateHealth(snapshot).filter((alert) => alert.key.startsWith("storage.mount.readonly"));
    expect(alerts.map((alert) => alert.key)).toEqual(["storage.mount.readonly:/mnt/the-dump"]);
    expect(alerts[0].priority).toBe("high");
    expect(alerts[0].message).toContain("Repair");
  });

  it("does not report a filesystem that was mounted read-only on purpose", () => {
    const deliberate = structuredClone(snapshot);
    deliberate.storage.filesystems.mounts[1].optionNames = ["ro", "relatime", "uid=1000"];   // no errors= policy: fstab asked for ro
    expect(evaluateHealth(deliberate).some((alert) => alert.key.startsWith("storage.mount.readonly"))).toBe(false);
  });

  it("clears once the mount is read-write again", () => {
    const fixed = structuredClone(snapshot);
    fixed.storage.filesystems.mounts[1] = { ...fixed.storage.filesystems.mounts[1], readOnly: false, optionNames: ["rw", "relatime", "uid=1000", "errors=remount-ro"] };
    expect(evaluateHealth(fixed).some((alert) => alert.key.startsWith("storage.mount.readonly"))).toBe(false);
  });

  it("is only evaluated when the mount list is actually available", () => {
    expect(collectorAvailability(snapshot)["storage.mount.readonly"]).toBe(true);
    expect(collectorAvailability({ storage: { filesystems: { available: false, mounts: [] } } })["storage.mount.readonly"]).toBe(false);
  });
});

it("coalesces overlapping health checks before sending notifications", async () => {
  const settings = new Map();
  const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn() };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const send = vi.fn(async () => { await held; });
  const inspect = vi.fn(async () => ({ ...healthy, maintenance: { system: { failedServiceCount: 1 } } }));
  const alerts = createHealthAlerts({ inventory: { inspect }, notifications: { getTarget: () => ({}), send }, store });
  const a = alerts.check(); const b = alerts.check();
  release();
  expect(await a).toEqual(await b);
  expect(inspect).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
});

describe("failures BoxPilot reports on its own work (M27.2)", () => {
  const at = () => new Date("2026-09-27T03:00:00Z");
  function ledger({ target = { kind: "ntfy" }, send = vi.fn(async () => ({ sent: true })), inspect = async () => ({}) } = {}) {
    const settings = new Map();
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn() };
    let current = target;
    const notifications = { getTarget: () => current, send };
    const alerts = createHealthAlerts({ inventory: { inspect }, notifications, store, now: at });
    return { alerts, send, store, state: () => settings.get("healthAlertsState") ?? {}, setTarget: (value) => { current = value; } };
  }
  const failure = { key: "schedule.failed:sch-1", title: "Scheduled task failed: Back up application data (jellyfin)", message: "tar failed: disk full. The job log is in Activity.", priority: "high" };

  it("announces a failure once however often it repeats, and says once that it cleared", async () => {
    const { alerts, send, state, store } = ledger();
    expect(await alerts.raise(failure)).toMatchObject({ notified: true, sent: true });
    expect(send).toHaveBeenCalledWith({ title: `BoxPilot: ${failure.title}`, message: failure.message, priority: "high" });
    // An hourly schedule failing all night is one push, not twelve.
    for (let run = 0; run < 12; run += 1) expect(await alerts.raise(failure)).toMatchObject({ sent: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(state()[failure.key]).toEqual({ since: "2026-09-27T03:00:00.000Z", title: failure.title, notified: true });

    expect(await alerts.clear(failure.key)).toMatchObject({ cleared: true, sent: true });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ title: `BoxPilot: resolved. ${failure.title}` }));
    expect(state()).toEqual({});
    expect(store.recordAudit).toHaveBeenCalledWith("health.alert.resolved", expect.objectContaining({ subjectId: failure.key }));
    expect(await alerts.clear(failure.key)).toMatchObject({ cleared: false, sent: false }); // nothing left to say
    expect(send).toHaveBeenCalledTimes(2);

    // Failing again after it recovered is news again.
    expect(await alerts.raise(failure)).toMatchObject({ sent: true });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("keeps a failure as not announced when there is no target, and the round that finds one sends it", async () => {
    const { alerts, send, state, setTarget } = ledger({ target: null });
    expect(await alerts.raise(failure)).toMatchObject({ notified: false, sent: false });
    expect(send).not.toHaveBeenCalled();
    expect(state()[failure.key]).toEqual({ since: "2026-09-27T03:00:00.000Z", title: failure.title, message: failure.message, priority: "high", notified: false });
    // Still no target: the round carries it forward rather than dropping what nothing re-evaluates.
    await alerts.check();
    expect(state()[failure.key]).toMatchObject({ notified: false });

    setTarget({ kind: "ntfy" });
    expect((await alerts.check()).sent).toEqual([failure.key]);
    expect(send).toHaveBeenCalledWith({ title: `BoxPilot: ${failure.title}`, message: failure.message, priority: "high" });
    expect(state()[failure.key]).toEqual({ since: "2026-09-27T03:00:00.000Z", title: failure.title, notified: true });
    expect((await alerts.check()).sent).toEqual([]); // announced now; the next round is quiet
  });

  it("keeps a failure whose delivery failed as not announced, and tries again", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("The notification target answered 502")).mockResolvedValue({ sent: true });
    const { alerts, state, store } = ledger({ send });
    expect(await alerts.raise(failure)).toMatchObject({ notified: false });
    expect(state()[failure.key]).toMatchObject({ notified: false, message: failure.message });
    expect(store.recordAudit).toHaveBeenCalledWith("health.alert.failed", expect.objectContaining({ subjectId: failure.key }));
    // The same failure again is another chance to deliver it, not a duplicate.
    expect(await alerts.raise(failure)).toMatchObject({ notified: true, sent: true });
    expect(state()[failure.key].notified).toBe(true);
  });

  it("drops a never-announced failure silently when it clears, and a deleted one quietly", async () => {
    const { alerts, send, state, setTarget } = ledger({ target: null });
    await alerts.raise(failure);
    setTarget({ kind: "ntfy" });
    expect(await alerts.clear(failure.key)).toMatchObject({ cleared: true, sent: false }); // nobody heard it failed
    expect(send).not.toHaveBeenCalled();

    await alerts.raise(failure); // announced this time
    expect(await alerts.clear(failure.key, { quietly: true })).toMatchObject({ cleared: true, sent: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(state()).toEqual({});
  });

  it("keeps a host alert whose delivery failed as not announced instead of forgetting it", async () => {
    const send = vi.fn(async () => { throw new Error("ntfy down"); });
    const { alerts, state } = ledger({ send, inspect: async () => ({ ...healthy, maintenance: { system: { failedServiceCount: 2 }, reboot: { required: false } } }) });
    expect(await alerts.check()).toMatchObject({ active: ["system.services"], sent: [] });
    expect(state()["system.services"]).toMatchObject({ notified: false });
  });

  it("does not let a round write over a failure raised while it was sending", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const send = vi.fn(async ({ title }) => { if (title.includes("system service")) await held; return { sent: true }; });
    const { alerts, state } = ledger({ send, inspect: async () => ({ ...healthy, maintenance: { system: { failedServiceCount: 1 }, reboot: { required: false } } }) });
    const round = alerts.check();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1)); // the round is waiting on its send
    const raised = alerts.raise(failure);
    release();
    await Promise.all([round, raised]);
    expect(Object.keys(state()).sort()).toEqual([failure.key, "system.services"]);
  });
});
