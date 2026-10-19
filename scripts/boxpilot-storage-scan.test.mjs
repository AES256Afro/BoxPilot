import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { carryLastReadings, collectFilesystemErrors, createStorageScanner, diskAsleep, needsSatRetry, parseSmartctlEvidence, smartEvidenceFor, usbBridgeUnrecognized, wakeAfterMs, weeklyWakeEnabled, writeStorageEvidence } from "./boxpilot-storage-scan.mjs";

const directories = [];
/** smartctl 7.4 --json output for USB disks, scrubbed: placeholder models, serials and USB ids. */
const fixture = (name) => readFile(path.join("test", "fixtures", "smartctl", `${name}.json`), "utf8");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("fixed root-only storage scan", () => {
  it("extracts only bounded health fields from smartctl JSON", () => {
    const result = parseSmartctlEvidence("/dev/nvme0n1", JSON.stringify({
      serial_number: "secret-serial",
      smart_status: { passed: true },
      temperature: { current: 43 },
      power_on_time: { hours: 100 },
      nvme_smart_health_information_log: { critical_warning: 0, percentage_used: 8, media_errors: 0, unsafe_shutdowns: 2 },
    }));
    expect(result).toMatchObject({ device: "/dev/nvme0n1", health: "healthy", passed: true, temperatureCelsius: 43, percentageUsed: 8 });
    expect(JSON.stringify(result)).not.toContain("secret-serial");
  });

  it("discovers fixed disk names and never accepts a browser path", async () => {
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("findmnt")) return { ok: true, stdout: JSON.stringify({ filesystems: [{ target: "/", source: "/dev/nvme0n1p2", fstype: "ext4", size: 1000, used: 500, avail: 500, "use%": "50%", options: "rw,relatime,password=secret" }] }) };
      if (binary.endsWith("lsblk") && args[0] === "--noheadings") return { ok: true, stdout: "nvme0n1p2" };
      if (binary.endsWith("lsblk")) return { ok: true, stdout: JSON.stringify({ blockdevices: [{ name: "/dev/nvme0n1", type: "disk" }, { name: "/dev/mapper/private", type: "disk" }, { name: "/dev/nvme0n1p1", type: "part" }] }) };
      expect(args).toEqual(["--json=c", "--all", "-n", "standby", "/dev/nvme0n1"]);
      return { ok: true, stdout: JSON.stringify({ smart_status: { passed: false }, serial_number: "secret" }) };
    });
    const loadFile = vi.fn(async (file) => file === "/sys/fs/ext4/nvme0n1p2/errors_count" ? "0\n" : Promise.reject(new Error("unexpected path")));
    const scanner = createStorageScanner({ run, loadFile, checkAccess: vi.fn(async () => {}), now: () => new Date("2026-08-16T05:00:00.000Z") });
    const result = await scanner.scan();
    expect(result).toMatchObject({ schemaVersion: 2, available: true, filesystems: { available: true, namespace: "host-pid1", mounts: [{ target: "/", readOnly: false, errorEvidence: { supported: true, state: "healthy", errorsCount: 0 } }], errors: { healthy: 1, critical: 0, unavailable: 0, unsupported: 0 } }, disks: [{ device: "/dev/nvme0n1", health: "critical" }], boundary: { mutationPerformed: false, browserTriggered: false, filesystemCheckTriggered: false } });
    expect(run).toHaveBeenCalledWith("/usr/bin/findmnt", ["--json", "--bytes", "--real", "--tab-file", "/proc/1/mountinfo", "--output", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%,OPTIONS"], { timeout: 10000 });
    expect(loadFile).toHaveBeenCalledWith("/sys/fs/ext4/nvme0n1p2/errors_count", "utf8");
    expect(run).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("writes fail-closed evidence when smartctl is not installed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-storage-scan-"));
    directories.push(directory);
    const outputPath = path.join(directory, "storage-health.json");
    const scanner = createStorageScanner({ run: vi.fn(async () => ({ ok: false, stdout: "" })), loadFile: vi.fn(async () => "0"), checkAccess: vi.fn(async () => { throw new Error("missing path secret"); }), now: () => new Date("2026-08-16T05:00:00.000Z") });
    await writeStorageEvidence({ outputPath, stateDirectory: directory, scanner });
    const contents = await readFile(outputPath, "utf8");
    expect(JSON.parse(contents)).toMatchObject({ schemaVersion: 2, available: false, reason: "smartctl-not-installed", disks: [], boundary: { filesystemCheckTriggered: false } });
    expect(contents).not.toContain("missing path secret");
  });

  it("reports ext4 counters and unsupported filesystems without running a filesystem check", async () => {
    const run = vi.fn(async (_binary, args) => args.at(-1) === "/dev/sda2" ? { ok: true, stdout: "sda2" } : { ok: false, stdout: "" });
    const result = await collectFilesystemErrors({ available: true, mounts: [
      { target: "/", source: "/dev/sda2", filesystem: "ext4" },
      { target: "/boot/efi", source: "/dev/sda1", filesystem: "vfat" },
      { target: "/srv", source: "[remote-or-virtual-source]", filesystem: "ext4" },
    ] }, { run, loadFile: vi.fn(async () => "3\n") });
    expect(result).toMatchObject({ errors: { healthy: 0, critical: 1, unavailable: 1, unsupported: 1 }, mounts: [
      { errorEvidence: { state: "critical", errorsCount: 3, reason: "errors-recorded" } },
      { errorEvidence: { state: "unsupported", supported: false } },
      { errorEvidence: { state: "unavailable", reason: "local-device-unavailable" } },
    ] });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("SMART through a USB bridge", () => {
  it("asks an unrecognised bridge again with -d sat and records that it answered that way", async () => {
    const direct = await fixture("usb-bridge-unknown");
    expect(usbBridgeUnrecognized(direct)).toBe(true);
    expect(parseSmartctlEvidence("/dev/sdb", direct)).toMatchObject({ health: "unavailable", reason: "unsupported-device" });
    // lsblk may not name the transport; the bridge message is enough to know this is USB.
    expect(needsSatRetry(null, direct)).toBe(true);
    const result = smartEvidenceFor("/dev/sdb", { transport: null, direct, sat: await fixture("usb-sat") });
    expect(result).toMatchObject({ device: "/dev/sdb", health: "healthy", passed: true, temperatureCelsius: 38, powerOnHours: 12034, transport: "usb", deviceType: "sat", reason: "ok" });
    expect(JSON.stringify(result)).not.toContain("PLACEHOLDER-SERIAL");
  });

  it("does not ask again when smartctl already knew the bridge and read the disk", async () => {
    const direct = await fixture("usb-bridge-known");
    expect(usbBridgeUnrecognized(direct)).toBe(false);
    expect(needsSatRetry("usb", direct)).toBe(false);
    expect(smartEvidenceFor("/dev/sdd", { transport: "usb", direct })).toMatchObject({ health: "healthy", transport: "usb", deviceType: "auto", reason: "ok" });
  });

  it("names a bridge that passes no SMART through as the enclosure's limit, not a failed read", async () => {
    const direct = await fixture("usb-scsi-no-smart");
    expect(usbBridgeUnrecognized(direct)).toBe(false);
    expect(needsSatRetry("usb", direct)).toBe(true);
    const result = smartEvidenceFor("/dev/sdc", { transport: "usb", direct, sat: await fixture("usb-sat-refused") });
    expect(result).toMatchObject({ device: "/dev/sdc", health: "unavailable", passed: null, transport: "usb", deviceType: "sat", reason: "usb-bridge-unsupported" });
    expect(JSON.stringify(result)).not.toContain("PLACEHOLDER-SERIAL");
  });

  it("keeps a device that could not be opened a failed read, since that says nothing about the bridge", async () => {
    const result = smartEvidenceFor("/dev/sdb", { transport: "usb", direct: await fixture("usb-bridge-unknown"), sat: await fixture("usb-open-failed") });
    expect(result).toMatchObject({ health: "unavailable", reason: "smartctl-read-failed" });
  });

  it("never asks an internal disk again", async () => {
    const direct = await fixture("usb-scsi-no-smart");
    expect(needsSatRetry("sata", direct)).toBe(false);
    expect(needsSatRetry(null, direct)).toBe(false);
    expect(smartEvidenceFor("/dev/sda", { transport: "sata", direct })).toMatchObject({ health: "unavailable", transport: "sata", deviceType: "auto", reason: "unsupported-device" });
  });

  it("scans a USB disk twice only when the first read did not answer", async () => {
    const outputs = { direct: await fixture("usb-bridge-unknown"), sat: await fixture("usb-sat") };
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("findmnt")) return { ok: true, stdout: JSON.stringify({ filesystems: [] }) };
      if (binary.endsWith("lsblk")) {
        expect(args).toEqual(["--json", "--paths", "--nodeps", "--output", "NAME,TYPE,TRAN"]);
        return { ok: true, stdout: JSON.stringify({ blockdevices: [{ name: "/dev/nvme0n1", type: "disk", tran: "nvme" }, { name: "/dev/sdb", type: "disk", tran: "usb" }] }) };
      }
      if (args.at(-1) === "/dev/nvme0n1") return { ok: true, stdout: JSON.stringify({ smart_status: { passed: true }, nvme_smart_health_information_log: { percentage_used: 3 } }) };
      if (args.includes("sat")) { expect(args).toEqual(["--json=c", "--all", "-n", "standby", "-d", "sat", "/dev/sdb"]); return { ok: true, stdout: outputs.sat }; }
      expect(args).toEqual(["--json=c", "--all", "-n", "standby", "/dev/sdb"]);
      return { ok: false, stdout: outputs.direct };
    });
    const scanner = createStorageScanner({ run, loadFile: vi.fn(async () => "0"), checkAccess: vi.fn(async () => {}), now: () => new Date("2026-09-28T06:00:00.000Z") });
    const result = await scanner.scan();
    expect(result.disks).toMatchObject([
      { device: "/dev/nvme0n1", health: "healthy", transport: "nvme", deviceType: "auto" },
      { device: "/dev/sdb", health: "healthy", transport: "usb", deviceType: "sat" },
    ]);
    expect(run.mock.calls.filter(([binary]) => binary.endsWith("smartctl"))).toHaveLength(3);
    expect(result.boundary).toMatchObject({ mutationPerformed: false, serialsIncluded: false });
  });
});

// M36: a check every six hours used to spin up every drive that had gone to sleep.
describe("a sleeping disk", () => {
  const asleepRun = (outputs) => vi.fn(async (binary, args) => {
    if (binary.endsWith("findmnt")) return { ok: true, stdout: JSON.stringify({ filesystems: [] }) };
    if (binary.endsWith("lsblk")) return { ok: true, stdout: JSON.stringify({ blockdevices: [{ name: "/dev/sdb", type: "disk", tran: "usb" }] }) };
    return args.includes("sat") ? outputs.sat : outputs.direct;
  });

  it("is left asleep and recorded as asleep, not as a failed read", async () => {
    const standby = await fixture("usb-standby");
    expect(diskAsleep(standby)).toBe(true);
    expect(diskAsleep(await fixture("usb-open-failed"))).toBe(false);
    expect(parseSmartctlEvidence("/dev/sdb", standby)).toMatchObject({ health: "unavailable", passed: null, reason: "asleep" });
  });

  it("is not asked a second time through its bridge, which would wake it", async () => {
    const standby = await fixture("usb-standby");
    expect(needsSatRetry("usb", standby)).toBe(false);
    const run = asleepRun({ direct: { ok: false, stdout: standby }, sat: { ok: true, stdout: await fixture("usb-sat") } });
    const scanner = createStorageScanner({ run, loadFile: vi.fn(async () => "0"), checkAccess: vi.fn(async () => {}), now: () => new Date("2026-09-29T06:00:00.000Z") });
    const result = await scanner.scan();
    expect(run.mock.calls.filter(([binary]) => binary.endsWith("smartctl")).map(([, args]) => args)).toEqual([["--json=c", "--all", "-n", "standby", "/dev/sdb"]]);
    // Every disk asleep is a quiet server, not a failed scan.
    expect(result).toMatchObject({ available: false, reason: "disks-asleep", disks: [{ device: "/dev/sdb", health: "unavailable", reason: "asleep", transport: "usb" }] });
  });

  it("asleep behind a bridge smartctl did not know is found asleep when asked through it", async () => {
    const result = smartEvidenceFor("/dev/sdb", { transport: "usb", direct: await fixture("usb-bridge-unknown"), sat: await fixture("usb-standby") });
    expect(result).toMatchObject({ health: "unavailable", reason: "asleep", transport: "usb", deviceType: "sat" });
  });

  it("keeps the health it had when it was last read, and when that was", () => {
    const previous = { generatedAt: "2026-09-28T00:00:00.000Z", disks: [
      { device: "/dev/sdb", health: "critical", reason: "ok", readAt: "2026-09-27T18:00:00.000Z" },
      { device: "/dev/sdc", health: "unavailable", reason: "asleep", lastHealth: "healthy", lastReadAt: "2026-09-20T06:00:00.000Z" },
      { device: "/dev/sdd", health: "healthy", reason: "ok" },
    ] };
    const now = { generatedAt: "2026-09-29T06:00:00.000Z", disks: [
      { device: "/dev/sdb", health: "unavailable", reason: "asleep" },
      { device: "/dev/sdc", health: "unavailable", reason: "asleep" },
      { device: "/dev/sdd", health: "unavailable", reason: "asleep" },
      { device: "/dev/sde", health: "unavailable", reason: "asleep" },
    ] };
    expect(carryLastReadings(now, previous).disks).toEqual([
      { device: "/dev/sdb", health: "unavailable", reason: "asleep", lastHealth: "critical", lastReadAt: "2026-09-27T18:00:00.000Z" },
      { device: "/dev/sdc", health: "unavailable", reason: "asleep", lastHealth: "healthy", lastReadAt: "2026-09-20T06:00:00.000Z" },
      // Read before readAt was recorded: the scan it came from is when.
      { device: "/dev/sdd", health: "unavailable", reason: "asleep", lastHealth: "healthy", lastReadAt: "2026-09-28T00:00:00.000Z" },
      { device: "/dev/sde", health: "unavailable", reason: "asleep" },
    ]);
    expect(carryLastReadings(now, null).disks).toEqual(now.disks);
  });

  it("carries the last reading through the evidence file it rewrites", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-storage-scan-"));
    directories.push(directory);
    const outputPath = path.join(directory, "storage-health.json");
    const scan = (disks, at) => ({ scan: async () => ({ schemaVersion: 2, generatedAt: at, available: true, reason: "fixed-root-scan", filesystems: { available: false }, disks, boundary: {} }) });
    await writeStorageEvidence({ outputPath, stateDirectory: directory, scanner: scan([{ device: "/dev/sdb", health: "healthy", reason: "ok", readAt: "2026-09-28T06:00:00.000Z" }], "2026-09-28T06:00:00.000Z") });
    await writeStorageEvidence({ outputPath, stateDirectory: directory, scanner: scan([{ device: "/dev/sdb", health: "unavailable", reason: "asleep" }], "2026-09-28T12:00:00.000Z") });
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    expect(written.disks[0]).toMatchObject({ reason: "asleep", lastHealth: "healthy", lastReadAt: "2026-09-28T06:00:00.000Z" });
  });
});

describe("the owner's weekly read of a drive that is always asleep", () => {
  const asleep = JSON.stringify({ smartctl: { messages: [{ string: "Device is in STANDBY mode, exit(2)" }] } });
  const awake = JSON.stringify({ smart_status: { passed: true }, temperature: { current: 31 }, power_on_time: { hours: 9000 } });
  const at = new Date("2026-10-19T06:00:00.000Z");
  /** One spinning disk that answers "asleep" to the polite read and its health to the waking one. */
  function sleepyDisk() {
    const smart = [];
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("findmnt")) return { ok: true, stdout: JSON.stringify({ filesystems: [] }) };
      if (binary.endsWith("lsblk")) return { ok: true, stdout: JSON.stringify({ blockdevices: [{ name: "/dev/sda", type: "disk", tran: "sata" }] }) };
      smart.push(args);
      return { ok: true, stdout: args.includes("standby") ? asleep : awake };
    });
    return { scanner: createStorageScanner({ run, checkAccess: async () => {}, now: () => at }), smart };
  }
  const readAgo = (ms) => ({ generatedAt: at.toISOString(), disks: [{ device: "/dev/sda", reason: "ok", health: "healthy", readAt: new Date(at.getTime() - ms).toISOString() }] });

  it("leaves it asleep unless the owner turned the weekly read on", async () => {
    const { scanner, smart } = sleepyDisk();
    const result = await scanner.scan({ wake: false, previous: readAgo(30 * 24 * 60 * 60 * 1000) });
    expect(result.disks[0]).toMatchObject({ reason: "asleep", health: "unavailable" });
    expect(smart.every((args) => args.includes("standby"))).toBe(true);
  });

  it("wakes it once it has gone a week unread, and records that it did", async () => {
    const { scanner, smart } = sleepyDisk();
    const result = await scanner.scan({ wake: true, previous: readAgo(wakeAfterMs) });
    expect(result.disks[0]).toMatchObject({ device: "/dev/sda", reason: "ok", health: "healthy", wokenForWeeklyRead: true, readAt: at.toISOString() });
    expect(smart.at(-1)).toEqual(["--json=c", "--all", "/dev/sda"]);
    // Never read awake at all counts as a week unread too.
    const never = sleepyDisk();
    expect((await never.scanner.scan({ wake: true, previous: null })).disks[0]).toMatchObject({ wokenForWeeklyRead: true });
  });

  it("leaves it asleep when it was read awake less than a week ago, including a reading carried while asleep", async () => {
    const recent = sleepyDisk();
    expect((await recent.scanner.scan({ wake: true, previous: readAgo(wakeAfterMs - 60_000) })).disks[0]).toMatchObject({ reason: "asleep" });
    expect(recent.smart.every((args) => args.includes("standby"))).toBe(true);
    const carried = sleepyDisk();
    const previous = { generatedAt: at.toISOString(), disks: [{ device: "/dev/sda", reason: "asleep", lastHealth: "healthy", lastReadAt: new Date(at.getTime() - 60 * 60 * 1000).toISOString() }] };
    expect((await carried.scanner.scan({ wake: true, previous })).disks[0]).toMatchObject({ reason: "asleep" });
  });

  it("reads the owner's choice from the database, read-only, and is off when it cannot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-wake-"));
    directories.push(directory);
    const databasePath = path.join(directory, "state.sqlite3");
    expect(weeklyWakeEnabled(databasePath)).toBe(false);
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL)");
    expect(weeklyWakeEnabled(databasePath)).toBe(false);
    db.prepare("INSERT INTO settings VALUES ('storageWeeklyWake', ?, NULL, '2026-10-19')").run(JSON.stringify({ enabled: true }));
    expect(weeklyWakeEnabled(databasePath)).toBe(true);
    db.prepare("UPDATE settings SET value_json = 'not json'").run();
    expect(weeklyWakeEnabled(databasePath)).toBe(false);
    db.close();
  });

  it("hands the scan the evidence it replaces and the owner's choice", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-wake-"));
    directories.push(directory);
    const scan = vi.fn(async () => ({ schemaVersion: 2, generatedAt: at.toISOString(), available: true, disks: [] }));
    const outputPath = path.join(directory, "storage-health.json");
    await writeStorageEvidence({ outputPath, stateDirectory: directory, scanner: { scan }, wake: () => true });
    await writeStorageEvidence({ outputPath, stateDirectory: directory, scanner: { scan }, wake: () => false });
    expect(scan.mock.calls[0][0]).toEqual({ wake: true, previous: null });
    expect(scan.mock.calls[1][0]).toMatchObject({ wake: false, previous: { generatedAt: at.toISOString() } });
  });
});
