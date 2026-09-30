import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { appUrl, type TailnetServe } from "../appLinks";
import type { AppProtection } from "../backupProtection";
import type { ViewName } from "../data";
import { readJson } from "../http";
import { offBoxVerdict, type OffBoxInputs, type OffBoxVerdict } from "../offBox";
import { followJobs, inspectOperation, type Job } from "../operations";
import { scanFrom, type RepairScan } from "../repair/types";
import type { PowerEvent } from "../powerEvents";

/*
 * What Home and Ops know about this server (M33.2, M33.3). One provider gathers it, from the
 * endpoints the Classic pages already read, so the two views of ADR-004 cannot disagree: they are
 * drawn from the same answers. Each source loads on its own and keeps its own state. One that
 * fails is `failed`, and whatever reads it says "not known" rather than "fine" (M28.5).
 *
 * Nothing is fetched until a view asks for it (useFacts), so a Classic page opened by a deep link
 * does not pay for Home. While a view is open the quick sources are read again every minute, the
 * slow ones every five, and jobs follow the live event stream Activity uses.
 */

export interface Source<T> {
  state: "idle" | "loading" | "ready" | "failed";
  value: T | null;
  error: string | null;
}

export interface AppFact {
  id: string;
  name: string;
  icon: string | null;
  category: string;
  running: boolean;
  paused: boolean;
  /** Docker's word for the main container: running, paused, exited, restarting, absent. */
  status: string;
  health: string;
  /** A helper container that is down or restarting, which makes the app broken however alive it looks. */
  troubledSidecar: { id: string; status: string } | null;
  updateAvailable: boolean;
  folderProblems: number;
  vpnLeaked: boolean;
  url: string | null;
  port: number | null;
  exposure: string | null;
  /** Published on the tailnet over HTTPS by Tailscale Serve. */
  served: boolean;
  drill: { verified: boolean; checkedAt: string | null } | null;
  /** Stopped from BoxPilot by the owner (app.action stop), so a choice rather than a fault. */
  stoppedOnPurpose: boolean;
}

export interface CatalogFacts {
  apps: AppFact[];
  /** Every app in the catalog, installed or not. */
  total: number;
  /** False when the helper could not say what is installed: then `apps` is empty and means nothing. */
  liveKnown: boolean;
}

export interface MountFact { target: string; source: string; total: number | null; used: number | null; percent: number | null; state: string }

/**
 * One drive's SMART health, as the storage scan last read it (M33.8, from the Classic overview).
 * `reason` says why a drive has no reading: its USB bridge does not pass SMART through, or it was
 * asleep and reading it would have woken it (then `lastHealth` is its last reading awake).
 */
export interface SmartDiskFact {
  device: string;
  health: string;
  temperature: number | null;
  wear: number | null;
  mediaErrors: number | null;
  reason: string | null;
  viaBridge: boolean;
  lastHealth: string | null;
  lastReadAt: string | null;
}

/** Disk health: whether smartmontools answered, and each drive it read. */
export interface SmartFacts { available: boolean; status: string; reason: string; readAt: string | null; stale: boolean; disks: SmartDiskFact[] }

/** The UPS plugged into this server, as NUT on localhost reports it (M33.8, from the Classic overview). */
export interface UpsFact {
  installed: boolean;
  configured: boolean;
  available: boolean;
  /** online, on-battery, low-battery, forced-shutdown, bypass, offline or unavailable. */
  state: string;
  reason: string;
  charge: number | null;
  runtimeSeconds: number | null;
  load: number | null;
  tokens: string[];
}

/** One of the system services the inventory names as key: BoxPilot, Docker, SSH, Tailscale… */
export interface ServiceFact { unit: string; active: string; sub: string; enabled: string }

export interface InventoryFacts {
  hostname: string;
  operatingSystem: string;
  kernel: string;
  uptimeSeconds: number;
  cpuCount: number;
  cpuModel: string;
  load1: number;
  loadPercent: number;
  memoryTotal: number;
  memoryUsed: number;
  memoryPercent: number;
  root: { total: number; used: number; percent: number } | null;
  mounts: MountFact[];
  /** Null when the inventory said nothing about disk health (an older server). */
  smart: SmartFacts | null;
  /** Null when the inventory said nothing about power. */
  ups: UpsFact | null;
  /** The power-event log, newest first (M39.1): Home tells the outages as news. */
  powerEvents: PowerEvent[];
  /** The key services, loaded ones only. */
  services: ServiceFact[];
  addresses: Array<{ interface: string; address: string }>;
  tailscale: { installed: boolean; connected: boolean; dnsName: string | null };
}

export interface UpdatesFacts { count: number; security: number; rebootRequired: boolean }
export interface WatchAlert { family: string; title: string; since: string | null; announced: boolean }
export interface WatchFacts { targetConfigured: boolean; alerts: WatchAlert[]; notices: WatchAlert[] }

export type { Finding } from "../repair/types";
/** Repair's scan (M35): the findings, and - from a server that says - the ones set aside and which failed jobs are accounted for. */
export type RepairFacts = Pick<RepairScan, "findings" | "unavailableChecks"> & Partial<Omit<RepairScan, "findings" | "unavailableChecks">>;

export interface ScheduleFact {
  id: string;
  operationId: string;
  title: string;
  parameters: { subject?: unknown; id?: unknown } | null;
  enabled: boolean;
  overdue: boolean;
  cadence: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastReason: string | null;
}

export interface OffBoxFacts { verdict: OffBoxVerdict; inputs: OffBoxInputs }
export interface ChecklistItem { id: string; title: string; detail: string; done: boolean; known?: boolean; optional: boolean; view: ViewName }
export interface ChecklistFacts { items: ChecklistItem[]; done: number; total: number }
export interface VmFacts { domains: Array<{ name: string; state: string; vcpus: number | null; memoryBytes: number | null }> }

export interface Facts {
  catalog: Source<CatalogFacts>;
  inventory: Source<InventoryFacts>;
  updates: Source<UpdatesFacts>;
  unattended: Source<{ enabled: boolean }>;
  services: Source<{ failed: number }>;
  watch: Source<WatchFacts>;
  repairs: Source<RepairFacts>;
  jobs: Source<Job[]>;
  schedules: Source<ScheduleFact[]>;
  protection: Source<AppProtection[]>;
  offBox: Source<OffBoxFacts>;
  database: Source<{ lastBackupAt: string | null }>;
  setup: Source<{ firstRun: boolean }>;
  checklist: Source<ChecklistFacts>;
  vms: Source<VmFacts>;
  rebuild: Source<{ count: number; source: string } | null>;
}

/** The facts' values alone, null for anything not (or not yet) known: what the pure helpers read. */
export type FactValues = { [K in keyof Facts]: Facts[K]["value"] };

export const valuesOf = (facts: Facts): FactValues =>
  Object.fromEntries(Object.entries(facts).map(([key, source]) => [key, source.value])) as FactValues;

const idle = { state: "idle", value: null, error: null } as const;

export const emptyFacts: Facts = {
  catalog: idle, inventory: idle, updates: idle, unattended: idle, services: idle, watch: idle, repairs: idle, jobs: idle,
  schedules: idle, protection: idle, offBox: idle, database: idle, setup: idle, checklist: idle, vms: idle, rebuild: idle,
};

const getJson = async <T,>(url: string): Promise<T> => readJson<T>(await fetch(url));
const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// ── The loaders: each reads one thing and checks its shape. A shape it does not recognise is a
//    failure, not an empty answer: an empty list would read as "nothing wrong". ──

type RawLive = {
  installed?: boolean;
  container?: { running?: boolean; status?: string; health?: string };
  sidecars?: Array<{ id?: string; running?: boolean; status?: string }>;
  updateAvailable?: boolean;
  folderProblems?: unknown[];
  killSwitchDrill?: { leaked?: boolean } | null;
  stoppedOnPurpose?: { at?: string | null } | null;
  backupVerification?: { verified?: boolean; checkedAt?: string | null } | null;
  urls?: Array<{ host: number; exposure: string; path?: string | null }>;
};
type RawCatalog = {
  applications?: Array<{ manifest?: { id?: string; name?: string; icon?: string | null; category?: string }; live?: RawLive | null }>;
  liveError?: string | null;
  host?: { lanAddress?: string | null };
};
type ServeAnswer = { available?: boolean; serves?: TailnetServe[] };

export function appFactsFrom(body: RawCatalog, serves: TailnetServe[]): CatalogFacts {
  if (!Array.isArray(body?.applications)) throw new Error("The catalog's answer had no list of apps");
  const lanAddress = body.host?.lanAddress ?? null;
  const apps: AppFact[] = [];
  for (const entry of body.applications) {
    const manifest = entry?.manifest;
    const live = entry?.live;
    if (!manifest?.id || !live?.installed) continue;
    const status = text(live.container?.status, live.container?.running ? "running" : "absent");
    // A paused container still reports running to Docker; it is frozen, not serving.
    const paused = status === "paused";
    const troubled = list<{ id?: string; running?: boolean; status?: string }>(live.sidecars).find((sidecar) => !sidecar.running || sidecar.status === "restarting");
    const web = list<{ host: number; exposure: string; path?: string | null }>(live.urls)[0] ?? null;
    apps.push({
      id: manifest.id,
      name: text(manifest.name, manifest.id),
      icon: typeof manifest.icon === "string" && manifest.icon.trim() ? manifest.icon : null,
      category: text(manifest.category),
      running: Boolean(live.container?.running) && !paused,
      paused,
      status,
      health: text(live.container?.health, "none"),
      troubledSidecar: troubled ? { id: text(troubled.id, "a helper"), status: text(troubled.status, "down") } : null,
      updateAvailable: Boolean(live.updateAvailable),
      folderProblems: list(live.folderProblems).length,
      vpnLeaked: Boolean(live.killSwitchDrill?.leaked),
      stoppedOnPurpose: Boolean(live.stoppedOnPurpose),
      url: web ? appUrl(web, { lanAddress, serves }) : null,
      port: web ? web.host : null,
      exposure: web ? web.exposure : null,
      served: web ? serves.some((serve) => serve.port === web.host) : false,
      drill: live.backupVerification && typeof live.backupVerification.verified === "boolean"
        ? { verified: live.backupVerification.verified, checkedAt: live.backupVerification.checkedAt ?? null } : null,
    });
  }
  apps.sort((left, right) => left.name.localeCompare(right.name));
  return { apps, total: body.applications.length, liveKnown: !body.liveError };
}

async function loadCatalog(): Promise<CatalogFacts> {
  const [body, serves] = await Promise.all([
    getJson<RawCatalog>("/api/v1/catalog?view=summary"),
    // Where an app is published over HTTPS on the tailnet; optional, so a failure only changes the links.
    inspectOperation<ServeAnswer>("app.serve.inspect").then(({ result }) => (result?.available ? list<TailnetServe>(result.serves) : [])).catch(() => [] as TailnetServe[]),
  ]);
  return appFactsFrom(body, serves);
}

type RawMount = { target?: string; source?: string; totalBytes?: number | null; usedBytes?: number | null; usedPercent?: number | null; capacityState?: string };
type RawSmartDisk = { device?: string; health?: string; temperatureCelsius?: number | null; percentageUsed?: number | null; mediaErrors?: number | null; reason?: string; deviceType?: string | null; lastHealth?: string | null; lastReadAt?: string | null };
type RawUps = { installed?: boolean; configured?: boolean; available?: boolean; state?: string; reason?: string; statusTokens?: string[]; batteryChargePercent?: number | null; estimatedRuntimeSeconds?: number | null; loadPercent?: number | null };
type RawInventory = {
  host?: { hostname?: string; operatingSystem?: string; kernel?: string; uptimeSeconds?: number };
  compute?: { cpuCount?: number; cpuModel?: string; load1?: number; loadPercent?: number; totalMemoryBytes?: number; usedMemoryBytes?: number; memoryUsedPercent?: number };
  storage?: {
    root?: { totalBytes?: number; usedBytes?: number; usedPercent?: number } | null;
    filesystems?: { mounts?: RawMount[] };
    smart?: { available?: boolean; status?: string; reason?: string; generatedAt?: string | null; stale?: boolean; disks?: RawSmartDisk[] };
  };
  power?: { ups?: RawUps; events?: Array<Partial<PowerEvent>> };
  services?: Array<{ unit?: string; load?: string; active?: string; sub?: string; enabled?: string }>;
  network?: { addresses?: Array<{ interface?: string; address?: string }>; tailscale?: { installed?: boolean; connected?: boolean; dnsName?: string | null } };
};

function smartFactsFrom(smart: NonNullable<RawInventory["storage"]>["smart"]): SmartFacts | null {
  if (!smart || typeof smart !== "object") return null;
  return {
    available: Boolean(smart.available),
    status: text(smart.status, "unavailable"),
    reason: text(smart.reason),
    readAt: smart.generatedAt ?? null,
    stale: Boolean(smart.stale),
    disks: list<RawSmartDisk>(smart.disks).filter((disk) => typeof disk?.device === "string").map((disk) => ({
      device: disk.device as string,
      health: text(disk.health, "unavailable"),
      temperature: number(disk.temperatureCelsius),
      wear: number(disk.percentageUsed),
      mediaErrors: number(disk.mediaErrors),
      reason: typeof disk.reason === "string" && disk.reason ? disk.reason : null,
      viaBridge: disk.deviceType === "sat",
      lastHealth: disk.lastHealth ?? null,
      lastReadAt: disk.lastReadAt ?? null,
    })),
  };
}

function upsFactFrom(ups: RawUps | undefined): UpsFact | null {
  if (!ups || typeof ups !== "object") return null;
  return {
    installed: Boolean(ups.installed),
    configured: Boolean(ups.configured),
    available: Boolean(ups.available),
    state: text(ups.state, "unavailable"),
    reason: text(ups.reason),
    charge: number(ups.batteryChargePercent),
    runtimeSeconds: number(ups.estimatedRuntimeSeconds),
    load: number(ups.loadPercent),
    tokens: list<string>(ups.statusTokens).filter((token) => typeof token === "string"),
  };
}

export function inventoryFactsFrom(body: RawInventory): InventoryFacts {
  if (!body?.host || !body.compute) throw new Error("The inventory's answer had no host or compute section");
  const root = body.storage?.root;
  return {
    hostname: text(body.host.hostname, "this server"),
    operatingSystem: text(body.host.operatingSystem),
    kernel: text(body.host.kernel),
    uptimeSeconds: number(body.host.uptimeSeconds) ?? 0,
    cpuCount: number(body.compute.cpuCount) ?? 0,
    cpuModel: text(body.compute.cpuModel),
    load1: number(body.compute.load1) ?? 0,
    loadPercent: number(body.compute.loadPercent) ?? 0,
    memoryTotal: number(body.compute.totalMemoryBytes) ?? 0,
    memoryUsed: number(body.compute.usedMemoryBytes) ?? 0,
    memoryPercent: number(body.compute.memoryUsedPercent) ?? 0,
    root: root && number(root.totalBytes) !== null ? { total: root.totalBytes ?? 0, used: root.usedBytes ?? 0, percent: root.usedPercent ?? 0 } : null,
    mounts: list<RawMount>(body.storage?.filesystems?.mounts).map((mount) => ({
      target: text(mount.target), source: text(mount.source), total: number(mount.totalBytes), used: number(mount.usedBytes), percent: number(mount.usedPercent), state: text(mount.capacityState, "unavailable"),
    })).filter((mount) => mount.target),
    smart: smartFactsFrom(body.storage?.smart),
    ups: upsFactFrom(body.power?.ups),
    powerEvents: list<Partial<PowerEvent>>(body.power?.events)
      .filter((event): event is PowerEvent => typeof event?.at === "string" && typeof event.event === "string" && !Number.isNaN(Date.parse(event.at))),
    services: list<{ unit?: string; load?: string; active?: string; sub?: string; enabled?: string }>(body.services)
      .filter((service) => typeof service?.unit === "string" && service.load !== "not-found")
      .map((service) => ({ unit: service.unit as string, active: text(service.active, "unknown"), sub: text(service.sub), enabled: text(service.enabled) })),
    addresses: list<{ interface?: string; address?: string }>(body.network?.addresses).map((entry) => ({ interface: text(entry.interface), address: text(entry.address) })),
    tailscale: { installed: Boolean(body.network?.tailscale?.installed), connected: Boolean(body.network?.tailscale?.connected), dnsName: body.network?.tailscale?.dnsName ?? null },
  };
}

type UpgradableAnswer = { count?: number; securityCount?: number; rebootRequired?: boolean };
async function loadUpdates(): Promise<UpdatesFacts> {
  const { result } = await inspectOperation<UpgradableAnswer>("apt.upgradable.inspect");
  if (typeof result?.count !== "number") throw new Error("The update check did not say how many updates there are");
  return { count: result.count, security: result.securityCount ?? 0, rebootRequired: Boolean(result.rebootRequired) };
}

type UnattendedAnswer = { enabled?: boolean };
async function loadUnattended(): Promise<{ enabled: boolean }> {
  const { result } = await inspectOperation<UnattendedAnswer>("apt.unattended.inspect");
  if (typeof result?.enabled !== "boolean") throw new Error("The automatic-updates setting could not be read");
  return { enabled: result.enabled };
}

type ServiceAnswer = { counts?: { failed?: number } };
async function loadServices(): Promise<{ failed: number }> {
  const { result } = await inspectOperation<ServiceAnswer>("service.list");
  if (typeof result?.counts?.failed !== "number") throw new Error("The service list had no counts");
  return { failed: result.counts.failed };
}

type RawWatch = {
  targetConfigured?: boolean;
  conditions?: Array<{ key: string; active: boolean; details?: Array<{ title: string; since?: string | null; announced?: boolean }> }>;
  notices?: Array<{ key: string; title: string; since?: string | null }>;
};
export function watchFactsFrom(body: RawWatch): WatchFacts {
  if (!Array.isArray(body?.conditions)) throw new Error("The health watcher's answer had no conditions");
  return {
    targetConfigured: body.targetConfigured === true,
    alerts: body.conditions.filter((condition) => condition.active).flatMap((condition) => list<{ title: string; since?: string | null; announced?: boolean }>(condition.details)
      .map((detail) => ({ family: condition.key, title: detail.title, since: detail.since ?? null, announced: detail.announced !== false }))),
    notices: list<{ key: string; title: string; since?: string | null }>(body.notices).map((notice) => ({ family: notice.key, title: notice.title, since: notice.since ?? null, announced: false })),
  };
}

/** Repair's scan, checked for shape by the same reader the Repair page uses. */
export async function loadRepairs(): Promise<RepairScan> {
  return scanFrom(await getJson<unknown>("/api/v1/remediations"));
}

type RawSchedule = { id: string; operationId: string; title?: string; parameters?: ScheduleFact["parameters"]; enabled?: boolean; overdue?: boolean; cadence?: string; lastRunAt?: string | null; lastOutcome?: string | null; lastReason?: string | null };
async function loadSchedules(): Promise<ScheduleFact[]> {
  const body = await getJson<{ schedules?: RawSchedule[] }>("/api/v1/schedules");
  if (!Array.isArray(body?.schedules)) throw new Error("The schedule list was missing");
  return body.schedules.map((schedule) => ({
    id: schedule.id, operationId: schedule.operationId, title: text(schedule.title, schedule.operationId), parameters: schedule.parameters ?? null,
    enabled: schedule.enabled !== false, overdue: Boolean(schedule.overdue), cadence: schedule.cadence ?? null,
    lastRunAt: schedule.lastRunAt ?? null, lastOutcome: schedule.lastOutcome ?? null, lastReason: schedule.lastReason ?? null,
  }));
}

type ProtectionAnswer = { available?: boolean; apps?: AppProtection[] };
async function loadProtection(): Promise<AppProtection[]> {
  const { result } = await inspectOperation<ProtectionAnswer>("app.backup.protection");
  if (!result?.available || !Array.isArray(result.apps)) throw new Error("Which apps have backups could not be read");
  return result.apps;
}

type MachineAnswer = { sync?: { mount?: { mounted?: boolean }; lastSync?: { completedAt?: string } | null } };
type DestinationAnswer = { destination?: unknown; lastSync?: unknown };
async function loadOffBox(): Promise<OffBoxFacts> {
  // A destination that cannot be read is unknown, not absent: if none of the three answers, the
  // verdict is not known either, rather than "backups are only on this server".
  const destination = (url: string) => getJson<DestinationAnswer>(url).then((body) => ({ ok: true, body }), () => ({ ok: false, body: null as DestinationAnswer | null }));
  const [cloud, ssh, machine, backups] = await Promise.all([
    destination("/api/v1/settings/cloud-destination"),
    destination("/api/v1/settings/backup-destination"),
    inspectOperation<MachineAnswer>("host.snapshot.inspect").then(({ result }) => result, () => null),
    getJson<{ backups?: Array<{ createdAt?: string }> }>("/api/v1/backups").then((body) => list<{ createdAt?: string }>(body?.backups), () => []),
  ]);
  if (!cloud.ok && !ssh.ok && !machine) throw new Error("None of the backup destinations answered");
  const at = (value: unknown) => (typeof value === "string" ? value : (value as { completedAt?: string } | null)?.completedAt ?? null);
  const inputs: OffBoxInputs = {
    cloud: { configured: Boolean(cloud.body?.destination), lastSyncAt: at(cloud.body?.lastSync) },
    ssh: { configured: Boolean(ssh.body?.destination), lastSyncAt: at(ssh.body?.lastSync) },
    drive: { configured: Boolean(machine?.sync?.mount?.mounted), lastSyncAt: machine?.sync?.lastSync?.completedAt ?? null },
  };
  const newestLocalBackupAt = backups.reduce<string | null>((newest, backup) => (backup.createdAt && (newest === null || backup.createdAt > newest) ? backup.createdAt : newest), null);
  return { verdict: offBoxVerdict(inputs, { newestLocalBackupAt }), inputs };
}

async function loadDatabase(): Promise<{ lastBackupAt: string | null }> {
  const body = await getJson<{ backups?: Array<{ applicationId?: string; createdAt?: string }> }>("/api/v1/backups");
  if (!Array.isArray(body?.backups)) throw new Error("The backup list was missing");
  const own = body.backups.filter((backup) => backup.applicationId === "boxpilot-controller" && backup.createdAt).map((backup) => backup.createdAt as string).sort();
  return { lastBackupAt: own.at(-1) ?? null };
}

async function loadSetup(): Promise<{ firstRun: boolean }> {
  const body = await getJson<{ firstRun?: boolean }>("/api/v1/setup");
  if (typeof body?.firstRun !== "boolean") throw new Error("Whether this server is set up could not be read");
  return { firstRun: body.firstRun };
}

async function loadChecklist(): Promise<ChecklistFacts> {
  const body = await getJson<{ items?: ChecklistItem[]; done?: number; total?: number }>("/api/v1/setup/checklist");
  if (!Array.isArray(body?.items)) throw new Error("The setup checklist was missing");
  return { items: body.items, done: body.done ?? body.items.filter((item) => item.done).length, total: body.total ?? body.items.length };
}

type RawDomains = { domains?: Array<{ name?: string; state?: string; vcpus?: number; memoryKiB?: number }> };
async function loadVms(): Promise<VmFacts> {
  const body = await getJson<RawDomains>("/api/v1/virtualization/domains");
  if (!Array.isArray(body?.domains)) throw new Error("The virtual machine list was missing");
  return { domains: body.domains.map((domain) => ({ name: text(domain.name, "unnamed"), state: text(domain.state, "unknown"), vcpus: number(domain.vcpus), memoryBytes: number(domain.memoryKiB) === null ? null : (domain.memoryKiB as number) * 1024 })) };
}

type DiscoverAnswer = { locations?: Array<{ mount?: { source?: string }; snapshots?: unknown[] }> };
async function loadRebuild(): Promise<{ count: number; source: string } | null> {
  // A fresh box with a drive of snapshots already mounted is a rebuild waiting to happen.
  const { result } = await inspectOperation<DiscoverAnswer>("host.snapshot.discover");
  const locations = list<{ mount?: { source?: string }; snapshots?: unknown[] }>(result?.locations);
  const count = locations.reduce((total, location) => total + list(location.snapshots).length, 0);
  return count > 0 ? { count, source: text(locations[0]?.mount?.source, "a mounted drive") } : null;
}

const loaders = {
  catalog: loadCatalog,
  inventory: async () => inventoryFactsFrom(await getJson<RawInventory>("/api/v1/inventory")),
  updates: loadUpdates,
  unattended: loadUnattended,
  services: loadServices,
  watch: async () => watchFactsFrom(await getJson<RawWatch>("/api/v1/settings/watch")),
  repairs: loadRepairs,
  schedules: loadSchedules,
  protection: loadProtection,
  offBox: loadOffBox,
  database: loadDatabase,
  setup: loadSetup,
  checklist: loadChecklist,
  vms: loadVms,
} satisfies { [K in Exclude<keyof Facts, "jobs" | "rebuild">]: () => Promise<NonNullable<Facts[K]["value"]>> };

type LoadedKey = keyof typeof loaders;
const allKeys = Object.keys(loaders) as LoadedKey[];
/** Read again every minute while a view is open: what an app, a disk or a watcher says right now. */
const quickKeys: LoadedKey[] = ["catalog", "inventory", "services", "watch", "vms"];
/** Every five minutes: reads that cost the helper more (the problem scan, apt, the destinations). */
const slowKeys = allKeys.filter((key) => !quickKeys.includes(key));

function upsertJob(jobs: Job[], job: Job): Job[] {
  const next = jobs.some((entry) => entry.id === job.id) ? jobs.map((entry) => (entry.id === job.id ? job : entry)) : [job, ...jobs];
  return next.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, 50);
}

interface FactsContextValue {
  facts: Facts;
  /** Read these sources again now (every source when none are named). */
  refresh: (keys?: Array<keyof Facts>) => void;
  /** Take a source's answer read elsewhere, as if its loader had read it (a fix re-reading Repair's scan). */
  accept: <K extends keyof Facts>(key: K, value: NonNullable<Facts[K]["value"]>) => void;
  /** A view that shows facts calls this while it is open; the returned function says it closed. */
  demand: () => () => void;
}

const FactsContext = createContext<FactsContextValue | null>(null);

export function FactsProvider({ children }: { children: ReactNode }) {
  const [facts, setFacts] = useState<Facts>(emptyFacts);
  const [viewers, setViewers] = useState(0);
  const mounted = useRef(true);
  const inFlight = useRef(new Set<keyof Facts>());
  const lastFullLoad = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const set = useCallback(<K extends keyof Facts>(key: K, source: Facts[K]) => {
    if (mounted.current) setFacts((current) => ({ ...current, [key]: source }));
  }, []);

  const load = useCallback((key: LoadedKey) => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    // Keep the last answer on screen while it is read again; only a first read shows "loading".
    setFacts((current) => (current[key].value === null ? { ...current, [key]: { state: "loading", value: null, error: null } } : current));
    (loaders[key] as () => Promise<unknown>)()
      .then((value) => set(key, { state: "ready", value, error: null } as Facts[typeof key]))
      .catch((error: unknown) => set(key, { state: "failed", value: null, error: error instanceof Error ? error.message : "Could not be read" } as Facts[typeof key]))
      .finally(() => inFlight.current.delete(key));
  }, [set]);

  const refresh = useCallback((keys?: Array<keyof Facts>) => {
    const chosen = (keys ?? allKeys).filter((key): key is LoadedKey => key in loaders);
    if (!keys) lastFullLoad.current = Date.now();
    for (const key of chosen) load(key);
  }, [load]);

  const demand = useCallback(() => {
    setViewers((count) => count + 1);
    return () => setViewers((count) => Math.max(0, count - 1));
  }, []);

  const active = viewers > 0;
  useEffect(() => {
    if (!active) return undefined;
    // Switching between Home and Ops within half a minute reuses what was just read.
    if (Date.now() - lastFullLoad.current > 30_000) refresh();
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const quick = window.setInterval(() => { if (visible()) refresh(quickKeys); }, 60_000);
    const slow = window.setInterval(() => { if (visible()) refresh(slowKeys); }, 300_000);
    const stopJobs = followJobs({
      onSnapshot: (jobs) => set("jobs", { state: "ready", value: [...jobs].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")), error: null }),
      onJob: (job) => setFacts((current) => (mounted.current ? { ...current, jobs: { state: "ready", value: upsertJob(current.jobs.value ?? [], job), error: null } } : current)),
      onStatus: (status) => { if (status === "unavailable") setFacts((current) => (current.jobs.value ? current : { ...current, jobs: { state: "failed", value: null, error: "Job history could not be read" } })); },
    });
    return () => { window.clearInterval(quick); window.clearInterval(slow); stopJobs(); };
  }, [active, refresh, set]);

  // Only a server nobody has set up goes looking for a rebuild: an established one restoring a
  // single app is not rebuilding. It is an operator's read (ADR-003); anyone else gets no card.
  const firstRun = facts.setup.value?.firstRun ?? null;
  useEffect(() => {
    if (firstRun === null) return;
    if (!firstRun) { set("rebuild", { state: "ready", value: null, error: null }); return; }
    set("rebuild", { state: "loading", value: null, error: null });
    loadRebuild().then((value) => set("rebuild", { state: "ready", value, error: null }), () => set("rebuild", { state: "ready", value: null, error: null }));
  }, [firstRun, set]);

  const accept = useCallback(<K extends keyof Facts>(key: K, value: NonNullable<Facts[K]["value"]>) => {
    set(key, { state: "ready", value, error: null } as Facts[K]);
  }, [set]);

  const value = useMemo(() => ({ facts, refresh, accept, demand }), [facts, refresh, accept, demand]);
  return <FactsContext.Provider value={value}>{children}</FactsContext.Provider>;
}

/**
 * The facts, for a view that shows them. While `active`, the provider keeps them fresh; a part of
 * the shell that only glances at them (the dock's counts) passes false and asks for nothing.
 */
export function useFacts({ active = true }: { active?: boolean } = {}): FactsContextValue {
  const context = useContext(FactsContext);
  if (!context) throw new Error("useFacts needs a FactsProvider around it");
  const { demand } = context;
  useEffect(() => (active ? demand() : undefined), [active, demand]);
  return context;
}

/** The same, for a part of the page that may be drawn without a provider (a test of one component). */
export function useOptionalFacts(): FactsContextValue | null {
  return useContext(FactsContext);
}
