import { readdir, readFile, readlink, rm } from "node:fs/promises";
// udev's link file is read at boot: written durably, never truncated in place.
import { writeFileDurably as writeFile } from "../durable-file.mjs";
import path from "node:path";
import { fixedRun } from "../exec.mjs";

/**
 * Wake-on-LAN for this server's own network port (M39.6): another device on the network (the
 * router, a phone, a second computer) can switch the server on after a clean shutdown by sending
 * its port a "magic packet".
 *
 * The setting is kept by a systemd .link file, which udev applies each time the port appears at
 * boot. udev applies only the first .link file that matches a port, in file-name order across
 * /etc, /run and /usr/lib, so BoxPilot's file copies the rest of the file that applies today (the
 * port's naming rules: without them the port could be renamed) and adds WakeOnLan=magic, and is
 * named to come before it. Whether it really comes first is asked of udev itself
 * (`udevadm test-builtin net_setup_link`, which also applies it at once); a netplan-generated file
 * that still wins is left alone, and the owner is told what to add to netplan instead.
 *
 * Measured on Ubuntu 24.04 and 26.04 runners (tests/ubuntu/wake-on-lan-link.sh): udev picks the
 * file up after `udevadm control --reload`, and netplan's /run/systemd/network/10-netplan-*.link
 * outranks a file in /etc named 50-*. A runner's network port cannot wake anything, so the
 * ethtool half is only the unit tests'.
 */

export const managedMarker = "# Managed by BoxPilot";
export const linkDirectory = "/etc/systemd/network";
export const interfacePattern = /^[A-Za-z0-9_.-]{1,15}$/;
const macPattern = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
/** What systemd's own 99-default.link says, for a port whose current file cannot be read. */
export const defaultLinkSettings = Object.freeze(["NamePolicy=keep kernel database onboard slot path", "AlternativeNamesPolicy=database onboard slot path", "MACAddressPolicy=persistent"]);

const binaries = {
  ethtool: process.env.BOXPILOT_ETHTOOL_BINARY ?? "/usr/sbin/ethtool",
  udevadm: process.env.BOXPILOT_UDEVADM_BINARY ?? "/usr/bin/udevadm",
};

/** The .link file BoxPilot writes for a port. "50" comes before systemd's 73- and 99- defaults. */
export const linkFileFor = (name) => `${linkDirectory}/50-boxpilot-wake-on-lan-${name}.link`;

/** `ethtool <port>`'s wake-on lines: which wake-ups it can do, and which are on ("d" is none). */
export function parseEthtoolWake(text) {
  const supports = /^\s*Supports Wake-on:\s*([a-z]+)\s*$/m.exec(String(text ?? ""))?.[1] ?? null;
  const current = /^\s*Wake-on:\s*([a-z]+)\s*$/m.exec(String(text ?? ""))?.[1] ?? null;
  return { supports, current, supportsMagic: Boolean(supports?.includes("g")), magicOn: Boolean(current?.includes("g")) };
}

/** `udevadm info -q property`'s KEY=value lines. */
export function parseProperties(text) {
  return Object.fromEntries(String(text ?? "").split("\n").map((line) => line.trim().split(/=(.*)/s).slice(0, 2)).filter((pair) => pair.length === 2 && pair[0]));
}

/** Which .link file udev says it applied: "eth0: Config file /run/systemd/network/10-netplan-eth0.link is applied". */
export function appliedLinkFile(text) {
  return /Config file (\S+\.link) is applied/.exec(String(text ?? ""))?.[1] ?? /^ID_NET_LINK_FILE=(\S+)$/m.exec(String(text ?? ""))?.[1] ?? null;
}

/** The [Link] section's settings of a .link file, WakeOnLan ones removed. */
export function linkSettings(content) {
  const settings = [];
  let inLink = false;
  for (const raw of String(content ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[.+\]$/.test(line)) { inLink = line === "[Link]"; continue; }
    if (inLink && /^[A-Za-z]+=/.test(line) && !/^WakeOnLan/.test(line)) settings.push(line);
  }
  return settings;
}

/**
 * BoxPilot's .link file for a port: its naming rules as they are today, and Wake-on-LAN on. Matched
 * by the hardware address, as netplan matches (udev applies .link files before anything could
 * change the address, and matching by name is unreliable because the name is what udev decides).
 */
export function renderLinkFile({ name, mac, source = null, settings = defaultLinkSettings }) {
  if (!interfacePattern.test(name) || !macPattern.test(mac)) throw new Error("Invalid network port");
  return [
    `${managedMarker}: Wake-on-LAN for ${name}, kept after a restart. Turn it off from BoxPilot (System > Hardware),`,
    `# or delete this file. The other settings are copied from ${source ?? "systemd's default"} so the port keeps its name.`,
    "[Match]",
    `MACAddress=${mac}`,
    "",
    "[Link]",
    ...settings,
    "WakeOnLan=magic",
    "",
  ].join("\n");
}

const read = (file) => readFile(file, "utf8").then((text) => text, () => null);
const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");
const netplanHint = (file) => (/netplan/.test(file)
  ? `${file} decides this port's settings and comes before any file BoxPilot can add. It is netplan's: add "wakeonlan: true" to this port in /etc/netplan (matched by its "macaddress"), then run "sudo netplan apply"`
  : `${file} decides this port's settings and comes before any file BoxPilot can add: add "WakeOnLan=magic" to its [Link] section instead`);

/**
 * The server's wired network ports with a hardware device behind them: name, hardware address,
 * driver, whether they can wake on a magic packet and whether it is on, and which .link file
 * applies to them. Root-side: ethtool needs CAP_NET_ADMIN to read the wake-on setting.
 */
export async function inspectWakeOnLan({ run = fixedRun, root = "/sys/class/net", list = readdir, readText = read, link = readlink } = {}) {
  const ethtoolThere = await run(binaries.ethtool, ["--version"], { timeout: 10_000 });
  const ports = [];
  for (const name of (await list(root).catch(() => [])).filter((entry) => interfacePattern.test(entry)).sort()) {
    const base = `${root}/${name}`;
    const type = (await readText(`${base}/type`))?.trim();
    const device = await link(`${base}/device`).catch(() => null);
    if (type !== "1" || !device) continue; // not Ethernet, or virtual (bridges, Docker, VPNs)
    const wireless = (await list(`${base}/wireless`).then(() => true, () => false)) || (await link(`${base}/phy80211`).then(() => true, () => false));
    if (wireless) continue; // Wi-Fi cannot wake a server that is off
    const mac = (await readText(`${base}/address`))?.trim().toLowerCase() ?? null;
    const driver = await link(`${base}/device/driver`).then((target) => path.basename(target), () => null);
    const operstate = (await readText(`${base}/operstate`))?.trim() ?? null;
    const wake = ethtoolThere.ok ? parseEthtoolWake((await run(binaries.ethtool, [name], { timeout: 10_000 })).stdout) : { supports: null, current: null, supportsMagic: false, magicOn: false };
    const properties = parseProperties((await run(binaries.udevadm, ["info", "-q", "property", base], { timeout: 10_000 })).stdout);
    const ours = await readText(linkFileFor(name));
    ports.push({ name, mac, driver, up: operstate === "up", ...wake, linkFile: properties.ID_NET_LINK_FILE ?? null, keptByBoxPilot: Boolean(ours?.startsWith(managedMarker)) });
  }
  return { ethtool: ethtoolThere.ok, ports };
}

/**
 * Turn Wake-on-LAN on or off for one port, now and after a restart. On: BoxPilot's .link file,
 * proof from udev that it is the one that applies, then ethtool's word that magic-packet wake is
 * on. Off: the file removed and wake-on cleared. Anything that does not check out is undone.
 */
export async function wakeOnLanSet({ interface: name, enabled } = {}, { run = fixedRun, log = null, inspect = inspectWakeOnLan, files = { readText: read, writeFile, remove: rm } } = {}) {
  if (typeof name !== "string" || !interfacePattern.test(name)) throw new Error("interface must be a network port name");
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  const found = await inspect({ run });
  if (!found.ethtool) throw new Error("ethtool is not installed; install the ethtool package from Updates first");
  const port = found.ports.find((entry) => entry.name === name);
  if (!port) throw new Error(`${name} is not a wired network port on this server`);
  const target = linkFileFor(name);
  const sysfs = `/sys/class/net/${name}`;
  const reapply = () => run(binaries.udevadm, ["test-builtin", "net_setup_link", sysfs], { timeout: 30_000 });

  if (!enabled) {
    const ours = await files.readText(target);
    if (ours !== null && !ours.startsWith(managedMarker)) throw new Error(`${target} was not written by BoxPilot; it was left as it is`);
    if (ours !== null) { await files.remove(target, { force: true }); log?.(`Removed ${target}`, "stdout"); }
    await run(binaries.udevadm, ["control", "--reload"], { timeout: 30_000 });
    const off = await run(binaries.ethtool, ["-s", name, "wol", "d"], { timeout: 15_000 });
    if (!off.ok) throw new Error(`ethtool could not turn wake-on off: ${tail(off.stderr)}`);
    const now = parseEthtoolWake((await run(binaries.ethtool, [name], { timeout: 10_000 })).stdout);
    if (now.magicOn) throw new Error(`${name} still reports Wake-on: ${now.current}`);
    log?.(`${name}: Wake-on-LAN is off (Wake-on: ${now.current ?? "d"})`, "stdout");
    return { interface: name, enabled: false, wakeOn: now.current, removed: ours !== null };
  }

  if (!port.supportsMagic) throw new Error(`${name} cannot wake on a magic packet (ethtool says Supports Wake-on: ${port.supports ?? "nothing"})`);
  const mac = port.mac;
  if (!mac || !macPattern.test(mac) || mac === "00:00:00:00:00:00") throw new Error(`${name} has no hardware address to match it by`);
  // The rules the port is named by today, from the file that applies to it now.
  const current = port.linkFile && port.linkFile !== target ? port.linkFile : null;
  if (current && path.basename(current) < path.basename(target)) throw new Error(netplanHint(current));
  const settings = current ? linkSettings(await files.readText(current)) : [];
  const previous = await files.readText(target);
  if (previous !== null && !previous.startsWith(managedMarker)) throw new Error(`${target} was not written by BoxPilot; it was left as it is`);
  await files.writeFile(target, renderLinkFile({ name, mac, source: current, settings: settings.length ? settings : defaultLinkSettings }), { mode: 0o644 });
  log?.(`Wrote ${target} (matched by the hardware address ${mac})`, "stdout");
  try {
    await run(binaries.udevadm, ["control", "--reload"], { timeout: 30_000 });
    // udev's own answer to "which file applies to this port", and it applies it now.
    const applied = await reapply();
    const winner = appliedLinkFile(`${applied.stdout}\n${applied.stderr}`);
    if (winner !== target) throw new Error(winner ? netplanHint(winner) : `udev did not say which settings apply to ${name}: ${tail(applied.stderr) || "no output"}`);
    log?.(`udev applies ${target} to ${name}`, "stdout");
    const on = await run(binaries.ethtool, ["-s", name, "wol", "g"], { timeout: 15_000 });
    if (!on.ok) throw new Error(`ethtool could not turn wake-on on: ${tail(on.stderr)}`);
    const now = parseEthtoolWake((await run(binaries.ethtool, [name], { timeout: 10_000 })).stdout);
    if (!now.magicOn) throw new Error(`${name} reports Wake-on: ${now.current ?? "nothing"} after it was turned on`);
    log?.(`${name}: Wake-on-LAN is on (Wake-on: ${now.current}); a magic packet to ${mac} switches the server on after a clean shutdown`, "stdout");
    return { interface: name, enabled: true, mac, wakeOn: now.current, linkFile: target };
  } catch (error) {
    if (previous === null) await files.remove(target, { force: true }).catch(() => {});
    else await files.writeFile(target, previous, { mode: 0o644 }).catch(() => {});
    await run(binaries.udevadm, ["control", "--reload"], { timeout: 30_000 });
    await reapply();
    throw new Error(`${error.message}. ${previous === null ? `${target} was removed again` : `${target} was put back as it was`}`);
  }
}
