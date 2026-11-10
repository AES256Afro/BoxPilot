// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createLoopLog, logged, loopLogLimits } from "./logged-loop.mjs";

describe("a background loop's failed round", () => {
  it("is said once, with the loop's name, and again only after an hour of the same failure", async () => {
    // Each loop caught its own rejection into nothing: one that failed every round was silent in the journal.
    let at = Date.parse("2026-11-10T03:00:00Z");
    const warn = vi.fn();
    const log = createLoopLog({ warn, now: () => at });
    const tick = async () => { throw new Error("database is locked"); };
    for (let round = 0; round < 5; round += 1) { await tick().catch(log("scheduler")); at += 30_000; }
    expect(warn.mock.calls).toEqual([["[boxpilot] scheduler: database is locked"]]);
    // The same words from another loop are another line; a different failure of this one is too.
    await tick().catch(log("flows"));
    await Promise.reject(new Error("helper did not answer")).catch(log("scheduler"));
    expect(warn.mock.calls.slice(1)).toEqual([["[boxpilot] flows: database is locked"], ["[boxpilot] scheduler: helper did not answer"]]);
    at += loopLogLimits.repeatAfterMs;
    await tick().catch(log("scheduler"));
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenLastCalledWith("[boxpilot] scheduler: database is locked");
  });

  it("remembers a bounded number of messages, forgetting the oldest first", () => {
    const warn = vi.fn();
    const log = createLoopLog({ warn, now: () => 0, remembered: 3 });
    for (const message of ["a", "b", "c", "d"]) log("sampler")(new Error(message));
    expect(warn).toHaveBeenCalledTimes(4);
    log("sampler")(new Error("d")); log("sampler")(new Error("b"));
    expect(warn).toHaveBeenCalledTimes(4);          // still remembered
    log("sampler")(new Error("a"));                 // forgotten when "d" arrived, so said again
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("says something for a rejection that is not an error, keeps a long one short, and never throws", () => {
    const warn = vi.fn();
    const log = createLoopLog({ warn, now: () => 0 });
    log("push")(undefined); log("push")("plain words\nover two lines"); log("push")(new Error("x".repeat(2_000)));
    expect(warn.mock.calls[0][0]).toBe("[boxpilot] push: undefined");
    expect(warn.mock.calls[1][0]).toBe("[boxpilot] push: plain words over two lines");
    expect(warn.mock.calls[2][0]).toHaveLength("[boxpilot] push: ".length + loopLogLimits.messageChars);
    const broken = createLoopLog({ warn: () => { throw new Error("stderr is closed"); }, now: () => 0 });
    expect(() => broken("push")(new Error("x"))).not.toThrow();
    expect(typeof logged("anything")).toBe("function");
  });
});
