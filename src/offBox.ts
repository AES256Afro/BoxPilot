/**
 * Whether a copy of the backups exists anywhere other than this server.
 *
 * Backups sitting beside the data they protect guard against a bad upgrade and nothing else: the
 * disk failure everyone actually fears takes both at once. BoxPilot only ever raised this when a
 * backup *drive* happened to be mounted, so a server with a cloud destination it had never synced —
 * or, more commonly, with no destination at all — was told nothing.
 *
 * Three destinations count, and any one of them is enough: a cloud bucket through rclone, another
 * machine over SSH, or a drive that is not the system disk.
 */

export interface DestinationState {
  /** A destination has been saved. Says nothing about whether anything reached it. */
  configured: boolean;
  lastSyncAt: string | null;
}

export interface OffBoxInputs {
  cloud?: DestinationState | null;
  ssh?: DestinationState | null;
  drive?: DestinationState | null;
}

export interface OffBoxVerdict {
  /** At least one destination is saved. */
  configured: boolean;
  /** The most recent successful copy to any destination. */
  lastSyncAt: string | null;
  ageDays: number | null;
  /** Which kinds are set up, for wording that names them. */
  where: Array<"cloud" | "another machine" | "a backup drive">;
  /**
   * "none" — nowhere to copy to. "never" — set up but nothing sent. "behind" — local backups newer
   * than the copy have been waiting long enough that the sync that should have followed them
   * clearly did not run. "stale"/"ok" — by age.
   */
  state: "none" | "never" | "behind" | "stale" | "ok";
  /** How many hours the newest unmirrored local backup has been waiting, when state is "behind". */
  behindHours: number | null;
}

const KINDS: Array<[keyof OffBoxInputs, OffBoxVerdict["where"][number]]> = [
  ["cloud", "cloud"],
  ["ssh", "another machine"],
  ["drive", "a backup drive"],
];

export function offBoxVerdict(
  inputs: OffBoxInputs,
  { now = Date.now(), staleAfterDays = 7, newestLocalBackupAt = null, behindSlackHours = 12 }:
  { now?: number; staleAfterDays?: number; newestLocalBackupAt?: string | null; behindSlackHours?: number } = {},
): OffBoxVerdict {
  const where: OffBoxVerdict["where"] = [];
  let newest: number | null = null;
  for (const [key, label] of KINDS) {
    const destination = inputs[key];
    if (!destination?.configured) continue;
    where.push(label);
    const at = destination.lastSyncAt ? Date.parse(destination.lastSyncAt) : Number.NaN;
    // The best copy anywhere is what matters: two destinations do not make you worse off, so the
    // most recent success wins rather than the most neglected destination dragging the answer down.
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  const ageDays = newest === null ? null : Math.floor((now - newest) / 86_400_000);
  // A copy can be recent and still behind: a nightly backup that the nightly sync never followed.
  // The seven-day age rule alone kept quiet about exactly that for days on a real machine. The
  // slack covers the ordinary window between a backup and the sync scheduled after it — only a
  // backup that has waited longer than that with no sync counts as the sync not running.
  const localAt = newestLocalBackupAt ? Date.parse(newestLocalBackupAt) : Number.NaN;
  const behind = newest !== null && Number.isFinite(localAt)
    && localAt > newest
    && now - localAt > behindSlackHours * 3_600_000;
  const state: OffBoxVerdict["state"] = where.length === 0 ? "none"
    : newest === null ? "never"
    : behind ? "behind"
    : (ageDays ?? 0) > staleAfterDays ? "stale"
    : "ok";
  const behindHours = state === "behind" ? Math.floor((now - localAt) / 3_600_000) : null;
  return { configured: where.length > 0, lastSyncAt: newest === null ? null : new Date(newest).toISOString(), ageDays, where, state, behindHours };
}

/** One sentence for the Overview, or null when a recent copy exists somewhere else. */
export function offBoxWarning(verdict: OffBoxVerdict): string | null {
  if (verdict.state === "none") return "Backups are only on this server. A disk failure would take them with it";
  if (verdict.state === "never") return "Backups have never been copied off this server";
  if (verdict.state === "behind") return `Backups newer than the off-box copy have been waiting ${verdict.behindHours} hours; the sync that should have followed them has not run`;
  if (verdict.state === "stale") return `The off-box copy of your backups is ${verdict.ageDays} days old`;
  return null;
}

/** The sync operations worth scheduling for whatever is actually set up. */
export function mirrorOperations(inputs: OffBoxInputs): string[] {
  const operations: string[] = [];
  if (inputs.cloud?.configured) operations.push("backup.cloud.sync");
  if (inputs.ssh?.configured) operations.push("backup.remote.sync");
  if (inputs.drive?.configured) operations.push("backup.sync");
  return operations;
}
