import { randomBytes } from "node:crypto";
import { access, appendFile, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";
import { appendPowerEvent, formatPowerEvent, notifyEvents, powerEventsDirectory, powerEventsPath, powerPolicyPath } from "../power-events.mjs";

/**
 * Root-side UPS (Network UPS Tools) setup executed by scripts/boxpilot-run.mjs (M39.1).
 *
 * Writes a complete standalone NUT configuration for one USB UPS: the driver, the local server
 * bound to loopback, a monitor user with a generated password, and upsmon set to shut this server
 * down cleanly when the UPS reports a low battery. Existing files are kept as *.before-boxpilot.
 * Nothing is reachable from the network: upsd listens on 127.0.0.1.
 *
 * Two scripts go beside the configuration. boxpilot-notify writes each power event (on battery,
 * back on mains, low battery, the shutdown) to the power-event log the System page and Home read.
 * boxpilot-shutdown is what upsmon runs when the battery is low: it stops the apps and unmounts
 * the drives the way BoxPilot's own reboot does (scripts/boxpilot-ups-shutdown.mjs, bounded), and
 * then powers off whatever that did.
 *
 * Measured on NUT 2.8 (Ubuntu 24.04 and 26.04, tests/ubuntu/ups-power-events.sh): the drivers are
 * systemd units there (nut-driver@<name>, made by nut-driver-enumerator from ups.conf), and a
 * driver started beside them with `upsdrvctl start` kills the unit's copy and is killed in turn.
 * upsmon, seeing its UPS stop answering while on battery, then shuts the server down. So the
 * monitor is stopped while the driver is reconfigured, and started again last.
 *
 * On 2.8.4 (26.04) the package enables and starts upsd at install, when ups.conf defines no UPS:
 * it fails ("at least one UPS must be defined") until systemd stops restarting it ("start request
 * repeated too quickly"), and systemd then refuses every start, the enumerator's included, until
 * `systemctl reset-failed`. So the units are reset before they are started. The enumerator's path
 * trigger fires on each write to ups.conf and restarts upsd itself; it is held while the files are
 * written, and ups.conf goes last, so the enumerator runs once, on the finished configuration.
 */

export const nutDirectory = "/etc/nut";
export const managedMarker = "# Managed by BoxPilot";
export const drivers = Object.freeze(["usbhid-ups", "nutdrv_qx", "riello_usb", "blazer_usb", "apcsmart", "snmp-ups"]);
export const upsNamePattern = /^[a-z][a-z0-9_-]{0,31}$/;
const hexPattern = /^[0-9a-f]{4}$/;
/** How long the shutdown gives the apps and drives before it powers off regardless. */
export const shutdownPreparationSeconds = 60;
/** Low-battery thresholds the owner may set; outside these the server would shut down too late or far too early. */
export const thresholdLimits = Object.freeze({ percent: { min: 10, max: 90 }, runtimeSeconds: { min: 120, max: 1800 } });

const binaries = {
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  journalctl: process.env.BOXPILOT_JOURNALCTL_BINARY ?? "/usr/bin/journalctl",
  upsc: "/usr/bin/upsc",
  upsdrvctl: "/sbin/upsdrvctl",
  chown: "/usr/bin/chown",
};

/** Where the scripts find BoxPilot and what they power off with; the real-host test points them elsewhere. */
export const defaultHost = Object.freeze({
  installRoot: "/opt/boxpilot",
  nodeBinary: "/usr/local/bin/node",
  powerOff: "/sbin/shutdown -h +0",
  eventsPath: powerEventsPath,
});

const inRange = (value, { min, max }) => value === null || value === undefined || (Number.isInteger(value) && value >= min && value <= max);

export function validateUpsSetup({ name = "ups", driver = "usbhid-ups", vendorId = null, productId = null, shutdownAtLowBattery = true, lowBatteryPercent = null, lowRuntimeSeconds = null } = {}) {
  if (!upsNamePattern.test(String(name))) return "name must be lower-case letters, digits, underscore, hyphen (max 32)";
  if (!drivers.includes(driver)) return `driver must be one of ${drivers.join(", ")}`;
  if (vendorId !== null && !hexPattern.test(String(vendorId))) return "vendorId must be four hex digits";
  if (productId !== null && !hexPattern.test(String(productId))) return "productId must be four hex digits";
  if (typeof shutdownAtLowBattery !== "boolean") return "shutdownAtLowBattery must be true or false";
  if (!inRange(lowBatteryPercent, thresholdLimits.percent)) return `lowBatteryPercent must be a whole number from ${thresholdLimits.percent.min} to ${thresholdLimits.percent.max}`;
  if (!inRange(lowRuntimeSeconds, thresholdLimits.runtimeSeconds)) return `lowRuntimeSeconds must be a whole number from ${thresholdLimits.runtimeSeconds.min} to ${thresholdLimits.runtimeSeconds.max}`;
  return null;
}

/**
 * The notify script upsmon runs (as the `nut` user) for each event: one line in the power-event
 * log, with the battery's charge and runtime when the UPS answers. It rotates the log itself,
 * keeping the last 500 lines once it passes 128 KiB, and never fails upsmon.
 */
export function renderNotifyScript({ name = "ups", eventsPath = powerEventsPath } = {}) {
  const cases = Object.entries(notifyEvents).map(([type, event]) => `  ${type}) event=${event} ;;`);
  return [
    "#!/bin/sh",
    `${managedMarker}: upsmon runs this for each UPS event (NOTIFYCMD in upsmon.conf).`,
    "# It adds one line to the power-event log that BoxPilot's System page and Home read.",
    "umask 022",
    `log='${eventsPath}'`,
    'case "${NOTIFYTYPE:-}" in',
    ...cases,
    "  *) exit 0 ;;",
    "esac",
    "number() {",
    `  value="$(timeout 5 ${binaries.upsc} '${name}@localhost' "$1" 2>/dev/null)"`,
    '  case "$value" in',
    "    ''|*[!0-9.]*) ;;",
    '    *) printf \' %s=%s\' "$2" "$value" ;;',
    "  esac",
    "}",
    'fields="$(number battery.charge charge)$(number battery.runtime runtime)"',
    'if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 131072 ]; then',
    '  tail -n 500 "$log" > "$log.new" && mv "$log.new" "$log"',
    "fi",
    'printf \'%s %s%s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event" "$fields" >> "$log" 2>/dev/null',
    "exit 0",
    "",
  ].join("\n");
}

/**
 * The shutdown command upsmon runs (as root) when the battery is low. With shutdown turned off it
 * only notes that it was skipped. Otherwise it gives BoxPilot at most `seconds` (and the node
 * process a little more before `timeout` stops it) to stop the apps and unmount the drives, notes
 * the power-off, and powers off whatever happened before.
 */
export function renderShutdownScript({ shutdownAtLowBattery = true, eventsPath = powerEventsPath, installRoot = defaultHost.installRoot, nodeBinary = defaultHost.nodeBinary, powerOff = defaultHost.powerOff, seconds = shutdownPreparationSeconds } = {}) {
  const note = [
    "note() {",
    '  printf \'%s %s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$log" 2>/dev/null || true',
    "}",
  ];
  if (!shutdownAtLowBattery) {
    return [
      "#!/bin/sh",
      `${managedMarker}: upsmon runs this when the UPS battery is low (SHUTDOWNCMD in upsmon.conf).`,
      "# Shutting down is turned off in BoxPilot, so this only notes that it was skipped.",
      "umask 022",
      `log='${eventsPath}'`,
      ...note,
      "note shutdown-skipped",
      "exit 0",
      "",
    ].join("\n");
  }
  const script = `${installRoot}/scripts/boxpilot-ups-shutdown.mjs`;
  return [
    "#!/bin/sh",
    `${managedMarker}: upsmon runs this when the UPS battery is low (SHUTDOWNCMD in upsmon.conf).`,
    `# It stops the apps and unmounts the drives the way BoxPilot's reboot does, for at most ${seconds} seconds,`,
    "# then powers off. The power-off happens whatever the preparation did.",
    "umask 022",
    `log='${eventsPath}'`,
    ...note,
    `if [ -x '${nodeBinary}' ] && [ -f '${script}' ]; then`,
    `  timeout ${seconds + 20} '${nodeBinary}' '${script}' --budget-seconds ${seconds} || note apps-not-stopped`,
    "else",
    "  note apps-not-stopped",
    "fi",
    "note power-off",
    "sync",
    `exec ${powerOff}`,
    "",
  ].join("\n");
}

/** Render every NUT file and both scripts. Pure. */
export function renderNutConfig({ name = "ups", driver = "usbhid-ups", port = null, vendorId = null, productId = null, description = "UPS", monitorPassword, shutdownAtLowBattery = true, lowBatteryPercent = null, lowRuntimeSeconds = null, host = defaultHost } = {}) {
  const thresholds = lowBatteryPercent !== null || lowRuntimeSeconds !== null;
  const upsConf = [
    managedMarker, "",
    `[${name}]`,
    `\tdriver = ${driver}`,
    `\tport = ${port ?? (driver === "snmp-ups" ? "localhost" : "auto")}`,
    ...(vendorId ? [`\tvendorid = ${vendorId}`] : []),
    ...(productId ? [`\tproductid = ${productId}`] : []),
    `\tdesc = "${description.replace(/"/g, "")}"`,
    "\tpollinterval = 5",
    // The owner's thresholds replace the UPS's own: the driver raises "low battery" itself when the
    // charge or the runtime left falls below them, and ignores the UPS's own low-battery flag.
    ...(thresholds ? ["\tignorelb"] : []),
    ...(lowBatteryPercent !== null ? [`\toverride.battery.charge.low = ${lowBatteryPercent}`] : []),
    ...(lowRuntimeSeconds !== null ? [`\toverride.battery.runtime.low = ${lowRuntimeSeconds}`] : []),
    "",
  ].join("\n");
  const exec = (flags) => `${flags}+EXEC`;
  const upsmonConf = [
    managedMarker, "",
    `MONITOR ${name}@localhost 1 upsmon ${monitorPassword} primary`,
    "MINSUPPLIES 1",
    `SHUTDOWNCMD "${nutDirectory}/boxpilot-shutdown"`,
    `NOTIFYCMD ${nutDirectory}/boxpilot-notify`,
    "POLLFREQ 5",
    "POLLFREQALERT 5",
    "HOSTSYNC 15",
    "DEADTIME 15",
    // The UPS switches its outlets off shortly after this server has shut down, and on again when
    // the mains returns, so the server starts again (with the firmware set to power on after a
    // power loss) even when the mains came back before the battery ran out. Only with shutdown on:
    // otherwise the flag would be left for the next ordinary reboot to cut the power with.
    ...(shutdownAtLowBattery ? ["POWERDOWNFLAG /etc/killpower"] : []),
    `NOTIFYFLAG ONLINE ${exec("SYSLOG+WALL")}`,
    `NOTIFYFLAG ONBATT ${exec("SYSLOG+WALL")}`,
    `NOTIFYFLAG LOWBATT ${exec("SYSLOG+WALL")}`,
    `NOTIFYFLAG FSD ${exec("SYSLOG+WALL")}`,
    `NOTIFYFLAG COMMOK ${exec("SYSLOG")}`,
    `NOTIFYFLAG COMMBAD ${exec("SYSLOG")}`,
    `NOTIFYFLAG SHUTDOWN ${exec("SYSLOG+WALL")}`,
    `NOTIFYFLAG REPLBATT ${exec("SYSLOG+WALL")}`,
    `NOTIFYFLAG NOCOMM ${exec("SYSLOG")}`,
    "RBWARNTIME 43200",
    "NOCOMMWARNTIME 300",
    "FINALDELAY 5",
    "",
  ].join("\n");
  return {
    "nut.conf": `${managedMarker}\nMODE=standalone\n`,
    "ups.conf": upsConf,
    "upsd.conf": `${managedMarker}\nLISTEN 127.0.0.1 3493\nMAXAGE 15\n`,
    "upsd.users": `${managedMarker}\n\n[upsmon]\n\tpassword = ${monitorPassword}\n\tupsmon primary\n`,
    "upsmon.conf": upsmonConf,
    "boxpilot-notify": renderNotifyScript({ name, eventsPath: host.eventsPath }),
    "boxpilot-shutdown": renderShutdownScript({ shutdownAtLowBattery, eventsPath: host.eventsPath, installRoot: host.installRoot, nodeBinary: host.nodeBinary, powerOff: host.powerOff }),
  };
}

/** Each file's mode: NUT's configuration is the nut group's to read, as the package ships it; the scripts everyone's to run. */
export function modeFor(file) {
  return file.startsWith("boxpilot-") ? 0o755 : 0o640;
}

/** The order the files are written in: ups.conf last, since writing it is what starts NUT's enumerator. */
export function writeOrder(files) {
  return Object.keys(files).sort((a, b) => Number(a === "ups.conf") - Number(b === "ups.conf"));
}

const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");

/** `key: value` lines from upsc, as a lookup. */
export function upscValues(text) {
  const values = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

const numberOrNull = (value) => (value !== undefined && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null);

/**
 * How the drivers are started on this system: NUT 2.8's enumerator and per-UPS units, NUT 2.7's
 * single nut-driver.service, or upsdrvctl by hand where neither exists.
 */
export async function driverManager(run) {
  const loaded = async (unit) => {
    const shown = await run(binaries.systemctl, ["show", "--property=LoadState", "--value", unit], { timeout: 15_000 });
    return shown.ok && shown.stdout.trim() === "loaded";
  };
  if (await loaded("nut-driver-enumerator.service")) return "enumerator";
  if (await loaded("nut-driver.service")) return "unit";
  return "upsdrvctl";
}

export async function upsSetup(parameters = {}, {
  run = fixedRun, log = null,
  files = { readFile, writeFile, appendFile, mkdir, copyFile, chmod, access },
  secret = () => randomBytes(18).toString("base64url"),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
  host = defaultHost,
  // The real-host test's simulated UPS (NUT's dummy-ups); never reachable through the operation.
  simulated = null,
  eventsDirectory = powerEventsDirectory, policyPath = powerPolicyPath,
} = {}) {
  const { name = "ups", driver = "usbhid-ups", vendorId = null, productId = null, description = "UPS", shutdownAtLowBattery = true, lowBatteryPercent = null, lowRuntimeSeconds = null } = parameters;
  const problem = validateUpsSetup({ name, driver, vendorId, productId, shutdownAtLowBattery, lowBatteryPercent, lowRuntimeSeconds });
  if (problem) throw new Error(`Invalid UPS setup: ${problem}`);
  const installed = await files.access(binaries.upsc).then(() => true, () => false);
  if (!installed) throw new Error("NUT is not installed; install the nut package from the System page first");

  // 1. The monitor stops first: while the driver restarts the UPS stops answering, and a monitor
  // that sees that while the UPS is on battery shuts the server down.
  const stopped = await run(binaries.systemctl, ["stop", "nut-monitor.service"], { timeout: 60_000 });
  if (!stopped.ok) log?.(`nut-monitor did not stop: ${tail(stopped.stderr)}`, "stderr");

  // 2. The configuration, the scripts, and the log they write to, with NUT's own trigger held.
  const manager = await driverManager(run);
  if (manager === "enumerator") await run(binaries.systemctl, ["stop", "nut-driver-enumerator.path"], { timeout: 30_000 });
  const monitorPassword = secret();
  const rendered = renderNutConfig({
    name, driver: simulated?.driver ?? driver, port: simulated?.port ?? null, vendorId, productId,
    description: String(description).slice(0, 60), monitorPassword, shutdownAtLowBattery, lowBatteryPercent, lowRuntimeSeconds, host,
  });
  await files.mkdir(nutDirectory, { recursive: true, mode: 0o755 });
  for (const file of writeOrder(rendered)) {
    const content = rendered[file];
    const target = `${nutDirectory}/${file}`;
    const previous = await files.readFile(target, "utf8").catch(() => null);
    const ours = previous !== null && (previous.startsWith(managedMarker) || previous.startsWith(`#!/bin/sh\n${managedMarker}`));
    if (previous !== null && !ours) { await files.copyFile(target, `${target}.before-boxpilot`); log?.(`Kept the original ${target} as ${target}.before-boxpilot`, "stdout"); }
    await files.writeFile(target, content, { mode: modeFor(file) });
    // writeFile's mode applies only to a new file; an existing one keeps the mode it had.
    await files.chmod(target, modeFor(file));
    await run(binaries.chown, ["root:nut", target], { timeout: 10_000 }).catch(() => {});
  }
  await files.mkdir(eventsDirectory, { recursive: true, mode: 0o755 });
  const eventsPath = host.eventsPath;
  const existing = await files.readFile(eventsPath, "utf8").catch(() => null);
  if (existing === null) await files.writeFile(eventsPath, "", { mode: 0o644 });
  await files.chmod(eventsPath, 0o644);
  // The notify script runs as `nut`: it appends to the log and rotates it inside this directory.
  await run(binaries.chown, ["nut:nut", eventsDirectory, eventsPath], { timeout: 10_000 });
  log?.(`Wrote NUT configuration for ${name} (${simulated?.driver ?? driver}); upsd listens on 127.0.0.1 only; power events go to ${eventsPath}`, "stdout");

  // 3. The driver, the way this NUT starts drivers.
  const driverUnit = manager === "enumerator" ? `nut-driver@${name}.service` : manager === "unit" ? "nut-driver.service" : null;
  if (manager === "enumerator") {
    const enumerated = await run(binaries.systemctl, ["restart", "nut-driver-enumerator.service"], { timeout: 60_000 });
    if (!enumerated.ok) throw new Error(`nut-driver-enumerator could not read the new ups.conf: ${tail(enumerated.stderr)}`);
    const restarted = await run(binaries.systemctl, ["restart", driverUnit], { timeout: 60_000 });
    if (!restarted.ok) log?.(`${driverUnit}: ${tail(restarted.stderr)}`, "stderr");
    await run(binaries.systemctl, ["start", "nut-driver-enumerator.path"], { timeout: 30_000 });
  } else if (manager === "unit") {
    const restarted = await run(binaries.systemctl, ["restart", driverUnit], { timeout: 60_000 });
    if (!restarted.ok) log?.(`${driverUnit}: ${tail(restarted.stderr)}`, "stderr");
  } else {
    await run(binaries.upsdrvctl, ["stop"], { timeout: 60_000 });
    const started = await run(binaries.upsdrvctl, ["start"], { timeout: 60_000 });
    if (!started.ok) log?.(`upsdrvctl start: ${tail(started.stderr) || tail(started.stdout)}`, "stderr");
  }

  // 4. The server, enabled for the next boot, and a status from the UPS through it. Reset first:
  // units that failed at install have hit systemd's start limit, which refuses any start.
  for (const unit of ["nut-server.service", "nut-monitor.service"]) {
    const enable = await run(binaries.systemctl, ["enable", unit], { timeout: 60_000 });
    if (!enable.ok) log?.(`${unit}: ${tail(enable.stderr)}`, "stderr");
  }
  await run(binaries.systemctl, ["reset-failed", "nut-server.service", "nut-monitor.service"], { timeout: 15_000 });
  let server = await run(binaries.systemctl, ["restart", "nut-server.service"], { timeout: 60_000 });
  if (!server.ok) {
    log?.(`nut-server did not start the first time (${tail(server.stderr)}); trying once more`, "stderr");
    await run(binaries.systemctl, ["reset-failed", "nut-server.service"], { timeout: 15_000 });
    await wait(2000);
    server = await run(binaries.systemctl, ["restart", "nut-server.service"], { timeout: 60_000 });
  }
  let status = null;
  if (server.ok) {
    for (let attempt = 0; attempt < 10 && !status; attempt += 1) {
      const probe = await run(binaries.upsc, [`${name}@localhost`], { timeout: 10_000 });
      // NUT 2.8.4 says "WAIT" while a driver is still starting: that is not the UPS answering.
      if (probe.ok && /^ups\.status:\s*(?!WAIT\s*$)\S/m.test(probe.stdout)) status = probe.stdout;
      else await wait(2000);
    }
  }
  // 5. The monitor again, even when the UPS did not answer: it is what shuts the server down, and
  // it warns about a UPS it cannot reach.
  const monitor = await run(binaries.systemctl, ["restart", "nut-monitor.service"], { timeout: 60_000 });
  if (!server.ok) {
    const journal = await run(binaries.journalctl, ["-u", "nut-server.service", "-n", "4", "--no-pager", "-o", "cat"], { timeout: 15_000 });
    throw new Error(`Could not start nut-server: ${journal.ok && journal.stdout.trim() ? tail(journal.stdout) : tail(server.stderr)}`);
  }
  if (!status) {
    const journal = driverUnit ? await run(binaries.journalctl, ["-u", driverUnit, "-n", "4", "--no-pager", "-o", "cat"], { timeout: 15_000 }) : null;
    throw new Error(`NUT started but the UPS did not report a status within 20 seconds; check the USB cable and the driver choice${journal?.ok && journal.stdout.trim() ? ` (the driver said: ${tail(journal.stdout)})` : ""}`);
  }
  if (!monitor.ok) throw new Error(`Could not start nut-monitor, so nothing would shut the server down: ${tail(monitor.stderr)}`);
  // The monitor is only protecting the server once it has logged in to upsd.
  let watching = false;
  for (let attempt = 0; attempt < 10 && !watching; attempt += 1) {
    const clients = await run(binaries.upsc, ["-c", `${name}@localhost`], { timeout: 10_000 });
    if (clients.ok && /^(127\.0\.0\.1|::1)$/m.test(clients.stdout)) watching = true;
    else await wait(1000);
  }
  if (!watching) throw new Error("nut-monitor started but did not connect to the UPS server within 10 seconds, so nothing would shut the server down; its journal says why");

  const values = upscValues(status);
  const charge = numberOrNull(values.get("battery.charge"));
  const runtime = numberOrNull(values.get("battery.runtime"));
  await appendPowerEvent("watching", { ...(charge !== null ? { charge } : {}), ...(runtime !== null ? { runtime } : {}) }, { path: eventsPath, now: now(), append: files.appendFile ?? appendFile });
  const thresholds = { lowBatteryPercent: numberOrNull(values.get("battery.charge.low")), lowRuntimeSeconds: numberOrNull(values.get("battery.runtime.low")) };
  const policy = { shutdownAtLowBattery, lowBatteryPercent: thresholds.lowBatteryPercent ?? lowBatteryPercent, lowRuntimeSeconds: thresholds.lowRuntimeSeconds ?? lowRuntimeSeconds, preparationSeconds: shutdownPreparationSeconds, configuredAt: now().toISOString() };
  await files.writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o644 });
  await files.chmod(policyPath, 0o644);
  log?.(`UPS ${name} reports status "${values.get("ups.status")}", battery ${charge ?? "?"}%; the monitor is connected`, "stdout");
  log?.(shutdownAtLowBattery
    ? `When the UPS says its battery is low${thresholds.lowBatteryPercent !== null ? ` (below ${thresholds.lowBatteryPercent}%` : ""}${thresholds.lowRuntimeSeconds !== null ? `${thresholds.lowBatteryPercent !== null ? " or" : " (under"} ${Math.round(thresholds.lowRuntimeSeconds / 60)} min left)` : thresholds.lowBatteryPercent !== null ? ")" : ""}, apps stop, drives unmount and the server powers off`
    : "Shutting down on a low battery is off: the events are logged and the server runs until the battery is empty", "stdout");
  return {
    configured: true, name, driver, manager,
    status: values.get("ups.status") ?? null,
    batteryChargePercent: charge,
    model: values.get("ups.model") ?? null,
    shutdownAtLowBattery,
    thresholds,
    eventsPath,
  };
}

export const upsTaskInternals = { binaries, formatPowerEvent };
