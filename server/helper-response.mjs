import { timeoutOf } from "./timeouts.mjs";

/** Incremental newline-delimited helper replies. Only one incomplete frame is retained. */
export const maxHelperResponseBytes = 32 * 1024 * 1024;

/**
 * Progress frames the helper may send before its final reply. `queued` repeats while the request
 * waits behind another operation on its lane; `started` is sent once, when a request that queued
 * leaves the queue, because the operation's own time budget starts there and not at submission.
 */
export const helperQueuedFrame = (id, lane) => ({ version: 1, id, queued: true, ...(lane ? { lane } : {}) });
export const helperStartedFrame = (id) => ({ version: 1, id, started: true });

/**
 * The helper's reply for an operation that threw. A step that ran out of its own time says so in a
 * field (M30.3), and an operation that tried to undo its partial changes says whether that worked
 * (rolledBack), so the job records it from the field rather than from the words. An older web side
 * reads only `error`, so the reply stays what it was for it.
 */
export function helperErrorReply(id, error) {
  const timeout = timeoutOf(error);
  return {
    version: 1, id, ok: false, error: error.message, code: timeout ? "timeout" : "operation_failed",
    ...(timeout ? { timeout } : {}),
    ...(typeof error?.rolledBack === "boolean" ? { rolledBack: error.rolledBack } : {}),
  };
}

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
    if (response.ok !== true) {
      // The reply's code, a step's timeout when it ran out of time (M30.3), and whether the
      // operation's own rollback worked, ride on the error.
      const timeout = timeoutOf(response);
      throw Object.assign(new Error(response.error ?? "Helper operation failed"), typeof response.code === "string" ? { code: response.code } : {}, timeout ? { timeout } : {}, typeof response.rolledBack === "boolean" ? { rolledBack: response.rolledBack } : {});
    }
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
