import { describe, expect, it, vi } from "vitest";
import { blacklisted, cpuVendor, inspectWatchdog, moduleAvailable, moduleLoadDropIn, moduleLoadFile, parseManagerWatchdog, parseTimespan, parseWdctl, renderModuleFiles, renderWatchdogDropIn, watchdogDevices, watchdogDisable, watchdogDropIn, watchdogEnable } from "./watchdog.mjs";

const blacklist = "# Kernel supplied blacklist\nblacklist iTCO_wdt\nblacklist softdog\nblacklist sp5100_tco\n";

/**
 * A machine in memory: its /sys/class/watchdog, /proc and /lib/modules, what systemd reports and
 * whether it is a VM. `load` says what `modprobe <driver>` makes appear.
 */
function machine({ virt = "none", cpu = "AuthenticAMD", sys = {}, modulesDep = "kernel/drivers/watchdog/sp5100_tco.ko.zst:\n", procModules = "", runtime = "0", reboot = "10min", load = null, reloadTakes = true, dropIn = null } = {}) {
  const files = {
    "/proc/cpuinfo": `processor\t: 0\nvendor_id\t: ${cpu}\n`,
    "/lib/modules/6.17.0/modules.dep": modulesDep,
    "/lib/modules/6.17.0/modules.builtin": "",
    "/proc/modules": procModules,
    "/lib/modprobe.d/blacklist_linux_6.17.0.conf": blacklist,
    ...(dropIn ? { [watchdogDropIn]: dropIn } : {}),
  };
  const watchdogs = { ...sys };
  const manager = { runtime, reboot };
  const calls = [];
  const run = vi.fn(async (binary, args) => {
    const name = binary.split("/").at(-1);
    calls.push(`${name} ${args.join(" ")}`);
    if (name === "systemd-detect-virt") return virt === "none" ? { ok: false, code: 1, stdout: "none", stderr: "" } : { ok: true, stdout: virt, stderr: "" };
    if (name === "systemctl" && args[0] === "show") return { ok: true, stdout: `RuntimeWatchdogUSec=${manager.runtime}\nRebootWatchdogUSec=${manager.reboot}\nWatchdogDevice=`, stderr: "" };
    if (name === "systemctl" && args[0] === "daemon-reload") {
      const text = files[watchdogDropIn];
      if (reloadTakes) {
        manager.runtime = text ? `${Math.round(Number(/RuntimeWatchdogSec=(\d+)s/.exec(text)[1]) / 60)}min` : "0";
        for (const device of Object.values(watchdogs)) device.state = text ? "active" : "inactive";
      }
      return { ok: true, stdout: "", stderr: "" };
    }
    if (name === "modprobe" && args[0] !== "-r") { if (load) Object.assign(watchdogs, load); return load ? { ok: true, stdout: "", stderr: "" } : { ok: false, stdout: "", stderr: "modprobe: ERROR: could not insert 'sp5100_tco': No such device" }; }
    if (name === "wdctl") return { ok: true, stdout: '/dev/watchdog0: VERSION="0" IDENTITY="SP5100 TCO timer" TIMEOUT="60" TIMELEFT="58"', stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
  const readText = vi.fn(async (file) => {
    const device = /^\/sys\/class\/watchdog\/(watchdog\d+)\/(\w+)$/.exec(file);
    if (device) { const value = watchdogs[device[1]]?.[device[2]]; return value === undefined ? null : String(value); }
    return file in files ? files[file] : null;
  });
  const list = vi.fn(async (directory) => {
    if (directory === "/sys/class/watchdog") return Object.keys(watchdogs);
    const names = Object.keys(files).filter((file) => file.startsWith(`${directory}/`)).map((file) => file.slice(directory.length + 1));
    if (names.length) return names;
    throw new Error("ENOENT");
  });
  const fileSystem = {
    readText, mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (file, content) => { files[file] = content; }),
    remove: vi.fn(async (file) => { delete files[file]; }),
  };
  const devices = () => watchdogDevices({ list, readText });
  const inspect = ({ run: runner }) => inspectWatchdog({ run: runner, readText, list, release: "6.17.0" });
  return { run, calls, files, watchdogs, manager, readText, list, fileSystem, devices, inspect };
}

const sp5100 = { identity: "SP5100 TCO timer", timeout: 60, state: "inactive", nowayout: 0 };
const softdog = { identity: "Software Watchdog", timeout: 60, state: "inactive", nowayout: 0 };

describe("reading systemd, wdctl and the kernel", () => {
  it("parses systemd's time spans and its watchdog properties", () => {
    expect(parseTimespan("1min")).toBe(60);
    expect(parseTimespan("10min")).toBe(600);
    expect(parseTimespan("1min 30s")).toBe(90);
    expect(parseTimespan("45s")).toBe(45);
    expect(parseTimespan("0")).toBe(0);
    expect(parseTimespan("60000000")).toBe(60);
    expect(parseTimespan("infinity")).toBe(Number.POSITIVE_INFINITY);
    expect(parseTimespan("soon")).toBeNull();
    expect(parseManagerWatchdog("RuntimeWatchdogUSec=1min\nRebootWatchdogUSec=10min\nWatchdogDevice=\n")).toEqual({ runtimeSeconds: 60, rebootSeconds: 600, device: null });
  });

  it("reads wdctl's one-line form, as 24.04 and 26.04 print it", () => {
    expect(parseWdctl('/dev/watchdog0: VERSION="0" IDENTITY="Software Watchdog" TIMEOUT="60" PRETIMEOUT="0" KEEPALIVEPING="1"')).toEqual({ device: "/dev/watchdog0", identity: "Software Watchdog", timeoutSeconds: 60 });
    expect(parseWdctl('/dev/watchdog0: VERSION="0" IDENTITY="SP5100 TCO timer" TIMEOUT="60" PRETIMEOUT="0" TIMELEFT="0"')).toMatchObject({ identity: "SP5100 TCO timer" });
    expect(parseWdctl("wdctl: cannot open /dev/watchdog0")).toBeNull();
  });

  it("finds the chipset driver on disk, on the blacklist, and for which processor", () => {
    expect(moduleAvailable({ modulesDep: "kernel/drivers/watchdog/sp5100_tco.ko.zst:\n" }, "sp5100_tco")).toBe("module");
    expect(moduleAvailable({ modulesDep: "kernel/drivers/watchdog/iTCO_wdt.ko: kernel/drivers/watchdog/iTCO_vendor_support.ko\n" }, "iTCO_wdt")).toBe("module");
    expect(moduleAvailable({ modulesBuiltin: "kernel/drivers/watchdog/sp5100_tco.ko\n" }, "sp5100_tco")).toBe("built-in");
    expect(moduleAvailable({ modulesDep: "kernel/drivers/watchdog/softdog.ko.zst:\n" }, "sp5100_tco")).toBeNull();
    expect(blacklisted([blacklist], "sp5100_tco")).toBe(true);
    expect(blacklisted(["# blacklist sp5100_tco\n"], "sp5100_tco")).toBe(false);
    expect(cpuVendor("processor\t: 0\nvendor_id\t: AuthenticAMD\n")).toBe("AuthenticAMD");
  });
});

describe("what the watchdog can do here", () => {
  it("an AMD board on Ubuntu: no device yet, the driver on disk and blacklisted, so turning it on loads it", async () => {
    const host = machine();
    const found = await host.inspect({ run: host.run });
    expect(found).toMatchObject({ state: "loadable", usable: true, virtualization: "none", devices: [], driver: { name: "sp5100_tco", available: "module", loaded: false, blacklisted: true }, runtimeSeconds: 0, rebootSeconds: 600, managedByBoxPilot: false });
  });

  it("an Intel board with its timer already there", async () => {
    const host = machine({ cpu: "GenuineIntel", modulesDep: "kernel/drivers/watchdog/iTCO_wdt.ko:\n", procModules: "iTCO_wdt 16384 0 - Live 0x0\n", sys: { watchdog0: { ...sp5100, identity: "iTCO_wdt" } } });
    await expect(host.inspect({ run: host.run })).resolves.toMatchObject({ state: "ready", driver: { name: "iTCO_wdt", loaded: true } });
  });

  it("a virtual machine, whatever it has", async () => {
    const host = machine({ virt: "kvm", sys: { watchdog0: softdog } });
    await expect(host.inspect({ run: host.run })).resolves.toMatchObject({ state: "virtual-machine", usable: false, virtualization: "kvm" });
  });

  it("only the software watchdog, a driver that found nothing, and nothing at all", async () => {
    const soft = machine({ modulesDep: "kernel/drivers/watchdog/softdog.ko:\n", sys: { watchdog0: softdog } });
    await expect(soft.inspect({ run: soft.run })).resolves.toMatchObject({ state: "software-only", usable: false });
    const off = machine({ procModules: "sp5100_tco 12288 0 - Live 0x0\n" });
    await expect(off.inspect({ run: off.run })).resolves.toMatchObject({ state: "disabled-in-firmware", usable: false });
    const none = machine({ cpu: "SomethingElse", modulesDep: "" });
    await expect(none.inspect({ run: none.run })).resolves.toMatchObject({ state: "no-device", usable: false, driver: null });
  });

  it("on, and set up but with no device at this boot", async () => {
    const on = machine({ runtime: "1min", procModules: "sp5100_tco 1 0\n", sys: { watchdog0: { ...sp5100, state: "active" } }, dropIn: renderWatchdogDropIn(60) });
    await expect(on.inspect({ run: on.run })).resolves.toMatchObject({ state: "on", runtimeSeconds: 60, managedByBoxPilot: true });
    const missing = machine({ runtime: "1min" });
    await expect(missing.inspect({ run: missing.run })).resolves.toMatchObject({ state: "configured-no-device", usable: true });
  });
});

describe("turning it on", () => {
  const wait = async () => {};

  it("loads the driver, keeps it loading at boot, writes the drop-in, reloads, and proves it runs", async () => {
    const host = machine({ load: { watchdog0: { ...sp5100 } } });
    const log = vi.fn();
    const result = await watchdogEnable({ runtimeSeconds: 60 }, { run: host.run, log, inspect: host.inspect, files: host.fileSystem, wait, devices: host.devices });
    expect(result).toEqual({ on: true, runtimeSeconds: 60, rebootSeconds: 600, device: "/dev/watchdog0", identity: "SP5100 TCO timer", timeoutSeconds: 60, driverLoadedAtBoot: true });
    expect(host.calls).toContain("modprobe sp5100_tco");
    expect(host.files[watchdogDropIn]).toContain("[Manager]\nRuntimeWatchdogSec=60s\nRebootWatchdogSec=10min\n");
    expect(host.files[moduleLoadFile]).toContain("\nsp5100_tco\n");
    expect(host.files[moduleLoadDropIn]).toContain("[Service]\nExecStartPost=-/usr/sbin/modprobe sp5100_tco\n");
    expect(host.calls.indexOf("systemctl daemon-reload")).toBeGreaterThan(host.calls.indexOf("modprobe sp5100_tco"));
    expect(host.calls).toContain("wdctl -O /dev/watchdog0");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Ubuntu does not load it by itself"), "stdout");
  });

  it("with the device already there, writes only the drop-in", async () => {
    const host = machine({ procModules: "sp5100_tco 1 0\n", sys: { watchdog0: { ...sp5100 } } });
    const result = await watchdogEnable({ runtimeSeconds: 120 }, { run: host.run, inspect: host.inspect, files: host.fileSystem, wait, devices: host.devices });
    expect(result).toMatchObject({ on: true, runtimeSeconds: 120, driverLoadedAtBoot: false });
    expect(host.calls.some((call) => call.startsWith("modprobe"))).toBe(false);
    expect(host.files[moduleLoadFile]).toBeUndefined();
  });

  it("re-executes systemd when a reload does not take the setting", async () => {
    const host = machine({ procModules: "sp5100_tco 1 0\n", sys: { watchdog0: { ...sp5100 } }, reloadTakes: false });
    host.run.mockImplementation(async (binary, args) => {
      const name = binary.split("/").at(-1);
      host.calls.push(`${name} ${args.join(" ")}`);
      if (name === "systemd-detect-virt") return { ok: false, code: 1, stdout: "none", stderr: "" };
      if (name === "systemctl" && args[0] === "daemon-reexec") { host.manager.runtime = "1min"; host.watchdogs.watchdog0.state = "active"; }
      if (name === "systemctl" && args[0] === "show") return { ok: true, stdout: `RuntimeWatchdogUSec=${host.manager.runtime}\nRebootWatchdogUSec=10min\n`, stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    await expect(watchdogEnable({ runtimeSeconds: 60 }, { run: host.run, inspect: host.inspect, files: host.fileSystem, wait, devices: host.devices })).resolves.toMatchObject({ on: true });
    expect(host.calls).toContain("systemctl daemon-reexec");
  });

  it("undoes everything when systemd never takes it", async () => {
    const host = machine({ load: { watchdog0: { ...sp5100 } }, reloadTakes: false });
    await expect(watchdogEnable({ runtimeSeconds: 60 }, { run: host.run, inspect: host.inspect, files: host.fileSystem, wait, devices: host.devices })).rejects.toThrow("the change was undone");
    expect(host.files[watchdogDropIn]).toBeUndefined();
    expect(host.files[moduleLoadFile]).toBeUndefined();
    expect(host.files[moduleLoadDropIn]).toBeUndefined();
  });

  it("refuses a virtual machine, the software watchdog, a timer switched off in the firmware, and one that can never be stopped", async () => {
    const vm = machine({ virt: "kvm" });
    await expect(watchdogEnable({}, { run: vm.run, inspect: vm.inspect, files: vm.fileSystem, wait, devices: vm.devices })).rejects.toThrow("virtual machine (kvm)");
    const soft = machine({ modulesDep: "", sys: { watchdog0: softdog } });
    await expect(watchdogEnable({}, { run: soft.run, inspect: soft.inspect, files: soft.fileSystem, wait, devices: soft.devices })).rejects.toThrow("cannot restart a kernel that has frozen");
    const off = machine({ load: null });
    await expect(watchdogEnable({}, { run: off.run, inspect: off.inspect, files: off.fileSystem, wait, devices: off.devices })).rejects.toThrow("switched off in the firmware settings. Nothing was changed");
    expect(off.calls).toContain("modprobe -r sp5100_tco");
    const stubborn = machine({ load: { watchdog0: { ...sp5100, nowayout: 1 } } });
    await expect(watchdogEnable({}, { run: stubborn.run, inspect: stubborn.inspect, files: stubborn.fileSystem, wait, devices: stubborn.devices })).rejects.toThrow("cannot be stopped once it has started");
    expect(stubborn.files[moduleLoadFile]).toBeUndefined();
    expect(stubborn.files[watchdogDropIn]).toBeUndefined();
    await expect(watchdogEnable({ runtimeSeconds: 5 })).rejects.toThrow("from 30 to 300");
  });
});

describe("turning it off", () => {
  it("removes BoxPilot's files, reloads, and proves systemd stopped", async () => {
    const host = machine({ runtime: "1min", sys: { watchdog0: { ...sp5100, state: "active" } }, dropIn: renderWatchdogDropIn(60) });
    for (const [file, content] of Object.entries(renderModuleFiles("sp5100_tco"))) host.files[file] = content;
    const result = await watchdogDisable({}, { run: host.run, files: host.fileSystem, devices: host.devices, wait: async () => {} });
    expect(result).toEqual({ on: false, removed: [watchdogDropIn, moduleLoadDropIn, moduleLoadFile], stopped: true });
    expect(host.manager.runtime).toBe("0");
  });

  it("leaves files it did not write, and a watchdog that cannot stop", async () => {
    const theirs = machine({ runtime: "1min", sys: { watchdog0: { ...sp5100, state: "active" } }, dropIn: "[Manager]\nRuntimeWatchdogSec=30s\n" });
    await expect(watchdogDisable({}, { run: theirs.run, files: theirs.fileSystem, devices: theirs.devices, wait: async () => {} })).rejects.toThrow("was not written by BoxPilot");
    const stubborn = machine({ runtime: "1min", sys: { watchdog0: { ...sp5100, state: "active", nowayout: 1 } }, dropIn: renderWatchdogDropIn(60) });
    await expect(watchdogDisable({}, { run: stubborn.run, files: stubborn.fileSystem, devices: stubborn.devices, wait: async () => {} })).rejects.toThrow("would restart the server within 60 seconds");
    expect(stubborn.files[watchdogDropIn]).toBeDefined();
  });

  it("says so when another file still turns it on", async () => {
    const host = machine({ runtime: "30s", sys: { watchdog0: { ...sp5100, state: "active" } } });
    host.run.mockImplementation(async (binary, args) => (binary.endsWith("systemctl") && args[0] === "show" ? { ok: true, stdout: "RuntimeWatchdogUSec=30s\nRebootWatchdogUSec=10min\n", stderr: "" } : { ok: true, stdout: "", stderr: "" }));
    await expect(watchdogDisable({}, { run: host.run, files: host.fileSystem, devices: host.devices, wait: async () => {} })).rejects.toThrow("from another file");
  });
});
