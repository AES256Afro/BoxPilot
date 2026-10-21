import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { createHelperConnectionHandler } from "./helper-connection.mjs";
import { createAdmission, createConcurrencyGate, createLaneQueues } from "./helper-lanes.mjs";

const cleanup = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/** A helper socket served by the real handler, with stand-ins for the registry and the operations. */
async function helper({ execute = async (request) => ({ version: 1, id: request.id, ok: true, result: { ran: request.operation } }), readOnly = ["thing.inspect"], admission = 64, restarting = () => false, maxRequestBytes = 1024 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-helper-conn-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, "helper.sock");
  const waiting = new Set();
  const run = vi.fn(execute);
  const handle = createHelperConnectionHandler({
    registry: { budgetFor: () => null }, readOnlyOperations: new Set(readOnly), execute: run,
    lanes: createLaneQueues(), reads: createConcurrencyGate(2), mutations: createAdmission(admission), waiting,
    isRestarting: restarting, maxRequestBytes, queuedHeartbeatMs: 60_000, holdRootTasks: (_hold, work) => work(),
  });
  // Counts the hang-ups the server has seen, so a test can wait for one instead of sleeping.
  const hangUps = { count: 0 };
  const server = net.createServer({ allowHalfOpen: true }, (socket) => { socket.on("end", () => { hangUps.count += 1; }); handle(socket); });
  await new Promise((resolve) => server.listen(socketPath, () => resolve(undefined)));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  return { socketPath, run, waiting, hangUps };
}

/** Send one request line; resolve with every frame the helper wrote, once it closes. `hangUp` sends FIN right after. */
function ask(socketPath, request, { raw = null, hangUp = false, onFrame = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      for (const line of chunk.split("\n").filter(Boolean)) { try { onFrame(JSON.parse(line), socket); } catch { /* partial */ } }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(text.split("\n").filter(Boolean).map((line) => JSON.parse(line))));
    socket.write(raw ?? `${JSON.stringify(request)}\n`);
    if (hangUp) socket.end();
  });
}

const deferred = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
const request = (id, operation = "job.output.release", parameters = {}) => ({ version: 1, id, operation, parameters });

describe.skipIf(onWindows)("a connection to the root helper", () => {
  it("answers a malformed request and one that is too large without running anything", async () => {
    const { socketPath, run } = await helper();
    expect(await ask(socketPath, null, { raw: "{not json\n" })).toEqual([{ version: 1, id: null, ok: false, error: "Malformed JSON request", code: "malformed_json" }]);
    expect(await ask(socketPath, null, { raw: `${"x".repeat(2048)}\n` })).toEqual([{ version: 1, id: null, ok: false, error: "Request is too large", code: "request_too_large" }]);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a read and a mutation and replies with what they return", async () => {
    const { socketPath, run } = await helper();
    expect(await ask(socketPath, request("r1", "thing.inspect"))).toEqual([{ version: 1, id: "r1", ok: true, result: { ran: "thing.inspect" } }]);
    expect(await ask(socketPath, request("m1"))).toEqual([{ version: 1, id: "m1", ok: true, result: { ran: "job.output.release" } }]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("turns a thrown error into an error reply, keeping a rollback verdict", async () => {
    const { socketPath } = await helper({ execute: async () => { throw Object.assign(new Error("it broke"), { rolledBack: true }); } });
    expect(await ask(socketPath, request("m1"))).toEqual([{ version: 1, id: "m1", ok: false, error: "it broke", code: "operation_failed", rolledBack: true }]);
  });

  it("says a mutation is queued behind another on its lane, then that it started, then replies", async () => {
    const first = deferred();
    const { socketPath, run } = await helper({ execute: async (sent) => { if (sent.id === "m1") await first.promise; return { version: 1, id: sent.id, ok: true }; } });
    const one = ask(socketPath, request("m1"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const two = ask(socketPath, request("m2"), { onFrame: (frame) => { if (frame.queued) first.release(); } });
    expect(await two).toEqual([{ version: 1, id: "m2", queued: true, lane: "job-output" }, { version: 1, id: "m2", started: true }, { version: 1, id: "m2", ok: true }]);
    expect(await one).toEqual([{ version: 1, id: "m1", ok: true }]);
  });

  it("never runs a mutation whose caller hung up while it waited", async () => {
    const first = deferred();
    const { socketPath, run, hangUps } = await helper({ execute: async (sent) => { if (sent.id === "m1") await first.promise; return { version: 1, id: sent.id, ok: true }; } });
    const one = ask(socketPath, request("m1"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const gone = ask(socketPath, request("m2"), { onFrame: (frame, socket) => { if (frame.queued) { socket.end(); void vi.waitFor(() => expect(hangUps.count).toBe(1)).then(() => first.release()); } } });
    await one;
    const frames = await gone;
    expect(frames.at(-1)).toMatchObject({ id: "m2", ok: false, error: expect.stringContaining("abandoned") });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses mutations while the helper restarts, and when every admission slot is held", async () => {
    let restarting = true;
    const held = deferred();
    const { socketPath, run } = await helper({ restarting: () => restarting, admission: 1, execute: async (sent) => { if (sent.id === "slow") await held.promise; return { version: 1, id: sent.id, ok: true }; } });
    expect(await ask(socketPath, request("m1"))).toEqual([expect.objectContaining({ id: "m1", ok: false, code: "helper_restarting" })]);
    // Reads still run while it restarts.
    expect(await ask(socketPath, request("r1", "thing.inspect"))).toEqual([{ version: 1, id: "r1", ok: true }]);
    restarting = false;
    const slow = ask(socketPath, request("slow", "job.output.release"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(await ask(socketPath, request("busy", "agents.runtime.cpu"))).toEqual([expect.objectContaining({ id: "busy", ok: false, error: expect.stringContaining("already running or waiting") })]);
    held.release();
    await slow;
    // The slot comes back once the mutation is done.
    expect(await ask(socketPath, request("after", "agents.runtime.cpu"))).toEqual([{ version: 1, id: "after", ok: true }]);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("lets a stop of the helper answer a waiting mutation at once, with nothing done", async () => {
    const first = deferred();
    const { socketPath, run, waiting } = await helper({ execute: async (sent) => { if (sent.id === "m1") await first.promise; return { version: 1, id: sent.id, ok: true }; } });
    const one = ask(socketPath, request("m1"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const two = ask(socketPath, request("m2"));
    await vi.waitFor(() => expect(waiting.size).toBe(1));
    for (const queued of waiting) queued.refuse();
    const frames = await two;
    expect(frames.at(-1)).toMatchObject({ id: "m2", ok: false, code: "helper_restarting" });
    first.release();
    await one;
    expect(run).toHaveBeenCalledTimes(1);
  });
});
