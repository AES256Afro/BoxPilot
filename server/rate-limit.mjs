/**
 * A small sliding-window limit (M50): so many calls per key per window, keys forgotten when their
 * window passes and never more than `maxKeys` kept. For the doors that had no limit at all: the
 * set-up call, the sign-in clients' token and userinfo endpoints, a webhook's wrong-token guesses,
 * and the sends anyone signed in can order (a test notification, the weekly report, a push, a
 * share listing). The login throttle is for passwords, with its growing delay; this is a plain cap.
 */
export function createRateLimit({ count = 60, perMs = 60_000, maxKeys = 5000, now = () => Date.now() } = {}) {
  const calls = new Map(); // key → [at, ...] within the window

  function prune(at) {
    for (const [key, stamps] of calls) {
      const kept = stamps.filter((stamp) => at - stamp < perMs);
      if (kept.length) calls.set(key, kept); else calls.delete(key);
    }
  }

  /** Whether one more call under `key` is within the limit; it is counted when it is. */
  function take(key) {
    const at = now();
    const recent = (calls.get(key) ?? []).filter((stamp) => at - stamp < perMs);
    if (recent.length >= count) { calls.set(key, recent); return false; }
    recent.push(at);
    calls.set(key, recent);
    if (calls.size > maxKeys) prune(at);
    // Still too many after the sweep: the oldest keys go, since a flood of new keys is the only way here.
    while (calls.size > maxKeys) calls.delete(calls.keys().next().value);
    return true;
  }

  /** How long until a call under `key` would be within the limit again, 0 when it is now. */
  function retryAfterMs(key) {
    const at = now();
    const recent = (calls.get(key) ?? []).filter((stamp) => at - stamp < perMs);
    return recent.length >= count ? Math.max(1, recent[0] + perMs - at) : 0;
  }

  return { take, retryAfterMs, size: () => calls.size };
}

/**
 * Express middleware answering 429 once a caller is over `limit`. `keyOf` names the caller: the
 * signed-in account by default, or the address before there is one.
 */
export function rateLimited(limit, name, { keyOf = (request) => request.boxpilotSession?.owner?.id ?? request.ip ?? "unknown", message = "Too many requests; wait a minute" } = {}) {
  return function limitMiddleware(request, response, next) {
    const key = `${name}:${keyOf(request)}`;
    if (limit.take(key)) return next();
    response.setHeader("Retry-After", String(Math.max(1, Math.ceil(limit.retryAfterMs(key) / 1000))));
    return response.status(429).json({ error: message, code: "rate_limited" });
  };
}
