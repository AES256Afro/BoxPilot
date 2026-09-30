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

export const historyLimit = 100;
export const historyMaxAgeMs = 30 * 24 * 60 * 60_000;
const settingKey = "notificationHistory";
const seenKey = "notificationsSeen";

/** Kinds: a condition turning bad, one-off news, a failed job's push, and a job waiting for approval (M25.2). */
export const historyKinds = Object.freeze(["alert", "notice", "job", "approval"]);

const text = (value, maximum) => (typeof value === "string" ? value.slice(0, maximum) : null);

export function createNotificationHistory({ store, now = () => new Date(), limit = historyLimit, maxAgeMs = historyMaxAgeMs } = {}) {
  function read() {
    const value = store.getSetting?.(settingKey, []) ?? [];
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object" && typeof entry.at === "string") : [];
  }

  function write(entries) {
    const cutoff = now().getTime() - maxAgeMs;
    const kept = entries.filter((entry) => Date.parse(entry.at) >= cutoff).slice(-limit);
    store.setSetting?.(settingKey, kept, { updatedBy: null });
    return kept;
  }

  /** The newest entry for this key and kind still open to change: not yet delivered, or not yet cleared. */
  const latest = (entries, key, kind) => {
    for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index].key === key && entries[index].kind === kind) return entries[index];
    return null;
  };

  /**
   * Something was said, or tried. `delivered` false with `reason` "no-target" or "failed" when it did
   * not arrive. The same key said again before it arrived updates that entry; once it has arrived,
   * or cleared, saying it again is a new entry.
   */
  function record({ key, kind, title, message = null, priority = "default", delivered, reason = null }) {
    if (typeof key !== "string" || !historyKinds.includes(kind)) return null;
    try {
      const entries = read();
      const at = now().toISOString();
      const open = latest(entries, key, kind);
      if (open && !open.delivered && !open.resolvedAt) {
        Object.assign(open, { title: text(title, 300) ?? open.title, message: text(message, 1000) ?? open.message, delivered: Boolean(delivered), reason: delivered ? null : reason, ...(delivered ? { deliveredAt: at } : {}) });
        write(entries);
        return open;
      }
      const entry = { id: randomUUID(), key: key.slice(0, 200), kind, title: text(title, 300) ?? key, message: text(message, 1000), priority, at, delivered: Boolean(delivered), reason: delivered ? null : reason, ...(delivered ? { deliveredAt: at } : {}) };
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

  /** Newest first, within the age limit. */
  function list() {
    const cutoff = now().getTime() - maxAgeMs;
    return read().filter((entry) => Date.parse(entry.at) >= cutoff).reverse();
  }

  function seenAt(ownerId) {
    const map = store.getSetting?.(seenKey, {}) ?? {};
    return typeof map?.[ownerId] === "string" ? map[ownerId] : null;
  }

  /** "Mark seen": everything said up to now stops counting for this account. Nothing else changes. */
  function markSeen(ownerId) {
    const at = now().toISOString();
    const map = store.getSetting?.(seenKey, {}) ?? {};
    store.setSetting?.(seenKey, { ...(map && typeof map === "object" && !Array.isArray(map) ? map : {}), [ownerId]: at }, { updatedBy: ownerId });
    return at;
  }

  return { record, resolve, list, seenAt, markSeen };
}
