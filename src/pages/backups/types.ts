import type { ComposeReview } from "./ComposeReview";

/*
 * What the Backups page reads (M33.9), typed once for the page and its tabs, and the two small
 * rules it keeps: how much of a machine snapshot would come back with its data, and when each app's
 * nightly backup runs.
 */

export interface BackupRecord { id: string; applicationId: string; destination: string; checksumSha256: string; sizeBytes: number; downtimeMs: number; restoreDrill: { passed?: boolean } | null; createdAt: string }
export interface ControllerProtection { id: string; backupId: string; snapshotId?: string; createdAt: string; protected?: boolean; retained?: boolean }
/** `setupCommand`: what the owner runs at the server's terminal to create the recovery password and the store. */
export interface ProtectionState { destination: { ready?: boolean; encrypted?: boolean; repositoryId?: string | null; blockers?: string[]; setupCommand?: string } | null; protections: ControllerProtection[] }
export interface RetentionStatus { policy?: { minimumCopies?: number; minimumAgeDays?: number }; candidates?: unknown[]; beforeCount?: number }

export interface SnapshotApp { id: string; installed?: boolean; projectFiles?: number; backups?: number }
export interface MachineSnapshot { artifact: string; sizeBytes: number | null; checksumSha256: string | null; createdAt: string | null; contents: { apps?: SnapshotApp[]; vms?: { domains?: string[] } } | null }
export interface MachineSnapshotState {
  snapshots: MachineSnapshot[];
  keep: number;
  /** `skippedCount`/`skipped`: what the last sync left out, and why (the first few); absent from a record written before it said so. */
  sync: { destination: string; mount: { mounted: boolean; blocker?: string | null; freeBytes?: number | null }; lastSync: { completedAt: string; copiedCount: number; skippedCount?: number; skipped?: string[] } | null };
}

export interface RemoteMirrorState { keyReady: boolean; publicKey: string | null; fingerprint: string | null; hostKeysPinned: number; rsyncInstalled: boolean }
export interface RemoteDestination { host: string; port: number; user: string; path: string }
/** A viewer is told only that a destination is set (`hidden`), not where. */
export interface RemoteSettings { destination: RemoteDestination | { hidden: true } | null; lastSync: { completedAt: string; filesTransferred: number; bytesTransferred: number; destination: string } | null }

export interface CloudProvider { label: string; fields: string[]; secrets: string[]; help: string }
export interface CloudState { rcloneInstalled: boolean; configured: boolean; sealed?: boolean; provider: string | null; providers: Record<string, CloudProvider> }
export interface CloudSettings { destination: (Record<string, string | null> & { provider: string }) | null; lastSync: { completedAt: string; filesTransferred: number; bytesTransferred: string | null; destination: string; errors?: number } | null }

/** One place a machine snapshot can be restored from. */
export interface SnapshotEntry { artifact: string; sizeBytes: number | null; createdAt: string | null; checksumSha256: string | null; apps: number | null }
export interface SnapshotSources { sources: Array<{ source: "local" | "mirror"; root: string; available: boolean; snapshots: SnapshotEntry[] }>; mount: { mounted: boolean; blocker: string | null } }
/** Snapshots on drives BoxPilot did not write to: how a rebuilt server finds the old one's. */
export interface DiscoveredSnapshots { locations: Array<{ root: string; mount: { target: string; source: string; filesystem: string }; snapshots: SnapshotEntry[] }>; unanswered?: Array<{ target: string; source: string; error: string }> }
export interface DescribedSnapshot {
  source: string; artifact: string; createdAt: string | null;
  /**
   * `newestBackup`: the data archive the snapshot names. `dataArchive`: the one a restore would use,
   * that one or, when it is gone, an older one the snapshot lists (null when none is left).
   * `compose`: what restoring the app's data archive would start (sweep 4), when there is one to restore.
   */
  apps: Array<{ id: string; installed: boolean; newestBackup: string | null; dataAvailable: boolean; dataLocation: string | null; dataArchive?: string | null; compose?: ComposeReview }>;
  system: { netplanFiles?: number; ufwFiles?: number; fstab?: boolean } | null;
  vms: { domains: string[]; disksIncluded?: boolean; diskRepositoryReachable?: boolean } | null;
}
export interface StagedFile { path: string; area: string; sizeBytes: number; content: string | null }
export interface RestoreReview { name: string; stagedAt: string; files: StagedFile[] }

/**
 * How many apps in a snapshot have a data backup to restore from.
 *
 * A machine snapshot holds settings and secrets, not the data itself, so "12 apps" reads as twelve
 * apps protected when it can mean twelve apps that would come back empty. The count the archive
 * already records is the honest number to show beside it.
 */
export function withData(snapshot: MachineSnapshot): number | null {
  const apps = snapshot.contents?.apps;
  if (!Array.isArray(apps) || apps.length === 0) return null;
  if (apps.some((app) => typeof app.backups !== "number")) return null; // an older snapshot did not record it
  return apps.filter((app) => (app.backups ?? 0) > 0).length;
}

/**
 * The index-th of `total` nightly slots, spread evenly through 02:00-03:59: spacing shrinks as apps
 * are added, so the last backup is always written before the off-box copy at 04:15 looks for it.
 */
export function nightlySlot(index: number, total: number): { hour: number; minute: number } {
  const offset = Math.round((index * 119) / Math.max(total, 1));
  return { hour: 2 + Math.floor(offset / 60), minute: offset % 60 };
}

/** A date and time as this browser writes them, or a dash. */
export function when(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/** "today", "1 day ago", "63 days ago", from a timestamp. */
export function ago(value: string | null | undefined, now = Date.now()): string | null {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  const days = Math.floor((now - parsed) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

/** A sync's time, whichever shape the setting stored it in. */
export function syncedAt(value: unknown): string | null {
  if (typeof value === "string") return value;
  return (value as { completedAt?: string } | null)?.completedAt ?? null;
}

/**
 * What the encrypted store still needs, in the owner's words. The helper names each blocker the way a
 * log would ("the separate root-owned mode-0600 controller recovery password"); the page says what to
 * do about it. One it does not recognise is shown as it came, never dropped.
 */
export function plainBlocker(blocker: string): string {
  if (/^Install restic\b/.test(blocker)) return "restic, the encryption tool, is not installed: Repair offers to install it, under Prerequisites.";
  const mount = /^Mount a writable filesystem .* at (\S+)$/.exec(blocker);
  if (mount) return `Mount a backup drive at ${mount[1]}. It has to be a different disk from the one holding BoxPilot's database and its local backups.`;
  if (/recovery password/.test(blocker)) return "Create the recovery password with the command below. Keep a copy of it somewhere other than this server: without it the encrypted copies cannot be opened.";
  if (/^Initialize and verify\b/.test(blocker)) return "Set up the encrypted store on the backup drive with the command below.";
  return blocker;
}
