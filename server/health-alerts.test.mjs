import { describe, expect, it, vi } from "vitest";
import { collectorAvailability, createHealthAlerts, evaluateHealth, isNotice, jobNoticeKey, noticeLimit, noticeMaxAgeMs, tellInterrupted } from "./health-alerts.mjs";

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

  it("does not call the LVM root lost when the sandbox's lsblk cannot see device-mapper volumes", () => {
    // What the web service's lsblk returns on the owner's server (PrivateDevices=yes): the disks
    // and partitions, but not /dev/mapper/ubuntu--vg-ubuntu--lv on nvme0n1p3. "/ lost its drive"
    // stood in the ledger from 2026-08-31 until this.
    const sandboxed = structuredClone(detached);
    sandboxed.storage.blockDevices.devices = [{ name: "/dev/sdb" }, { name: "/dev/sdb2" }, { name: "/dev/nvme0n1" }, { name: "/dev/nvme0n1p3" }];
    expect(evaluateHealth(sandboxed).map((alert) => alert.key)).toEqual(["storage.mount.detached:/mnt/the-dump"]);
    // Where the list does show device-mapper volumes, a mapper source missing from it is still judged.
    const listed = structuredClone(sandboxed);
    listed.storage.blockDevices.devices.push({ name: "/dev/mapper/other--vg-data" });
    expect(evaluateHealth(listed).map((alert) => alert.key)).toEqual(["storage.mount.detached:/", "storage.mount.detached:/mnt/the-dump"]);
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

  it("keeps a failing disk's alert while the scan leaves it asleep, and raises none for a healthy one (M36)", () => {
    const asleep = (lastHealth) => ({ storage: { smart: { disks: [{ device: "/dev/sdb", health: "unavailable", reason: "asleep", lastHealth, lastReadAt: "2026-09-28T06:00:00.000Z" }] } } });
    const [alert] = evaluateHealth(asleep("critical"));
    expect(alert).toMatchObject({ key: "storage.smart:/dev/sdb", priority: "high" });
    expect(alert.message).toMatch(/critical when it was last read.*asleep at the latest check/);
    expect(evaluateHealth(asleep("healthy"))).toEqual([]);
    expect(evaluateHealth(asleep(null))).toEqual([]);
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

  it("keeps who ran the run its words describe, through a later delivery, here and in the notification centre (sweep 3)", async () => {
    const recorded = [];
    const settings = new Map();
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn() };
    let target = null;
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications: { getTarget: () => target, send: vi.fn(async () => ({ sent: true })) }, store, now: at, history: { record: (entry) => recorded.push(entry), resolve: () => {} } });
    const automation = { key: "flow.failed:f1", title: "Automation stopped: Tidy", message: "Tidy stopped at step 2: the owner's error", actorId: "owner-1" };
    await alerts.raise(automation);
    expect(settings.get("healthAlertsState")[automation.key]).toMatchObject({ notified: false, actorId: "owner-1" });
    target = { kind: "ntfy" };
    await alerts.check();
    expect(settings.get("healthAlertsState")[automation.key]).toEqual({ since: "2026-09-27T03:00:00.000Z", title: automation.title, notified: true, actorId: "owner-1" });
    expect(recorded.map((entry) => [entry.delivered, entry.actorId])).toEqual([[false, "owner-1"], [true, "owner-1"]]);
    // A failure raised with nobody to name keeps that too; one raised without saying keeps nothing.
    await alerts.raise({ ...automation, key: "flow.failed:f2", actorId: null });
    await alerts.raise({ ...failure });
    expect(settings.get("healthAlertsState")["flow.failed:f2"]).toMatchObject({ actorId: null });
    expect(settings.get("healthAlertsState")[failure.key]).not.toHaveProperty("actorId");
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

describe("news pushed straight to the target, kept when it reaches no one (M27.2)", () => {
  function ledger({ target = { kind: "ntfy" }, send = vi.fn(async () => ({ sent: true })), at = "2026-09-27T03:00:00Z" } = {}) {
    const settings = new Map();
    const store = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn() };
    let current = target;
    let clock = new Date(at);
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications: { getTarget: () => current, send }, store, now: () => clock });
    return { alerts, send, store, state: () => settings.get("healthAlertsState") ?? {}, setTarget: (value) => { current = value; }, setClock: (value) => { clock = new Date(value); } };
  }
  const signIn = { key: "signin.new:owner-1:100.64.0.20", title: "New sign-in from 100.64.0.20", message: "alex signed in from 100.64.0.20 via password.", priority: "high" };

  it("is sent and forgotten when the target takes it", async () => {
    const { alerts, send, state } = ledger();
    expect(await alerts.tell(signIn)).toEqual({ key: signIn.key, notified: true });
    expect(send).toHaveBeenCalledWith({ title: `BoxPilot: ${signIn.title}`, message: signIn.message, priority: "high" });
    expect(state()).toEqual({}); // news, not a condition: nothing stands once it is told
  });

  it("is kept once per key without a target, and a round that finds one sends it and lets it go", async () => {
    const { alerts, send, state, setTarget, setClock } = ledger({ target: null });
    expect(await alerts.tell(signIn)).toMatchObject({ notified: false });
    setClock("2026-09-28T03:00:00Z");
    await alerts.tell({ ...signIn, message: "alex signed in again from 100.64.0.20." });
    expect(Object.keys(state())).toEqual([signIn.key]); // the same news twice is one entry
    expect(state()[signIn.key]).toEqual({ since: "2026-09-27T03:00:00.000Z", renewedAt: "2026-09-28T03:00:00.000Z", title: signIn.title, message: "alex signed in again from 100.64.0.20.", priority: "high", notified: false });
    await alerts.check();
    expect(state()[signIn.key]).toMatchObject({ notified: false }); // still nobody to tell

    setTarget({ kind: "ntfy" });
    expect((await alerts.check()).sent).toEqual([signIn.key]);
    expect(send).toHaveBeenCalledWith({ title: `BoxPilot: ${signIn.title}`, message: "alex signed in again from 100.64.0.20.", priority: "high" });
    expect(state()).toEqual({});
  });

  it("keeps one whose send failed, and a later delivery of the same news clears it", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("The notification target answered 502")).mockResolvedValue({ sent: true });
    const { alerts, state, store } = ledger({ send });
    expect(await alerts.tell(signIn)).toMatchObject({ notified: false });
    expect(state()[signIn.key]).toMatchObject({ notified: false });
    expect(store.recordAudit).toHaveBeenCalledWith("health.alert.failed", expect.objectContaining({ subjectId: signIn.key }));
    expect(await alerts.tell(signIn)).toMatchObject({ notified: true });
    expect(state()).toEqual({});
  });

  it("never grows a pile: the oldest go past the limit, and a month-old one is no longer news", async () => {
    const { alerts, state, setClock } = ledger({ target: null });
    await alerts.raise({ key: "schedule.failed:s1", title: "Scheduled task failed: Back up application data", message: "disk full" });
    const start = Date.parse("2026-09-01T00:00:00Z");
    for (let index = 0; index < noticeLimit + 5; index += 1) {
      setClock(new Date(start + index * 60 * 60_000).toISOString()); // one an hour
      await alerts.tell({ key: `signin.new:owner-1:100.64.0.${index}`, title: `New sign-in from 100.64.0.${index}`, message: "m" });
    }
    const notices = Object.keys(state()).filter(isNotice);
    expect(notices).toHaveLength(noticeLimit);
    expect(notices).not.toContain("signin.new:owner-1:100.64.0.0"); // the oldest went first
    expect(state()["schedule.failed:s1"]).toBeTruthy(); // conditions are not news and are never trimmed

    // A month after the tenth hour: the ones kept from hours 5 to 9 are past it, 10 onwards are not.
    setClock(new Date(start + noticeMaxAgeMs + 9.5 * 60 * 60_000).toISOString());
    await alerts.check();
    expect(Object.keys(state()).filter(isNotice)).toHaveLength(noticeLimit - 5);
    expect(state()["schedule.failed:s1"]).toBeTruthy();
  });

  it("ages news from its newest words, so news that replaced older news is not dropped as a month old", async () => {
    // A release, the weekly report and a drive's reconnect are each kept under one key, the newest
    // replacing the last. The month a notice is kept is counted from the newest of them.
    const { alerts, send, state, setTarget, setClock } = ledger({ target: null, at: "2026-09-01T00:00:00Z" });
    await alerts.tell({ key: "release.available", title: "Version 1.131.0 is available", message: "first" });
    setClock("2026-09-25T00:00:00Z");
    await alerts.tell({ key: "release.available", title: "Version 1.132.0 is available", message: "newest" });
    expect(state()["release.available"]).toMatchObject({ since: "2026-09-01T00:00:00.000Z", title: "Version 1.132.0 is available" });

    setClock("2026-10-02T00:00:00Z"); // a month after the first, a week after the newest
    await alerts.check();
    expect(state()["release.available"]).toMatchObject({ title: "Version 1.132.0 is available", notified: false });
    setTarget({ kind: "ntfy" });
    expect((await alerts.check()).sent).toEqual(["release.available"]);
    expect(send).toHaveBeenCalledWith({ title: "BoxPilot: Version 1.132.0 is available", message: "newest", priority: "default" });

    // A month after its newest words it is no longer news.
    setTarget(null);
    await alerts.tell({ key: "release.available", title: "Version 1.133.0 is available", message: "later" });
    setClock("2026-11-02T00:00:01Z");
    await alerts.check();
    expect(state()).toEqual({});
  });

  it("clears quietly: news nobody heard has nothing to resolve", async () => {
    const { alerts, send, state, setTarget } = ledger({ target: null });
    await alerts.tell({ key: "job.interrupted:apt.upgrade", title: "Install all package updates was interrupted", message: "m", priority: "high" });
    setTarget({ kind: "ntfy" });
    expect(await alerts.clear("job.interrupted:apt.upgrade")).toMatchObject({ cleared: true, sent: false });
    expect(send).not.toHaveBeenCalled();
    expect(state()).toEqual({});
  });
});

describe("jobs a restart cut off (M27.2)", () => {
  it("tells the ones started by hand, once per operation, and leaves scheduled runs and automation steps to their owners", async () => {
    const settings = new Map();
    const jobsById = {
      manual: { id: "manual", type: "op:apt.upgrade", title: "Install all package updates", parameters: {} },
      again: { id: "again", type: "op:apt.upgrade", title: "Install all package updates", parameters: {} },
      backup: { id: "backup", type: "op:app.backup", title: "Back up application data", parameters: { id: "immich" } },
      scheduled: { id: "scheduled", type: "op:app.backup", title: "Back up application data", parameters: { id: "jellyfin" } },
      step: { id: "step", type: "op:docker.prune", title: "Clean up Docker disk space", parameters: {} },
    };
    const store = {
      getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: vi.fn(),
      getJob: (id) => jobsById[id] ?? null,
      listFlows: () => [{ id: "f1", lastResult: "running step 2 of 3 (Clean up Docker disk space)", lastJobIds: ["earlier", "step"] }, { id: "f2", lastResult: "completed", lastJobIds: ["manual"] }],
    };
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications: { getTarget: () => null, send: vi.fn() }, store, now: () => new Date("2026-09-27T03:00:00Z") });
    const interrupted = Object.keys(jobsById).map((id) => ({ id, title: jobsById[id].title }));
    await tellInterrupted({ alerts, store, interrupted, owned: new Set(["scheduled"]) });
    const state = settings.get("healthAlertsState");
    expect(Object.keys(state).sort()).toEqual(["job.interrupted:app.backup:immich", "job.interrupted:apt.upgrade"]);
    expect(state["job.interrupted:apt.upgrade"]).toMatchObject({ title: "Install all package updates was interrupted", notified: false, priority: "high" });
    expect(state["job.interrupted:app.backup:immich"].title).toBe("Back up application data (immich) was interrupted");
    expect(jobNoticeKey("job.interrupted", jobsById.backup)).toBe("job.interrupted:app.backup:immich");
  });
});
