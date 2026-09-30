import { useCallback, useRef, useState } from "react";
import type { StorageLeadProps } from "../StorageLead";
import { gib as fullGib, percentUsed, type DeviceRow, type StorageReport } from "../../pages/storage/types";
import { AreaIcon } from "../../shell/areaIcons";
import "./storage.css";

/*
 * The top of Storage in Home + Ops (M41): the drawing's disk map (05-looks.html, blendStorage).
 * Each disk is one row: its name in mono and what it is in words, then a bar drawn to scale for
 * that disk with its partitions, its LVM volumes and snapshots, the space nothing uses yet and
 * what is not mounted, each named inside its segment where the words fit. The tabs below have the
 * details and every action; this is the picture.
 */

type Kind = "used" | "room" | "snap" | "boot" | "free" | "off";

interface Segment { key: string; kind: Kind; bytes: number; label: string; words: string }
export interface DiskRow { key: string; name: string; plain: string; segments: Segment[] }

const GiB = 1024 ** 3;

/** "700 GiB", "2.6 TiB", "20 GiB": a size in the map, without a decimal it does not need. */
const gib = (bytes: number | null | undefined) => fullGib(bytes).replace(/^(\d{2,})\.\d /, "$1 ").replace(/\.0 /, " ");

/** "nvme0n1" from "/dev/nvme0n1". */
const base = (path: string | null) => (path ?? "").replace(/^\/dev\/(mapper\/)?/, "");

/** How a filesystem is written: exFAT, FAT, ext4. */
function fsName(fstype: string): string {
  const known: Record<string, string> = { exfat: "exFAT", vfat: "FAT", ntfs: "NTFS", ntfs3: "NTFS", btrfs: "Btrfs", xfs: "XFS", zfs_member: "ZFS", crypto_LUKS: "LUKS" };
  return known[fstype] ?? fstype;
}

/** A disk's size as it is sold: "1 TB", "4 TB", "500 GB". */
function soldAs(bytes: number | null): string {
  if (!bytes) return "";
  const tb = bytes / 1e12;
  if (tb >= 1) return `${Math.abs(tb - Math.round(tb)) < 0.35 ? Math.round(tb) : tb.toFixed(1)} TB`;
  return `${Math.round(bytes / 1e9)} GB`;
}

const transports: Record<string, string> = { nvme: "NVMe", usb: "USB", sata: "SATA", ata: "SATA", sas: "SAS", mmc: "SD card", virtio: "Virtual" };

/** What a disk is, in words: the system disk, the media drive, the backup drive. */
function plainName(disk: DeviceRow, below: DeviceRow[]): string {
  const points = [disk, ...below].flatMap((device) => device.mountpoints);
  const data = points.find((point) => point.startsWith("/mnt/") || point.startsWith("/srv/") || point.startsWith("/media/"));
  const label = below.find((device) => device.label)?.label ?? disk.label;
  const what = disk.protectedReason === "system disk" || points.includes("/") ? "System"
    : data ? `${(data.split("/").pop() ?? "").replace(/^./, (first) => first.toUpperCase())} drive`
      : label ? `${label.replace(/^./, (first) => first.toUpperCase())} drive`
        : disk.removable ? "Removable drive" : "Disk";
  const kind = [disk.transport ? transports[disk.transport] ?? disk.transport.toUpperCase() : null, soldAs(disk.sizeBytes)].filter(Boolean).join(" ");
  return kind ? `${what} · ${kind}` : what;
}

/** The segments one partition (or a whole-disk filesystem) draws. */
function partSegments(part: DeviceRow, below: DeviceRow[], report: StorageReport): Segment[] {
  const size = part.sizeBytes ?? 0;
  const key = part.path ?? `${part.depth}:${part.uuid ?? part.sizeBytes}`;
  // LVM: the group's volumes, its snapshots and the space no volume has yet.
  if (part.fstype === "LVM2_member" && part.holdsVolumeGroups.length) {
    return part.holdsVolumeGroups.flatMap((name) => {
      const group = report.volumeGroups.find((entry) => entry.name === name);
      if (!group) return [];
      const share = group.physicalVolumes.length > 1 && group.sizeBytes ? size / group.sizeBytes / part.holdsVolumeGroups.length : 1;
      const volumes: Segment[] = group.logicalVolumes.map((volume) => {
        const point = volume.mountpoints[0];
        const mount = point ? report.mounts.find((entry) => entry.target === point) : undefined;
        const used = mount ? percentUsed(mount.usedBytes, mount.sizeBytes) : null;
        if (volume.snapshot) return { key: volume.path, kind: "snap" as const, bytes: volume.sizeBytes * share, label: "snapshot", words: `snapshot ${volume.name}, ${gib(volume.sizeBytes)}` };
        const label = `${point ? `${point} ` : ""}${volume.name} · ${gib(volume.sizeBytes)}${used !== null ? ` · ${used}% used` : point ? "" : " · not mounted"}`;
        return { key: volume.path, kind: point ? "used" as const : "off" as const, bytes: volume.sizeBytes * share, label, words: label.replace(/ · /g, ", ") };
      });
      const free = group.freeBytes > 0 ? [{ key: `${group.name}:free`, kind: "free" as const, bytes: group.freeBytes * share, label: `${gib(group.freeBytes)} not in use`, words: `${gib(group.freeBytes)} of ${group.name} not in use` }] : [];
      return [...volumes, ...free];
    });
  }
  // An encrypted partition draws what is opened inside it.
  const inner = part.fstype === "crypto_LUKS" ? below.find((device) => device.depth === part.depth + 1 && device.mountpoints.length) : undefined;
  const shown = inner ?? part;
  const point = shown.mountpoints[0];
  if (shown.fstype === "swap" || point === "[SWAP]") return [{ key, kind: "boot", bytes: size, label: "swap", words: `swap, ${gib(size)}` }];
  if (point && (point === "/boot" || point.startsWith("/boot/"))) return [{ key, kind: "boot", bytes: size, label: point, words: `${point}, ${gib(size)}` }];
  if (point) {
    const mount = report.mounts.find((entry) => entry.target === point);
    const fraction = mount?.sizeBytes && mount.usedBytes !== null ? Math.min(1, mount.usedBytes / mount.sizeBytes) : null;
    if (fraction === null) return [{ key, kind: "used", bytes: size, label: point, words: `${point}, ${gib(size)}` }];
    const label = `${point} · ${gib(mount?.usedBytes)} used`;
    return [
      { key, kind: "used", bytes: size * fraction, label, words: `${label}, of ${gib(mount?.sizeBytes)}` },
      { key: `${key}:room`, kind: "room", bytes: size * (1 - fraction), label: "", words: `${gib(mount?.availableBytes)} free on ${point}` },
    ];
  }
  if (shown.fstype) return [{ key, kind: "off", bytes: size, label: `${fsName(shown.fstype)} · not mounted`, words: `${base(shown.path)}, ${fsName(shown.fstype)}, not mounted, ${gib(size)}` }];
  return [{ key, kind: "free", bytes: size, label: `${gib(size)} no filesystem`, words: `${base(part.path)}, ${gib(size)} with no filesystem` }];
}

/** Every disk in the report as a row of the map, in the report's order. */
export function diskRows(report: StorageReport): DiskRow[] {
  const devices = report.devices;
  return devices.flatMap((disk, index) => {
    if (disk.type !== "disk") return [];
    const below: DeviceRow[] = [];
    for (let at = index + 1; at < devices.length && devices[at].depth > disk.depth; at += 1) below.push(devices[at]);
    const parts = below.filter((device) => device.depth === disk.depth + 1);
    const segments = parts.length ? parts.flatMap((part) => partSegments(part, below.filter((device) => device.depth > part.depth), report))
      : disk.mountpoints.length || disk.fstype ? partSegments(disk, [], report)
        : [{ key: `${disk.path}:free`, kind: "free" as const, bytes: disk.sizeBytes ?? 0, label: "not in use", words: `${gib(disk.sizeBytes)} not partitioned` }];
    // Space no partition holds, when it is worth drawing.
    const held = parts.reduce((sum, part) => sum + (part.sizeBytes ?? 0), 0);
    const rest = (disk.sizeBytes ?? 0) - held;
    if (parts.length && rest > Math.max(GiB, (disk.sizeBytes ?? 0) * 0.01)) segments.push({ key: `${disk.path}:rest`, kind: "free", bytes: rest, label: `${gib(rest)} not partitioned`, words: `${gib(rest)} not partitioned` });
    return [{ key: disk.path ?? String(index), name: base(parts.length === 1 ? parts[0].path : disk.path), plain: plainName(disk, below), segments }];
  });
}

/** Roughly how wide a label is in the bar's mono, to leave it out where it would be cut. */
const labelWidth = (label: string) => label.length * 6.6 + 12;

/** The width of an element, kept as it resizes; measured from when it is first drawn. */
function useWidth(): [(element: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.current.observe(element);
  }, []);
  return [measure, width];
}

function Bar({ row, width }: { row: DiskRow; width: number }) {
  const total = row.segments.reduce((sum, segment) => sum + segment.bytes, 0) || 1;
  const room = Math.max(0, width - (row.segments.length - 1) - row.segments.length * 12);
  return (
    <div className="blend-map__bar" role="img" aria-label={`${row.name}: ${row.segments.map((segment) => segment.words).join("; ")}`}>
      {row.segments.map((segment) => {
        const wide = 12 + (segment.bytes / total) * room;
        return (
          <span key={segment.key} className="blend-map__seg" data-kind={segment.kind} style={{ flexGrow: segment.bytes / GiB }} title={segment.words}>
            {segment.label && width > 0 && wide >= labelWidth(segment.label) ? segment.label : null}
          </span>
        );
      })}
    </div>
  );
}

export default function StorageLead({ report, loading }: StorageLeadProps) {
  const [measure, width] = useWidth();
  const rows = report ? diskRows(report) : [];
  return (
    <section className="blend-map" aria-labelledby="blend-map-title">
      <header className="blend-map__head">
        <h2 id="blend-map-title" className="blend-map__title"><AreaIcon view="storage" />Disk map</h2>
        <span className="blend-map__meta">drawn to scale per disk</span>
      </header>
      {!report
        ? <p className="blend-map__quiet">{loading ? "Reading the disks…" : "The disks could not be read."}</p>
        : rows.length === 0 ? <p className="blend-map__quiet">No disks were reported.</p>
          : (
            <ul className="blend-map__disks">
              {rows.map((row, index) => (
                <li key={row.key} className="blend-map__disk">
                  <span className="blend-map__name"><b>{row.name}</b><small>{row.plain}</small></span>
                  <div className="blend-map__track" ref={index === 0 ? measure : undefined}><Bar row={row} width={width} /></div>
                </li>
              ))}
            </ul>
          )}
      <ul className="blend-map__legend" aria-label="Key">
        <li><i data-kind="used" aria-hidden="true" />In use</li>
        <li><i data-kind="snap" aria-hidden="true" />Snapshot</li>
        <li><i data-kind="free" aria-hidden="true" />Not in use</li>
        <li><i data-kind="boot" aria-hidden="true" />Boot</li>
      </ul>
    </section>
  );
}
