/** Incremental newline-delimited helper replies. Only one incomplete frame is retained. */
export const maxHelperResponseBytes = 32 * 1024 * 1024;

export function createHelperResponseReader(id, { maxFrameBytes = maxHelperResponseBytes } = {}) {
  let pending = "";
  let pendingBytes = 0;
  let result;
  let complete = false;
  let heartbeats = 0;

  function frame(line) {
    if (!line.trim()) return;
    if (complete) throw new Error("Helper sent data after its final response");
    const response = JSON.parse(line);
    if (response?.id !== id) throw new Error("Helper response id did not match the request");
    if (response.version !== 1) throw new Error("Helper response version is unsupported");
    if (response.queued === true && response.ok === undefined) { heartbeats += 1; return; }
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

  return { push, finish, stats: () => ({ pendingBytes, heartbeats, complete }) };
}
