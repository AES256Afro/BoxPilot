/** Incremental newline-delimited helper replies. Only one incomplete frame is retained. */
export const maxHelperResponseBytes = 32 * 1024 * 1024;

/**
 * Progress frames the helper may send before its final reply. `queued` repeats while the request
 * waits behind another operation on its lane; `started` is sent once, when a request that queued
 * leaves the queue, because the operation's own time budget starts there and not at submission.
 */
export const helperQueuedFrame = (id, lane) => ({ version: 1, id, queued: true, ...(lane ? { lane } : {}) });
export const helperStartedFrame = (id) => ({ version: 1, id, started: true });

export function createHelperResponseReader(id, { maxFrameBytes = maxHelperResponseBytes, onQueued = () => {}, onStarted = () => {} } = {}) {
  let pending = "";
  let pendingBytes = 0;
  let result;
  let complete = false;
  let heartbeats = 0;
  let started = false;

  function frame(line) {
    if (!line.trim()) return;
    if (complete) throw new Error("Helper sent data after its final response");
    const response = JSON.parse(line);
    if (response?.id !== id) throw new Error("Helper response id did not match the request");
    if (response.version !== 1) throw new Error("Helper response version is unsupported");
    if (response.queued === true && response.ok === undefined) {
      if (started) throw new Error("Helper reported a queued request after it started");
      heartbeats += 1; onQueued(); return;
    }
    if (response.started === true && response.ok === undefined) {
      if (started) throw new Error("Helper reported the same request starting twice");
      started = true; onStarted(); return;
    }
    if (response.ok !== true) throw new Error(response.error ?? "Helper operation failed");
    complete = true;
    result = response.result;
  }

  function push(chunk) {
    let from = 0;
    while (from < chunk.length) {
      const newline = chunk.indexOf("\n", from);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.slice(from, end);
      pendingBytes += Buffer.byteLength(part, "utf8");
      if (pendingBytes > maxFrameBytes) throw new Error(`Helper response exceeds the ${maxFrameBytes}-byte limit`);
      pending += part;
      if (newline < 0) break;
      frame(pending);
      pending = "";
      pendingBytes = 0;
      from = newline + 1;
    }
  }

  function finish() {
    if (pending.trim()) frame(pending);
    pending = "";
    pendingBytes = 0;
    if (!complete) throw new Error("Helper closed before sending a result");
    return result;
  }

  return { push, finish, stats: () => ({ pendingBytes, heartbeats, started, complete }) };
}
