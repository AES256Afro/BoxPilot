// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../../test/platform.mjs";
import { createGatewayClient, createGatewayServer } from "./socket.mjs";

/*
 * Both ends of the gateway's socket (M45.3), over a real Unix socket: one line asked, one answered,
 * a refusal arriving as an Error with its code, a gateway that is not there said plainly, and a
 * caller who goes away stopping the call it made. Needs a Unix socket path (Linux).
 */

const cleanup = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function serving(handle) {
  const directory = await mkdtemp(path.join(tmpdir(), "boxpilot-gateway-"));
  const socketPath = path.join(directory, "gateway.sock");
  const server = createGatewayServer({ gateway: { handle } });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)), () => rm(directory, { recursive: true, force: true }));
  return createGatewayClient({ socketPath });
}

describe.skipIf(onWindows)("the gateway's socket", () => {
  it("carries a chat request there and its answer back", async () => {
    const seen = [];
    const client = await serving(async (message) => { seen.push(message); return { version: 1, id: message.id, ok: true, result: { content: "68% full", toolCalls: [] } }; });
    expect(await client.chat({ model: "claude-opus-5-5", messages: [] }, { timeoutMs: 2_000 })).toEqual({ content: "68% full", toolCalls: [] });
    expect(seen[0]).toMatchObject({ version: 1, op: "chat", request: { model: "claude-opus-5-5" }, timeoutMs: 2_000 });
    expect(typeof seen[0].id).toBe("string");
  });

  it("turns a refusal into an Error with the gateway's code", async () => {
    const client = await serving(async (message) => ({ version: 1, id: message.id, ok: false, code: "budget", error: "This call could pass this month's cap", spentUsd: 9.9, capUsd: 10 }));
    await expect(client.chat({ model: "m", messages: [] })).rejects.toMatchObject({ code: "budget", spentUsd: 9.9, capUsd: 10, message: "This call could pass this month's cap" });
  });

  it("says the gateway is down when nothing answers on the socket", async () => {
    const client = createGatewayClient({ socketPath: path.join(tmpdir(), `boxpilot-nothing-${process.pid}.sock`) });
    await expect(client.status()).rejects.toMatchObject({ code: "gateway-down" });
  });

  it("stops the call its caller gave up on", async () => {
    let aborted = null;
    const client = await serving((message, { signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve({ version: 1, id: message.id, ok: false, code: "abandoned", error: "gone" }); });
    }));
    const controller = new AbortController();
    const asked = client.chat({ model: "m", messages: [] }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error("timeout"));
    await expect(asked).rejects.toThrow("timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aborted).toBe(true);
  });

  it("refuses a request that is not JSON", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "boxpilot-gateway-"));
    const socketPath = path.join(directory, "gateway.sock");
    const server = createGatewayServer({ gateway: { handle: async () => ({}) } });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    cleanup.push(() => new Promise((resolve) => server.close(resolve)), () => rm(directory, { recursive: true, force: true }));
    const net = await import("node:net");
    const answer = await new Promise((resolve) => {
      const connection = net.createConnection(socketPath, () => connection.write("not json\n"));
      let text = "";
      connection.setEncoding("utf8");
      connection.on("data", (chunk) => { text += chunk; });
      connection.on("end", () => resolve(JSON.parse(text)));
    });
    expect(answer).toMatchObject({ ok: false, code: "malformed" });
  });
});
