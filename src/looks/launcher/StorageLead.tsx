import { useId, type ReactNode } from "react";
import { mountpointFor } from "../../mountpoints";
import { ReconnectSwitch } from "../../pages/storage/parts";
import { gib, managedMounts, percentUsed, type DeviceRow, type MountRow, type StorageReport } from "../../pages/storage/types";
import { useOperation } from "../../shell/ApproveDialog";
import { AreaIcon, BellIcon } from "../../shell/areaIcons";
import { Button, RiskTag, StatusChip, mayStart, riskOf, type Status } from "../../ui";
import type { ViewName } from "../../data";
import type { StorageLeadProps } from "../StorageLead";
import "./lead.css";

/*
 * The top of Storage in the Launcher (M41, docs/design-directions/05-looks.html, M.homeStorage):
 * a glance above the tabs. The drives down the left in a glass panel, each named plainly first
 * ("Media drive", "System disk"), its path and filesystem in mono under the name, how full in a
 * thick bar, and a row under it: reconnecting it when it drops, the space it leaves unused, or a way
 * to mount it. At the right, what needs you here, the shared folders and the snapshots. Every fact
 * leads to its tab; the one fix offered, claiming unused space, is the Drives tab's own, through
 * the approval dialog at its tier.
 */

// storage.lvm.extend keeps 32 GiB unallocated for snapshots and does nothing below 256 MiB of real
// growth, as the Drives tab reads it (src/pages/storage/DrivesTab.tsx).
const snapshotReserveBytes = 32 * 1024 ** 3;

type Tab = Parameters<StorageLeadProps["onTab"]>[0];

/** A size as it is said: "954 GB", "3.9 TB". */
function roughSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const tib = bytes / 1024 ** 4;
  if (tib >= 0.98) return `${tib.toFixed(1).replace(/\.0$/, "")} TB`;
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

/** Used of the whole in the whole's unit: "2.6 of 3.9 TB", "212 of 700 GB". */
function usedOf(used: number | null, total: number | null): string {
  if (used === null || total === null) return "size not known";
  if (total >= 0.98 * 1024 ** 4) return `${(used / 1024 ** 4).toFixed(1)} of ${(total / 1024 ** 4).toFixed(1)} TB`;
  return `${Math.round(used / 1024 ** 3)} of ${Math.round(total / 1024 ** 3)} GB`;
}

const transportWords: Record<string, string> = { usb: "USB", nvme: "NVMe", sata: "SATA", ata: "SATA", sas: "SAS", mmc: "SD card", virtio: "virtual" };

/** "Media drive" from its label "media"; a label that already says what it is stays as it is. */
function plainName(label: string | null | undefined): string | null {
  const words = (label ?? "").replace(/[-_]+/g, " ").trim();
  if (!words) return null;
  const said = words.charAt(0).toUpperCase() + words.slice(1);
  return /\b(drive|disk|ssd|hdd)$/i.test(words) ? said : `${said} drive`;
}

/** "Before upgrade" from "before-upgrade". */
const humanize = (text: string) => { const words = text.replace(/[-_]+/g, " ").trim(); return words.charAt(0).toUpperCase() + words.slice(1); };

/** "30 Sep, 02:58": a snapshot's day and time. */
function takenAt(iso: string | undefined): string | null {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

interface Drive {
  key: string;
  name: string;
  sub: string;
  icon: ViewName;
  mount: MountRow | null;
  percent: number | null;
  status: Status | undefined;
  /** BoxPilot's name for a drive it mounted, when it can reconnect it. */
  armable: string | null;
  /** A partition that can be mounted, for a drive with nothing mounted. */
  mountable: DeviceRow | null;
  system: boolean;
}

/** Where a drive stands in the list: data first, as the owner thinks of them. */
const rank = (drive: Drive) => (drive.system ? 1 : drive.mount ? 0 : 2);

function Pane({ icon, title, count, all, className, children }: { icon: ReactNode; title: ReactNode; count?: ReactNode; /** A way to the rest, when the panel shows only the first few. */ all?: { label: string; onClick: () => void }; className?: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section className={className ? `launcher-pane ${className}` : "launcher-pane"} aria-labelledby={titleId}>
      <div className="launcher-pane__head">
        <h2 className="launcher-pane__title"><span className="launcher-pane__icon" aria-hidden="true">{icon}</span><span id={titleId}>{title}</span>{!all && count !== undefined && count !== null && <span className="launcher-pane__count">{count}</span>}</h2>
        {all && <button type="button" className="launcher-pane__all" onClick={all.onClick}>{all.label}</button>}
      </div>
      {children}
    </section>
  );
}

export default function StorageLead({ csrfToken, role, report, loading, forecasts, fsSnapshots, sambaShares, autoReconnect, onTab, onChanged }: StorageLeadProps) {
  const { start, dialog } = useOperation(csrfToken, () => onChanged());
  const may = (operationId: string) => mayStart(role, operationId);
  const open = (tab: Tab) => onTab(tab);

  const devices = report?.devices ?? [];
  const mounts = report?.mounts ?? [];
  const managed = managedMounts(report);
  const soon = new Map(forecasts.map((forecast) => [forecast.target, forecast.daysToFull]));
  const mountOf = (point: string) => mounts.find((mount) => mount.target === point) ?? null;

  // One entry per physical disk, named for what it holds: the drives with your data first, then
  // the system disk, then what is not mounted.
  const drives = devices.filter((device) => device.type === "disk").map((disk, index): Drive => {
    const at = devices.indexOf(disk);
    const next = devices.findIndex((device, position) => position > at && device.depth === 0);
    const below = devices.slice(at + 1, next === -1 ? undefined : next);
    const family = [disk, ...below];
    const system = disk.protectedReason === "system disk" || family.some((device) => device.mountpoints.includes("/"));
    const holder = system ? family.find((device) => device.mountpoints.includes("/")) ?? null
      : family.find((device) => device.mountpoints.some((point) => point.startsWith("/mnt/") || point.startsWith("/srv/"))) ?? family.find((device) => device.mountpoints.length > 0) ?? null;
    const point = system ? "/" : holder?.mountpoints.find((entry) => entry.startsWith("/mnt/") || entry.startsWith("/srv/")) ?? holder?.mountpoints[0] ?? null;
    const mount = point ? mountOf(point) : null;
    const mountable = holder ? null : below.find((device) => device.uuid && device.fstype && device.fstype !== "swap" && device.fstype !== "LVM2_member" && !device.protected && device.mountpoints.length === 0) ?? null;
    const labelled = family.find((device) => device.label)?.label ?? null;
    const managedName = point ? managed.get(point) ?? null : null;
    const name = system ? "System disk" : plainName(labelled) ?? plainName(managedName) ?? disk.model ?? disk.path ?? `Drive ${index + 1}`;
    const transport = disk.transport ? transportWords[disk.transport] ?? disk.transport.toUpperCase() : null;
    const lvm = family.some((device) => device.type === "lvm");
    const fs = system ? (lvm ? "LVM" : holder?.fstype ?? null) : (holder ?? mountable)?.fstype ?? null;
    const where = system ? "/" : point ?? mountable?.path ?? disk.path ?? "";
    const sub = [where, system ? null : fs === "exfat" ? "exFAT" : fs, [transport, roughSize(disk.sizeBytes)].filter(Boolean).join(" "), system ? fs : null].filter(Boolean).join(" · ");
    const percent = mount ? percentUsed(mount.usedBytes, mount.sizeBytes) : null;
    const days = mount ? soon.get(mount.target) : undefined;
    const status: Status | undefined = percent === null ? undefined : percent >= 90 ? "danger" : percent >= 80 || (days !== undefined && days <= 14) ? "warning" : undefined;
    const armable = managedName && point === mountpointFor(managedName) ? managedName : null;
    return { key: disk.path ?? `disk-${index}`, name, sub, icon: system ? "virtualization" : holder ? "storage" : "backups", mount, percent, status, armable, mountable, system };
  }).sort((a, b) => rank(a) - rank(b));

  // Space the installer left unused: the Drives tab's own offer, the same operation and preview.
  const growable = (report?.volumeGroups ?? []).flatMap((group) => group.logicalVolumes.filter((volume) => volume.growable).map((volume) => ({ group, volume }))).filter(({ group }) => group.freeBytes - snapshotReserveBytes >= 256 * 1024 ** 2);
  const claim = growable[0] ?? null;
  const claimOnSystem = claim ? claim.volume.mountpoints.includes("/") : false;
  const useTheRest = claim ? () => start({
    operationId: "storage.lvm.extend",
    title: `Grow ${claim.volume.mountpoints[0]} by ${gib(claim.group.freeBytes - snapshotReserveBytes)}`,
    parameters: { path: claim.volume.path },
    preview: <span>Grows the logical volume into the free space of {claim.group.name ?? "its group"} and resizes the {claim.volume.fstype} filesystem while mounted (<code>lvextend -r</code>), keeping <strong>32 GiB</strong> unallocated for snapshots. Existing data is untouched.</span>,
  }) : null;

  // What needs a look here: a filesystem nearly full, a share that dropped, space left unused.
  const full = mounts.filter((mount) => (percentUsed(mount.usedBytes, mount.sizeBytes) ?? 0) >= 90);
  const dropped = (report?.shares ?? []).filter((share) => !share.mounted && !share.automount);
  const needCount = full.length + dropped.length + (claim ? 1 : 0);

  // Shared folders: this server's own, then what it mounts from a NAS; the first two, as drawn.
  const shares = report?.shares ?? [];
  const sharedCount = sambaShares.length + shares.length;
  const sharedRows = [
    ...sambaShares.map((share) => ({ key: `smb:${share.name}`, tab: "sharing" as const, name: share.name, line: `Shared from ${share.path} (SMB)`, status: "good" as Status, state: "Shared", said: "shared. Open File sharing" })),
    ...shares.map((share) => ({ key: `nas:${share.name}`, tab: "shares" as const, name: share.name,
      line: share.mounted ? `Connected${share.automount ? " · reconnects by itself" : ` at ${share.mountpoint}`}` : `Not connected · ${share.source}`,
      status: (share.mounted ? "good" : "warning") as Status, state: share.mounted ? "Connected" : "Not connected", said: `${share.mounted ? "connected" : "not connected"}. Open Shares` })),
  ];
  const shownShared = sharedRows.slice(0, 2);
  const hiddenShared = sharedRows.slice(2);

  // Snapshots: LVM's with their names, then btrfs' and ZFS', newest first.
  const lvmSnapshots = [...(report?.snapshots ?? [])].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const fsList = fsSnapshots?.supported ? [
    ...(fsSnapshots.btrfs?.filesystems ?? []).flatMap((entry) => entry.snapshots.map((snapshot) => ({ key: snapshot.path, name: snapshot.name, where: `btrfs · ${entry.target}` }))),
    ...(fsSnapshots.zfs?.datasets ?? []).flatMap((entry) => entry.snapshots.map((snapshot) => ({ key: snapshot.path, name: snapshot.name, where: `ZFS · ${entry.name}${snapshot.used ? ` · ${snapshot.used}` : ""}` }))),
  ] : [];
  const snapshotRows = [
    ...lvmSnapshots.map((snapshot) => ({ key: snapshot.path, name: humanize(snapshot.suffix ?? snapshot.name.replace(/^boxpilot-snap-/, "")), where: [takenAt(snapshot.createdAt), snapshot.sizeGiB ? `${snapshot.sizeGiB} GB` : roughSize(snapshot.sizeBytes)].filter(Boolean).join(" · ") })),
    ...fsList,
  ];
  const shownSnapshots = snapshotRows.slice(0, 2);

  const reading = !report ? (loading ? "Reading…" : "Could not be read.") : null;

  return (
    <div className="launcher-lead">
      {dialog}
      <Pane className="launcher-drives" icon={<AreaIcon view="storage" />} title="Drives" count={report ? drives.length : undefined}>
        {reading && <p className="launcher-quiet">{reading === "Reading…" ? "Reading the drives…" : "The drives could not be read."}</p>}
        {report && drives.length === 0 && <p className="launcher-quiet">No disks were listed.</p>}
        <ul className="launcher-drives__list">
          {drives.map((drive) => (
            <li key={drive.key} className="launcher-drive ui-marked" data-status={drive.status}>
              <span className="launcher-well" aria-hidden="true"><AreaIcon view={drive.icon} /></span>
              <span className="launcher-drive__name">
                <b>{drive.name}</b>
                <small>{drive.sub}</small>
              </span>
              <span className="launcher-drive__value">
                <b>{drive.percent === null ? "—" : `${drive.percent}%`}</b>
                <small>{drive.mount ? usedOf(drive.mount.usedBytes, drive.mount.sizeBytes) : "not mounted"}</small>
              </span>
              <span className="launcher-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={drive.percent ?? 0} aria-label={`${drive.name}: ${drive.percent === null ? "not mounted" : `${drive.percent}% used`}`}>
                <i style={{ width: `${drive.percent ?? 0}%` }} />
              </span>
              <div className="launcher-drive__row">
                {drive.armable && autoReconnect.status
                  ? <ReconnectSwitch drive={drive.armable} control={autoReconnect} canChange={may("storage.remount")} />
                  : drive.system && claim && claimOnSystem
                    ? <><span>{roughSize(claim.group.freeBytes)} of the disk is not in use yet</span><Button variant="ghost" onClick={() => open("drives")}>Details</Button></>
                    : drive.mountable
                      ? <><span>{drive.mountable.removable ? "Plugged in, not mounted" : "Not mounted"}{drive.mountable.label ? `: ${drive.mountable.label}` : ""}</span>{may("storage.mount") ? <Button aria-label={`Mount ${drive.mountable.path}: open Drives`} onClick={() => open("drives")}>Mount…</Button> : <Button variant="ghost" onClick={() => open("drives")}>Details</Button>}</>
                      : <><span>{drive.system ? "Holds the system and your apps" : drive.mount ? `Mounted at ${drive.mount.target}` : "Nothing on it to mount"}</span><Button variant="ghost" onClick={() => open(drive.mount ? "mounts" : "drives")}>Details</Button></>}
              </div>
            </li>
          ))}
        </ul>
      </Pane>

      <div className="launcher-stack">
        <Pane icon={<BellIcon />} title="What needs you" count={report ? (needCount ? <StatusChip status="warning">{needCount} to look at</StatusChip> : undefined) : undefined}>
          {reading && <p className="launcher-quiet">{reading}</p>}
          {report && needCount === 0 && <p className="launcher-quiet">Nothing needs you here.</p>}
          {report && needCount > 0 && (
            <ul className="launcher-needs">
              {full.map((mount) => (
                <li key={`full:${mount.target}`} className="launcher-need">
                  <span className="launcher-well" aria-hidden="true"><AreaIcon view="storage" /></span>
                  <div className="launcher-need__words">
                    <b>{mount.target === "/" ? "The system disk" : mount.target} is nearly full</b>
                    <p>{usedOf(mount.usedBytes, mount.sizeBytes)} used. The Mounts tab shows what fills it.</p>
                    <div className="launcher-need__acts"><Button variant="ghost" onClick={() => open("mounts")}>See what fills it</Button></div>
                  </div>
                </li>
              ))}
              {dropped.map((share) => (
                <li key={`share:${share.name}`} className="launcher-need">
                  <span className="launcher-well" aria-hidden="true"><AreaIcon view="network" /></span>
                  <div className="launcher-need__words">
                    <b>{share.name} is not connected</b>
                    <p>{share.source} is not mounted at {share.mountpoint}.</p>
                    <div className="launcher-need__acts"><Button variant="ghost" onClick={() => open("shares")}>Open Shares</Button></div>
                  </div>
                </li>
              ))}
              {claim && (
                <li className="launcher-need">
                  <span className="launcher-well" aria-hidden="true"><AreaIcon view="storage" /></span>
                  <div className="launcher-need__words">
                    <b>{roughSize(claim.group.freeBytes)} of {claimOnSystem ? "the system disk" : claim.group.name ?? "the volume group"} is not in use</b>
                    {may("storage.lvm.extend") && <RiskTag risk={riskOf("storage.lvm.extend")} className="launcher-need__tier" />}
                    <p>Claiming it happens while running. No reboot, nothing erased.</p>
                    <div className="launcher-need__acts">
                      {may("storage.lvm.extend") && useTheRest
                        ? <Button risk={riskOf("storage.lvm.extend")} onClick={useTheRest}>Use the rest of the disk</Button>
                        : <Button variant="ghost" onClick={() => open("drives")}>Details</Button>}
                    </div>
                  </div>
                </li>
              )}
            </ul>
          )}
        </Pane>

        <Pane icon={<AreaIcon view="network" />} title="Shared folders" count={report && sharedCount ? sharedCount : undefined}
          all={report && hiddenShared.length ? { label: `All ${sharedCount}`, onClick: () => open(hiddenShared.some((row) => row.tab === "shares") ? "shares" : "sharing") } : undefined}>
          {reading && <p className="launcher-quiet">{reading}</p>}
          {report && sharedCount === 0 && (
            <div className="launcher-li">
              <span className="launcher-li__words"><b>No shared folders yet</b><small>Share a folder with your other devices, or mount one from a NAS.</small></span>
              <Button variant="ghost" onClick={() => open("sharing")}>Share a folder…</Button>
            </div>
          )}
          {report && shownShared.map((row) => (
            <div key={row.key} className="launcher-li">
              <span className="launcher-li__words"><b>{row.name}</b><small>{row.line}</small></span>
              <button type="button" className="launcher-state" data-status={row.status} onClick={() => open(row.tab)} aria-label={`${row.name}: ${row.said}`}><span className="ui-mark" aria-hidden="true" />{row.state}</button>
            </div>
          ))}
        </Pane>

        <Pane icon={<AreaIcon view="backups" />} title="Snapshots" count={report ? snapshotRows.length : undefined}
          all={report && snapshotRows.length > shownSnapshots.length ? { label: `All ${snapshotRows.length}`, onClick: () => open("snapshots") } : undefined}>
          {reading && <p className="launcher-quiet">{reading}</p>}
          {report && snapshotRows.length === 0 && (
            <div className="launcher-li">
              <span className="launcher-li__words"><b>No snapshots</b><small>Take one before a big change, to roll back to.</small></span>
              <Button variant="ghost" onClick={() => open("snapshots")}>Take one…</Button>
            </div>
          )}
          {report && shownSnapshots.map((snapshot) => (
            <div key={snapshot.key} className="launcher-li">
              <span className="launcher-li__words"><b>{snapshot.name}</b><small>{snapshot.where}</small></span>
              <Button variant="ghost" aria-label={`${snapshot.name}: open Snapshots`} onClick={() => open("snapshots")}>Details</Button>
            </div>
          ))}
        </Pane>
      </div>
    </div>
  );
}
