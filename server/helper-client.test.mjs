import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createHelperClient } from "./helper-client.mjs";

/**
 * The client half of the boundary between the unprivileged web process and the root helper. It had
 * no tests at all, which for the one component that decides whether a root operation is believed
 * is the wrong number.
 */
const servers = [];
const directories = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A stand-in helper that replies however the test wants, over a real Unix socket. */
async function helper(respond) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-helper-"));
  directories.push(directory);
  const socketPath = path.join(directory, "helper.sock");
  const requests = [];
  const server = net.createServer((connection) => {
    let received = "";
    connection.on("data", (chunk) => {
      received += chunk.toString("utf8");
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(received.slice(0, newline));
      requests.push(request);
      respond(connection, request);
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { socketPath, requests };
}

describe("talking to the root helper", () => {
  it("sends the operation and resolves the result", async () => {
    const { socketPath, requests } = await helper((connection, request) => {
      connection.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: { done: true } })}\n`);
    });
    const client = createHelperClient({ socketPath });
    await expect(client.request("app.install", { id: "demo" }, { jobId: "job-1" })).resolves.toEqual({ done: true });
    expect(requests[0]).toMatchObject({ version: 1, operation: "app.install", parameters: { id: "demo" }, context: { jobId: "job-1" } });
    expect(requests[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("takes the final line, so heartbeats before the reply are ignored", async () => {
    const { socketPath } = await helper((connection, request) => {
      connection.write(`${JSON.stringify({ version: 1, id: request.id, queued: true })}\n`);
      connection.write(`${JSON.stringify({ version: 1, id: request.id, queued: true })}\n`);
      connection.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: { value: 7 } })}\n`);
    });
    await expect(createHelperClient({ socketPath }).request("noop")).resolves.toEqual({ value: 7 });
  });

  it("refuses a reply whose id does not match the request", async () => {
    // The id is the only thing tying an answer to the question asked. A mismatch means the reply
    // belongs to something else, and believing it would attribute one operation's result to another.
    const { socketPath } = await helper((connection) => {
      connection.end(`${JSON.stringify({ version: 1, id: "a-different-request", ok: true, result: { done: true } })}\n`);
    });
    await expect(createHelperClient({ socketPath }).request("noop")).rejects.toThrow("id did not match");
  });

  it("surfaces the helper's own error rather than a generic one", async () => {
    const { socketPath } = await helper((connection, request) => {
      connection.end(`${JSON.stringify({ version: 1, id: request.id, ok: false, error: "Docker is not installed" })}\n`);
    });
    await expect(createHelperClient({ socketPath }).request("noop")).rejects.toThrow("Docker is not installed");
  });

  it("fails rather than hangs when the helper closes without answering", async () => {
    const { socketPath } = await helper((connection) => connection.end());
    await expect(createHelperClient({ socketPath }).request("noop")).rejects.toThrow();
  });

  it("fails when the helper answers with something that is not JSON", async () => {
    const { socketPath } = await helper((connection) => connection.end("not json at all\n"));
    await expect(createHelperClient({ socketPath }).request("noop")).rejects.toThrow();
  });

  it("reports an unreachable socket as unavailable, not as a silent success", async () => {
    const client = createHelperClient({ socketPath: path.join(os.tmpdir(), "boxpilot-absent.sock") });
    await expect(client.request("noop")).rejects.toThrow(/Helper unavailable/);
  });

  it("gives up on a helper that accepts the connection and then says nothing", async () => {
    const { socketPath } = await helper(() => { /* accept, never reply */ });
    const client = createHelperClient({ socketPath, timeoutMs: 150 });
    await expect(client.request("noop")).rejects.toThrow(/timed out/);
  });
});
