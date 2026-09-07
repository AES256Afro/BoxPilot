/**
 * Share one slow read between callers that ask at the same time.
 *
 * Two things are worth separating here, because they have very different risks.
 *
 * Collapsing *concurrent* calls is free. Three components mounting at once and each asking the
 * helper what the containers are doing want the same answer, and giving them one answer from one
 * round trip cannot show anyone anything a separate call would not have shown them.
 *
 * Holding an answer for later is not free. A cached container list handed back just after the owner
 * installed something tells them the install did not happen. That is a worse failure than the
 * latency it saves, so `ttlMs` defaults to zero: dedupe by default, and hold on only where the
 * facts genuinely move slower than the owner does.
 */
export function shared(read, { ttlMs = 0, now = () => Date.now() } = {}) {
  let generation = 0;
  let inFlight = null;
  let held = null; // { at, value }
  const counters = { reads: 0, cacheHits: 0, deduplicated: 0, failures: 0, invalidations: 0, lastDurationMs: null };

  const call = (...args) => {
    if (ttlMs > 0 && held && now() - held.at < ttlMs) { counters.cacheHits += 1; return Promise.resolve(held.value); }
    if (inFlight) { counters.deduplicated += 1; return inFlight; }
    const started = generation;
    const startedAt = now();
    counters.reads += 1;
    const pending = Promise.resolve().then(() => read(...args))
      .then((value) => { if (ttlMs > 0 && started === generation) held = { at: now(), value }; return value; })
      // A failure is never held: the next caller should get a fresh attempt, not a cached apology.
      .catch((error) => { counters.failures += 1; throw error; })
      .finally(() => { counters.lastDurationMs = Math.max(0, now() - startedAt); if (inFlight === pending) inFlight = null; });
    inFlight = pending;
    return pending;
  };
  /** Call after anything that changes what `read` would report. */
  call.forget = () => { counters.invalidations += 1; generation += 1; held = null; inFlight = null; };
  call.stats = () => ({ ...counters, inFlight: Boolean(inFlight), heldAgeMs: held ? Math.max(0, now() - held.at) : null, ttlMs });
  return call;
}
