/** Bounded SSE delivery. Slow clients are disconnected and can reconnect for a fresh snapshot. */
export function createStreamBudget({ perAccount = 8, total = 32 } = {}) {
  const counts = new Map();
  let active = 0;
  function acquire(key) {
    if (active >= total || (counts.get(key) ?? 0) >= perAccount) return null;
    active += 1;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const remaining = counts.get(key) - 1;
      if (remaining) counts.set(key, remaining); else counts.delete(key);
    };
  }
  return { acquire, stats: () => ({ active, accounts: counts.size, perAccount, total }) };
}

export function createEventStream(response, {
  maxBufferedBytes = 8 * 1024 * 1024,
  maxStallMs = 15_000,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
} = {}) {
  let closed = false;
  let stalled = null;
  const cleanup = new Set();
  const drains = new Set();
  function finish() {
    if (closed) return;
    closed = true;
    if (stalled !== null) cancel(stalled);
    stalled = null;
    for (const resolve of drains) resolve(false);
    drains.clear();
    for (const fn of cleanup) fn();
    cleanup.clear();
    response.off("drain", drained);
    response.off("close", finish);
    response.off("finish", finish);
    response.off("error", abort);
  }
  function abort() { finish(); response.destroy(); }
  function drained() {
    if (stalled !== null) cancel(stalled);
    stalled = null;
    for (const resolve of drains) resolve(true);
    drains.clear();
  }
  response.on("drain", drained);
  response.once("close", finish);
  response.once("finish", finish);
  response.once("error", abort);

  function write(frame) {
    if (closed || response.destroyed || response.writableEnded) return false;
    if (Buffer.byteLength(frame) + response.writableLength > maxBufferedBytes) { abort(); return false; }
    try {
      if (!response.write(frame) && stalled === null) {
        stalled = schedule(abort, maxStallMs);
        stalled.unref?.();
      }
    } catch { abort(); return false; }
    return !closed;
  }
  function ready() {
    if (closed) return Promise.resolve(false);
    if (stalled === null) return Promise.resolve(true);
    return new Promise((resolve) => drains.add(resolve));
  }
  const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  async function output(text) {
    // A persisted log can be several MiB. Yield to drain between chunks instead of queueing it all.
    for (let from = 0; from < text.length;) {
      let to = Math.min(text.length, from + 32 * 1024);
      if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1])) to -= 1;
      if (!await ready() || !send("output", { text: text.slice(from, to) })) return false;
      from = to;
    }
    return true;
  }
  function onClose(fn) { if (closed) fn(); else cleanup.add(fn); }
  function end() { if (!closed) response.end(); }
  return { send, write, output, ready, onClose, end, abort, get closed() { return closed; } };
}
