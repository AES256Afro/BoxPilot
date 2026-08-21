import { randomBytes } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

/**
 * Root-side UPS (Network UPS Tools) setup executed by scripts/boxpilot-run.mjs.
 *
 * Writes a complete standalone NUT configuration for one USB UPS: the driver, the local
 * server bound to loopback, a monitor user with a generated password, and upsmon set to
 * shut this server down cleanly when the UPS reports a low battery. Existing files are kept
 * as *.before-boxpilot. Nothing is reachable from the network: upsd listens on 127.0.0.1.
 */

export const nutDirectory = "/etc/nut";
export const managedMarker = "# Managed by BoxPilot";
export const drivers = Object.freeze(["usbhid-ups", "nutdrv_qx", "riello_usb", "blazer_usb", "apcsmart", "snmp-ups"]);
export const upsNamePattern = /^[a-z][a-z0-9_-]{0,31}$/;
const hexPattern = /^[0-9a-f]{4}$/;

const binaries = {
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  upsc: "/usr/bin/upsc",
  upsdrvctl: "/sbin/upsdrvctl",
  chown: "/usr/bin/chown",
};

export function validateUpsSetup({ name = "ups", driver = "usbhid-ups", vendorId = null, productId = null, shutdownAtLowBattery = true } = {}) {
  if (!upsNamePattern.test(String(name))) return "name must be lower-case letters, digits, underscore, hyphen (max 32)";
  if (!drivers.includes(driver)) return `driver must be one of ${drivers.join(", ")}`;
  if (vendorId !== null && !hexPattern.test(String(vendorId))) return "vendorId must be four hex digits";
  if (productId !== null && !hexPattern.test(String(productId))) return "productId must be four hex digits";
  if (typeof shutdownAtLowBattery !== "boolean") return "shutdownAtLowBattery must be true or false";
  return null;
}

/** Render every NUT file. Pure. */
export function renderNutConfig({ name = "ups", driver = "usbhid-ups", vendorId = null, productId = null, description = "UPS", monitorPassword, shutdownAtLowBattery = true } = {}) {
  const port = driver === "snmp-ups" ? "localhost" : "auto";
  const upsConf = [managedMarker, "", `[${name}]`, `\tdriver = ${driver}`, `\tport = ${port}`, ...(vendorId ? [`\tvendorid = ${vendorId}`] : []), ...(productId ? [`\tproductid = ${productId}`] : []), `\tdesc = "${description.replace(/"/g, "")}"`, "\tpollinterval = 5", ""].join("\n");
  const upsmonConf = [
    managedMarker, "",
    `MONITOR ${name}@localhost 1 upsmon ${monitorPassword} primary`,
    "MINSUPPLIES 1",
    `SHUTDOWNCMD "${shutdownAtLowBattery ? "/sbin/shutdown -h +0" : "/bin/true"}"`,
    "NOTIFYCMD /usr/sbin/upssched",
    "POLLFREQ 5",
    "POLLFREQALERT 5",
    "HOSTSYNC 15",
    "DEADTIME 15",
    "POWERDOWNFLAG /etc/killpower",
    "NOTIFYFLAG ONLINE SYSLOG+WALL",
    "NOTIFYFLAG ONBATT SYSLOG+WALL",
    "NOTIFYFLAG LOWBATT SYSLOG+WALL",
    "NOTIFYFLAG FSD SYSLOG+WALL",
    "NOTIFYFLAG COMMOK SYSLOG",
    "NOTIFYFLAG COMMBAD SYSLOG",
    "NOTIFYFLAG SHUTDOWN SYSLOG+WALL",
    "NOTIFYFLAG REPLBATT SYSLOG+WALL",
    "NOTIFYFLAG NOCOMM SYSLOG",
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
  };
}

const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");

export async function upsSetup({ name = "ups", driver = "usbhid-ups", vendorId = null, productId = null, description = "UPS", shutdownAtLowBattery = true } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, mkdir, copyFile, chmod, access }, secret = () => randomBytes(18).toString("base64url"), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const problem = validateUpsSetup({ name, driver, vendorId, productId, shutdownAtLowBattery });
  if (problem) throw new Error(`Invalid UPS setup: ${problem}`);
  const installed = await files.access(binaries.upsc).then(() => true, () => false);
  if (!installed) throw new Error("NUT is not installed; install the nut package from the System page first");
  const monitorPassword = secret();
  const rendered = renderNutConfig({ name, driver, vendorId, productId, description: String(description).slice(0, 60), monitorPassword, shutdownAtLowBattery });
  await files.mkdir(nutDirectory, { recursive: true, mode: 0o755 });
  for (const [file, content] of Object.entries(rendered)) {
    const target = `${nutDirectory}/${file}`;
    const previous = await files.readFile(target, "utf8").catch(() => null);
    if (previous !== null && !previous.startsWith(managedMarker)) { await files.copyFile(target, `${target}.before-boxpilot`); log?.(`Kept the original ${target} as ${target}.before-boxpilot`, "stdout"); }
    await files.writeFile(target, content, { mode: file === "upsd.users" || file === "upsmon.conf" ? 0o640 : 0o644 });
    await run(binaries.chown, [`root:nut`, target], { timeout: 10_000 }).catch(() => {});
  }
  log?.(`Wrote NUT configuration for ${name} (${driver}, port auto); upsd listens on 127.0.0.1 only`, "stdout");
  for (const unit of ["nut-server", "nut-monitor"]) {
    const enable = await run(binaries.systemctl, ["enable", unit], { timeout: 60_000 });
    if (!enable.ok) log?.(`${unit}: ${tail(enable.stderr)}`, "stderr");
  }
  const driverStart = await run(binaries.upsdrvctl, ["start"], { timeout: 60_000 });
  if (!driverStart.ok) throw new Error(`The UPS driver could not start (is the UPS plugged into USB?): ${tail(driverStart.stderr) || tail(driverStart.stdout)}`);
  for (const unit of ["nut-server", "nut-monitor"]) {
    const restart = await run(binaries.systemctl, ["restart", unit], { timeout: 60_000 });
    if (!restart.ok) throw new Error(`Could not start ${unit}: ${tail(restart.stderr)}`);
  }
  let status = null;
  for (let attempt = 0; attempt < 5 && !status; attempt += 1) {
    const probe = await run(binaries.upsc, [`${name}@localhost`], { timeout: 10_000 });
    if (probe.ok && /ups\.status:/.test(probe.stdout)) status = probe.stdout;
    else await wait(2000);
  }
  if (!status) throw new Error("NUT started but the UPS did not report a status within 10 seconds; check the cable and the driver choice");
  const value = (key) => status.split("\n").find((line) => line.startsWith(`${key}:`))?.split(":").slice(1).join(":").trim() ?? null;
  log?.(`UPS ${name} reports status "${value("ups.status")}", battery ${value("battery.charge") ?? "?"}%`, "stdout");
  return { configured: true, name, driver, status: value("ups.status"), batteryChargePercent: value("battery.charge") ? Number(value("battery.charge")) : null, model: value("ups.model"), shutdownAtLowBattery };
}
