/**
 * The storage map (M23.4): one picture of how storage is wired. For every place data can live —
 * a mounted drive, a connected network share, the system disk — which apps read and write it,
 * which network shares serve it out, how full it is, and when it is forecast to fill.
 *
 * Pure correlation over data the Storage page already fetches, so it stays testable and adds no
 * new endpoint.
 */

export interface MapMount { target: string; source: string; fstype: string; sizeBytes: number | null; availableBytes: number | null }
export interface MapSambaShare { name: string; path: string; recycle?: boolean; recycleBytes?: number | null }
export interface MapApp { id: string; name: string; paths: string[] }
export interface MapForecast { target: string; daysToFull: number }

export interface StorageMapEntry {
  id: string;
  label: string;
  kind: "drive" | "network" | "system";
  source: string | null;
  fstype: string | null;
  sizeBytes: number | null;
  availableBytes: number | null;
  daysToFull: number | null;
  apps: Array<{ id: string; name: string; path: string }>;
  shares: Array<{ name: string; recycle: boolean; recycleBytes: number | null }>;
}

const isDataTarget = (target: string) => target.startsWith("/mnt/") || target.startsWith("/srv/");
const contains = (base: string, candidate: string) => candidate === base || candidate.startsWith(`${base}/`);

/** Apps from the catalog listing, reduced to the host folders each installed app actually mounts. */
export function appFolders(applications: Array<{ manifest: { id: string; name: string; volumes?: Array<{ id: string; hostPath: string | null }> }; live?: { installed?: boolean; state?: { values?: { volumes?: Record<string, string> } } | null } | null }>): MapApp[] {
  const apps: MapApp[] = [];
  for (const entry of applications) {
    if (!entry.live?.installed) continue;
    const chosen = entry.live.state?.values?.volumes ?? {};
    const paths = new Set<string>();
    for (const volume of entry.manifest.volumes ?? []) {
      const path = chosen[volume.id] ?? volume.hostPath;
      if (path && isDataTarget(path)) paths.add(path.replace(/\/+$/, ""));
    }
    if (paths.size) apps.push({ id: entry.manifest.id, name: entry.manifest.name, paths: [...paths] });
  }
  return apps;
}

export function buildStorageMap({ mounts = [], sambaShares = [], apps = [], forecasts = [], networkTargets = [] }: {
  mounts?: MapMount[]; sambaShares?: MapSambaShare[]; apps?: MapApp[]; forecasts?: MapForecast[]; networkTargets?: string[];
}): StorageMapEntry[] {
  const network = new Set(networkTargets);
  const dataMounts = mounts.filter((mount) => isDataTarget(mount.target));
  const entries: StorageMapEntry[] = dataMounts.map((mount) => ({
    id: mount.target,
    label: mount.target,
    kind: network.has(mount.target) || ["cifs", "nfs", "nfs4"].includes(mount.fstype) ? "network" : "drive",
    source: mount.source,
    fstype: mount.fstype,
    sizeBytes: mount.sizeBytes,
    availableBytes: mount.availableBytes,
    daysToFull: forecasts.find((forecast) => forecast.target === mount.target)?.daysToFull ?? null,
    apps: [],
    shares: [],
  }));
  const system: StorageMapEntry = {
    id: "/", label: "System disk", kind: "system", source: null, fstype: null,
    sizeBytes: null, availableBytes: null,
    daysToFull: forecasts.find((forecast) => forecast.target === "/")?.daysToFull ?? null,
    apps: [], shares: [],
  };
  // Deepest mount wins, so /mnt/pool/media attaches to /mnt/pool/media over /mnt/pool.
  const homeFor = (path: string) => {
    const candidates = entries.filter((entry) => contains(entry.id, path));
    if (!candidates.length) return system;
    return candidates.sort((left, right) => right.id.length - left.id.length)[0];
  };
  for (const app of apps) for (const path of app.paths) {
    const home = homeFor(path);
    if (!home.apps.some((existing) => existing.id === app.id && existing.path === path)) home.apps.push({ id: app.id, name: app.name, path });
  }
  for (const share of sambaShares) {
    const path = share.path.replace(/\/+$/, "");
    if (!isDataTarget(path)) continue;
    homeFor(path).shares.push({ name: share.name, recycle: Boolean(share.recycle), recycleBytes: share.recycleBytes ?? null });
  }
  // The system bucket only earns a card when something actually lives there.
  const all = system.apps.length || system.shares.length || system.daysToFull !== null ? [...entries, system] : entries;
  return all.sort((left, right) => (Number(left.kind === "system") - Number(right.kind === "system")) || left.label.localeCompare(right.label));
}
