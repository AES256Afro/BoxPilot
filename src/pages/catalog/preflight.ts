import type { InventoryFacts, MountFact } from "../../home/facts";
import { loadStatus, mountName, mountStatus, size } from "../../home/format";
import type { PortConflict } from "../../portConflict";
import type { Status } from "../../ui/types";
import { nightlySlot } from "../backups/types";
import type { Entry, Manifest, Values } from "./types";

/*
 * "Will it fit": what installing an app takes from this server, worked out before Install is
 * pressed. Pure: everything it reads is handed in, so it says the same for the same answers.
 *
 * Every figure is one the product already has. In use now and the totals are the inventory's
 * (Home's Memory and System disk tiles). What the app adds is its manifest's `needs`, and "not
 * stated" when the manifest states nothing: the check is then made on what is free now alone. A
 * figure that was not read is "not read", and the result is never green about it (M28.5).
 */

/**
 * Thin is what the product already calls a warning: 85% in use, and 95% is critical. Home and Ops
 * draw memory amber and red from these (loadStatus(percent, 85, 95)), and the inventory judges a
 * filesystem by the same two (capacityState in server/storage-evidence.mjs).
 */
const thinPercent = 85;
const criticalPercent = 95;
/** The Storage page shows a drive's forecast inside 90 days, and warns inside 14. */
const forecastShownDays = 90;
const forecastSoonDays = 14;
const mebibyte = 1024 ** 2;

/** Where Docker keeps images, and where BoxPilot keeps an app's own folders. */
const imagesPath = "/var/lib/docker";
const managedPath = (appId: string) => `/var/lib/boxpilot-managed/catalog/${appId}`;

export type Check = "pass" | "caution" | "fail" | "unread" | "reading";

export interface FitRow {
  id: string;
  kind: "memory" | "disk" | "port";
  /** What is measured: Memory, System disk, a drive by where it is mounted, a port. */
  item: string;
  usedNow: string;
  adds: string;
  /** How full it is after the install, for the bar. Null when there is nothing to measure. */
  scale: { percent: number; words: string; status: Status } | null;
  /** What stands in the bar's place for a row without one ("next free one"). */
  scaleWords: string | null;
  leftAfter: string;
  /** A second line under what is left: the drive's forecast, when Storage has one. */
  leftHint: string | null;
  check: Check;
  /** Why it is not a pass, in a sentence. */
  note: string | null;
}

export interface DriveForecast { target: string; daysToFull: number }

/** A port the precheck found taken; `id` is the manifest port's, which the server sends with it. */
export type PortClash = PortConflict & { id?: string };

/** What the server's precheck said about the ports the form holds now. */
export interface PortReading {
  state: "reading" | "read" | "unread";
  conflicts: PortClash[];
  /** Ports this check moved off a taken default, by port id: where from, and who holds that one. */
  moved: Record<string, { from: number; held: string }>;
  /** Why it is unread: the form still needs a setting the server checks first, or the check failed. */
  reason?: "settings" | "failed";
}

export const checkWords: Record<Check, string> = { pass: "Pass", caution: "Caution", fail: "Does not fit", unread: "Not read", reading: "Checking…" };
export const checkStatus: Record<Check, Status> = { pass: "good", caution: "warning", fail: "danger", unread: "unknown", reading: "unknown" };

const percentOf = (part: number, whole: number) => Math.round((part / whole) * 100);
/** A figure that was really read: a number, and a finite one. Anything else is "not read", never arithmetic. */
const read = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** What a manifest states, in bytes; null for anything that is not a positive number of MB. */
const statedBytes = (megabytes: unknown) => (read(megabytes) && megabytes > 0 ? megabytes * mebibyte : null);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function unreadRow(id: string, kind: FitRow["kind"], item: string, adds: string): FitRow {
  return { id, kind, item, usedNow: "not read", adds, scale: null, scaleWords: null, leftAfter: "not read", leftHint: null, check: "unread", note: null };
}

/** Amber and red are both "thin": a row is a caution, and only what cannot fit at all fails. */
const checkOf = (status: Status): Check => (status === "good" ? "pass" : status === "unknown" ? "unread" : "caution");

function memoryRow(inventory: InventoryFacts | null, memoryMb: number | null): FitRow {
  const stated = statedBytes(memoryMb);
  const adds = stated === null ? "not stated" : `+ ${size(stated)}`;
  // The inventory writes 0 for a total it could not read: that is not a server with no memory.
  if (!inventory || !read(inventory.memoryTotal) || !(inventory.memoryTotal > 0) || !read(inventory.memoryUsed)) return unreadRow("memory", "memory", "Memory", adds);
  const total = inventory.memoryTotal;
  const used = Math.min(Math.max(inventory.memoryUsed, 0), total);
  const after = used + (stated ?? 0);
  const left = total - after;
  const base = { id: "memory", kind: "memory" as const, item: "Memory", usedNow: size(used), adds, scaleWords: null, leftHint: null };
  if (left < 0) {
    return { ...base, scale: { percent: 100, words: `more than all ${size(total)} after install`, status: "danger" }, leftAfter: `${size(-left)} short of ${size(total)}`, check: "fail", note: `Memory: it states ${size(stated ?? 0)} and ${size(total - used)} is free.` };
  }
  const percent = percentOf(after, total);
  const status = loadStatus(percent, thinPercent, criticalPercent);
  const note = status === "good" ? null
    : stated === null ? `Memory is ${percent}% in use already; what this adds is not stated.`
      : `Memory would be ${percent}% in use after this, with ${size(left)} left.`;
  return { ...base, scale: { percent, words: `${percent} percent of ${size(total)} in use${stated === null ? " now" : " after install"}`, status }, leftAfter: `${size(left)} of ${size(total)}`, check: checkOf(status), note };
}

/** The filesystem a path lives on: the mount with the longest matching target. Null when none of them holds it. */
export function mountFor(path: string, mounts: MountFact[]): MountFact | null {
  const wanted = path.replace(/\/+$/, "") || "/";
  let best: MountFact | null = null;
  for (const mount of mounts) {
    // The inventory hides a home folder's mount and writes "[unavailable]" for one it could not name.
    if (!mount.target.startsWith("/") || mount.target.includes("[")) continue;
    const target = mount.target === "/" ? "/" : mount.target.replace(/\/+$/, "");
    const holds = target === "/" || wanted === target || wanted.startsWith(`${target}/`);
    if (holds && (!best || target.length > best.target.length)) best = mount;
  }
  return best;
}

/** The folders of its own the app writes to, as the form has them: what its Data fact lists once installed. */
function dataFolders(manifest: Pick<Manifest, "volumes">, values: Pick<Values, "volumes">): string[] {
  return manifest.volumes
    .filter((volume) => volume.configurable && !volume.readOnly)
    .map((volume) => (values.volumes[volume.id] ?? volume.hostPath ?? "").trim())
    .filter((path) => path.startsWith("/"));
}

const keepsManagedData = (manifest: Pick<Manifest, "volumes" | "sidecars">) =>
  manifest.volumes.some((volume) => Boolean(volume.path)) || (manifest.sidecars ?? []).some((sidecar) => (sidecar.volumes ?? []).some((volume) => Boolean(volume.path)));

function diskRow(mount: MountFact, { stated, system, forecast }: { stated: number | null; system: boolean; forecast: DriveForecast | null }): FitRow {
  const item = mountName(mount.target);
  const id = `disk:${mount.target}`;
  const adds = stated === null ? "not stated" : `+ ${size(stated)}`;
  const soon = forecast !== null && read(forecast.daysToFull) && forecast.daysToFull <= forecastShownDays;
  const leftHint = !soon ? null : forecast.daysToFull <= 0 ? "full very soon" : `~${plural(forecast.daysToFull, "day")} left at the rate it has been filling`;
  const fillingNote = soon && forecast.daysToFull <= forecastSoonDays
    ? `${item} is on track to fill ${forecast.daysToFull <= 0 ? "very soon" : `in about ${plural(forecast.daysToFull, "day")}`}, at the rate free space has been dropping.` : null;
  const base = { id, kind: "disk" as const, item, adds, scaleWords: null, leftHint };
  const sized = read(mount.total) && mount.total > 0 && read(mount.used);
  // The inventory's own figure for how full it is, when it is one a filesystem can have.
  const full = read(mount.percent) && mount.percent >= 0 && mount.percent <= 100 ? mount.percent : null;
  if (!sized) {
    // Its size was not read. With nothing stated to add, how full it is still answers the question.
    if (full === null || stated !== null) return { ...unreadRow(id, "disk", item, adds), leftHint };
    const status = mountStatus(mount) === "unknown" ? loadStatus(full, thinPercent, criticalPercent) : mountStatus(mount);
    const thin = status !== "good";
    return { ...base, usedNow: `${full}% full`, scale: { percent: full, words: `${full} percent full now`, status }, leftAfter: `${100 - full}% free`, check: thin || fillingNote ? "caution" : "pass", note: thin ? `${item} is ${full}% full already.` : fillingNote };
  }
  const total = mount.total as number;
  const used = Math.min(Math.max(mount.used as number, 0), total);
  const after = used + (stated ?? 0);
  const left = total - after;
  if (left < 0) {
    return { ...base, usedNow: size(used), scale: { percent: 100, words: `more than all ${size(total)} after install`, status: "danger" }, leftAfter: `${size(-left)} short of ${size(total)}`, check: "fail", note: `${item}: it states ${size(stated ?? 0)} and ${size(total - used)} is free.` };
  }
  // How full it is now is the inventory's own figure (df's, which Home shows); what is stated is added to that.
  const now = full ?? percentOf(used, total);
  const percent = stated === null ? now : Math.min(100, Math.round(now + (stated / total) * 100));
  // With nothing added the inventory's own word for this filesystem stands; a projection is judged by the same two lines.
  const judged = stated === null ? mountStatus(mount) : "unknown";
  const status = judged === "unknown" ? loadStatus(percent, thinPercent, criticalPercent) : judged;
  const thinNote = status === "good" ? null
    : stated !== null ? `${item} would be ${percent}% full after this, with ${size(left)} left.`
      : system ? `${item} is ${percent}% full already; what this adds is not stated.`
        : `${item} is ${percent}% full already, before anything this app keeps there.`;
  return {
    ...base, usedNow: size(used),
    scale: { percent, words: `${percent} percent of ${size(total)} full${stated === null ? " now" : " after install"}`, status },
    leftAfter: `${size(left)} of ${size(total)}`,
    check: thinNote || fillingNote ? "caution" : "pass",
    note: thinNote ?? fillingNote,
  };
}

function diskRows(manifest: Pick<Manifest, "id" | "volumes" | "sidecars" | "needs">, values: Pick<Values, "volumes">, inventory: InventoryFacts | null, forecasts: DriveForecast[] | null): FitRow[] {
  const stated = statedBytes(manifest.needs?.diskMb);
  const adds = stated === null ? "not stated" : `+ ${size(stated)}`;
  const folders = dataFolders(manifest, values);
  if (!inventory) {
    return [unreadRow("disk:/", "disk", "System disk", adds), ...(folders.length ? [unreadRow("disk:data", "disk", folders.length === 1 ? folders[0] : "Its data folders", "not stated")] : [])];
  }
  // The inventory's mounts, and the system disk from its own reading when the list does not hold it.
  const mounts = inventory.mounts.some((mount) => mount.target === "/") || !inventory.root ? inventory.mounts
    : [...inventory.mounts, { target: "/", source: "", total: inventory.root.total, used: inventory.root.used, percent: inventory.root.percent, state: "" }];
  // Each place the install writes, and which filesystem holds it. What the manifest states lands
  // with Docker's images; the app's own folders under BoxPilot's directory are usually the same disk.
  const places = [
    { path: imagesPath, stated },
    ...(keepsManagedData(manifest) ? [{ path: managedPath(manifest.id), stated: null as number | null }] : []),
    ...folders.map((path) => ({ path, stated: null as number | null })),
  ];
  const rows: FitRow[] = [];
  const seen = new Map<string, { mount: MountFact; stated: number | null; system: boolean }>();
  for (const [index, place] of places.entries()) {
    const mount = mountFor(place.path, mounts);
    if (!mount) {
      if (!rows.some((row) => row.id === `disk:${place.path}`)) rows.push(unreadRow(`disk:${place.path}`, "disk", index === 0 ? "System disk" : place.path, place.stated === null ? "not stated" : `+ ${size(place.stated)}`));
      continue;
    }
    const group = seen.get(mount.target);
    if (group) { if (place.stated !== null) group.stated = (group.stated ?? 0) + place.stated; continue; }
    seen.set(mount.target, { mount, stated: place.stated, system: index === 0 || mount.target === "/" });
  }
  const read = [...seen.values()].map((group) => diskRow(group.mount, { stated: group.stated, system: group.system, forecast: forecasts?.find((forecast) => forecast.target === group.mount.target) ?? null }));
  // The disk the images land on first, then the drives, then whatever could not be placed.
  return [...read, ...rows];
}

/** Whose a taken port is, in the fewest words: "Portainer's", "held by container emby", "in use". */
export function heldWords(conflict: PortClash, appName: (id: string) => string | null = () => null): string {
  const holder = conflict.containers?.[0];
  if (holder?.app) return `${appName(holder.app) ?? holder.app}'s`;
  if (holder?.name) return `held by container ${holder.name}`;
  if (conflict.port === 53 && (conflict.listeners ?? []).some((listener) => String(listener).includes("127.0.0.53"))) return "held by Ubuntu's own resolver";
  return "in use";
}

const hostNetworked = (manifest: Pick<Manifest, "network">, values: Pick<Values, "networkMode">) => (values.networkMode ?? manifest.network) === "host";
/** The host port each of the manifest's ports gets with the form as it is: its container port on the host's own network. */
function chosenPort(manifest: Pick<Manifest, "network">, values: Pick<Values, "ports" | "networkMode">, port: Manifest["ports"][number]): number {
  return hostNetworked(manifest, values) ? port.container : values.ports[port.id] ?? port.host;
}
const clashFor = (conflicts: PortClash[], port: Manifest["ports"][number], chosen: number) =>
  conflicts.find((conflict) => (conflict.id !== undefined ? conflict.id === port.id : conflict.port === chosen && conflict.protocol === port.protocol)) ?? null;

function portRows(manifest: Pick<Manifest, "ports" | "network">, values: Pick<Values, "ports" | "networkMode">, reading: PortReading, appName: (id: string) => string | null): FitRow[] {
  return manifest.ports.map((port) => {
    const chosen = chosenPort(manifest, values, port);
    const item = manifest.ports.length === 1 ? "Port" : `${port.label} port`;
    const id = `port:${port.id}`;
    const takes = `takes ${chosen}${port.protocol === "udp" ? "/udp" : ""}`;
    const base = { id, kind: "port" as const, item, scale: null, leftHint: null };
    if (reading.state === "reading") return { ...base, usedNow: "checking…", adds: takes, scaleWords: null, leftAfter: "checking…", check: "reading", note: null };
    if (reading.state === "unread") {
      return { ...base, usedNow: "not read", adds: takes, scaleWords: null, leftAfter: "not checked", check: "unread", note: reading.reason === "settings" ? "The ports are checked once the settings this app requires are filled in." : null };
    }
    const clash = clashFor(reading.conflicts, port, chosen);
    if (clash) {
      const held = heldWords(clash, appName);
      const fixed = port.fixed || hostNetworked(manifest, values);
      return { ...base, usedNow: `${clash.port} is ${held}`, adds: `needs ${chosen}`, scaleWords: fixed ? "cannot move" : "pick another", leftAfter: "clash", check: "fail", note: `${port.label} port ${clash.port}/${clash.protocol} is ${held}${fixed ? ", and this app cannot use another." : "."}` };
    }
    const moved = reading.moved[port.id];
    if (moved && moved.from !== chosen) return { ...base, usedNow: `${moved.from} is ${moved.held}`, adds: takes, scaleWords: "next free one", leftAfter: "no clash", check: "pass", note: null };
    return { ...base, usedNow: `${chosen} is free`, adds: takes, scaleWords: null, leftAfter: "no clash", check: "pass", note: null };
  });
}

export interface FitInput {
  manifest: Pick<Manifest, "id" | "ports" | "volumes" | "sidecars" | "needs" | "network">;
  /** The install form as it is filled in: the ports and folders chosen. */
  values: Pick<Values, "ports" | "volumes" | "networkMode">;
  /** The inventory Home reads; null when it has not been read. */
  inventory: InventoryFacts | null;
  /** The inventory is still being read: its rows say so rather than "not read". */
  inventoryPending?: boolean;
  /** Storage's forecast of when each filesystem fills; null when it was not read (then none is shown). */
  forecasts?: DriveForecast[] | null;
  ports: PortReading;
  appName?: (id: string) => string | null;
}

/** The rows of "What it takes": memory, the system disk, each other drive its folders live on, each port. */
export function fitRows({ manifest, values, inventory, inventoryPending = false, forecasts = null, ports, appName = () => null }: FitInput): FitRow[] {
  const measured = [memoryRow(inventory, manifest.needs?.memoryMb ?? null), ...diskRows(manifest, values, inventory, forecasts)];
  return [
    ...(inventoryPending && !inventory ? measured.map((row): FitRow => ({ ...row, usedNow: "reading…", leftAfter: "reading…", check: "reading" })) : measured),
    ...portRows(manifest, values, ports, appName),
  ];
}

/** `summary` is said only for what was not read; why a row is a caution or does not fit is the row's own note. */
export interface FitVerdict { status: Status; label: string; summary: string | null }

const listed = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The one result near the title. Never green about a row that was not read. */
export function fitVerdict(rows: FitRow[]): FitVerdict {
  const of = (check: Check) => rows.filter((row) => row.check === check);
  const failed = of("fail");
  if (failed.length) return { status: "danger", label: "Does not fit", summary: null };
  if (of("reading").length) return { status: "unknown", label: "Checking…", summary: null };
  const unread = of("unread");
  if (unread.length) return { status: "unknown", label: "Not read", summary: `${listed(unread.map((row) => row.item))} could not be read, so this cannot say it fits.` };
  const cautions = of("caution");
  if (cautions.length) return { status: "warning", label: `Fits, ${plural(cautions.length, "caution")}`, summary: null };
  return { status: "good", label: "Fits", summary: null };
}

/**
 * The first port number above `from` that nothing is known to hold, or null when there is none.
 * "Known" is what the page has: the ports installed apps publish, and the ones the precheck has
 * already said are taken. The precheck is asked again about the answer before anything says Pass.
 */
export function nextFreePort(from: number, taken: (port: number) => boolean): number | null {
  for (let port = from + 1; port <= 65535; port += 1) if (!taken(port)) return port;
  return null;
}

/** The host ports installed apps hold, as "8000/tcp": what an install must step around. */
export function heldPorts(applications: Entry[], exceptId: string): Set<string> {
  const held = new Set<string>();
  for (const { manifest, live } of applications) {
    if (!live?.installed || manifest.id === exceptId) continue;
    for (const published of live.published ?? []) held.add(`${published.host}/${published.protocol}`);
    for (const port of manifest.ports) held.add(`${live.state?.values?.ports?.[port.id] ?? port.host}/${port.protocol}`);
  }
  return held;
}

export interface Relocation { ports: Record<string, number>; moved: PortReading["moved"] }

/**
 * Where to move each taken port the owner has not chosen themselves: the next free one. A port
 * the manifest fixes, one on the host's own network, and one the owner typed stay where they are,
 * and the row says they clash. Empty when there is nothing to move.
 */
export function relocatePorts({ manifest, values, conflicts, touched, held, tried, appName = () => null }: {
  manifest: Pick<Manifest, "ports" | "network">;
  values: Pick<Values, "ports" | "networkMode">;
  conflicts: PortClash[];
  /** Port ids the owner typed a number for. */
  touched: ReadonlySet<string>;
  /** "8000/tcp" for each port an installed app holds. */
  held: ReadonlySet<string>;
  /** "8000/tcp" for each port a precheck has already found taken. */
  tried: ReadonlySet<string>;
  appName?: (id: string) => string | null;
}): Relocation {
  const relocation: Relocation = { ports: {}, moved: {} };
  if (hostNetworked(manifest, values)) return relocation;
  const claimed = new Set(manifest.ports.map((port) => `${values.ports[port.id] ?? port.host}/${port.protocol}`));
  for (const port of manifest.ports) {
    const chosen = values.ports[port.id] ?? port.host;
    const clash = clashFor(conflicts, port, chosen);
    if (!clash || clash.port !== chosen || port.fixed || touched.has(port.id)) continue;
    const taken = (candidate: number) => { const key = `${candidate}/${port.protocol}`; return held.has(key) || tried.has(key) || claimed.has(key); };
    const free = nextFreePort(chosen, taken);
    if (free === null) continue;
    claimed.add(`${free}/${port.protocol}`);
    relocation.ports[port.id] = free;
    relocation.moved[port.id] = { from: chosen, held: heldWords(clash, appName) };
  }
  return relocation;
}

/** A setting the server's precheck refuses the form without, still empty: it answers no question about ports until then. */
export function needsSettingsFirst(manifest: Pick<Manifest, "env">, values: Pick<Values, "env">): boolean {
  return manifest.env.some((entry) => entry.required && !entry.fixed && !entry.generate && (entry.default === null || entry.default === undefined) && !(values.env[entry.name] ?? ""));
}

export interface AnswerLine { id: string; label: string; address: string | null; words: string | null }

/**
 * Where the app will answer once installed, from what the page knows: this server's network
 * address and tailnet name as the catalog read them, and the port the form holds. An address that
 * was not read is said as not read; none is made up.
 */
export function whereItAnswers({ manifest, values, host, https = false }: {
  manifest: Pick<Manifest, "ports" | "network" | "defaultExposure">;
  values: Pick<Values, "ports" | "networkMode">;
  host: { lanAddress: string | null; tailscaleDnsName: string | null };
  /** The app's own page speaks HTTPS (Portainer). */
  https?: boolean;
}): AnswerLine[] {
  if (!manifest.ports.length) return [{ id: "none", label: "No address", address: null, words: "It publishes no port, so nothing opens it from another device." }];
  // The ports that speak HTTP are the ones that get an address to open, as on an installed app's sheet.
  const web = manifest.ports.filter((port) => port.protocol === "tcp" && (port.tailnet ?? "serve") === "serve");
  const others = manifest.ports.filter((port) => !web.includes(port));
  const scheme = https ? "https" : "http";
  const tailnetOnly = !hostNetworked(manifest, values) && manifest.defaultExposure === "tailnet";
  const lines: AnswerLine[] = [];
  const named = web.length > 1;
  for (const port of web) {
    const number = chosenPort(manifest, values, port);
    const suffix = named ? ` · ${port.label}` : "";
    if (tailnetOnly) {
      lines.push({ id: `lan:${port.id}`, label: `On your network${suffix}`, address: null, words: "Not reachable: its page stays on this server." });
      lines.push(host.tailscaleDnsName
        ? { id: `tailnet:${port.id}`, label: `Over Tailscale${suffix}`, address: `https://${host.tailscaleDnsName}:${number}`, words: "Published by Tailscale Serve over HTTPS, for devices signed in to your tailnet." }
        : { id: `tailnet:${port.id}`, label: `Over Tailscale${suffix}`, address: null, words: `Published by Tailscale Serve on port ${number}; this server's tailnet name was not read.` });
    } else if (port.exposure === "loopback") {
      lines.push({ id: `loopback:${port.id}`, label: `On this server only${suffix}`, address: `${scheme}://127.0.0.1:${number}`, words: "Bound to the server itself; not reachable from other devices." });
    } else {
      lines.push(host.lanAddress
        ? { id: `lan:${port.id}`, label: `On your network${suffix}`, address: `${scheme}://${host.lanAddress}:${number}`, words: null }
        : { id: `lan:${port.id}`, label: `On your network${suffix}`, address: null, words: `Port ${number} on this server; its network address was not read.` });
      // The short MagicDNS name: a plain http link on the full ts.net name can never open (appLinks).
      lines.push(host.tailscaleDnsName
        ? { id: `tailnet:${port.id}`, label: `Over Tailscale${suffix}`, address: `${scheme}://${host.tailscaleDnsName.split(".")[0]}:${number}`, words: "Needs Tailscale running on the device you are using." }
        : { id: `tailnet:${port.id}`, label: `Over Tailscale${suffix}`, address: null, words: "No tailnet name is known for this server." });
    }
  }
  if (others.length) lines.push({ id: "others", label: web.length ? "Other ports" : "Ports", address: others.map((port) => `${port.label} ${chosenPort(manifest, values, port)}/${port.protocol}`).join(" · "), words: web.length ? null : "No web page: these do not speak HTTP." });
  lines.push({ id: "internet", label: "On the internet", address: null, words: "Not published. Installing it opens nothing on your router." });
  return lines;
}

/**
 * The nightly backup an install offers: the schedule the Backups page's "Schedule it" creates for
 * one app (app.backup, daily, in the first of its 02:00-03:59 slots).
 */
export const nightlyBackup = { operationId: "app.backup", frequency: "daily", ...nightlySlot(0, 1) } as const;
export const nightlyTime = `${String(nightlyBackup.hour).padStart(2, "0")}:${String(nightlyBackup.minute).padStart(2, "0")}`;

/** Whether an app backup archives anything of it, sidecars included: keepsBackupData in server/catalog/schema.mjs. */
export function holdsData(manifest: Pick<Manifest, "volumes" | "sidecars">): boolean {
  if (manifest.volumes.some((volume) => volume.backup && (volume.path || volume.hostPath))) return true;
  return (manifest.sidecars ?? []).some((sidecar) => (sidecar.volumes ?? []).some((volume) => volume.backup && volume.path));
}

/** What installing starts: one container for the app and one for each of its sidecars (none of those on the host's own network). */
export function startsWords(manifest: Pick<Manifest, "id" | "sidecars" | "network">, values: Pick<Values, "networkMode">): string {
  const services = [manifest.id, ...(hostNetworked(manifest, values) ? [] : (manifest.sidecars ?? []).map((sidecar) => sidecar.id))];
  return `Starts ${plural(services.length, "container")}${services.length > 1 ? ` (${services.join(", ")})` : ""}. Nothing that is running now is stopped or changed.`;
}
