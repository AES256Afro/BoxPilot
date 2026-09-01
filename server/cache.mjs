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
  let inFlight = null;
  let held = null; // { at, value }

  const call = (...args) => {
    if (ttlMs > 0 && held && now() - held.at < ttlMs) return Promise.resolve(held.value);
    if (inFlight) return inFlight;
    inFlight = Promise.resolve(read(...args))
      .then((value) => { if (ttlMs > 0) held = { at: now(), value }; return value; })
      // A failure is never held: the next caller should get a fresh attempt, not a cached apology.
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  /** Call after anything that changes what `read` would report. */
  call.forget = () => { held = null; };
  return call;
}
