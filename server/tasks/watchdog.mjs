import os from "node:os";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

/**
 * A frozen server restarts itself (M39.4): the hardware watchdog, and systemd pinging it.
 *
 * Most boards carry a watchdog timer in the chipset (on AMD the FCH's, driven by sp5100_tco; on
 * Intel the TCO timer, iTCO_wdt). Once something opens it, it must be told "still alive" within
 * its timeout or it resets the machine. systemd does the telling when RuntimeWatchdogSec= is set,
 * so a kernel or PID 1 that hangs stops the pings and the board restarts itself. RebootWatchdogSec=
 * bounds a reboot that hangs.
 *
 * Measured on Ubuntu 24.04 and 26.04 (tests/ubuntu/watchdog-softdog.sh): Ubuntu's kernel packages
 * list every watchdog driver as not to be loaded automatically (/lib/modprobe.d/blacklist_linux_*),
 * so a board with a watchdog usually shows no /dev/watchdog until the driver is loaded by name;
 * `systemctl daemon-reload` is enough for systemd to take RuntimeWatchdogSec= from a drop-in in
 * /etc/systemd/system.conf.d; and `wdctl` reads the device while systemd holds it.
 *
 * systemd-modules-load (the only thing that loads modules listed in modules-load.d at boot) honours
 * that blacklist, so turning the watchdog on also gives systemd-modules-load.service a drop-in that
 * loads the driver by name after it: `modprobe <name>` ignores the blacklist, which only stops
 * automatic loading. systemd opens the device when it appears, so the order at boot does not matter.
 *
 * A virtual machine's watchdog belongs to its host, and the kernel's software watchdog (softdog)
 * cannot restart a kernel that has frozen, so neither is offered.
 */

export const managedMarker = "# Managed by BoxPilot";
export const watchdogDropIn = "/etc/systemd/system.conf.d/90-boxpilot-watchdog.conf";
export const moduleLoadFile = "/etc/modules-load.d/boxpilot-watchdog.conf";
export const moduleLoadDropIn = "/etc/systemd/system/systemd-modules-load.service.d/boxpilot-watchdog.conf";
export const runtimeLimits = Object.freeze({ min: 30, max: 300, default: 60 });
export const rebootWatchdogSeconds = 600;
/** Hardware watchdog drivers by processor maker: the chipset timer every board of that maker has. */
export const chipsetDrivers = Object.freeze({ AuthenticAMD: "sp5100_tco", HygonGenuine: "sp5100_tco", GenuineIntel: "iTCO_wdt" });
const softwareIdentity = /^software watchdog$/i;
const modulePattern = /^[a-z0-9_]{2,40}$/;

const binaries = {
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  detectVirt: "/usr/bin/systemd-detect-virt",
  modprobe: "/usr/sbin/modprobe",
  wdctl: "/usr/bin/wdctl",
};

/** Seconds from systemd's time span ("1min", "10min", "1min 30s", "500ms", "0", "infinity"). */
export function parseTimespan(text) {
  const value = String(text ?? "").trim();
  if (value === "" ) return null;
  if (value === "infinity") return Number.POSITIVE_INFINITY;
  if (/^\d+$/.test(value)) return Number(value) / 1_000_000; // a bare number is microseconds (the USec property)
  const units = { us: 1e-6, ms: 1e-3, s: 1, sec: 1, min: 60, m: 60, h: 3600, hr: 3600, d: 86400 };
  let total = 0;
  for (const part of value.split(/\s+/)) {
    const match = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(part);
    if (!match || !(match[2] in units)) return null;
    total += Number(match[1]) * units[match[2]];
  }
  return Math.round(total * 1000) / 1000;
}

/** `wdctl -O`'s one line: `/dev/watchdog0: VERSION="0" IDENTITY="SP5100 TCO timer" TIMEOUT="60" ...`. */
export function parseWdctl(text) {
  const line = String(text ?? "").split("\n").find((entry) => /^\/dev\/watchdog\d*:/.test(entry.trim()));
  if (!line) return null;
  const device = line.trim().split(":")[0];
  const fields = Object.fromEntries([...line.matchAll(/([A-Z_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
  return { device, identity: fields.IDENTITY ?? null, timeoutSeconds: /^\d+$/.test(fields.TIMEOUT ?? "") ? Number(fields.TIMEOUT) : null };
}

/** Whether modprobe configuration says `blacklist <name>` anywhere. */
export function blacklisted(configs, name) {
  const pattern = new RegExp(`^\\s*blacklist\\s+${name}\\s*$`, "m");
  return configs.some((text) => pattern.test(String(text ?? "")));
}

/** Whether a module is on disk for this kernel, loadable or built in. */
export function moduleAvailable({ modulesDep = "", modulesBuiltin = "" }, name) {
  const file = new RegExp(`(^|/)${name.replace(/_/g, "[_-]")}\\.ko(\\.[a-z]+)?:?`, "m");
  return file.test(String(modulesDep)) ? "module" : file.test(String(modulesBuiltin)) ? "built-in" : null;
}

/** RuntimeWatchdogUSec, RebootWatchdogUSec and WatchdogDevice from `systemctl show`. */
export function parseManagerWatchdog(text) {
  const values = Object.fromEntries(String(text ?? "").split("\n").map((line) => line.split("=", 2)).filter((pair) => pair.length === 2));
  return {
    runtimeSeconds: parseTimespan(values.RuntimeWatchdogUSec),
    rebootSeconds: parseTimespan(values.RebootWatchdogUSec),
    device: values.WatchdogDevice || null,
  };
}

const read = (file) => readFile(file, "utf8").then((text) => text.trim(), () => null);

/** Each watchdog the kernel has, from /sys/class/watchdog (readable by anyone). */
export async function watchdogDevices({ root = "/sys/class/watchdog", list = readdir, readText = read } = {}) {
  const names = await list(root).catch(() => []);
  const devices = [];
  for (const name of names.filter((entry) => /^watchdog\d+$/.test(entry)).sort()) {
    const attribute = (key) => readText(`${root}/${name}/${key}`);
    const identity = await attribute("identity");
    const timeout = await attribute("timeout");
    devices.push({
      device: `/dev/${name}`,
      identity,
      software: softwareIdentity.test(identity ?? ""),
      state: await attribute("state"),
      timeoutSeconds: /^\d+$/.test(timeout ?? "") ? Number(timeout) : null,
      nowayout: (await attribute("nowayout")) === "1",
    });
  }
  return devices;
}

/** The first `vendor_id` in /proc/cpuinfo. */
export function cpuVendor(cpuinfo) {
  return /^vendor_id\s*:\s*(\S+)/m.exec(String(cpuinfo ?? ""))?.[1] ?? null;
}

/**
 * Everything about the watchdog, and whether it can be turned on here. Root-side (it reads the
 * kernel's module list, which the web process and the helper are kept from).
 *
 * state: "on" (systemd pings a hardware watchdog), "ready" (a hardware watchdog is there and off),
 * "loadable" (none yet, but this board's chipset driver is on disk: turning it on loads it),
 * "configured-no-device" (systemd is set to ping one and none is there: the driver did not load at
 * boot), "disabled-in-firmware" (the driver is loaded and found no timer), "virtual-machine",
 * "software-only" or "no-device".
 */
export async function inspectWatchdog({ run = fixedRun, readText = read, list = readdir, release = os.release() } = {}) {
  const [devices, cpuinfo, modulesDep, modulesBuiltin, loaded, shown, virt, dropIn] = await Promise.all([
    watchdogDevices({ list, readText }),
    readText("/proc/cpuinfo"),
    readText(`/lib/modules/${release}/modules.dep`),
    readText(`/lib/modules/${release}/modules.builtin`),
    readText("/proc/modules"),
    run(binaries.systemctl, ["show", "--property=RuntimeWatchdogUSec,RebootWatchdogUSec,WatchdogDevice"], { timeout: 15_000 }),
    run(binaries.detectVirt, ["--vm"], { timeout: 15_000 }),
    readText(watchdogDropIn),
  ]);
  const configs = [];
  for (const directory of ["/etc/modprobe.d", "/run/modprobe.d", "/lib/modprobe.d", "/usr/lib/modprobe.d"]) {
    for (const file of (await list(directory).catch(() => [])).filter((entry) => entry.endsWith(".conf"))) configs.push(await readText(`${directory}/${file}`));
  }
  const manager = shown.ok ? parseManagerWatchdog(shown.stdout) : { runtimeSeconds: null, rebootSeconds: null, device: null };
  // `systemd-detect-virt --vm` prints "none" and exits 1 on real hardware.
  const virtualization = (virt.stdout || "").trim() || (virt.ok ? "unknown" : "none");
  const vendor = cpuVendor(cpuinfo);
  const candidate = chipsetDrivers[vendor] ?? null;
  const driver = candidate ? {
    name: candidate,
    available: moduleAvailable({ modulesDep: modulesDep ?? "", modulesBuiltin: modulesBuiltin ?? "" }, candidate),
    loaded: new RegExp(`^${candidate}\\s`, "m").test(loaded ?? ""),
    blacklisted: blacklisted(configs, candidate),
  } : null;
  const hardware = devices.filter((device) => !device.software);
  const active = hardware.find((device) => device.state === "active") ?? null;
  const configured = (manager.runtimeSeconds ?? 0) > 0;
  const state = virtualization !== "none" ? "virtual-machine"
    : configured && active ? "on"
      : hardware.length ? "ready"
        : driver?.loaded ? "disabled-in-firmware"
          : configured && driver?.available ? "configured-no-device"
            : driver?.available ? "loadable"
              : devices.length ? "software-only" : "no-device";
  return {
    state,
    usable: ["on", "ready", "loadable", "configured-no-device"].includes(state),
    virtualization,
    devices,
    driver,
    runtimeSeconds: manager.runtimeSeconds,
    rebootSeconds: manager.rebootSeconds,
    managedByBoxPilot: Boolean(dropIn?.startsWith(managedMarker)),
  };
}

export function validateRuntimeSeconds(value) {
  return Number.isInteger(value) && value >= runtimeLimits.min && value <= runtimeLimits.max ? null : `runtimeSeconds must be a whole number from ${runtimeLimits.min} to ${runtimeLimits.max}`;
}

/** The drop-in that turns systemd's pinging on. */
export function renderWatchdogDropIn(runtimeSeconds) {
  return [
    `${managedMarker}: a hardware watchdog restarts this server if it freezes.`,
    `# systemd tells the watchdog it is alive every ${runtimeSeconds / 2} seconds; if the kernel or systemd hangs and the`,
    `# telling stops for ${runtimeSeconds} seconds, the board restarts itself. A reboot that hangs is cut off after ${rebootWatchdogSeconds / 60} minutes.`,
    "# Turn it off from BoxPilot (System > Hardware), or delete this file and run systemctl daemon-reload.",
    "[Manager]",
    `RuntimeWatchdogSec=${runtimeSeconds}s`,
    `RebootWatchdogSec=${rebootWatchdogSeconds / 60}min`,
    "",
  ].join("\n");
}

/** Loading the chipset's driver at boot despite Ubuntu's blacklist (see the top of this file). */
export function renderModuleFiles(module) {
  if (!modulePattern.test(module)) throw new Error("Invalid module name");
  return {
    [moduleLoadFile]: `${managedMarker}: the hardware watchdog's driver. Ubuntu lists it as not to be loaded automatically,\n# so ${moduleLoadDropIn} loads it by name as well.\n${module}\n`,
    [moduleLoadDropIn]: `${managedMarker}: load the hardware watchdog's driver by name, which the blacklist does not stop.\n[Service]\nExecStartPost=-${binaries.modprobe} ${module}\n`,
  };
}

const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function managerWatchdog(run) {
  const shown = await run(binaries.systemctl, ["show", "--property=RuntimeWatchdogUSec,RebootWatchdogUSec,WatchdogDevice"], { timeout: 15_000 });
  return shown.ok ? parseManagerWatchdog(shown.stdout) : { runtimeSeconds: null, rebootSeconds: null, device: null };
}

async function removeIfOurs(file, { readText, remove }) {
  const content = await readText(file);
  if (content === null) return false;
  if (!content.startsWith(managedMarker)) throw new Error(`${file} was not written by BoxPilot; it was left as it is`);
  await remove(file, { force: true });
  return true;
}

/**
 * Turn the watchdog on: the driver loaded (and kept loading at boot) if the device is not there
 * yet, the drop-in written, systemd reloaded, and proof that systemd took the setting and the
 * device is now running. Anything that does not check out is undone.
 */
export async function watchdogEnable({ runtimeSeconds = runtimeLimits.default } = {}, {
  run = fixedRun, log = null, inspect = inspectWatchdog,
  files = { readText: read, writeFile, mkdir, remove: rm }, wait = sleep, devices = watchdogDevices,
} = {}) {
  const problem = validateRuntimeSeconds(runtimeSeconds);
  if (problem) throw new Error(problem);
  const found = await inspect({ run });
  if (found.state === "virtual-machine") throw new Error(`This is a virtual machine (${found.virtualization}): what a hang does is its host's decision, so BoxPilot does not turn a watchdog on here`);
  if (found.state === "software-only") throw new Error("Only the kernel's software watchdog is here, and it cannot restart a kernel that has frozen, so BoxPilot does not use it");
  if (found.state === "no-device") throw new Error("No hardware watchdog was found on this board, and no driver for one is installed");
  if (found.state === "disabled-in-firmware") throw new Error(`${found.driver.name} is loaded but found no watchdog: it is most likely switched off in the firmware settings`);
  const written = [];
  const undo = async () => {
    for (const file of written.reverse()) await files.remove(file, { force: true }).catch(() => {});
    await run(binaries.systemctl, ["daemon-reload"], { timeout: 60_000 });
  };

  let hardware = found.devices.filter((device) => !device.software);
  if (hardware.length === 0 && found.driver?.available) {
    log?.(`Loading ${found.driver.name}, the watchdog driver for this chipset${found.driver.blacklisted ? " (Ubuntu does not load it by itself)" : ""}`, "stdout");
    const loaded = await run(binaries.modprobe, [found.driver.name], { timeout: 30_000 });
    for (let attempt = 0; attempt < 10 && hardware.length === 0; attempt += 1) {
      hardware = (await devices()).filter((device) => !device.software);
      if (hardware.length === 0) await wait(500);
    }
    if (hardware.length === 0) {
      await run(binaries.modprobe, ["-r", found.driver.name], { timeout: 30_000 });
      throw new Error(`${found.driver.name} ${loaded.ok ? "loaded but found no watchdog" : `did not load (${tail(loaded.stderr) || "no reason given"})`}: it is most likely switched off in the firmware settings. Nothing was changed`);
    }
    for (const [file, content] of Object.entries(renderModuleFiles(found.driver.name))) {
      await files.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true, mode: 0o755 });
      await files.writeFile(file, content, { mode: 0o644 });
      written.push(file);
    }
    log?.(`${found.driver.name} loads at every boot from now on (${moduleLoadFile}, ${moduleLoadDropIn})`, "stdout");
  }
  const device = hardware[0];
  if (!device) throw new Error("No hardware watchdog is there to turn on");
  if (device.nowayout && written.length) await undo();
  if (device.nowayout) throw new Error(`${device.identity ?? device.device} cannot be stopped once it has started (nowayout), so it could never be turned off again without a restart; BoxPilot leaves it off`);

  await files.mkdir("/etc/systemd/system.conf.d", { recursive: true, mode: 0o755 });
  await files.writeFile(watchdogDropIn, renderWatchdogDropIn(runtimeSeconds), { mode: 0o644 });
  written.push(watchdogDropIn);
  log?.(`Wrote ${watchdogDropIn}: RuntimeWatchdogSec=${runtimeSeconds}s, RebootWatchdogSec=${rebootWatchdogSeconds / 60}min`, "stdout");
  try {
    const reload = await run(binaries.systemctl, ["daemon-reload"], { timeout: 60_000 });
    if (!reload.ok) throw new Error(`systemctl daemon-reload failed: ${tail(reload.stderr)}`);
    let manager = await managerWatchdog(run);
    if (manager.runtimeSeconds !== runtimeSeconds) {
      // An older systemd reads system.conf only when it re-executes.
      log?.("systemd did not take the setting on a reload; re-executing it", "stdout");
      await run(binaries.systemctl, ["daemon-reexec"], { timeout: 60_000 });
      manager = await managerWatchdog(run);
    }
    if (manager.runtimeSeconds !== runtimeSeconds) throw new Error(`systemd reports RuntimeWatchdogUSec=${manager.runtimeSeconds ?? "unknown"}s, not ${runtimeSeconds}s`);
    log?.(`systemctl show: RuntimeWatchdogUSec is ${runtimeSeconds}s, RebootWatchdogUSec is ${manager.rebootSeconds}s`, "stdout");
    let running = null;
    for (let attempt = 0; attempt < 10 && !running; attempt += 1) {
      running = (await devices()).find((entry) => !entry.software && entry.state === "active") ?? null;
      if (!running) await wait(500);
    }
    if (!running) throw new Error(`systemd took the setting but ${device.device} did not start`);
    const shown = await run(binaries.wdctl, ["-O", running.device], { timeout: 15_000 });
    const card = shown.ok ? parseWdctl(shown.stdout) : null;
    log?.(`wdctl: ${card ? `${card.device}, ${card.identity}, timeout ${card.timeoutSeconds} s` : "could not read the device"}; it is running`, "stdout");
    return { on: true, runtimeSeconds, rebootSeconds: manager.rebootSeconds, device: running.device, identity: running.identity ?? card?.identity ?? null, timeoutSeconds: card?.timeoutSeconds ?? running.timeoutSeconds, driverLoadedAtBoot: written.includes(moduleLoadFile) };
  } catch (error) {
    await undo();
    throw new Error(`${error.message}; the change was undone`);
  }
}

/** Turn it off: BoxPilot's files removed, systemd reloaded, and proof that it stopped pinging. */
export async function watchdogDisable(_parameters = {}, { run = fixedRun, log = null, files = { readText: read, remove: rm }, devices = watchdogDevices, wait = sleep } = {}) {
  const current = (await devices()).find((device) => !device.software && device.state === "active");
  if (current?.nowayout) throw new Error(`${current.identity ?? current.device} cannot be stopped once started (nowayout): turning systemd's pinging off would restart the server within ${current.timeoutSeconds ?? "its"} seconds. Nothing was changed`);
  const removed = [];
  for (const file of [watchdogDropIn, moduleLoadDropIn, moduleLoadFile]) if (await removeIfOurs(file, files)) removed.push(file);
  if (removed.length === 0) log?.("BoxPilot had not turned the watchdog on; nothing to remove", "stdout");
  else log?.(`Removed ${removed.join(", ")}`, "stdout");
  const reload = await run(binaries.systemctl, ["daemon-reload"], { timeout: 60_000 });
  if (!reload.ok) throw new Error(`systemctl daemon-reload failed: ${tail(reload.stderr)}`);
  const manager = await managerWatchdog(run);
  if ((manager.runtimeSeconds ?? 0) > 0) throw new Error(`systemd still has RuntimeWatchdogSec=${manager.runtimeSeconds}s from another file (systemd-analyze cat-config systemd/system.conf shows which)`);
  let still = true;
  for (let attempt = 0; attempt < 10 && still; attempt += 1) {
    still = (await devices()).some((device) => !device.software && device.state === "active");
    if (still) await wait(500);
  }
  log?.(still ? "systemd stopped pinging, but the device still reports itself active" : "systemd stopped pinging and the watchdog is stopped", still ? "stderr" : "stdout");
  return { on: false, removed, stopped: !still };
}
