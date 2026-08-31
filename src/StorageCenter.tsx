import { useCallback, useEffect, useState } from "react";
import type { ViewName } from "./data";
import { appFolders, buildStorageMap, type MapApp, type MapSambaShare, type StorageMapEntry } from "./storageMap";
import { readJson } from "./http";
import { validShareName } from "./shareName";
import { useOperation } from "./ApproveDialog";
import SambaPanel from "./SambaPanel";
import NfsPanel from "./NfsPanel";

interface DeviceRow {
  path: string | null; type: string | null; sizeBytes: number | null; fstype: string | null; uuid: string | null; label: string | null; model: string | null; transport: string | null;
  mountpoints: string[]; readOnly: boolean; removable: boolean; depth: number;
  protected: boolean; protectedReason: string | null; volumeGroup: string | null; logicalVolume: string | null; holdsVolumeGroups: string[]; mountedBelow: string[];
}
interface MountRow { target: string; source: string; fstype: string; sizeBytes: number | null; usedBytes: number | null; availableBytes: number | null }
interface FstabRow { device: string; mountpoint: string; fstype: string; options: string; managedName: string | null }
interface VolumeGroup { name: string | null; physicalVolumes: string[]; sizeBytes: number; usedBytes: number; freeBytes: number; logicalVolumes: Array<{ path: string; name: string; sizeBytes: number; fstype: string | null; mountpoints: string[]; growable: boolean; snapshot?: boolean }> }
interface ShareRow { name: string; kind: "smb" | "nfs"; source: string; mountpoint: string; readOnly: boolean; automount: boolean; mounted: boolean; sizeBytes: number | null; usedBytes: number | null; availableBytes: number | null }
interface SnapshotRow { path: string; name: string; volumeGroup: string | null; sizeBytes: number; origin?: string; sizeGiB?: number; createdAt?: string; suffix?: string | null }
interface StorageReport { devices: DeviceRow[]; mounts: MountRow[]; fstab: FstabRow[]; volumeGroups: VolumeGroup[]; snapshots?: SnapshotRow[]; shares: ShareRow[]; tools: { cifs: boolean; nfs: boolean; smbclient: boolean; showmount: boolean } }
interface Forecast { target: string; daysToFull: number; availableBytes: number | null; totalBytes: number | null; samples: number }
interface Discovered { address: string; name: string | null; smb: boolean; nfs: boolean; mac: string | null; interface: string | null }

function gib(bytes: number | null): string {
  if (bytes === null) return "—";
  return bytes >= 1024 ** 4 ? `${(bytes / 1024 ** 4).toFixed(1)} TiB` : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
/** Backups sync to this exact mount point; see server/machine-snapshot-helper.mjs. */
const BACKUP_MOUNT_NAME = "boxpilot-backup";

const nameValid = (name: string) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(name);
// exFAT/FAT/NTFS carry no Unix permissions, so a plain mount is root-owned and apps cannot write.
const permissionlessFs = (fstype: string | null) => ["exfat", "vfat", "ntfs", "ntfs3", "msdos"].includes((fstype ?? "").toLowerCase());

export default function StorageCenter({ csrfToken, onNavigate }: { csrfToken: string; onNavigate?: (view: ViewName) => void }) {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mountTarget, setMountTarget] = useState<DeviceRow | null>(null);
  const [mountName, setMountName] = useState("");
  const [mountReadOnly, setMountReadOnly] = useState(false);
  const [mountAppWritable, setMountAppWritable] = useState(false);
  const [sharePrefill, setSharePrefill] = useState<{ name: string; path: string } | null>(null);

  const [discovered, setDiscovered] = useState<{ devices: Discovered[]; scanned: number } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [kind, setKind] = useState<"smb" | "nfs">("smb");
  const [host, setHost] = useState("");
  const [share, setShare] = useState("");
  const [shareName, setShareName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");
  const [shareReadOnly, setShareReadOnly] = useState(false);
  const [listing, setListing] = useState(false);
  const [listed, setListed] = useState<Array<{ name: string; comment: string | null }> | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [snapshotOrigin, setSnapshotOrigin] = useState("");
  const [snapshotSize, setSnapshotSize] = useState(10);
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [forecasts, setForecasts] = useState<Forecast[]>([]);
  const [mapApps, setMapApps] = useState<MapApp[]>([]);
  const [mapShares, setMapShares] = useState<MapSambaShare[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await readJson<StorageReport>(await fetch("/api/v1/storage/overview")));
      fetch("/api/v1/storage/forecast").then((response) => (response.ok ? response.json() : { forecasts: [] })).then((body: { forecasts?: Forecast[] }) => setForecasts(body.forecasts ?? [])).catch(() => {});
      // For the storage map: which apps mount which folders, and which folders are served as shares.
      fetch("/api/v1/catalog").then((response) => (response.ok ? response.json() : null)).then((body: { applications?: Parameters<typeof appFolders>[0] } | null) => setMapApps(body?.applications ? appFolders(body.applications) : [])).catch(() => {});
      fetch("/api/v1/storage/samba").then((response) => (response.ok ? response.json() : null)).then((body: { config?: { shares?: MapSambaShare[] } } | null) => setMapShares(body?.config?.shares ?? [])).catch(() => {});
      setRefreshKey((key) => key + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read storage state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { setMountTarget(null); setMountName(""); setPassword(""); void refresh(); });

  const managedByMountpoint = new Map((report?.fstab ?? []).filter((row) => row.managedName && !row.managedName.startsWith("share-")).map((row) => [row.mountpoint, row.managedName as string]));
  const disks = (report?.devices ?? []).filter((device) => device.type === "disk");
  // storage.lvm.extend keeps 32 GiB unallocated for snapshots and does nothing below 256 MiB of
  // actual growth, so the offer only appears when there is really something to claim.
  const snapshotReserveBytes = 32 * 1024 ** 3;
  const growable = (report?.volumeGroups ?? []).flatMap((group) => group.logicalVolumes.filter((volume) => volume.growable).map((volume) => ({ group, volume }))).filter(({ group }) => group.freeBytes - snapshotReserveBytes >= 256 * 1024 ** 2);

  const canMount = (device: DeviceRow) => Boolean(!device.protected && device.uuid && device.fstype && device.fstype !== "swap" && device.mountpoints.length === 0 && !device.readOnly);
  const canFormat = (device: DeviceRow) => Boolean(!device.protected && device.path && !device.readOnly && ["disk", "part"].includes(device.type ?? "") && device.mountpoints.length === 0);

  const useDevice = (device: Discovered) => {
    setHost(device.name ?? device.address);
    setKind(device.smb ? "smb" : "nfs");
    setListed(null);
    setShareError(null);
  };
  const setShareAndName = (value: string) => { setShare(value); if (!nameTouched) setShareName(slug(value.split("/").filter(Boolean).at(-1) ?? value)); };

  const discover = async () => {
    setDiscovering(true); setShareError(null);
    try { setDiscovered(await readJson(await fetch("/api/v1/storage/shares/discover"))); }
    catch (requestError) { setShareError(requestError instanceof Error ? requestError.message : "Discovery failed"); }
    finally { setDiscovering(false); }
  };
  const listShares = async () => {
    setListing(true); setShareError(null); setListed(null);
    try {
      const body = await readJson<{ shares: Array<{ name: string; comment: string | null }> }>(await fetch("/api/v1/storage/shares/list", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ kind, host: host.trim(), username: kind === "smb" && username.trim() ? username.trim() : null, password: kind === "smb" && username.trim() ? password : null, domain: kind === "smb" && domain.trim() ? domain.trim() : null }) }));
      setListed(body.shares);
      if (!body.shares.length) setShareError("No shares were listed. Type the share name if you know it.");
    } catch (requestError) { setShareError(requestError instanceof Error ? requestError.message : "Could not list shares"); }
    finally { setListing(false); }
  };

  const hostValid = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/.test(host.trim());
  const shareValid = validShareName(kind, share.trim());
  const toolReady = kind === "smb" ? report?.tools.cifs : report?.tools.nfs;
  const shareFormValid = hostValid && shareValid && nameValid(shareName) && Boolean(toolReady);
  const shareBlocker = !toolReady ? null // the tools hint next to the button already covers this
    : !hostValid ? "Enter the NAS address first."
    : !shareValid ? (kind === "smb" ? "Pick a share below, or type its name. A folder inside one is fine, like alex/Backups." : "Enter the export path.")
    : !nameValid(shareName) ? "Give it a folder name under /mnt (lower case, no spaces)."
    : null;
  const credentialsPath = `/etc/boxpilot/secrets/share-${shareName || "<name>"}.cred`;
  const installTool = (pkg: string) => start({ operationId: "apt.install", title: `Install ${pkg}`, parameters: { packages: [pkg] }, preview: <span><code>apt-get install --no-install-recommends {pkg}</code></span> });

  const mountShare = () => start({
    operationId: "share.mount",
    title: `Mount ${kind === "smb" ? `//${host.trim()}/${share.trim()}` : `${host.trim()}:${share.trim()}`} at /mnt/${shareName}`,
    parameters: {
      kind, host: host.trim(), share: share.trim(), name: shareName,
      ...(kind === "smb" && username.trim() ? { username: username.trim(), password } : {}),
      ...(kind === "smb" && username.trim() && domain.trim() ? { domain: domain.trim() } : {}),
      ...(shareReadOnly ? { readOnly: true } : {}),
    },
    preview: (
      <span>
        Adds a <code>{kind === "smb" ? "cifs" : "nfs"}</code> entry to fstab for <code>/mnt/{shareName}</code> with <code>nofail</code>, <code>_netdev</code>, and systemd automount, so a NAS that is off never blocks boot and reconnects by itself.
        {kind === "smb" && username.trim() ? <> Credentials for <strong>{username.trim()}</strong> are stored root-only at <code>{credentialsPath}</code> and never shown again.</> : kind === "smb" ? <> Connects as <strong>guest</strong>.</> : null}
        {shareReadOnly ? " Mounted read-only." : ""} If the first mount fails, everything is removed again.
      </span>
    ),
  });

  return (
    <div className="storage-center">
      {dialog}
      {error && <div className="auth-error" role="alert">{error}</div>}

      <div className="metric-grid">
        <article className="panel"><span className="eyebrow">Disks</span><strong>{loading && !report ? "…" : disks.length}</strong><span>{disks.filter((disk) => disk.removable).length} removable</span></article>
        <article className="panel"><span className="eyebrow">Mounted</span><strong>{loading && !report ? "…" : report?.mounts.length ?? "—"}</strong><span>real filesystems</span></article>
        <article className="panel"><span className="eyebrow">Network shares</span><strong>{loading && !report ? "…" : report?.shares.length ?? "—"}</strong><span>{report?.shares.filter((entry) => entry.mounted).length ?? 0} connected</span></article>
        <article className="panel"><span className="eyebrow">Unallocated</span><strong>{loading && !report ? "…" : report ? gib(report.volumeGroups.reduce((sum, group) => sum + group.freeBytes, 0)) : "—"}</strong><span>free inside LVM volume groups</span></article>
      </div>

      {(() => {
        const map = report ? buildStorageMap({ mounts: report.mounts, sambaShares: mapShares, apps: mapApps, forecasts, networkTargets: report.shares.map((entry) => entry.mountpoint) }) : [];
        if (!map.length) return null;
        return (
          <section className="panel">
            <header className="panel-header"><div><strong>Storage map</strong><span>Each place data lives, what uses it, and how it is shared, in one picture.</span></div></header>
            <div className="storage-map">
              {map.map((entry) => {
                const usedShare = entry.sizeBytes && entry.availableBytes !== null ? Math.min(100, Math.round(((entry.sizeBytes - entry.availableBytes) / entry.sizeBytes) * 100)) : null;
                return (
                  <article className="storage-map-card" key={entry.id}>
                    <header>
                      <strong>{entry.label}</strong>
                      <span className="muted">{entry.kind === "network" ? `network share · ${entry.source}` : entry.kind === "drive" ? `${entry.fstype ?? "drive"} · ${entry.source}` : "everything not on a mounted drive"}</span>
                    </header>
                    {usedShare !== null && (
                      <div className="storage-map-usage">
                        <div className="storage-map-bar" role="img" aria-label={`${usedShare}% used`}><span style={{ width: `${usedShare}%` }} className={usedShare >= 90 ? "bar-hot" : ""} /></div>
                        <span className="muted">{gib(entry.availableBytes)} free{entry.daysToFull !== null && entry.daysToFull <= 90 ? ` · fills in ~${entry.daysToFull} days` : ""}</span>
                      </div>
                    )}
                    {usedShare === null && entry.daysToFull !== null && <p className="muted">Fills in ~{entry.daysToFull} days at the current rate.</p>}
                    <div className="storage-map-row"><span className="eyebrow">Apps</span>{entry.apps.length ? entry.apps.map((app) => <span className="chip" key={app.id + app.path} title={app.path}>{app.name}</span>) : <span className="muted">none yet</span>}</div>
                    <div className="storage-map-row"><span className="eyebrow">Shared as</span>{entry.shares.length ? entry.shares.map((share) => <span className="chip" key={share.name}>{share.name}{share.recycle ? " · recycle bin" : ""}</span>) : <span className="muted">not shared</span>}</div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })()}

      {forecasts.filter((forecast) => forecast.daysToFull <= 90).length > 0 && (
        <section className="panel">
          <header className="panel-header"><div><strong>Filling up</strong><span>At the rate free space has been dropping, these fill within three months. The estimate needs a few days of history and updates as the trend changes.</span></div></header>
          <div className="workload-list">
            {forecasts.filter((forecast) => forecast.daysToFull <= 90).map((forecast) => (
              <div className="workload" key={forecast.target}>
                <div><strong>{forecast.target}</strong><span>{forecast.availableBytes !== null ? `${gib(forecast.availableBytes)} free now` : ""}</span></div>
                <span className={`status-pill status-${forecast.daysToFull <= 14 ? "warning" : "neutral"}`}>{forecast.daysToFull <= 0 ? "full very soon" : `~${forecast.daysToFull} day${forecast.daysToFull === 1 ? "" : "s"} left`}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {(report?.volumeGroups ?? []).some((group) => group.logicalVolumes.some((volume) => !volume.snapshot && volume.mountpoints.length > 0)) && (() => {
        const origins = (report?.volumeGroups ?? []).flatMap((group) => group.logicalVolumes.filter((volume) => !volume.snapshot && volume.mountpoints.length > 0).map((volume) => ({ group, volume })));
        const chosen = origins.find((entry) => entry.volume.path === snapshotOrigin) ?? origins.find((entry) => entry.volume.mountpoints.includes("/")) ?? origins[0];
        const freeGiB = chosen ? Math.floor(chosen.group.freeBytes / 1024 ** 3) : 0;
        const sizeValid = Number.isInteger(snapshotSize) && snapshotSize >= 1 && snapshotSize <= Math.max(1, freeGiB);
        const labelValid = snapshotLabel === "" || /^[a-z0-9-]{1,24}$/.test(snapshotLabel);
        const snapshots = report?.snapshots ?? [];
        return (
          <section className="panel" id="snapshots">
            <header className="panel-header"><div><strong>Snapshots</strong><span>A restore point for a whole volume: take one before a big update, roll back if it goes wrong. Snapshots use free space in the volume group ({gib(chosen?.group.freeBytes ?? 0)} available) and fill up as the original changes.</span></div></header>
            {snapshots.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Snapshot</th><th>Of</th><th>Reserved</th><th>Taken</th><th aria-label="Actions" /></tr></thead>
                  <tbody>
                    {snapshots.map((snapshot) => (
                      <tr key={snapshot.path}>
                        <td><strong>{snapshot.suffix ?? snapshot.name.replace(/^boxpilot-snap-/, "")}</strong><span className="muted"> {snapshot.name}</span></td>
                        <td>{snapshot.origin ? <code>{snapshot.origin}</code> : <span className="muted">unknown</span>}</td>
                        <td>{snapshot.sizeGiB ? `${snapshot.sizeGiB} GiB` : gib(snapshot.sizeBytes)}</td>
                        <td>{snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : "—"}</td>
                        <td>
                          <div className="recovery-actions">
                            <button className="text-button" type="button" disabled={!snapshot.origin} title={snapshot.origin ? undefined : "BoxPilot has no record of which volume this snapshot came from"} onClick={() => start({
                              operationId: "storage.lvm.snapshot.rollback",
                              title: `Roll back to ${snapshot.name}`,
                              parameters: { path: snapshot.path },
                              confirmText: snapshot.name,
                              preview: <span>Runs <code>lvconvert --merge {snapshot.path}</code>. <strong>Everything written to {snapshot.origin ?? "the volume"} since {snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : "the snapshot"} is discarded.</strong> For the root volume the merge runs during the next reboot, so reboot the server when convenient. The snapshot is consumed by the merge.</span>,
                            })}>Roll back</button>
                            <button className="text-button" type="button" onClick={() => start({ operationId: "storage.lvm.snapshot.delete", title: `Remove snapshot ${snapshot.name}`, parameters: { path: snapshot.path }, preview: <span>Runs <code>lvremove -f {snapshot.path}</code> and frees its space. The original volume is untouched.</span> })}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <form className="share-form" onSubmit={(event) => { event.preventDefault(); if (chosen && sizeValid && labelValid) start({
              operationId: "storage.lvm.snapshot.create",
              title: `Take a snapshot of ${chosen.volume.mountpoints[0]}`,
              parameters: { path: chosen.volume.path, sizeGiB: snapshotSize, ...(snapshotLabel ? { suffix: snapshotLabel } : {}) },
              preview: <span>Runs <code>lvcreate -s -L {snapshotSize}G -n boxpilot-snap-&lt;time&gt;{snapshotLabel ? `-${snapshotLabel}` : ""} {chosen.volume.path}</code>. Reserves {snapshotSize} GiB for changes; if the original changes by more than that, the snapshot becomes invalid (it never harms the original). Remove snapshots you no longer need.</span>,
            }); }}>
              <label>Volume
                <select aria-label="Snapshot volume" value={chosen?.volume.path ?? ""} onChange={(event) => setSnapshotOrigin(event.target.value)}>{origins.map((entry) => <option value={entry.volume.path} key={entry.volume.path}>{entry.volume.mountpoints[0]} ({gib(entry.volume.sizeBytes)}, {entry.group.name})</option>)}</select>
              </label>
              <label>Space for changes (GiB)<input aria-label="Snapshot size" type="number" min={1} max={Math.max(1, freeGiB)} value={snapshotSize} onChange={(event) => setSnapshotSize(Number.parseInt(event.target.value, 10) || 1)} /></label>
              <label>Label <span className="muted">(optional)</span><input aria-label="Snapshot label" placeholder="before-upgrade" value={snapshotLabel} onChange={(event) => setSnapshotLabel(event.target.value.toLowerCase())} /></label>
              <div className="recovery-actions share-actions"><button className="primary-button" type="submit" disabled={!chosen || !sizeValid || !labelValid || freeGiB < 1}>Take a snapshot</button>{freeGiB < 1 && <span className="muted">No free space in the volume group; remove a snapshot or keep some space unallocated.</span>}</div>
            </form>
          </section>
        );
      })()}

      {growable.map(({ group, volume }) => (
        <section className="panel storage-grow" key={volume.path}>
          <header className="panel-header">
            <div>
              <strong>{gib(group.freeBytes)} of {group.name ?? "the volume group"} is not in use</strong>
              <span>The installer gave <code>{volume.mountpoints[0]}</code> only {gib(volume.sizeBytes)} of the {gib(group.sizeBytes)} volume group on {group.physicalVolumes.join(", ")}. Claim the rest online: no reboot, nothing is erased.</span>
            </div>
            <button className="primary-button" type="button" onClick={() => start({
              operationId: "storage.lvm.extend",
              title: `Grow ${volume.mountpoints[0]} by ${gib(group.freeBytes - snapshotReserveBytes)}`,
              parameters: { path: volume.path },
              preview: <span>Grows the logical volume into the free space of {group.name ?? "its group"} and resizes the {volume.fstype} filesystem while mounted (<code>lvextend -r</code>), keeping <strong>32 GiB</strong> unallocated for snapshots. Existing data is untouched.</span>,
            })}>Use the rest of the disk</button>
          </header>
        </section>
      ))}

      <section className="panel">
        <header className="panel-header"><div><strong>Block devices</strong><span>Mount a drive so your apps and network shares can use it: a nofail fstab entry, verified first, and by default handed to your apps so they can write to it. Format erases the device and asks you to type its name. The system disk and LVM members are never offered.</span></div>
          <button className="secondary-button" type="button" disabled={loading} onClick={() => void refresh()}>Refresh</button>
        </header>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Device</th><th>Size</th><th>Filesystem</th><th>Mounted at</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {loading && !report ? <tr><td colSpan={5}>Reading block devices...</td></tr> : null}
              {report?.devices.map((device, index) => (
                <tr key={device.path ?? `row-${index}`}>
                  <td style={{ paddingLeft: `${8 + device.depth * 18}px` }}><code>{device.path}</code>{device.model ? <span className="muted"> {device.model}</span> : null}{device.removable ? <span className="status-pill status-neutral">removable</span> : null}{device.protected ? <span className="status-pill status-neutral" title={device.protectedReason ?? ""}>{device.protectedReason === "system disk" ? "system" : "protected"}</span> : null}</td>
                  <td>{gib(device.sizeBytes)}</td>
                  <td>
                    {device.type === "lvm" && device.volumeGroup ? <>LVM volume <code>{device.volumeGroup}/{device.logicalVolume}</code>{device.fstype ? ` · ${device.fstype}` : ""}</>
                      : device.fstype === "LVM2_member" ? <>LVM physical volume{device.holdsVolumeGroups.length ? <> for <code>{device.holdsVolumeGroups.join(", ")}</code></> : null}</>
                        : <>{device.fstype ?? "—"}{device.label ? ` (${device.label})` : ""}</>}
                  </td>
                  <td>{device.mountpoints.length ? device.mountpoints.map((point) => <code key={point}>{point}</code>) : device.mountedBelow.length ? <span className="muted">holds {device.mountedBelow.join(", ")}</span> : "—"}</td>
                  <td>
                    <div className="recovery-actions">
                      {canMount(device) && <button className="text-button" type="button" onClick={() => { setMountTarget(device); setMountName(device.label ? slug(device.label) : ""); setMountReadOnly(false); setMountAppWritable(permissionlessFs(device.fstype)); }}>Mount</button>}
                      {canFormat(device) && <button className="text-button" type="button" onClick={() => start({
                        operationId: "storage.format",
                        title: `Erase and format ${device.path}`,
                        parameters: { device: device.path },
                        confirmText: device.path ?? "",
                        preview: <span>Runs <code>wipefs -a</code> then <code>mkfs.ext4</code> on <code>{device.path}</code> ({gib(device.sizeBytes)}{device.model ? `, ${device.model}` : ""}). <strong>Everything on it is destroyed.</strong></span>,
                      })}>Format</button>}
                      {!device.protected && device.mountpoints.some((point) => point.startsWith("/mnt/") || point.startsWith("/srv/")) && <button className="text-button" type="button" onClick={() => {
                        const point = device.mountpoints.find((entry) => entry.startsWith("/mnt/") || entry.startsWith("/srv/")) ?? device.mountpoints[0];
                        setSharePrefill({ name: slug(device.label || point.split("/").filter(Boolean).pop() || "share"), path: point });
                        document.getElementById("file-server")?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}>Share on network</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {mountTarget && (
          <div className="recovery-actions storage-mount-form">
            <span>Mount <code>{mountTarget.path}</code> at <code>/mnt/{nameValid(mountName) ? mountName : "<name>"}</code></span>
            <input aria-label="Mount name" placeholder="data" value={mountName} onChange={(event) => setMountName(event.target.value.toLowerCase())} />
            <label className="cloud-vm-check"><input type="checkbox" checked={mountReadOnly} onChange={(event) => { setMountReadOnly(event.target.checked); if (event.target.checked) setMountAppWritable(false); }} />read-only</label>
            <label className="cloud-vm-check" title="Give the drive to your apps (user 1000) so containers and network shares can write to it. Without this an exFAT/NTFS drive is read-only for apps."><input type="checkbox" checked={mountAppWritable} disabled={mountReadOnly} onChange={(event) => setMountAppWritable(event.target.checked)} />writable by my apps</label>
            <button className="primary-button" type="button" disabled={!nameValid(mountName)} onClick={() => start({
              operationId: "storage.mount",
              title: `Mount ${mountTarget.path} at /mnt/${mountName}`,
              parameters: { uuid: mountTarget.uuid, name: mountName, ...(mountReadOnly ? { readOnly: true } : {}), ...(mountAppWritable && !mountReadOnly ? { appWritable: true } : {}) },
              preview: <span>Mounts <code>{mountTarget.path}</code> ({mountTarget.fstype ?? "auto"}) at <code>/mnt/{mountName}</code> with a <code>nofail</code> fstab entry, so a missing disk never blocks boot.{mountReadOnly ? " Read-only." : mountAppWritable ? (permissionlessFs(mountTarget.fstype) ? " Owned by your apps user so containers and shares can write to it." : " The top folder is handed to your apps user so containers can write to it.") : ""}</span>,
            })}>Mount</button>
            <button className="text-button" type="button" onClick={() => setMountTarget(null)}>Cancel</button>
          </div>
        )}
      </section>

      <section className="panel" id="network-storage">
        <header className="panel-header"><div><strong>Network storage</strong><span>Mount a folder from a NAS (WD My Cloud, Synology, another PC) so apps here can use it. This server only connects out; nothing is opened to your LAN.</span></div></header>

        <div className="share-tools">
          <span>Tools:</span>
          <span className={`status-pill ${report?.tools.cifs ? "status-good" : "status-warning"}`}>SMB / Windows sharing {report?.tools.cifs ? "ready" : "missing"}</span>
          {report && !report.tools.cifs && <button className="text-button" type="button" onClick={() => installTool("cifs-utils")}>Install cifs-utils</button>}
          <span className={`status-pill ${report?.tools.nfs ? "status-good" : "status-warning"}`}>NFS {report?.tools.nfs ? "ready" : "missing"}</span>
          {report && !report.tools.nfs && <button className="text-button" type="button" onClick={() => installTool("nfs-common")}>Install nfs-common</button>}
          {report && !report.tools.smbclient && <button className="text-button" type="button" onClick={() => installTool("smbclient")}>Install smbclient (lists shares for you)</button>}
        </div>

        {report && report.shares.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Share</th><th>From</th><th>Mounted at</th><th>Status</th><th>Used</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {report.shares.map((entry) => {
                  const percent = entry.sizeBytes && entry.usedBytes !== null ? Math.round((entry.usedBytes / entry.sizeBytes) * 100) : null;
                  return (
                    <tr key={entry.name}>
                      <td><strong>{entry.name}</strong> <span className="status-pill status-neutral">{entry.kind === "smb" ? "SMB" : "NFS"}</span>{entry.readOnly && <span className="status-pill status-neutral">read-only</span>}</td>
                      <td><code>{entry.source}</code></td>
                      <td><code>{entry.mountpoint}</code></td>
                      <td><span className={`status-pill ${entry.mounted ? "status-good" : "status-neutral"}`}>{entry.mounted ? "Connected" : entry.automount ? "Connects on first use" : "Not connected"}</span></td>
                      <td>{percent !== null ? `${gib(entry.usedBytes)} of ${gib(entry.sizeBytes)} (${percent}%)` : "—"}</td>
                      <td><button className="text-button" type="button" onClick={() => start({ operationId: "share.unmount", title: `Unmount ${entry.name}`, parameters: { name: entry.name }, preview: <span>Unmounts <code>{entry.mountpoint}</code>, removes its fstab entry and automount, and deletes the stored credentials. Nothing on the NAS is touched.</span> })}>Unmount</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="share-discover">
          <div className="recovery-actions">
            <button className="secondary-button" type="button" disabled={discovering} onClick={() => void discover()}>{discovering ? "Scanning your network..." : "Find devices on my network"}</button>
            <span className="muted">Looks for anything answering Windows sharing (445) or NFS (2049) on your LAN. Takes a few seconds.</span>
          </div>
          {discovered && discovered.devices.length === 0 && <p className="muted">Nothing answered on ports 445 or 2049 across {discovered.scanned} addresses. Check the NAS is switched on. On a WD My Cloud Home, open the My Cloud Home app → Settings → <em>Local network access</em> and turn it on, then try again. You can also type its address below.</p>}
          {discovered && discovered.devices.length > 0 && (
            <ul className="discovered-list">
              {discovered.devices.map((device) => (
                <li className="discovered" key={device.address}>
                  <strong>{device.name ?? device.address}</strong>{device.name && <code>{device.address}</code>}
                  {device.smb && <span className="status-pill status-good">SMB</span>}
                  {device.nfs && <span className="status-pill status-good">NFS</span>}
                  <button className="text-button" type="button" onClick={() => useDevice(device)}>Use this device</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form className="share-form" onSubmit={(event) => { event.preventDefault(); if (shareFormValid) mountShare(); }}>
          <label>Type
            <select aria-label="Share type" value={kind} onChange={(event) => { setKind(event.target.value as "smb" | "nfs"); setListed(null); }}><option value="smb">SMB / Windows sharing (most NAS, My Cloud)</option><option value="nfs">NFS</option></select>
          </label>
          <label>NAS address or name
            <input aria-label="Host" placeholder="192.168.1.50 or mycloud" value={host} onChange={(event) => setHost(event.target.value)} />
          </label>
          <label>{kind === "smb" ? "Share name" : "Export path"}
            <input aria-label={kind === "smb" ? "Share name" : "Export path"} placeholder={kind === "smb" ? "Public or Public/Backups" : "/volume1/media"} value={share} onChange={(event) => setShareAndName(event.target.value)} />
          </label>
          <label>Mount as <code>/mnt/…</code>
            <input aria-label="Share mount name" placeholder="nas-media" value={shareName} onChange={(event) => { setNameTouched(true); setShareName(event.target.value.toLowerCase()); }} />
            {/* The one mount point that means something to the rest of BoxPilot. Backups look for
                this exact path, so a share mounted anywhere else is a folder and nothing more —
                which is easy to discover only after setting one up and wondering why the Backups
                page still says there is nowhere to copy to. */}
            {shareName === BACKUP_MOUNT_NAME
              ? <span className="muted">BoxPilot will copy its backups here.</span>
              : <button className="text-button" type="button" onClick={() => { setNameTouched(true); setShareName(BACKUP_MOUNT_NAME); }}>Use this for BoxPilot's backups</button>}
          </label>
          {kind === "smb" && (
            <>
              <label>Username <span className="muted">(empty = guest)</span>
                <input aria-label="Share username" placeholder="leave empty for the Public folder" autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <label>Password
                <input aria-label="Share password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={!username.trim()} />
              </label>
              <label>Domain / workgroup <span className="muted">(optional)</span>
                <input aria-label="Share domain" placeholder="WORKGROUP" value={domain} onChange={(event) => setDomain(event.target.value)} disabled={!username.trim()} />
              </label>
            </>
          )}
          <label className="cloud-vm-check share-readonly"><input type="checkbox" checked={shareReadOnly} onChange={(event) => setShareReadOnly(event.target.checked)} />read-only</label>
          <div className="recovery-actions share-actions">
            <button className="secondary-button" type="button" disabled={!hostValid || listing} onClick={() => void listShares()}>{listing ? "Asking the NAS..." : "List shares"}</button>
            <button className="primary-button" type="submit" disabled={!shareFormValid}>Mount share</button>
            {!toolReady && report && <span className="muted">Install {kind === "smb" ? "cifs-utils" : "nfs-common"} above first.</span>}
            {shareBlocker && <span className="muted">{shareBlocker}</span>}
          </div>
          {shareError && <div className="auth-error share-error" role="alert">{shareError}</div>}
          {listed && listed.length > 0 && (
            <div className="share-list">
              <span className="muted">Shares on {host.trim()}. Click one to use it:</span>
              {listed.map((entry) => <button className="text-button" type="button" key={entry.name} onClick={() => setShareAndName(entry.name)}>{entry.name}{entry.comment ? <span className="muted">, {entry.comment}</span> : null}</button>)}
            </div>
          )}
        </form>

        <p className="muted share-note">
          <strong>WD My Cloud Home:</strong> it offers only <code>Public</code>, <code>TimeMachineBackup</code> and one share per user. You cannot add more, so point at a folder inside one, like <code>yourname/Backups</code>. The <code>Public</code> folder works as guest; your private files need <em>Local network access</em> enabled in the My Cloud Home app, which gives you a username and password to enter here.
          <br /><strong>Reach it from anywhere, only over Tailscale:</strong> shares stay private to this server. To browse them from your phone or laptop, install <em>File Browser</em> from the App catalog (it listens on this server only), point it at <code>/mnt</code>, and click <em>Serve on tailnet (HTTPS)</em>. Nothing is exposed on your LAN or the internet.
        </p>
      </section>

      <SambaPanel start={start} refreshKey={refreshKey} prefill={sharePrefill} onNavigate={onNavigate} csrfToken={csrfToken} folders={[...new Set([...(report?.shares ?? []).map((entry) => entry.mountpoint), ...(report?.fstab ?? []).filter((row) => row.managedName).map((row) => row.mountpoint), "/srv", "/mnt"])]} />
      <NfsPanel start={start} refreshKey={refreshKey} folders={[...new Set([...(report?.shares ?? []).map((entry) => entry.mountpoint), ...(report?.fstab ?? []).filter((row) => row.managedName).map((row) => row.mountpoint), "/srv", "/mnt"])]} />

      <section className="panel">
        <header className="panel-header"><div><strong>Mounted filesystems</strong><span>Unmount is offered only for mounts BoxPilot added; entries you created stay yours.</span></div></header>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Mounted at</th><th>Device</th><th>Type</th><th>Used</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {report?.mounts.map((mount) => {
                const managedName = managedByMountpoint.get(mount.target);
                const percent = mount.sizeBytes && mount.usedBytes !== null ? Math.round((mount.usedBytes / mount.sizeBytes) * 100) : null;
                return (
                  <tr key={mount.target}>
                    <td><code>{mount.target}</code>{managedName ? <span className="status-pill status-neutral">managed</span> : null}</td>
                    <td><code>{mount.source}</code></td>
                    <td>{mount.fstype}</td>
                    <td>{percent !== null ? <span className={percent >= 90 ? "status-pill status-danger" : ""}>{gib(mount.usedBytes)} of {gib(mount.sizeBytes)} ({percent}%)</span> : "—"}</td>
                    <td>{managedName && <button className="text-button" type="button" onClick={() => start({
                      operationId: "storage.unmount",
                      title: `Unmount /mnt/${managedName}`,
                      parameters: { name: managedName },
                      preview: <span>Unmounts <code>{mount.target}</code> and removes its fstab entry. Data on the disk and the empty directory are kept.</span>,
                    })}>Unmount</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
