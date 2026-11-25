/**
 * What BoxPilot told the owner, and whether it got there (M36): the notification centre's record.
 *
 * The health-alert ledger (health-alerts.mjs) holds only what is live - a condition until it clears,
 * news until it is delivered - so once something was said it was gone, and nothing could show what
 * the server had been saying. This keeps the last few weeks of it: each condition raised (and when
 * it cleared), each piece of news, and each failed job pushed, with whether the notification target
 * took it. Kept in one setting, bounded by count and age, so a server that says a lot, or one with
 * no target that says it to nobody, never grows a pile.
 *
 * One entry per thing said, not per attempt: a condition retried every round while no target is set
 * is one entry marked not delivered, which becomes delivered when a later round gets it through.
 */
import { randomUUID } from "node:crypto";
import { jobNoticeKey } from "./health-alerts.mjs";

export const historyLimit = 100;
export const historyMaxAgeMs = 30 * 24 * 60 * 60_000;
const settingKey = "notificationHistory";
const seenKey = "notificationsSeen";
const ledgerKey = "healthAlertsState";

/** Kinds: a condition turning bad, one-off news, a failed job's push, and a job waiting for approval (M25.2). */
export const historyKinds = Object.freeze(["alert", "notice", "job", "approval"]);

const text = (value, maximum) => (typeof value === "string" ? value.slice(0, maximum) : null);

/** @param {{ store?: any, now?: () => Date, limit?: number, maxAgeMs?: number }} [options] */
export function createNotificationHistory({ store, now = () => new Date(), limit = historyLimit, maxAgeMs = historyMaxAgeMs } = {}) {
  function read() {
    const value = store.getSetting?.(settingKey, []) ?? [];
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object" && typeof entry.at === "string") : [];
  }

  /**
   * Whether an entry is about something the health ledger still holds (M88): a condition not yet
   * cleared, or news not yet heard. The bell reads it as still going, so neither the count limit nor
   * the age limit takes it: a server saying a lot pushed a live alert out of the record, and a disk
   * full for five weeks stopped being listed while it was still full.
   */
  function liveTest() {
    const ledger = store.getSetting?.(ledgerKey, {}) ?? {};
    const live = ledger && typeof ledger === "object" ? ledger : {};
    return (entry) => !entry.resolvedAt && Object.hasOwn(live, entry.key);
  }

  function write(entries) {
    const cutoff = now().getTime() - maxAgeMs;
    const isLive = liveTest();
    const current = entries.filter((entry) => isLive(entry) || Date.parse(entry.at) >= cutoff);
    // Over the limit, the oldest entries that are not live go first, and only those (M88).
    let excess = current.length - limit;
    const kept = excess <= 0 ? current : current.filter((entry) => {
      if (excess > 0 && !isLive(entry)) { excess -= 1; return false; }
      return true;
    });
    store.setSetting?.(settingKey, kept, { updatedBy: null });
    return kept;
  }

  /** The newest entry for this key and kind still open to change: not yet delivered, or not yet cleared. */
  const latest = (entries, key, kind) => {
    for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index].key === key && entries[index].kind === kind) return entries[index];
    return null;
  };

  /**
   * Something was said, or tried. `delivered` false with `reason` "no-target", "failed" or "held" (waiting for the quiet-hours summary) when it did
   * not arrive. The same key said again before it arrived updates that entry; once it has arrived,
   * or cleared, saying it again is a new entry. `actorId`, when given, is whose run the words describe
   * (an automation's, sweep 3); it goes with the words, so newer words take their own or none.
   */
  function record({ key, kind, title, message = null, priority = "default", delivered, reason = null, actorId }) {
    if (typeof key !== "string" || !historyKinds.includes(kind)) return null;
    const ranBy = actorId === undefined ? {} : { actorId: typeof actorId === "string" ? actorId : null };
    try {
      const entries = read();
      const at = now().toISOString();
      const open = latest(entries, key, kind);
      if (open && !open.delivered && !open.resolvedAt) {
        delete open.actorId;
        Object.assign(open, { title: text(title, 300) ?? open.title, message: text(message, 1000) ?? open.message, delivered: Boolean(delivered), reason: delivered ? null : reason, ...(delivered ? { deliveredAt: at } : {}), ...ranBy });
        write(entries);
        return open;
      }
      const entry = { id: randomUUID(), key: key.slice(0, 200), kind, title: text(title, 300) ?? key, message: text(message, 1000), priority, at, delivered: Boolean(delivered), reason: delivered ? null : reason, ...(delivered ? { deliveredAt: at } : {}), ...ranBy };
      write([...entries, entry]);
      return entry;
    } catch {
      return null; // the record is a courtesy; it never holds up what was being said
    }
  }

  /** A condition cleared: its latest entry says when. */
  function resolve(key) {
    try {
      const entries = read();
      const open = latest(entries, key, "alert");
      if (!open || open.resolvedAt) return false;
      open.resolvedAt = now().toISOString();
      write(entries);
      return true;
    } catch {
      return false;
    }
  }

  /** Newest first, within the age limit, and whatever is still live however old (M88). */
  function list() {
    const cutoff = now().getTime() - maxAgeMs;
    const isLive = liveTest();
    return read().filter((entry) => isLive(entry) || Date.parse(entry.at) >= cutoff).reverse();
  }

  function seenAt(ownerId) {
    const map = store.getSetting?.(seenKey, {}) ?? {};
    return typeof map?.[ownerId] === "string" ? map[ownerId] : null;
  }

  /**
   * "Mark seen": everything said up to `upTo` stops counting for this account. Nothing else changes.
   * `upTo` is when the caller last read the list (M88): closing the bell must not mark seen what
   * arrived after the list it showed was read. The marker is min(now, upTo); a missing, unreadable
   * or future `upTo` means now.
   *
   * @param {string} ownerId
   * @param {unknown} [upTo]
   */
  function markSeen(ownerId, upTo = null) {
    const current = now();
    const asked = typeof upTo === "string" ? Date.parse(upTo) : Number.NaN;
    const at = (Number.isFinite(asked) && asked < current.getTime() ? new Date(asked) : current).toISOString();
    const map = store.getSetting?.(seenKey, {}) ?? {};
    store.setSetting?.(seenKey, { ...(map && typeof map === "object" && !Array.isArray(map) ? map : {}), [ownerId]: at }, { updatedBy: ownerId });
    return at;
  }

  return { record, resolve, list, seenAt, markSeen };
}

const subjectKeys = ["id", "name", "unit", "target", "device", "mountpoint", "tag"];
/** What a job acted on, as src/jobStatus.ts's jobSubject reads it: an app, a unit, a drive, a release. */
function jobSubject(job) {
  for (const key of subjectKeys) {
    const value = job?.parameters?.[key];
    if (typeof value === "string" && value) return `${key}:${value}`;
  }
  return "";
}

/**
 * The work a job did, as one key, as src/jobStatus.ts's jobWork reads it: its operation and subject.
 * "Reconnect a drive" given a network share (share-<name>) is the same work as "Reconnect a network
 * share" for that share, so either one working settles a failure of the other.
 */
function jobWork(job) {
  const name = job?.parameters?.name;
  if (job?.type === "op:storage.remount" && typeof name === "string" && name.startsWith("share-")) return `op:share.reconnect|name:${name.slice("share-".length)}`;
  return `${job?.type}|${jobSubject(job)}`;
}

/** The operations whose jobs can be the same work as one of `type` (jobWork's one equivalence). */
const sameWorkTypes = (type) => (type === "op:storage.remount" || type === "op:share.reconnect" ? ["op:share.reconnect", "op:storage.remount"] : [type]);

const markedStep = (job, name, state) => (job.steps ?? []).some((step) => step?.name === name && step.state === state);

/**
 * Whether `other` settles `job` by src/jobStatus.ts's failureSettled (M88), so the bell and Today
 * agree on one rule: a retry or rerun of it, or the same work on the same subject started after it
 * that is done, running or waiting for approval. A later failure, or a later cancelled run, is not.
 */
function settles(job, other) {
  if (other.id === job.id) return false;
  if (other.recovery?.retryOf === job.id || other.recovery?.rerunOf === job.id) return true;
  return jobWork(other) === jobWork(job) && Date.parse(other.createdAt ?? "") > Date.parse(job.createdAt ?? "") && other.state !== "failed" && other.state !== "cancelled";
}

/**
 * Whether a `job.failed` or `job.interrupted` entry was settled since (M88), by failureSettled's
 * rule: a job not failed (cancelled, say) needs no one; a failed one is settled once dismissed, run
 * again by BoxPilot after a restart, or a later job settles it (`settles`). The bell kept every one
 * as "Needs a look" for 30 days, after it was dismissed or the same work had gone through. A failed
 * job's entry names the job; a cut-off one names its operation and subject only (jobNoticeKey), so
 * its job is the newest failed one of that work from before the entry was said, and with none on
 * record, any run of that work since that did not fail settles it. A job no longer on record settles
 * nothing. Each question reads only jobs of that work's operations created after the job, through
 * idx_jobs_type, and stops at the first that settles it.
 *
 * @param {{ getJob?: (id: string) => any, findJobOfType?: (types: string | string[], options: { after?: string | null, before?: string | null, mentioning?: string | null, limit?: number }, test: (job: any) => boolean) => any }} store
 * @returns {(entry: { key: string, at: string }) => boolean}
 */
export function failureSettledFor(store) {
  const find = (types, options, test) => store.findJobOfType?.(types, options, test) ?? null;
  const settled = (job) => {
    if (job.state !== "failed") return true;
    if (markedStep(job, "dismissed", "completed") || markedStep(job, "rerun", "started")) return true;
    // A retry or rerun runs the same parameters, so every job that can settle this one mentions its subject.
    const subject = jobSubject(job);
    const mentioning = subject ? subject.slice(subject.indexOf(":") + 1).replace(/^share-/, "") : null;
    return find(sameWorkTypes(job.type), { after: job.createdAt ?? null, mentioning }, (other) => settles(job, other)) !== null;
  };
  return (entry) => {
    try {
      const key = String(entry?.key ?? "");
      if (key.startsWith("job.failed:")) {
        const job = store.getJob?.(key.slice("job.failed:".length));
        return job ? settled(job) : false;
      }
      if (key.startsWith("job.interrupted:")) {
        const type = `op:${key.split(":")[1]}`;
        const ofThisWork = (job) => jobNoticeKey("job.interrupted", job) === key;
        const cut = find([type], { before: entry.at ?? null }, (job) => job.state === "failed" && ofThisWork(job));
        if (cut) return settled(cut);
        return find([type], { after: entry.at ?? null }, (job) => ofThisWork(job) && job.state !== "failed" && job.state !== "cancelled") !== null;
      }
      return false;
    } catch {
      return false; // a lookup that failed leaves the entry needing a look, as it was
    }
  };
}
