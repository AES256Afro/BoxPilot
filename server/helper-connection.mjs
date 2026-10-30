/**
 * One connection to the root helper's socket: read one newline-terminated JSON request (at most
 * `maxRequestBytes`), run it, and write the reply. Reads go through the concurrency gate; mutations
 * take an admission slot, wait in their lane (with queued/started frames so the web side's
 * deadlines follow), and are refused while the helper restarts or once the caller has gone.
 *
 * Moved out of helper-server.mjs, which builds every host service as it loads, so this part can be
 * tested against a real socket with stand-ins for the registry and the operations.
 */
import { helperErrorReply, helperQueuedFrame, helperStartedFrame } from "./helper-response.mjs";
import { laneFor } from "./helper-lanes.mjs";
import { restartRefusalError } from "./self-restart.mjs";
import { whileHoldingRootTasks } from "./run-unit.mjs";

/**
 * @param {{
 *   registry: { budgetFor: (operation: string, budgetMs: number | null) => number | null },
 *   readOnlyOperations: Set<string>,
 *   execute: (request: any) => Promise<any>,
 *   lanes: any, reads: any, mutations: { enter: () => () => void },
 *   waiting: Set<{ refused: boolean, refuse: (refusal?: any) => void }>,
 *   isRestarting: () => boolean,
 *   idleGraceMs?: number, maxRequestBytes?: number, queuedHeartbeatMs?: number, initialTimeoutMs?: number,
 *   holdRootTasks?: typeof whileHoldingRootTasks,
 * }} options
 */
export function createHelperConnectionHandler({
  registry, readOnlyOperations, execute, lanes, reads, mutations, waiting, isRestarting,
  idleGraceMs = 30_000, maxRequestBytes = 128 * 1024, queuedHeartbeatMs = 20_000, initialTimeoutMs = 180_000,
  holdRootTasks = whileHoldingRootTasks,
}) {
  /** @param {import("node:net").Socket} connection */
  return function handleConnection(connection) {
    const abandoned = new AbortController();
    connection.once("close", () => abandoned.abort());
    // The web side destroys its socket when a request times out or the service restarts. Writing the
    // reply then raises EPIPE, and an unhandled 'error' here would take the root helper down mid-operation.
    connection.on("error", () => connection.destroy());
    /** Send a reply only if the peer is still there. */
    const reply = (payload) => { if (!connection.destroyed && connection.writable) connection.end(`${JSON.stringify(payload)}\n`); else connection.destroy(); };
    connection.setEncoding("utf8");
    connection.setTimeout(initialTimeoutMs);
    let payload = "";
    let handled = false;

    async function respond() {
      if (handled) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(payload);
        payload = "";
      } catch {
        reply({ version: 1, id: null, ok: false, error: "Malformed JSON request", code: "malformed_json" });
        return;
      }
      try {
        // The budget this request runs under: the operation's own, or a larger one a job was given
        // with "Try again with more time" (the protocol validator checks it against the registry).
        // The idle limit sits a little past it, so the web side's deadline - the one that records the
        // timeout on the job - is the one that fires, and this stays the backstop for a dead peer.
        const budget = registry.budgetFor(request.operation, request.context?.budgetMs ?? null);
        const registeredTimeout = budget ? budget + idleGraceMs : null;
        if (registeredTimeout) connection.setTimeout(registeredTimeout);
        let result;
        if (readOnlyOperations.has(request.operation)) {
          result = await reads.run(() => execute(request), { signal: abandoned.signal });
        } else {
          if (isRestarting()) throw restartRefusalError();
          const admitted = mutations.enter();
          // Left on every path out, a throw before the lane included: a slot that leaks is one fewer for good.
          try {
            const held = laneFor(request.operation, request.parameters);
            // Waiting behind another operation must not look like a hung request: a heartbeat line keeps
            // both idle timers alive; the client reads those lines as progress, not as the reply.
            let heartbeat = null;
            // Anything can be held up by the exclusive lane, and an exclusive request waits for every lane.
            const willWait = lanes.busy(held);
            const frame = (value) => { if (!connection.destroyed && connection.writable) connection.write(`${JSON.stringify(value)}\n`); };
            if (willWait) {
              // Say so at once: the client holds a queued request to its queue ceiling rather than the
              // operation's own budget, which starts only when the "started" frame below arrives.
              frame(helperQueuedFrame(request?.id ?? null, held.join("+")));
              heartbeat = setInterval(() => frame(helperQueuedFrame(request?.id ?? null, held.join("+"))), queuedHeartbeatMs);
              heartbeat.unref?.();
            }
            // While it waits, a stop of the helper (a drained self-restart holds every lane until then)
            // answers it at once with nothing done, rather than holding the stop until systemd kills it.
            const queued = { refused: false, refuse: (refusal = restartRefusalError("BoxPilot's helper restarted before this began, so nothing was changed. Run it again.")) => { queued.refused = true; if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } reply(helperErrorReply(request?.id ?? null, refusal)); } };
            waiting.add(queued);
            try {
              result = await lanes.run(held, async (holdUntil) => {
                waiting.delete(queued);
                if (queued.refused) throw new Error("The helper stopped before this request began");
                // The web side gave up while this waited: running it now would change the host with no job watching.
                // allowHalfOpen keeps `destroyed` false after the peer's FIN, so check the read side too.
                if (connection.destroyed || connection.readableEnded) throw new Error("The request was abandoned while it waited for an earlier operation on this subject");
                if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
                if (registeredTimeout) connection.setTimeout(registeredTimeout); // the operation's own budget starts now
                if (willWait) frame(helperStartedFrame(request.id)); // ...and the client's deadline restarts with it
                // A root task it leaves running past its own limit keeps these lanes until its unit stops.
                return holdRootTasks(holdUntil, () => execute(request));
              });
            } finally {
              waiting.delete(queued);
              if (heartbeat) clearInterval(heartbeat);
            }
          } finally {
            admitted();
          }
        }
        reply(result);
      } catch (error) {
        // A step that ran out of its own time, and whether a rollback worked, go in fields.
        reply(helperErrorReply(request?.id ?? null, error));
      }
    }

    connection.on("data", (chunk) => {
      if (handled) return;
      payload += chunk;
      if (Buffer.byteLength(payload, "utf8") > maxRequestBytes) {
        handled = true;
        reply({ version: 1, id: null, ok: false, error: "Request is too large", code: "request_too_large" });
        return;
      }
      if (payload.includes("\n")) {
        payload = payload.slice(0, payload.indexOf("\n"));
        void respond();
      }
    });
    connection.on("end", () => {
      // Official clients keep the request side open until the reply. A FIN after submission
      // means that caller has gone; release a queued read before it starts expensive host work.
      if (handled) abandoned.abort();
      else void respond();
    });
    connection.on("timeout", () => connection.destroy());
  };
}
