import { randomUUID } from "node:crypto";
import net from "node:net";
import { shared } from "./cache.mjs";
import { createHelperResponseReader, maxHelperResponseBytes } from "./helper-response.mjs";

/**
 * Reads that several routes ask for at once, and that take no arguments so one answer serves them
 * all. Anything that changes the host is absent by design: two identical mutations arriving
 * together are two requests, not one.
 */
const sharableReads = new Set([
  "housekeeping.inspect", "app.stats.inspect", "system.performance.inspect",
  "apt.health.inspect", "system.controller.inspect", "controller.database.inspect",
  "system.runtime.inspect", "app.inspect", "samba.inspect", "container.docker.inventory", "app.data.usage",
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

export function createHelperClient({ socketPath = process.env.BOXPILOT_HELPER_SOCKET ?? "/run/boxpilot/helper.sock", timeoutMs = 5000, maxResponseBytes = maxHelperResponseBytes, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  const transport = { active: 0, completed: 0, failed: 0 };
  function send(operation, parameters = {}, { timeoutMs: requestTimeoutMs = timeoutMs, jobId = null } = {}) {
    return new Promise((resolve, reject) => {
      const connection = net.createConnection(socketPath);
      transport.active += 1;
      const id = randomUUID();
      const reader = createHelperResponseReader(id, { maxFrameBytes: maxResponseBytes });
      let settled = false;

      function fail(error) {
        if (settled) return;
        settled = true;
        transport.active -= 1; transport.failed += 1;
        cancel(deadline);
        connection.destroy();
        reject(error);
      }

      // Unlike the socket inactivity timeout, this cannot be extended forever by queued heartbeats.
      const deadline = schedule(() => fail(new Error("Helper request timed out (overall deadline reached)")), requestTimeoutMs);
      deadline.unref?.();
      connection.setEncoding("utf8");
      connection.setTimeout(requestTimeoutMs);
      connection.on("connect", () => connection.write(`${JSON.stringify({ version: 1, id, operation, parameters, ...(jobId ? { context: { jobId } } : {}) })}\n`));
      connection.on("data", (chunk) => { if (!settled) { try { reader.push(chunk); } catch (error) { fail(error); } } });
      connection.on("end", () => {
        if (settled) return;
        try {
          const result = reader.finish();
          settled = true;
          transport.active -= 1; transport.completed += 1;
          cancel(deadline);
          resolve(result);
        } catch (error) {
          fail(error);
        }
      });
      connection.on("timeout", () => fail(new Error("Helper request timed out")));
      connection.on("error", (error) => fail(new Error(`Helper unavailable: ${error.message}`)));
      connection.on("close", () => { if (!settled) fail(new Error("Helper connection closed before sending a result")); });
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
    // The ceiling is decided by whoever STARTS each read, not by whoever first asked in the life of
    // the process: the first version closed over that first caller's timeout for good, so a
    // 15-second checklist read arriving before a 60-second Backups read pinned the snapshot listing
    // to 30 seconds forever - and the reverse order made a later 30-second caller wait 60. What
    // remains, and is documented rather than hidden: a caller who joins a read already in flight
    // shares its ceiling, so a longer deadline than the read's can still be cut short by it.
    if (!sharedReads.has(operation)) sharedReads.set(operation, shared((ceilingMs) => send(operation, {}, { timeoutMs: ceilingMs })));
    const underlying = sharedReads.get(operation)(Math.max(sharedReadCeilingMs, requestTimeoutMs));
    // Every caller races the read against its own deadline - including the long ones, who were
    // previously handed the read itself and so inherited whatever ceiling it happened to have.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Helper request timed out")), requestTimeoutMs);
      timer.unref?.();
      underlying.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  function invalidate(operations) {
    for (const operation of operations) sharedReads.get(operation)?.forget();
  }
  return { socketPath, request, invalidate, diagnostics: () => ({ ...transport, sharedReads: Object.fromEntries([...sharedReads].map(([operation, read]) => [operation, read.stats()])) }) };
}
