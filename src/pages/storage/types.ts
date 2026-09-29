/*
 * What the Storage page reads (M33.9): the server's answers, typed once for the page and its tabs,
 * and the small rules the old page carried (names, filesystems, sizes).
 */

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
export interface Usage { appId: string | null; path: string | null; mount: string | null; bytes: number; grewBytes: number | null; days: number; sharedWith?: string[] }
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

/** The folders worth offering when sharing one: mounted shares, BoxPilot's drives, /srv and /mnt. */
export function shareableFolders(report: StorageReport | null): string[] {
  return [...new Set([...(report?.shares ?? []).map((entry) => entry.mountpoint), ...(report?.fstab ?? []).filter((row) => row.managedName).map((row) => row.mountpoint), "/srv", "/mnt"])];
}

/** A date and time as this browser writes them, or a dash. */
export function when(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
