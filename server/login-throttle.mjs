/**
 * Password-attempt throttle.
 *
 * Two keys guard every password check, and they answer different questions.
 *
 * The **per-caller** key — one account as seen from one caller — is the real defence against
 * guessing. After `maxFailures` consecutive failures it refuses further attempts for a delay that
 * doubles each time, up to `maxDelayMs`. Escalation is the point: whoever is guessing waits longer
 * and longer, and only they do.
 *
 * The **per-account** key counts failures from every caller, to slow an attack spread across many
 * of them. Anyone who can reach the port can drive that key, so it must never become a way to keep
 * the owner out: it is deliberately far above anything a person mistyping a password reaches, its
 * delay does not escalate, and serving a block decays the count so the next one is not free.
 *
 * In-memory: BoxPilot is a single process, and a restart resetting the counters is acceptable.
 * `now` is injectable for tests.
 */
export function createLoginThrottle({
  maxFailures = 5,
  baseDelayMs = 30_000,
  maxDelayMs = 15 * 60_000,
  // Serving a block leaves the count one short of the limit rather than clearing it. Without this
  // a counter that passed the limit stayed past it, and one wrong guess per expiry re-armed the
  // delay at its cap for ever. Clearing it outright was the other extreme: the limit then never
  // escalated at all, so the key allowed a flat `maxFailures` guesses per window indefinitely.
  decayOnExpiry = false,
  maxEntries = 5000,
  now = () => Date.now(),
} = {}) {
  const entries = new Map(); // key → { failures, blockedUntil, lastFailureAt }

  // How long a key is remembered after its last failure. It has to outlast the block by a good
  // margin: at exactly the block length the entry evaporated the moment its block expired, so the
  // count started from zero every window and the limit allowed its full quota again and again.
  const retentionMs = Math.max(maxDelayMs * 4, 15 * 60_000);

  /** Forget keys nobody has used lately, and never more than `maxEntries` of them. */
  function prune() {
    const at = now();
    for (const [key, entry] of entries) {
      if (entry.blockedUntil <= at && entry.lastFailureAt + retentionMs < at) entries.delete(key);
    }
    if (entries.size < maxEntries) return;
    // A key that is actively blocking somebody is never evicted. Eviction ran in insertion order
    // over every entry, so an attacker could burn their own block away by creating a few thousand
    // keys — which cost them nothing, since a wrong username is refused before any hashing.
    for (const [key, entry] of entries) {
      if (entries.size < maxEntries) break;
      if (entry.blockedUntil <= at) entries.delete(key);
    }
  }

  /** @returns {{ blocked: boolean, retryAfterMs: number }} */
  function check(keys) {
    const at = now();
    let retryAfterMs = 0;
    for (const key of keys) {
      const entry = entries.get(key);
      if (!entry) continue;
      if (entry.blockedUntil > at) { retryAfterMs = Math.max(retryAfterMs, entry.blockedUntil - at); continue; }
      if (decayOnExpiry && entry.failures >= maxFailures) {
        entries.set(key, { failures: maxFailures - 1, blockedUntil: 0, lastFailureAt: entry.lastFailureAt ?? at });
      }
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
      // Re-insert so Map order is least-recently-used, which is the order prune evicts in.
      entries.delete(key);
      entries.set(key, entry);
    }
  }

  return { check, record, size: () => entries.size };
}

export const defaultThrottle = createLoginThrottle();

/**
 * The per-account ceiling, counted across every caller.
 *
 * Fifty wrong guesses buy a one-minute pause, and it does not escalate beyond that: an account
 * under this much pressure should be slowed, but a pause an attacker can extend indefinitely is a
 * lock-out weapon, and this key is one anybody can drive. Serving a block leaves the count one
 * short of the limit, so holding the pause open costs a fresh guess every minute — visible in the
 * audit log — rather than being free.
 */
export const defaultSprayThrottle = createLoginThrottle({ maxFailures: 50, baseDelayMs: 60_000, maxDelayMs: 60_000, decayOnExpiry: true });
