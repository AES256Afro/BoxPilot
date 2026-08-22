/**
 * Password-attempt throttle. After `maxFailures` consecutive failures for a key (an account or
 * a client address) further attempts are refused for a delay that doubles per extra failure,
 * capped at `maxDelayMs`. A success clears the key. In-memory: BoxPilot is a single process,
 * and a restart resetting the counters is acceptable. `now` is injectable for tests.
 */
export function createLoginThrottle({ maxFailures = 5, baseDelayMs = 30_000, maxDelayMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const entries = new Map(); // key → { failures, blockedUntil }

  function prune() {
    if (entries.size < 1000) return;
    const at = now();
    for (const [key, entry] of entries) if (entry.blockedUntil < at && entry.failures < maxFailures) entries.delete(key);
  }

  /** @returns {{ blocked: boolean, retryAfterMs: number }} */
  function check(keys) {
    const at = now();
    let retryAfterMs = 0;
    for (const key of keys) {
      const entry = entries.get(key);
      if (entry && entry.blockedUntil > at) retryAfterMs = Math.max(retryAfterMs, entry.blockedUntil - at);
    }
    return { blocked: retryAfterMs > 0, retryAfterMs };
  }

  function record(keys, ok) {
    prune();
    for (const key of keys) {
      if (ok) { entries.delete(key); continue; }
      const entry = entries.get(key) ?? { failures: 0, blockedUntil: 0 };
      entry.failures += 1;
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
export const defaultSprayThrottle = createLoginThrottle({ maxFailures: 50, baseDelayMs: 60_000, maxDelayMs: 5 * 60_000 });
