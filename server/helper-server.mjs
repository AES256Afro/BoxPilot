import { chmod, mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { executeHelperOperation } from "./helper-protocol.mjs";

const socketPath = process.env.BOXPILOT_HELPER_SOCKET ?? "/run/boxpilot/helper.sock";
const maxRequestBytes = 8192;
let operationQueue = Promise.resolve();

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
await unlink(socketPath).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});

const server = net.createServer({ allowHalfOpen: true }, (connection) => {
  connection.setEncoding("utf8");
  connection.setTimeout(180000);
  let payload = "";
  let handled = false;

  async function respond() {
    if (handled) return;
    handled = true;
    let request;
    try {
      request = JSON.parse(payload);
    } catch {
      connection.end(`${JSON.stringify({ version: 1, id: null, ok: false, error: "Malformed JSON request", code: "malformed_json" })}\n`);
      return;
    }
    try {
      const execution = operationQueue.then(() => executeHelperOperation(request));
      operationQueue = execution.catch(() => {});
      connection.end(`${JSON.stringify(await execution)}\n`);
    } catch (error) {
      connection.end(`${JSON.stringify({ version: 1, id: request?.id ?? null, ok: false, error: error.message, code: "operation_failed" })}\n`);
    }
  }

  connection.on("data", (chunk) => {
    payload += chunk;
    if (Buffer.byteLength(payload, "utf8") > maxRequestBytes) {
      handled = true;
      connection.end(`${JSON.stringify({ version: 1, id: null, ok: false, error: "Request is too large", code: "request_too_large" })}\n`);
      return;
    }
    if (payload.includes("\n")) {
      payload = payload.slice(0, payload.indexOf("\n"));
      void respond();
    }
  });
  connection.on("end", () => void respond());
  connection.on("timeout", () => connection.destroy());
});

server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660);
  console.log(`BoxPilot helper 0.3.0 listening on ${socketPath}`);
});

async function shutdown() {
  server.close(async () => {
    await unlink(socketPath).catch(() => {});
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
