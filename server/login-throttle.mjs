/**
 * Password-attempt throttle. After `maxFailures` consecutive failures for a key (an account or
 * a client address) further attempts are refused for a delay that doubles per extra failure,
 * capped at `maxDelayMs`. A success clears the key. In-memory: BoxPilot is a single process,
 * and a restart resetting the counters is acceptable. `now` is injectable for tests.
 */
export function createLoginThrottle({ maxFailures = 5, baseDelayMs = 30_000, maxDelayMs = 15 * 60_000, resetOnExpiry = false, now = () => Date.now() } = {}) {
  const entries = new Map(); // key → { failures, blockedUntil }

  const maxEntries = 5000;
  function prune() {
    const at = now();
    // Prune on when the key was last used, not on its failure count: the old rule kept exactly the
    // entries an attacker generates and dropped the harmless ones. A key untouched for longer than
    // the maximum delay is finished with, whatever its count — and the map is capped besides,
    // because the key includes a caller and a caller can vary.
    for (const [key, entry] of entries) {
      if (entry.blockedUntil <= at && entry.lastFailureAt + maxDelayMs < at) entries.delete(key);
    }
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  /** @returns {{ blocked: boolean, retryAfterMs: number }} */
  function check(keys) {
    const at = now();
    let retryAfterMs = 0;
    for (const key of keys) {
      const entry = entries.get(key);
      if (!entry) continue;
      if (entry.blockedUntil > at) { retryAfterMs = Math.max(retryAfterMs, entry.blockedUntil - at); continue; }
      // On a key any caller can drive — the per-account ceiling — serving the block clears the
      // count, so the next block costs another full run of failures. Without that the count stayed
      // above the limit for ever and one wrong guess per expiry re-armed the delay at its cap,
      // holding the account shut indefinitely. On a per-caller key the escalation is the point:
      // whoever is guessing waits longer each time, and only they do.
      if (resetOnExpiry && entry.failures >= maxFailures) entries.set(key, { failures: 0, blockedUntil: 0, lastFailureAt: entry.lastFailureAt ?? at });
    }
    return { blocked: retryAfterMs > 0, retryAfterMs };
  }

  function record(keys, ok) {
    prune();
    for (const key of keys) {
      if (ok) { entries.delete(key); continue; }
      const entry = entries.get(key) ?? { failures: 0, blockedUntil: 0, lastFailureAt: 0 };
      entry.failures += 1;
      entry.lastFailureAt = now();
      if (entry.failures >= maxFailures) entry.blockedUntil = now() + Math.min(maxDelayMs, baseDelayMs * 2 ** (entry.failures - maxFailures));
      entries.set(key, entry);
    }
  }

  return { check, record, size: () => entries.size };
}

export const defaultThrottle = createLoginThrottle();

/**
 * The per-account ceiling, counted across every caller. It exists only to slow an attack spread
 * over many callers, so it sits far above anything a person mistyping a password reaches: fifty
 * wrong guesses before a one-minute pause, five minutes at most. The per-caller throttle is what
 * actually stops guessing; this one must never be the thing that keeps the owner out.
 */
export const defaultSprayThrottle = createLoginThrottle({ maxFailures: 50, baseDelayMs: 60_000, maxDelayMs: 5 * 60_000, resetOnExpiry: true });
