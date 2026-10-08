/**
 * The model gateway's socket, both ends (M45.3). One JSON line asked, one JSON line answered, over a
 * Unix socket only the web service's group may open, as the root helper's socket works without its
 * queue frames: a model call waits on nothing but the model.
 *
 * A caller that goes away (its socket closes) aborts the call it made, so Claude stops writing an
 * answer nobody will read.
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import { gatewayLimits } from "./terms.mjs";
import { defaultGatewaySocket } from "./paths.mjs";

export { defaultGatewaySocket };

/** Largest answer the client reads: a model's answer with its thinking blocks, well inside this. */
export const maxReplyBytes = 4 * 1024 * 1024;

/** The server side: `gateway.handle` for each request line. The caller listens. */
export function createGatewayServer({ gateway, maxRequestBytes = gatewayLimits.requestBytes }) {
  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    const abandoned = new AbortController();
    connection.once("close", () => abandoned.abort());
    connection.on("error", () => connection.destroy());
    connection.setEncoding("utf8");
    connection.setTimeout(gatewayLimits.timeoutMs + 30_000);
    const reply = (value) => { if (!connection.destroyed && connection.writable) connection.end(`${JSON.stringify(value)}\n`); else connection.destroy(); };
    let payload = "";
    let handled = false;

    async function respond() {
      if (handled) return;
      handled = true;
      let message;
      try {
        message = JSON.parse(payload);
      } catch {
        reply({ version: 1, id: null, ok: false, code: "malformed", error: "The request was not one JSON line" });
        return;
      }
      payload = "";
      reply(await gateway.handle(message, { signal: abandoned.signal }).catch(() => ({ version: 1, id: message?.id ?? null, ok: false, code: "error", error: "The gateway failed on this request" })));
    }

    connection.on("data", (chunk) => {
      if (handled) return;
      payload += chunk;
      if (Buffer.byteLength(payload, "utf8") > maxRequestBytes) {
        handled = true;
        reply({ version: 1, id: null, ok: false, code: "too-large", error: "The request is larger than the gateway takes" });
        return;
      }
      const end = payload.indexOf("\n");
      if (end >= 0) {
        payload = payload.slice(0, end);
        void respond();
      }
    });
    // The client keeps its side open until the answer; a close before then means it has gone.
    connection.on("end", () => { if (handled) abandoned.abort(); else void respond(); });
    connection.on("timeout", () => connection.destroy());
  });
  server.maxConnections = 16;
  return server;
}

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * The web service's side. `status()` resolves to the gateway's status; `chat(request)` to the
 * harness's ChatResult, or rejects with an Error whose `code` says why (the gateway's own codes,
 * Claude's, or `gateway-down` when nothing answers on the socket).
 */
export function createGatewayClient({ socketPath = process.env.BOXPILOT_MODEL_GATEWAY_SOCKET ?? defaultGatewaySocket, statusTimeoutMs = 5_000 } = {}) {
  function send(message, { signal, timeoutMs }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? failure("abandoned", "Stopped")); return; }
      const id = randomUUID();
      const connection = net.createConnection(socketPath);
      let settled = false;
      let text = "";
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", stop);
        connection.destroy();
        if (error) reject(error); else resolve(value);
      };
      const stop = () => finish(signal.reason ?? failure("abandoned", "Stopped"));
      const deadline = setTimeout(() => finish(failure("timeout", "The model gateway did not answer in time")), timeoutMs);
      deadline.unref?.();
      signal?.addEventListener("abort", stop, { once: true });
      connection.setEncoding("utf8");
      connection.on("connect", () => connection.write(`${JSON.stringify({ version: 1, id, ...message })}\n`));
      connection.on("data", (chunk) => {
        text += chunk;
        if (Buffer.byteLength(text, "utf8") > maxReplyBytes) { finish(failure("too-large", "The model gateway's answer was larger than allowed")); return; }
        const end = text.indexOf("\n");
        if (end < 0) return;
        let reply;
        try { reply = JSON.parse(text.slice(0, end)); } catch { finish(failure("malformed", "The model gateway's answer was not JSON")); return; }
        if (reply?.id !== id) { finish(failure("malformed", "The model gateway answered another request")); return; }
        if (reply.ok) finish(null, reply.result);
        else finish(failure(String(reply.code ?? "error"), String(reply.error ?? "The model gateway refused"), { ...(reply.status ? { status: reply.status } : {}), ...(reply.spentUsd !== undefined ? { spentUsd: reply.spentUsd, capUsd: reply.capUsd } : {}) }));
      });
      connection.on("end", () => finish(failure("gateway-down", "The model gateway closed without answering")));
      connection.on("error", (error) => finish(failure("gateway-down", `The model gateway is not answering (${error.code ?? error.message})`)));
    });
  }

  return {
    status: () => send({ op: "status" }, { timeoutMs: statusTimeoutMs }),
    check: () => send({ op: "check" }, { timeoutMs: 30_000 }),
    chat: (request, { signal, timeoutMs = gatewayLimits.defaultTimeoutMs } = {}) => send({ op: "chat", request, timeoutMs }, { signal, timeoutMs: timeoutMs + 15_000 }),
  };
}
