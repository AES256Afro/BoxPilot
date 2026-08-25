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
