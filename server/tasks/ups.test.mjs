import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { onWindows } from "../../test/platform.mjs";
import { driverManager, modeFor, renderNotifyScript, renderNutConfig, renderShutdownScript, upsSetup, validateUpsSetup, writeOrder } from "./ups.mjs";
import { classifyUsbDevice, detectUsbUps } from "../ups-detect.mjs";
import { parsePowerEvents } from "../power-events.mjs";

/**
 * A server with NUT in memory. `manager` is how its drivers start (NUT 2.8's enumerator, 2.7's
 * single unit, or upsdrvctl by hand); `answers` is how many upsc probes fail before the UPS answers;
 * `monitorConnects` is whether upsmon shows up among upsd's clients.
 */
function nutHost({ manager = "enumerator", answers = 1, monitorConnects = true, driverJournal = "", status = "OL CHRG", extra = "" } = {}) {
  let probes = 0;
  const calls = [];
  const run = vi.fn(async (binary, args) => {
    const name = binary.split("/").at(-1);
    calls.push(`${name} ${args.join(" ")}`);
    if (name === "systemctl" && args[0] === "show") {
      const unit = args.at(-1);
      const loaded = (manager === "enumerator" && unit === "nut-driver-enumerator.service") || (manager === "unit" && unit === "nut-driver.service");
      return { ok: true, stdout: loaded ? "loaded" : "not-found", stderr: "" };
    }
    if (name === "upsc" && args[0] === "-c") return monitorConnects ? { ok: true, stdout: "127.0.0.1\n", stderr: "" } : { ok: true, stdout: "", stderr: "" };
    if (name === "upsc") {
      probes += 1;
      return probes >= answers
        ? { ok: true, stdout: `battery.charge: 97\nbattery.charge.low: 20\nbattery.runtime: 1500\nbattery.runtime.low: 300\nups.model: Back-UPS ES 700G\nups.status: ${status}\n${extra}`, stderr: "" }
        : { ok: false, stdout: "", stderr: "Error: Driver not connected" };
    }
    if (name === "journalctl") return { ok: true, stdout: driverJournal, stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
  return { run, calls };
}

function fakeFiles(existing = {}) {
  const state = { files: { ...existing }, modes: {}, copies: [] };
  return {
    state,
    readFile: vi.fn(async (file) => { if (file in state.files) return state.files[file]; const error = new Error("ENOENT"); error.code = "ENOENT"; throw error; }),
    writeFile: vi.fn(async (file, content, options) => { state.files[file] = content; state.modes[file] = options?.mode; }),
    appendFile: vi.fn(async (file, content) => { state.files[file] = `${state.files[file] ?? ""}${content}`; }),
    mkdir: vi.fn(async () => {}),
    copyFile: vi.fn(async (_from, to) => { state.copies.push(to); }),
    chmod: vi.fn(async (file, mode) => { state.modes[file] = mode; }),
    access: vi.fn(async () => {}),
  };
}

const eventsPath = "/var/lib/boxpilot-power/events.log";
const host = { installRoot: "/opt/boxpilot", nodeBinary: "/usr/local/bin/node", powerOff: "/sbin/shutdown -h +0", eventsPath };
const dependencies = (files, run, extra = {}) => ({ run, files, secret: () => "generated-pw", wait: async () => {}, now: () => new Date("2026-09-29T18:00:00Z"), host, eventsDirectory: "/var/lib/boxpilot-power", policyPath: "/var/lib/boxpilot-power/policy.json", ...extra });

describe("UPS detection", () => {
  it("recognises UPS makers by USB vendor id and by name, ignoring everything else", () => {
    expect(classifyUsbDevice({ idVendor: "051d", idProduct: "0002", manufacturer: "American Power Conversion", product: "Back-UPS ES 700G FW:871.O4 .I USB FW:O4" })).toMatchObject({ driver: "usbhid-ups", confidence: "vendor-id", manufacturer: "American Power Conversion" });
    expect(classifyUsbDevice({ idVendor: "0665", idProduct: "5161", manufacturer: null, product: null })).toMatchObject({ driver: "nutdrv_qx", manufacturer: "PowerWalker / BlueWalker" });
    expect(classifyUsbDevice({ idVendor: "abcd", idProduct: "0001", manufacturer: "Acme", product: "Smart-UPS clone" })).toMatchObject({ driver: "usbhid-ups", confidence: "name" });
    expect(classifyUsbDevice({ idVendor: "03f0", idProduct: "134a", manufacturer: "PixArt", product: "HP USB Optical Mouse" })).toBeNull();
  });

  // Linux only: expects POSIX paths.
  it.skipIf(onWindows)("walks sysfs and lists only UPS devices", async () => {
    const tree = {
      "/sys/bus/usb/devices/1-2/idVendor": "0764", "/sys/bus/usb/devices/1-2/idProduct": "0501", "/sys/bus/usb/devices/1-2/product": "CP1500PFCLCD",
      "/sys/bus/usb/devices/1-3/idVendor": "03f0", "/sys/bus/usb/devices/1-3/idProduct": "134a", "/sys/bus/usb/devices/1-3/product": "HP USB Optical Mouse",
    };
    const found = await detectUsbUps({ list: async () => ["1-2", "1-3", "usb1"], read: async (file) => { if (file in tree) return `${tree[file]}\n`; throw new Error("ENOENT"); } });
    expect(found).toEqual([{ vendorId: "0764", productId: "0501", manufacturer: "CyberPower", product: "CP1500PFCLCD", driver: "usbhid-ups", confidence: "vendor-id", sysfs: "1-2" }]);
  });
});

describe("the NUT configuration", () => {
  it("validates the parameters, thresholds included", () => {
    expect(validateUpsSetup({})).toBeNull();
    expect(validateUpsSetup({ driver: "magic" })).toContain("driver");
    expect(validateUpsSetup({ vendorId: "zz" })).toContain("vendorId");
    expect(validateUpsSetup({ lowBatteryPercent: 30, lowRuntimeSeconds: 300 })).toBeNull();
    expect(validateUpsSetup({ lowBatteryPercent: 5 })).toContain("lowBatteryPercent");
    expect(validateUpsSetup({ lowRuntimeSeconds: 30 })).toContain("lowRuntimeSeconds");
    expect(validateUpsSetup({ lowRuntimeSeconds: 90.5 })).toContain("lowRuntimeSeconds");
  });

  it("renders a standalone NUT bound to loopback, whose events and shutdown go through BoxPilot's scripts", () => {
    const files = renderNutConfig({ name: "ups", driver: "usbhid-ups", vendorId: "051d", description: "APC Back-UPS", monitorPassword: "pw123" });
    expect(files["nut.conf"]).toContain("MODE=standalone");
    expect(files["ups.conf"]).toContain("[ups]\n\tdriver = usbhid-ups\n\tport = auto\n\tvendorid = 051d\n\tdesc = \"APC Back-UPS\"");
    expect(files["ups.conf"]).not.toContain("ignorelb");
    expect(files["upsd.conf"]).toContain("LISTEN 127.0.0.1 3493");
    expect(files["upsd.users"]).toContain("[upsmon]\n\tpassword = pw123\n\tupsmon primary");
    expect(files["upsmon.conf"]).toContain("MONITOR ups@localhost 1 upsmon pw123 primary");
    expect(files["upsmon.conf"]).toContain('SHUTDOWNCMD "/etc/nut/boxpilot-shutdown"');
    expect(files["upsmon.conf"]).toContain("NOTIFYCMD /etc/nut/boxpilot-notify");
    // Without EXEC upsmon never runs the notify command.
    for (const type of ["ONLINE", "ONBATT", "LOWBATT", "FSD", "SHUTDOWN", "COMMBAD", "COMMOK", "REPLBATT", "NOCOMM"]) expect(files["upsmon.conf"]).toMatch(new RegExp(`^NOTIFYFLAG ${type} \\S*EXEC$`, "m"));
    expect(files["upsmon.conf"]).toContain("POWERDOWNFLAG /etc/killpower");
    expect(files["upsmon.conf"]).not.toContain("upssched");
  });

  it("gives the owner's thresholds to the driver in place of the UPS's own low-battery flag", () => {
    const both = renderNutConfig({ monitorPassword: "x", lowBatteryPercent: 40, lowRuntimeSeconds: 300 })["ups.conf"];
    expect(both).toContain("\tignorelb\n\toverride.battery.charge.low = 40\n\toverride.battery.runtime.low = 300\n");
    const one = renderNutConfig({ monitorPassword: "x", lowRuntimeSeconds: 600 })["ups.conf"];
    expect(one).toContain("\tignorelb\n\toverride.battery.runtime.low = 600\n");
    expect(one).not.toContain("charge.low");
  });

  it("with shutdown off, only notes the skipped shutdown and leaves no flag for a later reboot to cut the power with", () => {
    const files = renderNutConfig({ monitorPassword: "x", shutdownAtLowBattery: false });
    expect(files["upsmon.conf"]).not.toContain("POWERDOWNFLAG");
    expect(files["boxpilot-shutdown"]).toContain("note shutdown-skipped");
    expect(files["boxpilot-shutdown"]).not.toMatch(/shutdown -h|poweroff|boxpilot-ups-shutdown/);
  });

  it("powers off after BoxPilot's own preparation, bounded, whatever the preparation did", () => {
    const script = renderShutdownScript({ installRoot: "/opt/boxpilot", nodeBinary: "/usr/local/bin/node", powerOff: "/sbin/shutdown -h +0", eventsPath, seconds: 60 });
    const lines = script.trim().split("\n");
    expect(lines).toContain("  timeout 80 '/usr/local/bin/node' '/opt/boxpilot/scripts/boxpilot-ups-shutdown.mjs' --budget-seconds 60 || note apps-not-stopped");
    expect(lines.at(-1)).toBe("exec /sbin/shutdown -h +0");
    expect(lines.indexOf("note power-off")).toBeLessThan(lines.length - 1);
    // No `set -e`: nothing before the power-off may stop it.
    expect(script).not.toMatch(/set -e/);
  });

  it("maps every NUT event the monitor is told to report onto a name the log reader knows", () => {
    const script = renderNotifyScript({ name: "ups", eventsPath });
    for (const [type, event] of [["ONBATT", "on-battery"], ["ONLINE", "on-mains"], ["LOWBATT", "low-battery"], ["SHUTDOWN", "shutdown"], ["COMMBAD", "contact-lost"]]) expect(script).toContain(`  ${type}) event=${event} ;;`);
    expect(script).toContain("'ups@localhost'");
    expect(script).toContain("umask 022");
    expect(modeFor("boxpilot-notify")).toBe(0o755);
    expect(modeFor("upsd.users")).toBe(0o640);
    expect(modeFor("ups.conf")).toBe(0o640);
    expect(writeOrder(renderNutConfig({ monitorPassword: "x" })).at(-1)).toBe("ups.conf");
  });

  // Linux only: runs the rendered scripts with /bin/sh, as upsmon does.
  it.skipIf(onWindows)("scripts that sh accepts, and a notify script whose lines the reader reads back", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "bp-ups-"));
    try {
      const log = path.join(directory, "events.log");
      const fakeUpsc = path.join(directory, "upsc");
      writeFileSync(path.join(directory, "notify"), renderNotifyScript({ name: "ups", eventsPath: log }).replace("/usr/bin/upsc", fakeUpsc), { mode: 0o755 });
      writeFileSync(fakeUpsc, "#!/bin/sh\ncase \"$2\" in battery.charge) echo 87 ;; battery.runtime) echo 1260 ;; esac\n", { mode: 0o755 });
      writeFileSync(path.join(directory, "shutdown"), renderShutdownScript({ eventsPath: log, installRoot: directory, nodeBinary: "/nonexistent/node", powerOff: "/bin/true" }), { mode: 0o755 });
      execFileSync("sh", ["-n", path.join(directory, "notify")]);
      execFileSync("sh", ["-n", path.join(directory, "shutdown")]);
      execFileSync(path.join(directory, "notify"), ["UPS ups@localhost on battery"], { env: { NOTIFYTYPE: "ONBATT", UPSNAME: "ups@localhost", PATH: "/usr/bin:/bin" } });
      execFileSync(path.join(directory, "notify"), ["ignored"], { env: { NOTIFYTYPE: "CAL", PATH: "/usr/bin:/bin" } });
      execFileSync(path.join(directory, "shutdown"), [], { env: { PATH: "/usr/bin:/bin" } });
      const events = parsePowerEvents(execFileSync("cat", [log], { encoding: "utf8" }));
      expect(events.map((event) => event.event)).toEqual(["on-battery", "apps-not-stopped", "power-off"]);
      expect(events[0]).toMatchObject({ charge: 87, runtime: 1260 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("setting the UPS up", () => {
  it("stops the monitor, writes everything, restarts the driver through systemd, and starts the monitor last", async () => {
    const files = fakeFiles({ "/etc/nut/nut.conf": "MODE=none\n" });
    const { run, calls } = nutHost({ answers: 2 });
    const result = await upsSetup({ name: "ups", driver: "usbhid-ups", vendorId: "051d", description: "APC" }, dependencies(files, run));
    expect(result).toMatchObject({ configured: true, name: "ups", manager: "enumerator", status: "OL CHRG", batteryChargePercent: 97, model: "Back-UPS ES 700G", thresholds: { lowBatteryPercent: 20, lowRuntimeSeconds: 300 } });
    expect(files.state.copies).toEqual(["/etc/nut/nut.conf.before-boxpilot"]);
    expect(files.state.modes["/etc/nut/upsd.users"]).toBe(0o640);
    expect(files.state.modes["/etc/nut/boxpilot-shutdown"]).toBe(0o755);
    expect(files.state.files["/etc/nut/upsmon.conf"]).toContain("generated-pw");
    const order = (call) => calls.indexOf(call);
    expect(order("systemctl stop nut-monitor.service")).toBe(0);
    // NUT 2.8.4's own trigger is held while the files are written, and ups.conf is the last of them.
    expect(order("systemctl stop nut-driver-enumerator.path")).toBeLessThan(order("chown root:nut /etc/nut/nut.conf"));
    expect(calls.filter((call) => call.startsWith("chown root:nut")).at(-1)).toBe("chown root:nut /etc/nut/ups.conf");
    expect(order("systemctl start nut-driver-enumerator.path")).toBeGreaterThan(order("systemctl restart nut-driver-enumerator.service"));
    // Never `upsdrvctl start` beside NUT 2.8's driver units: they kill each other's copy.
    expect(calls.some((call) => call.startsWith("upsdrvctl"))).toBe(false);
    expect(order("systemctl restart nut-driver-enumerator.service")).toBeGreaterThan(0);
    expect(order("systemctl restart nut-driver@ups.service")).toBeGreaterThan(order("systemctl restart nut-driver-enumerator.service"));
    expect(order("systemctl restart nut-server.service")).toBeGreaterThan(order("systemctl restart nut-driver@ups.service"));
    // NUT 2.8.4 starts upsd at install with no UPS defined, until systemd's start limit refuses it.
    expect(order("systemctl reset-failed nut-server.service nut-monitor.service")).toBeLessThan(order("systemctl restart nut-server.service"));
    expect(order("systemctl restart nut-monitor.service")).toBeGreaterThan(order("upsc ups@localhost"));
    expect(order("upsc -c ups@localhost")).toBeGreaterThan(order("systemctl restart nut-monitor.service"));
    expect(calls).toContain("chown nut:nut /var/lib/boxpilot-power /var/lib/boxpilot-power/events.log");
  });

  it("logs that it is watching and records what it set up, for the pages", async () => {
    const files = fakeFiles();
    const { run } = nutHost();
    await upsSetup({ lowBatteryPercent: 40 }, dependencies(files, run));
    expect(parsePowerEvents(files.state.files[eventsPath])).toEqual([{ at: "2026-09-29T18:00:00.000Z", event: "watching", charge: 97, runtime: 1500 }]);
    expect(JSON.parse(files.state.files["/var/lib/boxpilot-power/policy.json"])).toEqual({ shutdownAtLowBattery: true, lowBatteryPercent: 20, lowRuntimeSeconds: 300, preparationSeconds: 60, configuredAt: "2026-09-29T18:00:00.000Z" });
    expect(files.state.modes["/var/lib/boxpilot-power/policy.json"]).toBe(0o644);
    expect(files.state.files["/var/lib/boxpilot-power/policy.json"]).not.toContain("generated-pw");
  });

  it("keeps an existing event log and does not treat BoxPilot's own scripts as someone else's files", async () => {
    const files = fakeFiles({ [eventsPath]: "2026-09-28T10:00:00Z on-battery\n", "/etc/nut/boxpilot-notify": renderNotifyScript({}) });
    const { run } = nutHost();
    await upsSetup({}, dependencies(files, run));
    expect(files.state.files[eventsPath].startsWith("2026-09-28T10:00:00Z on-battery\n")).toBe(true);
    expect(files.state.copies).not.toContain("/etc/nut/boxpilot-notify.before-boxpilot");
  });

  it("restarts NUT 2.7's single driver unit, and starts drivers by hand only where there is no unit", async () => {
    const legacy = nutHost({ manager: "unit" });
    await upsSetup({}, dependencies(fakeFiles(), legacy.run));
    expect(legacy.calls).toContain("systemctl restart nut-driver.service");
    const bare = nutHost({ manager: "upsdrvctl" });
    await upsSetup({}, dependencies(fakeFiles(), bare.run));
    expect(bare.calls.filter((call) => call.startsWith("upsdrvctl"))).toEqual(["upsdrvctl stop", "upsdrvctl start"]);
    expect(await driverManager(nutHost().run)).toBe("enumerator");
  });

  it("waits past NUT 2.8.4's WAIT for the UPS's own status", async () => {
    const host = nutHost({ answers: 1 });
    let probes = 0;
    const base = host.run.getMockImplementation();
    host.run.mockImplementation(async (binary, args) => {
      if (binary.endsWith("upsc") && args[0] === "ups@localhost") { probes += 1; if (probes < 3) return { ok: true, stdout: "driver.state: init.quiet\nups.status: WAIT\n", stderr: "" }; }
      return base(binary, args);
    });
    await expect(upsSetup({}, dependencies(fakeFiles(), host.run))).resolves.toMatchObject({ status: "OL CHRG", batteryChargePercent: 97 });
    expect(probes).toBe(3);
  });

  it("gives upsd a second try, and says what it said when that fails too", async () => {
    const flaky = nutHost();
    let tries = 0;
    const base = flaky.run.getMockImplementation();
    flaky.run.mockImplementation(async (binary, args) => {
      if (binary.endsWith("systemctl") && args[0] === "restart" && args[1] === "nut-server.service") { flaky.calls.push("systemctl restart nut-server.service"); tries += 1; return tries === 1 ? { ok: false, stdout: "", stderr: "Job for nut-server.service failed" } : { ok: true, stdout: "", stderr: "" }; }
      return base(binary, args);
    });
    await expect(upsSetup({}, dependencies(fakeFiles(), flaky.run))).resolves.toMatchObject({ configured: true });
    expect(flaky.calls).toContain("systemctl reset-failed nut-server.service");
    const broken = nutHost({ driverJournal: "Can't open /etc/nut/upsd.users: Permission denied" });
    const brokenBase = broken.run.getMockImplementation();
    broken.run.mockImplementation(async (binary, args) => (binary.endsWith("systemctl") && args[0] === "restart" && args[1] === "nut-server.service" ? { ok: false, stdout: "", stderr: "failed" } : brokenBase(binary, args)));
    await expect(upsSetup({}, dependencies(fakeFiles(), broken.run))).rejects.toThrow("Could not start nut-server: Can't open /etc/nut/upsd.users: Permission denied");
  });

  it("says what the driver said when the UPS never answers, and still starts the monitor", async () => {
    const { run, calls } = nutHost({ answers: 99, driverJournal: "No matching HID UPS found\nDriver failed to start (exit status=1)" });
    await expect(upsSetup({}, dependencies(fakeFiles(), run))).rejects.toThrow("did not report a status within 20 seconds; check the USB cable and the driver choice (the driver said: No matching HID UPS found Driver failed to start (exit status=1))");
    expect(calls).toContain("systemctl restart nut-monitor.service");
  });

  it("fails when the monitor never connects, since nothing would then shut the server down", async () => {
    const { run } = nutHost({ monitorConnects: false });
    await expect(upsSetup({}, dependencies(fakeFiles(), run))).rejects.toThrow("did not connect to the UPS server");
  });

  it("fails clearly when NUT is missing, and on parameters the operation would refuse", async () => {
    const missing = fakeFiles();
    missing.access = vi.fn(async () => { throw new Error("ENOENT"); });
    await expect(upsSetup({}, dependencies(missing, nutHost().run))).rejects.toThrow("not installed");
    await expect(upsSetup({ lowBatteryPercent: 3 }, dependencies(fakeFiles(), nutHost().run))).rejects.toThrow("Invalid UPS setup");
  });

  it("uses the simulated UPS only when a caller in code asks for it", async () => {
    const files = fakeFiles();
    await upsSetup({}, dependencies(files, nutHost().run, { simulated: { driver: "dummy-ups", port: "boxpilot-ci.dev" } }));
    expect(files.state.files["/etc/nut/ups.conf"]).toContain("\tdriver = dummy-ups\n\tport = boxpilot-ci.dev\n");
  });
});
