/*
 * What the Storage page reads (M33.9): the server's answers, typed once for the page and its tabs,
 * and the small rules the old page carried (names, filesystems, sizes).
 */
import { mayServe } from "../../servedFolder";
import type { Status } from "../../ui";

export interface DeviceRow {
  path: string | null; type: string | null; sizeBytes: number | null; fstype: string | null; uuid: string | null; label: string | null; model: string | null; transport: string | null;
  mountpoints: string[]; readOnly: boolean; removable: boolean; depth: number;
  protected: boolean; protectedReason: string | null; volumeGroup: string | null; logicalVolume: string | null; holdsVolumeGroups: string[]; mountedBelow: string[];
}
export interface MountRow { target: string; source: string; fstype: string; sizeBytes: number | null; usedBytes: number | null; availableBytes: number | null }
export interface FstabRow { device: string; mountpoint: string; fstype: string; options: string; managedName: string | null }
export interface LogicalVolume { path: string; name: string; sizeBytes: number; fstype: string | null; mountpoints: string[]; growable: boolean; snapshot?: boolean }
export interface VolumeGroup { name: string | null; physicalVolumes: string[]; sizeBytes: number; usedBytes: number; freeBytes: number; logicalVolumes: LogicalVolume[] }
export interface ShareRow { name: string; kind: "smb" | "nfs"; source: string; mountpoint: string; readOnly: boolean; automount: boolean; mounted: boolean; sizeBytes: number | null; usedBytes: number | null; availableBytes: number | null }
export interface SnapshotRow { path: string; name: string; volumeGroup: string | null; sizeBytes: number; origin?: string; sizeGiB?: number; createdAt?: string; suffix?: string | null }
export interface StorageReport {
  devices: DeviceRow[]; mounts: MountRow[]; fstab: FstabRow[]; volumeGroups: VolumeGroup[]; snapshots?: SnapshotRow[]; shares: ShareRow[];
  tools: { cifs: boolean; nfs: boolean; smbclient: boolean; showmount: boolean };
}
/** What an app's folder holds, from the nightly sweep. */
export interface Usage { appId: string | null; path: string | null; mount: string | null; bytes: number; grewBytes: number | null; days: number; sharedWith?: string[]; /** Daily sizes, oldest first (M31.4). */ series?: Array<{ at: string; bytes: number }> }
export interface LastMeasured { at: string; sampled: number; unmeasured: number; error: string | null; deferred?: string }
export interface Forecast { target: string; daysToFull: number; availableBytes: number | null; totalBytes: number | null; samples: number }
export interface Discovered { address: string; name: string | null; smb: boolean; nfs: boolean; mac: string | null; interface: string | null }
export interface FsSnapshots {
  supported: boolean;
  btrfs: { filesystems: Array<{ target: string; source: string | null; snapshots: Array<{ name: string; path: string }> }> };
  zfs: { datasets: Array<{ name: string; mountpoint: string | null; snapshots: Array<{ name: string; path: string; used?: string | null }> }> };
}

export interface SambaShare { name: string; path: string; comment: string | null; readOnly: boolean; guest: boolean; users: string[]; forceUser?: string | null; recycle?: boolean; recycleBytes?: number | null }
export interface SambaState {
  installed: boolean; running: boolean | null; configured: boolean; error: string | null;
  config: { managed: boolean; workgroup: string; scope: "tailscale" | "lan"; interfaces: string[]; shares: SambaShare[] };
  users: string[];
  tailscaleDnsName: string | null; tailscaleAddress: string | null; lanAddress: string | null;
  discovery?: { installed: boolean; running: boolean };
}
export interface NfsExport { path: string; readOnly: boolean; clients?: string[] }
export interface NfsState {
  installed: boolean; running: boolean | null; configured: boolean; error: string | null;
  config: { managed: boolean; scope: "tailscale" | "lan"; exports: NfsExport[] };
  tailscaleDnsName: string | null; tailscaleAddress: string | null; lanAddress: string | null;
}
export interface DiagnosticCheck { id: string; state: "ok" | "problem" | "warn" | "info"; title: string; detail: string; hint: string | null; share: string | null }

export type Scope = "tailscale" | "lan";

/** GiB, or TiB from a tebibyte up; a size nobody could read is a dash. */
export function gib(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  return bytes >= 1024 ** 4 ? `${(bytes / 1024 ** 4).toFixed(1)} TiB` : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** How full, as a whole percentage, or null when either figure is missing. */
export function percentUsed(used: number | null, size: number | null): number | null {
  return size && used !== null ? Math.min(100, Math.round((used / size) * 100)) : null;
}

// 31, not 32: a share name maxes at 31 characters (shareNamePattern), so a 32-character mount name
// prefilled into "Add a share" would otherwise refuse with no hint as to why.
export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);
// "boxpilot" is the folder the backup destination lives in (server/backup-mount.mjs).
export const nameValid = (name: string) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) && name !== "boxpilot";
// exFAT/FAT/NTFS carry no Unix permissions, so a plain mount is root-owned and apps cannot write.
export const permissionlessFs = (fstype: string | null) => ["exfat", "vfat", "ntfs", "ntfs3", "msdos"].includes((fstype ?? "").toLowerCase());
// The filesystems storage.check has a read-only checker for (server/tasks/storage.mjs).
export const checkableFs = (fstype: string | null) => ["exfat", "ext2", "ext3", "ext4", "vfat"].includes((fstype ?? "").toLowerCase());

/** A mount point BoxPilot added itself, by its name, leaving the network shares to their own tab. */
export function managedMounts(report: StorageReport | null): Map<string, string> {
  return new Map((report?.fstab ?? []).filter((row) => row.managedName && !row.managedName.startsWith("share-")).map((row) => [row.mountpoint, row.managedName as string]));
}

/**
 * The folders worth offering when sharing one: mounted shares, BoxPilot's drives and /srv, less any
 * the file servers refuse. /mnt was offered too, but it holds the backup destination (/mnt/boxpilot),
 * so neither server will serve it, nor anything under /mnt/boxpilot.
 */
export function shareableFolders(report: StorageReport | null): string[] {
  return [...new Set([...(report?.shares ?? []).map((entry) => entry.mountpoint), ...(report?.fstab ?? []).filter((row) => row.managedName).map((row) => row.mountpoint), "/srv"])].filter(mayServe);
}

/** A date and time as this browser writes them, or a dash. */
export function when(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

type AtaField = "reallocated" | "reportedUncorrectable" | "pending" | "offlineUncorrectable";
const ataFields: readonly AtaField[] = ["reallocated", "reportedUncorrectable", "pending", "offlineUncorrectable"];
/**
 * A SATA disk's bad sectors by kind (ATA attributes 5, 187, 197, 198), as the storage scan read them;
 * `notSectorCounts` the ones the drive names as something else (an MX500's 197 counts ECC events).
 */
interface AtaErrors { reallocated: number | null; reportedUncorrectable: number | null; pending: number | null; offlineUncorrectable: number | null; notSectorCounts: AtaField[] }
/**
 * One drive's SMART health as the storage scan last read it (`/api/v1/inventory`, storage.smart):
 * `mediaErrors` is an NVMe drive's media errors or a SATA disk's bad sectors summed, `reason` why
 * there is no reading, and `lastHealth` what a drive left asleep said when it was last read awake.
 */
export interface DriveHealth {
  device: string; health: string; reason: string | null; passed: boolean | null;
  temperatureCelsius: number | null; percentageUsed: number | null; mediaErrors: number | null; ataErrors: AtaErrors | null; lastHealth: string | null;
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/** Each drive's health from the inventory's answer; empty when it left SMART out. */
export function driveHealthFrom(body: unknown): DriveHealth[] {
  const disks = (body as { storage?: { smart?: { disks?: unknown } } } | null)?.storage?.smart?.disks;
  return (Array.isArray(disks) ? disks : []).filter((disk) => typeof disk?.device === "string").map((disk) => {
    const ata = disk.ataErrors && typeof disk.ataErrors === "object" ? disk.ataErrors : null;
    return {
      device: disk.device,
      health: typeof disk.health === "string" ? disk.health : "unavailable",
      reason: typeof disk.reason === "string" && disk.reason ? disk.reason : null,
      passed: typeof disk.passed === "boolean" ? disk.passed : null,
      temperatureCelsius: count(disk.temperatureCelsius),
      percentageUsed: count(disk.percentageUsed),
      mediaErrors: count(disk.mediaErrors),
      ataErrors: ata ? {
        reallocated: count(ata.reallocated), reportedUncorrectable: count(ata.reportedUncorrectable), pending: count(ata.pending), offlineUncorrectable: count(ata.offlineUncorrectable),
        notSectorCounts: Array.isArray(ata.notSectorCounts) ? ataFields.filter((field) => ata.notSectorCounts.includes(field)) : [],
      } : null,
      lastHealth: typeof disk.lastHealth === "string" ? disk.lastHealth : null,
    };
  });
}

/** A drive's health in a word and a status: red for a failing one, including one asleep since it last said so. */
export function healthChip(disk: DriveHealth): { status: Status; label: string } {
  if (disk.reason === "usb-bridge-unsupported") return { status: "unknown", label: "no SMART" };
  const health = disk.reason === "asleep" ? disk.lastHealth : disk.health;
  if (health === "critical") return { status: "danger", label: disk.reason === "asleep" ? "failing (asleep)" : "failing" };
  if (health === "warning") return { status: "warning", label: disk.reason === "asleep" ? "needs a look (asleep)" : "needs a look" };
  if (disk.reason === "asleep") return { status: "unknown", label: "asleep" };
  if (health === "healthy") return { status: "good", label: "healthy" };
  return { status: "unknown", label: "not read" };
}

/** A drive that answers SMART's overall pass/fail and nothing else: no error counts and no wear, ever. */
export const reportsPassFailOnly = (disk: DriveHealth) => disk.reason === "ok" && disk.passed !== null && disk.mediaErrors === null && disk.percentageUsed === null;

/**
 * The disk a device sits on, by the block tree the overview lists (each row under the last disk
 * above it at depth 0), or by its name (sdb1 on sdb, nvme0n1p2 on nvme0n1) when the tree has no
 * disk above it.
 */
function diskOf(devices: DeviceRow[], path: string, known: string[] = []): string | null {
  const at = devices.findIndex((device) => device.path === path);
  for (let index = at; index >= 0; index -= 1) {
    if (devices[index].depth === 0 && devices[index].type === "disk") return devices[index].path;
    if (devices[index].depth === 0) break;
  }
  return known.find((disk) => path === disk || (path.startsWith(disk) && /^p?\d+$/.test(path.slice(disk.length)))) ?? null;
}

/** The disk a mount is on: its device row by mount point first, then by source. */
export function diskOfMount(report: StorageReport | null, mount: MountRow, known: string[] = []): string | null {
  const devices = report?.devices ?? [];
  const row = devices.find((device) => device.mountpoints.includes(mount.target)) ?? devices.find((device) => device.path === mount.source);
  return diskOf(devices, row?.path ?? mount.source, known);
}

/** Drive health for the page's verdict: failing drives first, then any that need a look; null when all read healthy. */
export function healthVerdict(health: DriveHealth[]): { status: Status; label: string } | null {
  const chips = health.map(healthChip);
  const failing = chips.filter((chip) => chip.status === "danger").length;
  if (failing) return { status: "danger", label: `${failing} drive${failing === 1 ? "" : "s"} failing` };
  const look = chips.filter((chip) => chip.status === "warning").length;
  return look ? { status: "warning", label: `${look} drive${look === 1 ? "" : "s"} to look at` } : null;
}
