import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHelperClient } from "./helper-client.mjs";

let server = null; let dir = null;

/** A helper socket that answers on command, so overlapping requests are deterministic. */
async function helperSocket(handler) {
  dir = mkdtempSync(path.join(tmpdir(), "boxpilot-helper-"));
  const socketPath = path.join(dir, "helper.sock");
  server = net.createServer((connection) => {
    let payload = "";
    connection.setEncoding("utf8");
    connection.on("data", async (chunk) => {
      payload += chunk;
      if (!payload.includes("\n")) return;
      const request = JSON.parse(payload.trim());
      const result = await handler(request);
      connection.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

// closeAllConnections as well as close: the client's sockets would otherwise keep the server (and
// its unix socket path) alive past the test that owns them.
afterEach(() => { server?.closeAllConnections?.(); server?.close(); server = null; if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe("sharing helper reads", () => {
  it("answers concurrent identical reads from one round trip", async () => {
    let calls = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const socketPath = await helperSocket(async () => { calls += 1; await held; return { applications: [] }; });
    const client = createHelperClient({ socketPath });
    const all = Promise.all([
      client.request("app.inspect", {}, { timeoutMs: 5000 }),
      client.request("app.inspect", {}, { timeoutMs: 5000 }),
      client.request("app.inspect", {}, { timeoutMs: 5000 }),
    ]);
    release();
    expect(await all).toEqual([{ applications: [] }, { applications: [] }, { applications: [] }]);
    expect(calls).toBe(1);
  });

  it("reads fresh once the previous read has finished", async () => {
    let calls = 0;
    const socketPath = await helperSocket(async () => { calls += 1; return { calls }; });
    const client = createHelperClient({ socketPath });
    expect(await client.request("app.inspect")).toEqual({ calls: 1 });
    expect(await client.request("app.inspect")).toEqual({ calls: 2 });
  });

  it("shares one round trip across callers with different deadlines", async () => {
    // The routes ask for app.inspect with 15 and with 30 seconds. Keying on the deadline as well
    // meant one page load made the read twice - the exact duplicate this exists to remove.
    let calls = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const socketPath = await helperSocket(async () => { calls += 1; await held; return { calls }; });
    const client = createHelperClient({ socketPath });
    const all = Promise.all([
      client.request("app.inspect", {}, { timeoutMs: 15_000 }),
      client.request("app.inspect", {}, { timeoutMs: 30_000 }),
    ]);
    release();
    expect(await all).toEqual([{ calls: 1 }, { calls: 1 }]);
    expect(calls).toBe(1);
  });

  it("still holds each caller to the deadline it asked for", async () => {
    // Sharing must not mean the short-deadline caller waits for the long one. It is told "timed
    // out" on its own clock; the other caller, still inside its allowance, gets the answer.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const socketPath = await helperSocket(async () => { await held; return { slow: true }; });
    const client = createHelperClient({ socketPath });
    const impatient = client.request("app.inspect", {}, { timeoutMs: 40 });
    const patient = client.request("app.inspect", {}, { timeoutMs: 30_000 });
    await expect(impatient).rejects.toThrow("Helper request timed out");
    release();
    await expect(patient).resolves.toEqual({ slow: true });
  });

  it("never shares a write", async () => {
    let calls = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const socketPath = await helperSocket(async () => { calls += 1; await held; return { ok: true }; });
    const client = createHelperClient({ socketPath });
    const all = Promise.all([client.request("app.deploy", {}), client.request("app.deploy", {})]);
    release();
    await all;
    expect(calls).toBe(2);
  });

  it("never shares a read that carries different arguments", async () => {
    let calls = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const socketPath = await helperSocket(async () => { calls += 1; await held; return { ok: true }; });
    const client = createHelperClient({ socketPath });
    const all = Promise.all([client.request("app.inspect", { id: "a" }), client.request("app.inspect", { id: "b" })]);
    release();
    await all;
    expect(calls).toBe(2);
  });

  it("never shares a read that belongs to a job, because its progress is reported to that job", async () => {
    let calls = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const socketPath = await helperSocket(async () => { calls += 1; await held; return { ok: true }; });
    const client = createHelperClient({ socketPath });
    const all = Promise.all([
      client.request("app.inspect", {}, { jobId: "one" }),
      client.request("app.inspect", {}, { jobId: "two" }),
    ]);
    release();
    await all;
    expect(calls).toBe(2);
  });
});


describe("deadlines on shared reads", () => {
  it("holds every caller to its own deadline, however long", async () => {
    // Callers with a long deadline used to be handed the underlying read itself, so they inherited
    // whatever ceiling it had. Now each one races it against its own clock.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const socketPath = await helperSocket(async () => { await held; return { late: true }; });
    const client = createHelperClient({ socketPath });
    const quick = client.request("app.inspect", {}, { timeoutMs: 40 });
    const longer = client.request("app.inspect", {}, { timeoutMs: 45_000 });
    await expect(quick).rejects.toThrow("Helper request timed out");
    release();
    await expect(longer).resolves.toEqual({ late: true });
  });

  it("lets a later read choose its own ceiling rather than inheriting the first caller's", async () => {
    // First read: a 15-second caller. Second read (after the first settled): a 60-second caller.
    // The second must not be cut to the first's ceiling - observable here as the second caller
    // still being served after the first's would-be deadline has passed.
    const answers = [];
    const socketPath = await helperSocket(async () => { const n = answers.push(Date.now()); return { n }; });
    const client = createHelperClient({ socketPath });
    expect(await client.request("app.inspect", {}, { timeoutMs: 15_000 })).toEqual({ n: 1 });
    expect(await client.request("app.inspect", {}, { timeoutMs: 60_000 })).toEqual({ n: 2 });
    expect(answers).toHaveLength(2);
  });
});
