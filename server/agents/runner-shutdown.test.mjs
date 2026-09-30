// @vitest-environment node
/**
 * The runner's shutdown signal lives as long as the process (runner-main.mjs), and the runner used
 * to add a listener to it for every run and every back-off sleep without taking it off. Each run's
 * listener kept that run's claim and outputs alive, a describe run's images included, so the capped
 * runner grew until the kernel's MemoryMax stopped it mid-run (reliability audit, 2026-09-29).
 */
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { createRunner } from "./runner.mjs";

const claim = (id) => ({
  run: { id, kind: "index", deadlineAt: new Date(Date.now() + 60_000).toISOString() },
  lease: `lease-${id}`,
  limits: { heartbeatMs: 60_000, remainingModelMs: 60_000 },
  runtime: {},
  index: { items: [] },
});

describe("the runner and the process's shutdown signal", () => {
  it("takes each run's listener off the signal when the run ends", async () => {
    const finished = [];
    const api = { finish: async (id) => { finished.push(id); return null; }, steps: async () => null, heartbeat: async () => null };
    const runtime = { ensure: async () => ({ endpoint: "http://127.0.0.1:1", model: "m", loadMs: 0 }), status: () => ({ state: "idle" }), touch: () => {} };
    const runner = createRunner({ api, runtime, client: {} });
    const shutdown = new AbortController();
    for (let index = 0; index < 25; index += 1) await runner.execute(claim(`run-${index}`), { signal: shutdown.signal });
    expect(finished).toHaveLength(25);
    expect(getEventListeners(shutdown.signal, "abort")).toHaveLength(0);
  });

  it("takes each back-off sleep's listener off too, and still stops at once when told to", async () => {
    let calls = 0;
    const shutdown = new AbortController();
    // BoxPilot unreachable: every poll fails, and the loop backs off between them.
    const api = {
      hello: async () => { calls += 1; if (calls >= 6) shutdown.abort(); throw new Error("connect ECONNREFUSED 127.0.0.1:8787"); },
      next: async () => null,
    };
    const runtime = { status: () => ({ state: "idle" }), maybeStopIdle: async () => {}, stop: async () => {} };
    const listeners = [];
    const runner = createRunner({ api, runtime, client: {}, options: { backoffMs: [1] } });
    const looping = runner.loop({ signal: shutdown.signal });
    const watch = setInterval(() => listeners.push(getEventListeners(shutdown.signal, "abort").length), 0);
    await looping;
    clearInterval(watch);
    expect(calls).toBe(6);
    expect(Math.max(0, ...listeners)).toBeLessThanOrEqual(1);
    expect(getEventListeners(shutdown.signal, "abort")).toHaveLength(0);
  });
});
