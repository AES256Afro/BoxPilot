import { randomUUID } from "node:crypto";
import net from "node:net";
import { shared } from "./cache.mjs";
import { createHelperResponseReader, maxHelperResponseBytes } from "./helper-response.mjs";
import { timedOut } from "./timeouts.mjs";

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
  "prerequisite.docker.inspect", "prerequisite.restic.inspect", "prerequisite.smartmontools.inspect", "prerequisite.drive-tools.inspect", "prerequisite.virtualization.inspect", "prerequisite.nvidia.inspect",
  "virtualization.foundation.inspect",
]);

/**
 * How long a shared read is allowed underneath. Callers keep their own deadlines (below), so this
 * only has to be at least as long as the longest any of them asks for - it is the ceiling, not the
 * wait. Thirty seconds is what the slowest caller in the codebase asks for.
 */
const sharedReadCeilingMs = 30_000;

/**
 * How long a mutation may wait in the helper's queue behind earlier work on its lane before the
 * web side gives up. The longest registered operations run for twelve hours, so a request queued
 * behind one of those must not be failed by its own (much shorter) budget.
 */
export const queuedCeilingMs = 24 * 60 * 60_000;

export function createHelperClient({ socketPath = process.env.BOXPILOT_HELPER_SOCKET ?? "/run/boxpilot/helper.sock", timeoutMs = 5000, queueTimeoutMs = queuedCeilingMs, maxResponseBytes = maxHelperResponseBytes, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  const transport = { active: 0, completed: 0, failed: 0 };
  // onQueued and onStarted tell the caller, once each, that the request is waiting behind other
  // work and that it has left the queue: a job says so, and a flow's step counts its time from then.
  function send(operation, parameters = {}, { timeoutMs: requestTimeoutMs = timeoutMs, jobId = null, budgetMs = null, onQueued = null, onStarted = null } = {}) {
    return new Promise((resolve, reject) => {
      const connection = net.createConnection(socketPath);
      transport.active += 1;
      const id = randomUUID();
      let settled = false;
      let deadline = null;
      let queued = false;
      let started = false;

      function fail(error) {
        if (settled) return;
        settled = true;
        transport.active -= 1; transport.failed += 1;
        cancel(deadline);
        connection.destroy();
        reject(error);
      }

      /**
       * Replace the overall deadline. Unlike the socket inactivity timeout, heartbeats never extend it.
       * Running out is a timeout the job record keeps (M30.3): which budget, and whether the request
       * was still queued behind other work or already running.
       */
      function arm(ms, message) {
        if (deadline !== null) cancel(deadline);
        deadline = schedule(() => fail(ranOut(message, ms)), ms);
        deadline.unref?.();
      }
      const ranOut = (message, ms) => timedOut(message, { scope: "operation", budgetMs: ms, ...(queued && !started ? { phase: "queued" } : {}) });
      const notify = (callback) => { try { callback?.(); } catch { /* the request's own outcome stands */ } };
      // The operation's budget is measured from when the helper starts it. A request the helper says
      // is queued behind earlier work waits under the queue ceiling instead, and gets its full budget
      // back when the helper reports that it left the queue.
      const reader = createHelperResponseReader(id, {
        maxFrameBytes: maxResponseBytes,
        onQueued: () => {
          if (queued || started) return;
          queued = true;
          arm(queueTimeoutMs, "Helper request timed out while queued behind earlier operations (overall deadline reached)");
          // Heartbeats arrive every 20 seconds; a short budget must not read the queue as a dead peer.
          connection.setTimeout(Math.max(requestTimeoutMs, 60_000));
          notify(onQueued);
        },
        onStarted: () => {
          started = true;
          arm(requestTimeoutMs, "Helper request timed out (overall deadline reached)");
          connection.setTimeout(requestTimeoutMs);
          notify(onStarted);
        },
      });
      arm(requestTimeoutMs, "Helper request timed out (overall deadline reached)");
      connection.setEncoding("utf8");
      connection.setTimeout(requestTimeoutMs);
      // budgetMs goes only with a job given more time: an older helper refuses any context key but
      // jobId, and every other request must keep working against it for a release.
      const context = { ...(jobId ? { jobId } : {}), ...(Number.isInteger(budgetMs) ? { budgetMs } : {}) };
      connection.on("connect", () => connection.write(`${JSON.stringify({ version: 1, id, operation, parameters, ...(Object.keys(context).length ? { context } : {}) })}\n`));
      function succeed() {
        if (settled) return;
        try {
          const result = reader.finish();
          settled = true;
          transport.active -= 1; transport.completed += 1;
          cancel(deadline);
          connection.destroy();
          resolve(result);
        } catch (error) {
          fail(error);
        }
      }
      // The reply is whole once its line has arrived. The socket's end can follow later under load,
      // and a deadline between the two reported a finished operation as a timeout.
      connection.on("data", (chunk) => { if (!settled) { try { reader.push(chunk); if (reader.stats().complete) succeed(); } catch (error) { fail(error); } } });
      connection.on("end", succeed);
      // Nothing heard for the whole budget: the same timeout, reached through the idle timer.
      connection.on("timeout", () => fail(ranOut("Helper request timed out", connection.timeout ?? requestTimeoutMs)));
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
      const timer = setTimeout(() => reject(timedOut("Helper request timed out", { scope: "operation", budgetMs: requestTimeoutMs })), requestTimeoutMs);
      timer.unref?.();
      underlying.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  function invalidate(operations) {
    for (const operation of operations) sharedReads.get(operation)?.forget();
  }
  return { socketPath, request, invalidate, diagnostics: () => ({ ...transport, sharedReads: Object.fromEntries([...sharedReads].map(([operation, read]) => [operation, read.stats()])) }) };
}
