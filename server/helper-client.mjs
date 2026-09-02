import { randomUUID } from "node:crypto";
import net from "node:net";
import { shared } from "./cache.mjs";

/**
 * Reads that several routes ask for at once, and that take no arguments so one answer serves them
 * all. Anything that changes the host is absent by design: two identical mutations arriving
 * together are two requests, not one.
 */
const sharableReads = new Set([
  "app.inspect", "samba.inspect", "container.docker.inventory", "app.data.usage",
  // The rest of what one Overview or Repair load asks for from several routes at once.
  "apt.unattended.inspect", "firewall.inspect", "nfs.inspect", "host.snapshot.inspect", "app.backups.counts",
  "prerequisite.docker.inspect", "prerequisite.restic.inspect", "prerequisite.smartmontools.inspect", "prerequisite.virtualization.inspect",
  "virtualization.foundation.inspect",
]);

/**
 * How long a shared read is allowed underneath. Callers keep their own deadlines (below), so this
 * only has to be at least as long as the longest any of them asks for - it is the ceiling, not the
 * wait. Thirty seconds is what the slowest caller in the codebase asks for.
 */
const sharedReadCeilingMs = 30_000;

export function createHelperClient({ socketPath = process.env.BOXPILOT_HELPER_SOCKET ?? "/run/boxpilot/helper.sock", timeoutMs = 5000 } = {}) {
  function send(operation, parameters = {}, { timeoutMs: requestTimeoutMs = timeoutMs, jobId = null } = {}) {
    return new Promise((resolve, reject) => {
      const connection = net.createConnection(socketPath);
      const id = randomUUID();
      let payload = "";
      let settled = false;

      function fail(error) {
        if (settled) return;
        settled = true;
        connection.destroy();
        reject(error);
      }

      connection.setEncoding("utf8");
      connection.setTimeout(requestTimeoutMs);
      connection.on("connect", () => connection.write(`${JSON.stringify({ version: 1, id, operation, parameters, ...(jobId ? { context: { jobId } } : {}) })}\n`));
      connection.on("data", (chunk) => { payload += chunk; });
      connection.on("end", () => {
        if (settled) return;
        try {
          // The helper may send "queued" heartbeat lines first; the reply is the last complete line.
          const lines = payload.split("\n").map((line) => line.trim()).filter(Boolean);
          const response = JSON.parse(lines.at(-1) ?? "");
          if (response.id !== id) throw new Error("Helper response id did not match the request");
          if (!response.ok) throw new Error(response.error ?? "Helper operation failed");
          settled = true;
          resolve(response.result);
        } catch (error) {
          fail(error);
        }
      });
      connection.on("timeout", () => fail(new Error("Helper request timed out")));
      connection.on("error", (error) => fail(new Error(`Helper unavailable: ${error.message}`)));
    });
  }

  // A page load asks several routes for the same read at the same time: the Repair centre alone
  // wants the container list for its own findings, for the catalog, and for the setup checklist.
  // Those are one question, so they get one round trip. Only reads are shared, and only while a
  // call is actually in flight — the moment one settles the next caller starts a fresh one, so
  // nobody is ever handed a container list from before the install they just ran.
  const sharedReads = new Map();
  function request(operation, parameters = {}, options = {}) {
    const { timeoutMs: requestTimeoutMs = timeoutMs, jobId = null } = options;
    // Only an argument-free read with no job attached is shared.
    if (!sharableReads.has(operation) || jobId || Object.keys(parameters).length) return send(operation, parameters, options);
    // One round trip per operation, whatever deadlines the callers brought. The first version keyed
    // this on the timeout as well, so that nobody would wait past their own deadline - and since the
    // routes ask with 15 and 30 seconds, the one Overview load ran app.inspect twice, which is the
    // duplicate this exists to remove. Instead the read underneath runs to a ceiling long enough for
    // everyone, and each caller races it against the deadline they actually asked for: a 15-second
    // caller is told "timed out" at 15 seconds while the 30-second caller alongside still gets the
    // answer. Nobody waits longer than they allowed; nobody is failed earlier.
    if (!sharedReads.has(operation)) sharedReads.set(operation, shared(() => send(operation, {}, { timeoutMs: Math.max(sharedReadCeilingMs, requestTimeoutMs) })));
    const underlying = sharedReads.get(operation)();
    if (requestTimeoutMs >= sharedReadCeilingMs) return underlying;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Helper request timed out")), requestTimeoutMs);
      timer.unref?.();
      underlying.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  return { socketPath, request };
}
