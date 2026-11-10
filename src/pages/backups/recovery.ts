import { scheduledAppIds, type AppProtection, type ScheduleLike } from "../../backupProtection";
import type { OffBoxInputs, OffBoxVerdict } from "../../offBox";
import type { Status } from "../../ui/types";

/*
 * What you'd get back: for each installed app that holds data, what a dead disk would leave.
 *
 * Three protections are counted, each from something the server records, none of them assumed:
 *
 *   1. A copy on this server: `app.backup.protection` (how many backups, when the newest was made).
 *   2. A copy off this server. Nothing records which archives a destination holds, only when each
 *      destination's last sync finished. Every sync copies every app backup and deletes nothing, so a
 *      sync that finished after an app's newest backup was made carried that backup: that is the
 *      derivation. A newest backup made after every sync has not left; whether an older one did is
 *      not known from here (the older ones' dates are not read), and is said as not known, except
 *      when the app has only the one backup, which is then its only copy.
 *   3. A restore proven: the last recorded rehearsal of that app (`app.backup.verify`, kept per app
 *      in the `appBackupVerifications` setting and carried on the catalog's live rows).
 *
 * Anything that could not be read is "not read", and never counts towards a good verdict (M28.5).
 * The clock is injected.
 */

/** The last recorded rehearsal of an app's backup, as the catalog carries it. */
export interface Rehearsal { verified?: unknown; checkedAt?: string | null; backup?: string | null; reason?: string | null }

export interface RecoveryInputs {
  /** `app.backup.protection`'s apps; null when it could not be read, or the backup folder could not. */
  apps: AppProtection[] | null;
  schedules: ScheduleLike[];
  /**
   * The three destinations as the page reads them, each null when its state did not come back; the
   * whole null when none did. An unread destination could hold a copy, so it never reads as "none".
   */
  offBox: OffBoxInputs | null;
  /**
   * Each installed app's last rehearsal by app id (null: none recorded). The whole map is null when
   * the catalog could not be read; an app missing from it was not read either.
   */
  rehearsals: Record<string, Rehearsal | null> | null;
}

export type LocalCopy = { state: "never" } | { state: "kept"; at: string | null; count: number };

export type OffCopy =
  /** A sync that left nothing out finished after this copy was made. */
  | { state: "copied"; copyAt: string; syncedAt: string }
  /** The only syncs since this copy was made left files out; whether this was one of them is not recorded. */
  | { state: "uncertain"; copyAt: string; syncedAt: string; leftOut: number }
  /** The newest copy was made after every sync. Older copies may have left before `syncedAt`. */
  | { state: "waiting"; syncedAt: string }
  | { state: "none" }
  | { state: "unread" };

export type Proof =
  | { state: "passed"; at: string | null }
  | { state: "failed"; at: string | null; reason: string | null }
  | { state: "never" }
  | { state: "unread" };

/** full: back to a recent copy, proven. partly: back, but old or unproven. none: nothing comes back. */
export type Grade = "full" | "partly" | "none" | "unknown";

/** The one action a row offers. "rehearse" is said in words: this tab starts no rehearsal. */
export type NextStep = "back-up" | "send-off" | "schedule" | "rehearse" | null;

export interface RecoveryRow {
  id: string;
  name: string;
  /** A nightly backup keeps happening. */
  scheduled: boolean;
  local: LocalCopy;
  off: OffCopy;
  proof: Proof;
  /** How many of the three protections it has: a copy here, a copy elsewhere, a restore proven. */
  depth: 0 | 1 | 2 | 3;
  grade: Grade;
  status: Status;
  /** The verdict: what a dead disk would leave of this app, in one sentence. */
  outcome: string;
  next: NextStep;
}

export interface Recovery {
  /** False when the apps could not be read: there are then no rows, and no verdict but "not read". */
  read: boolean;
  /** Worst first. */
  rows: RecoveryRow[];
  counts: Record<Grade, number>;
}

export interface RecoveryOptions {
  now?: number;
  /** A copy older than this is "old": the app comes back, with that much missing. */
  staleAfterDays?: number;
  /** The zone dates are said in; the browser's when left out. A test names one. */
  timeZone?: string;
}

const DAY = 86_400_000;
/** A moment in milliseconds, or null for anything that is not a date written as text. */
const parse = (value: unknown): number | null => {
  const at = typeof value === "string" && value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};

/** The calendar day a moment falls on in a zone, counted in days. */
function dayNumber(at: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  return Math.floor(Date.UTC(part("year"), part("month") - 1, part("day")) / DAY);
}

/** How many calendar days back a moment is; never negative (a clock a little ahead is today). */
export function daysBack(at: number, now: number, timeZone?: string): number {
  return Math.max(0, dayNumber(now, timeZone) - dayNumber(at, timeZone));
}

/** A day as a person says it: "8 September", with its year when that is not this one. */
export function dayWords(at: number, now: number, timeZone?: string): string {
  const year = (moment: number) => new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric" }).format(moment);
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long", ...(year(at) === year(now) ? {} : { year: "numeric" }) }).format(at);
}

/** "Back to yesterday", "Back to 8 September: 63 days gone". */
function backTo(copyAt: number, now: number, timeZone?: string): string {
  const days = daysBack(copyAt, now, timeZone);
  if (days === 0) return "Back to earlier today";
  if (days === 1) return "Back to yesterday";
  return `Back to ${dayWords(copyAt, now, timeZone)}: ${days} days gone`;
}

/**
 * Whether an app's newest backup is off this server, from when each destination last synced.
 *
 * A destination's sync covers every backup made before it finished. One that started while the
 * backup was still being written could have missed it and still finished later; the server does not
 * record when a sync started, so that window is not seen here.
 */
export function offCopyOf(local: LocalCopy, offBox: OffBoxInputs | null): OffCopy {
  if (local.state === "never") return { state: "none" };
  if (!offBox) return { state: "unread" };
  const destinations = [offBox.cloud, offBox.ssh, offBox.drive];
  // A destination whose state did not come back could hold a copy: without it, "not off this
  // server" is not known. A copy found at one that was read is still a copy.
  const short = (found: OffCopy): OffCopy => (destinations.some((destination) => !destination) ? { state: "unread" } : found);
  const syncs = destinations
    .filter((destination) => destination?.configured)
    .map((destination) => ({ at: parse(destination?.lastSyncAt), leftOut: typeof destination?.skipped === "number" && destination.skipped > 0 ? destination.skipped : 0 }))
    .filter((sync): sync is { at: number; leftOut: number } => sync.at !== null)
    .sort((left, right) => right.at - left.at);
  // Nowhere to copy to, or nothing ever sent: its copies are all on this disk.
  if (syncs.length === 0) return short({ state: "none" });
  const copyAt = parse(local.at);
  // A copy with no readable date cannot be placed before or after a sync.
  if (copyAt === null || local.at === null) return { state: "unread" };
  const covering = syncs.filter((sync) => sync.at >= copyAt);
  const whole = covering.find((sync) => sync.leftOut === 0);
  if (whole) return { state: "copied", copyAt: local.at, syncedAt: new Date(whole.at).toISOString() };
  if (covering.length) return short({ state: "uncertain", copyAt: local.at, syncedAt: new Date(covering[0].at).toISOString(), leftOut: covering[0].leftOut });
  // Made after every sync. With one backup, that one is all there is; with more, an older one may
  // have left with an earlier sync, and its date is not something this page reads.
  return short(local.count <= 1 ? { state: "none" } : { state: "waiting", syncedAt: new Date(syncs[0].at).toISOString() });
}

/** What the last rehearsal of an app proved, or that there was none, or that it was not read. */
export function proofOf(rehearsals: RecoveryInputs["rehearsals"], id: string): Proof {
  if (!rehearsals || !Object.prototype.hasOwnProperty.call(rehearsals, id)) return { state: "unread" };
  const last = rehearsals[id];
  if (last === null) return { state: "never" };
  if (typeof last !== "object" || typeof last.verified !== "boolean") return { state: "unread" };
  const at = typeof last.checkedAt === "string" && parse(last.checkedAt) !== null ? last.checkedAt : null;
  return last.verified ? { state: "passed", at } : { state: "failed", at, reason: typeof last.reason === "string" ? last.reason : null };
}

const gradeOrder: Record<Grade, number> = { none: 0, unknown: 1, partly: 2, full: 3 };

function judge(local: LocalCopy, off: OffCopy, proof: Proof, scheduled: boolean, now: number, staleAfterDays: number, timeZone?: string): Pick<RecoveryRow, "grade" | "status" | "outcome" | "next"> {
  if (local.state === "never") return { grade: "none", status: "danger", outcome: "Comes back installed and empty", next: "back-up" };
  if (off.state === "unread") return { grade: "unknown", status: "unknown", outcome: "Not known: whether a copy is off this server was not read", next: null };
  if (off.state === "none") return { grade: "none", status: "danger", outcome: "Gone: its only copy is on that disk", next: "send-off" };
  if (off.state === "waiting") {
    const before = dayWords(Date.parse(off.syncedAt), now, timeZone);
    return { grade: "unknown", status: "warning", outcome: `Back to before ${before} at best: its newer copies are only on that disk`, next: "send-off" };
  }
  const copyAt = Date.parse(off.copyAt);
  const back = backTo(copyAt, now, timeZone);
  if (off.state === "uncertain") {
    return { grade: "unknown", status: "warning", outcome: `${back}, unless its copy is among the ${off.leftOut} ${off.leftOut === 1 ? "file" : "files"} the last sync left out`, next: "send-off" };
  }
  const old = daysBack(copyAt, now, timeZone) > staleAfterDays;
  // What keeps the copy current comes before proving it: an old copy that restores is still old.
  const keepCurrent: NextStep = !scheduled ? "schedule" : old ? "back-up" : null;
  if (proof.state === "unread") return { grade: "unknown", status: "unknown", outcome: `${back}; whether it restores was not read`, next: keepCurrent };
  if (proof.state === "failed") {
    // A backup taken since the failed rehearsal has not been tried; the one that failed needs replacing.
    const failedAt = parse(proof.at);
    const newerUntried = failedAt !== null && copyAt > failedAt;
    return { grade: "partly", status: "danger", outcome: `${back}, but its last restore rehearsal failed`, next: newerUntried ? keepCurrent ?? "rehearse" : "back-up" };
  }
  if (proof.state === "never") return { grade: "partly", status: "warning", outcome: `${back}, if the copy restores`, next: keepCurrent ?? "rehearse" };
  return old
    ? { grade: "partly", status: "warning", outcome: back, next: keepCurrent }
    : { grade: "full", status: "good", outcome: back, next: keepCurrent };
}

/** Every installed app that holds data, worst first, with what a dead disk would leave of each. */
export function recoveryOf(inputs: RecoveryInputs, { now = Date.now(), staleAfterDays = 14, timeZone }: RecoveryOptions = {}): Recovery {
  const counts: Record<Grade, number> = { full: 0, partly: 0, none: 0, unknown: 0 };
  if (!inputs.apps) return { read: false, rows: [], counts };
  const scheduled = scheduledAppIds(inputs.schedules);
  // An entry that is not an app with an id is not a row (the answer is the server's, read as given).
  const apps = inputs.apps.filter((app) => app && typeof app === "object" && typeof app.id === "string" && app.protectable);
  const rows = apps.map((app): RecoveryRow => {
    const name = typeof app.name === "string" && app.name ? app.name : app.id;
    // A count with no date is still a copy; a date with no count is not one.
    const local: LocalCopy = typeof app.backups === "number" && app.backups > 0 ? { state: "kept", at: parse(app.newestAt) === null ? null : app.newestAt, count: app.backups } : { state: "never" };
    const off = offCopyOf(local, inputs.offBox);
    const proof = proofOf(inputs.rehearsals, app.id);
    const depth = (Number(local.state === "kept") + Number(off.state === "copied") + Number(proof.state === "passed")) as RecoveryRow["depth"];
    return { id: app.id, name, scheduled: scheduled.has(app.id), local, off, proof, depth, ...judge(local, off, proof, scheduled.has(app.id), now, staleAfterDays, timeZone) };
  });
  rows.sort((left, right) => gradeOrder[left.grade] - gradeOrder[right.grade] || left.depth - right.depth || left.name.localeCompare(right.name));
  for (const row of rows) counts[row.grade] += 1;
  return { read: true, rows, counts };
}

/**
 * The page's one verdict while this tab is open, and the same in a few words for the tab's own
 * mark. Never green about something unread.
 */
export function recoveryVerdict(recovery: Recovery): { status: Status; label: string; short: string } {
  const { counts, rows } = recovery;
  const apps = (count: number) => `${count} ${count === 1 ? "app" : "apps"}`;
  if (!recovery.read) return { status: "unknown", label: "Not read", short: "not read" };
  if (rows.length === 0) return { status: "neutral", label: "No app holds data yet", short: "no app holds data" };
  if (counts.none) return { status: "danger", label: `If the disk died tonight, ${apps(counts.none)} ${counts.none === 1 ? "comes" : "come"} back empty`, short: `${counts.none} would come back empty` };
  if (counts.unknown) return { status: rows.some((row) => row.status === "unknown") ? "unknown" : "warning", label: `If the disk died tonight, what ${apps(counts.unknown)} would get back is not known`, short: `${counts.unknown} not known` };
  if (counts.partly) return { status: "warning", label: `If the disk died tonight, ${apps(counts.partly)} ${counts.partly === 1 ? "comes" : "come"} back old or unproven`, short: `${counts.partly} old or unproven` };
  return { status: "good", label: `If the disk died tonight, ${rows.length === 1 ? "the app comes" : `all ${rows.length} apps come`} back`, short: "every app comes back" };
}

/** The depth in words, for a screen reader: which of the three it has. */
export function depthWords(row: Pick<RecoveryRow, "depth" | "local" | "off" | "proof">): string {
  const has = [
    row.local.state === "kept" ? "a copy on this server" : null,
    row.off.state === "copied" ? "a copy off this server" : null,
    row.proof.state === "passed" ? "a restore proven" : null,
  ].filter(Boolean);
  return `${row.depth} of 3${has.length ? `: ${has.join(", ")}` : ""}`;
}

/** The sync a "send off this server" starts: the first destination that is ready to take one. */
export function sendOffOperation(ready: { drive: boolean; ssh: boolean; cloud: boolean }, may: (operationId: string) => boolean): "backup.sync" | "backup.remote.sync" | "backup.cloud.sync" | null {
  const order = [["drive", "backup.sync"], ["ssh", "backup.remote.sync"], ["cloud", "backup.cloud.sync"]] as const;
  return order.find(([kind, operationId]) => ready[kind] && may(operationId))?.[1] ?? null;
}

export interface ServerFact { id: "snapshot" | "offbox" | "database"; label: string; value: string; at: string | null; status?: Status }

/**
 * The server itself, from what the page already reads: its newest machine snapshot, the newest copy
 * off this server, and whether the newest backup of BoxPilot's database passed its restore drill.
 * `value` is said before the time (`at`) when there is one. null means "could not be read".
 */
export function serverFacts({ snapshots, offBox, database }: {
  snapshots: Array<{ createdAt: string | null }> | null;
  offBox: OffBoxVerdict | null;
  database: Array<{ createdAt: string; restoreDrill: { passed?: boolean } | null }> | null;
}): ServerFact[] {
  const newest = <Item extends { createdAt: string | null }>(items: Item[]): Item | null => items.reduce<Item | null>((best, item) => (best === null || (parse(item.createdAt) ?? -Infinity) > (parse(best.createdAt) ?? -Infinity) ? item : best), null);
  const snapshot = snapshots ? newest(snapshots) : null;
  const backup = database ? newest(database) : null;
  return [
    !snapshots ? { id: "snapshot", label: "Machine snapshot", value: "not read", at: null, status: "unknown" }
      : !snapshot ? { id: "snapshot", label: "Machine snapshot", value: "none yet", at: null, status: "warning" }
        : parse(snapshot.createdAt) === null ? { id: "snapshot", label: "Machine snapshot", value: "taken, date not recorded", at: null }
          : { id: "snapshot", label: "Machine snapshot", value: "", at: snapshot.createdAt },
    !offBox ? { id: "offbox", label: "Off this server", value: "not read", at: null, status: "unknown" }
      : !offBox.configured ? { id: "offbox", label: "Off this server", value: "nowhere set up", at: null, status: "warning" }
        : !offBox.lastSyncAt ? { id: "offbox", label: "Off this server", value: "never sent", at: null, status: "warning" }
          : offBox.skipped ? { id: "offbox", label: "Off this server", value: `${offBox.skipped} ${offBox.skipped === 1 ? "file" : "files"} left out,`, at: offBox.lastSyncAt, status: "warning" }
            : { id: "offbox", label: "Off this server", value: "", at: offBox.lastSyncAt },
    !database ? { id: "database", label: "BoxPilot's database", value: "not read", at: null, status: "unknown" }
      : !backup ? { id: "database", label: "BoxPilot's database", value: "no backup yet", at: null, status: "warning" }
        : backup.restoreDrill?.passed ? { id: "database", label: "BoxPilot's database", value: "drilled, passed,", at: backup.createdAt }
          : { id: "database", label: "BoxPilot's database", value: "not drilled,", at: backup.createdAt, status: "warning" },
  ];
}
