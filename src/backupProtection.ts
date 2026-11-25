/**
 * Which installed apps are actually protected, and which only look it.
 *
 * Two different things have to be true, and BoxPilot used to check neither for applications: a
 * backup has to exist, and something has to keep making new ones. An app backed up once in March
 * is not protected in August, and an app with a daily schedule that has never run yet is not
 * protected today either — so both are reported, with the distinction kept rather than flattened
 * into one "backed up" boolean.
 */

export interface AppProtection {
  id: string;
  name: string;
  /** False for apps whose volumes are all caches or re-downloadable data; they are never "unprotected". */
  protectable: boolean;
  backups: number;
  newestAt: string | null;
}

export interface ScheduleLike {
  operationId: string;
  /**
   * What the schedule acts on. The list endpoint reduces the real parameters to a display subject
   * (`{ subject: "vaultwarden" }`) rather than passing them through, so reading `.id` here found
   * nothing and every app was reported as unscheduled while its schedule sat there running. Both
   * shapes are accepted: the API's, and the raw parameters as they are sent when creating one.
   */
  parameters?: { subject?: unknown; id?: unknown } | null;
  enabled?: boolean;
  /** Set by the schedules API when a schedule has slipped a whole cycle past its due time (M20.1). */
  overdue?: boolean;
  /** Human title from the schedules API (e.g. "Back up application data"). */
  title?: string;
}

/** Backup-related schedules that have quietly fallen behind, for the "your backups stopped" banner. */
export function behindBackupSchedules(schedules: ScheduleLike[]): ScheduleLike[] {
  return schedules.filter((schedule) =>
    schedule.overdue
    && schedule.enabled !== false
    && /^(app\.backup|backup\.|controller\.backup|host\.snapshot|vm\.)/.test(schedule.operationId));
}

export interface ProtectionVerdict {
  id: string;
  name: string;
  scheduled: boolean;
  backups: number;
  newestAt: string | null;
  ageDays: number | null;
  /** "never" — no backup at all. "stale" — nothing recent. "ok" — a recent backup exists. */
  state: "never" | "stale" | "ok";
}

/** App ids that have an enabled backup schedule. */
export function scheduledAppIds(schedules: ScheduleLike[]): Set<string> {
  const ids = new Set<string>();
  for (const schedule of schedules) {
    if (schedule.operationId !== "app.backup") continue;
    if (schedule.enabled === false) continue; // a paused schedule protects nothing
    const id = schedule.parameters?.subject ?? schedule.parameters?.id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/**
 * Judge each protectable app. `staleAfterDays` is deliberately generous: the point is to catch
 * "nobody has thought about this in months", not to nag about a backup that ran on Sunday.
 */
export function judgeProtection(
  apps: AppProtection[],
  schedules: ScheduleLike[],
  { now = Date.now(), staleAfterDays = 14 }: { now?: number; staleAfterDays?: number } = {},
): ProtectionVerdict[] {
  const scheduled = scheduledAppIds(schedules);
  return apps.filter((app) => app.protectable).map((app) => {
    const parsed = app.newestAt ? Date.parse(app.newestAt) : Number.NaN;
    const ageDays = Number.isFinite(parsed) ? Math.floor((now - parsed) / 86_400_000) : null;
    const state: ProtectionVerdict["state"] = app.backups === 0 || ageDays === null ? "never" : ageDays > staleAfterDays ? "stale" : "ok";
    return { id: app.id, name: app.name, scheduled: scheduled.has(app.id), backups: app.backups, newestAt: app.newestAt, ageDays, state };
  });
}

/** One sentence for the Overview's needs-attention list, or null when there is nothing to say. */
export function protectionWarning(verdicts: ProtectionVerdict[]): string | null {
  const never = verdicts.filter((verdict) => verdict.state === "never");
  const stale = verdicts.filter((verdict) => verdict.state === "stale");
  const naming = (list: ProtectionVerdict[]) => (list.length <= 2
    ? list.map((verdict) => verdict.name).join(" and ")
    : `${list.slice(0, 2).map((verdict) => verdict.name).join(", ")} and ${list.length - 2} more`);
  if (never.length) return `${naming(never)} ${never.length === 1 ? "has" : "have"} never been backed up`;
  if (stale.length) return `${naming(stale)} ${stale.length === 1 ? "has not been" : "have not been"} backed up recently`;
  return null;
}

/**
 * Whether this server could be rebuilt from what it keeps (M91).
 *
 * App backups are half of a rebuild. On a new server the Restore tab starts from a machine snapshot
 * (it reinstalls every app with its settings and secrets, then pours each app's data back in), and
 * BoxPilot's own database, with the schedules, accounts and destinations, comes back from a database
 * backup. A server that backed every app up nightly and never took a snapshot read "Protected" here
 * while it had nothing a rebuild could start from.
 *
 * Eight days, for both: the most often anything schedules a machine snapshot is weekly (the setup
 * profiles), so a week plus a day for a run that slipped is the age at which the schedule has
 * clearly stopped or never existed. A day less would warn every week before the weekly run.
 */
export const rebuildStaleAfterDays = 8;

export interface RebuildSnapshot {
  createdAt: string | null;
  contents: { apps?: Array<{ id: string; installed?: boolean }> } | null;
}

export interface RebuildInputs {
  /** The machine snapshots on this server; null when they could not be read. */
  snapshots: RebuildSnapshot[] | null;
  /** Every installed app's id, protectable or not: a snapshot brings back each one's settings. Null when unread. */
  installedAppIds: string[] | null;
  /** BoxPilot's database backups' times; null when they could not be read. */
  databaseBackupsAt: string[] | null;
}

export interface RebuildVerdict {
  /** "unknown" — something it rests on was not read. */
  state: "no-snapshot" | "snapshot-stale" | "snapshot-missing-apps" | "no-database-backup" | "database-stale" | "ok" | "unknown";
  /** What the header says, short. Null when there is nothing to say. */
  label: string | null;
  /** One sentence saying why, for the This server tab. */
  warning: string | null;
  snapshotAgeDays: number | null;
  /** Installed apps the newest snapshot would not bring back. */
  missingApps: string[];
  databaseAgeDays: number | null;
}

const newestOf = (values: Array<string | null | undefined>): number | null => {
  let newest: number | null = null;
  for (const value of values) {
    const parsed = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed) && (newest === null || parsed > newest)) newest = parsed;
  }
  return newest;
};

export function rebuildVerdict(
  { snapshots, installedAppIds, databaseBackupsAt }: RebuildInputs,
  { now = Date.now(), staleAfterDays = rebuildStaleAfterDays }: { now?: number; staleAfterDays?: number } = {},
): RebuildVerdict {
  const empty = { snapshotAgeDays: null, missingApps: [], databaseAgeDays: null };
  if (snapshots === null || databaseBackupsAt === null) return { state: "unknown", label: null, warning: null, ...empty };
  const days = (at: number | null) => (at === null ? null : Math.floor((now - at) / 86_400_000));
  const databaseAt = newestOf(databaseBackupsAt);
  const databaseAgeDays = days(databaseAt);
  if (snapshots.length === 0) {
    return { state: "no-snapshot", label: "No machine snapshot", warning: "There is no machine snapshot, so a new server would have nothing to rebuild from: take one on the This server tab.", ...empty, databaseAgeDays };
  }
  const newest = snapshots.reduce<RebuildSnapshot | null>((best, snapshot) => {
    const at = snapshot.createdAt ? Date.parse(snapshot.createdAt) : Number.NaN;
    if (!Number.isFinite(at)) return best;
    return best === null || at > Date.parse(best.createdAt ?? "") ? snapshot : best;
  }, null);
  const snapshotAgeDays = days(newest?.createdAt ? Date.parse(newest.createdAt) : null);
  // An app installed after the newest snapshot is not in it: a rebuild would leave it out entirely.
  const listed = newest?.contents?.apps;
  const inSnapshot = new Set((Array.isArray(listed) ? listed : []).filter((app) => app?.installed !== false).map((app) => app?.id));
  // A snapshot that recorded no app list (an older one) is not said to be missing every app.
  const missingApps = Array.isArray(listed) && installedAppIds ? installedAppIds.filter((id) => !inSnapshot.has(id)) : [];
  const base = { snapshotAgeDays, missingApps, databaseAgeDays };
  if (snapshotAgeDays === null || snapshotAgeDays > staleAfterDays) {
    return { state: "snapshot-stale", label: "Machine snapshot out of date", warning: snapshotAgeDays === null ? "The newest machine snapshot records no date, so how old a rebuild would be is unknown: take a new one." : `The newest machine snapshot is ${snapshotAgeDays} days old; a rebuild from it would bring back the server as it was then.`, ...base };
  }
  if (missingApps.length) {
    const named = missingApps.length <= 2 ? missingApps.join(" and ") : `${missingApps.slice(0, 2).join(", ")} and ${missingApps.length - 2} more`;
    return { state: "snapshot-missing-apps", label: "Machine snapshot out of date", warning: `The newest machine snapshot was taken before ${named} ${missingApps.length === 1 ? "was" : "were"} installed, so a rebuild would leave ${missingApps.length === 1 ? "it" : "them"} out: take a new one.`, ...base };
  }
  if (databaseAt === null) {
    return { state: "no-database-backup", label: "No database backup", warning: "BoxPilot's database has never been backed up, so a rebuild would lose its accounts, schedules and destinations: Back up now on the This server tab.", ...base };
  }
  if ((databaseAgeDays ?? 0) > staleAfterDays) {
    return { state: "database-stale", label: "Database backup out of date", warning: `BoxPilot's newest database backup is ${databaseAgeDays} days old; a rebuild would lose every change since.`, ...base };
  }
  return { state: "ok", label: null, warning: null, ...base };
}
