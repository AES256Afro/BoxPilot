// @vitest-environment node
/**
 * The owner's first question, at the speed the owner's server measured on one thread: 20 tokens a
 * second read, 4 written (test/agents-bench.mjs). It timed out after 416 s on 2026-09-29, the call
 * after the plan cut off at 300 s while reading 22 tools' schemas. Here it must finish, within the
 * run's limits, with every call after the first to act reading only what it added. The table goes
 * to the log, so CI shows the numbers.
 */
import { describe, expect, it } from "vitest";
import { describe as table, ownerQuestion, runOwnerQuestion } from "../../test/agents-bench.mjs";
import { budgetCeilings } from "./spec.mjs";

describe("the owner's first question, at 20 tokens a second read and 4 written", () => {
  it("finishes within the run's limits, reading each prompt's shared start once", async () => {
    const result = await runOwnerQuestion({ promptPerSecond: 20, generatePerSecond: 4 });
    console.log(table(result, `"${ownerQuestion}" at 20 tokens a second read, 4 written (one thread on the owner's server)`));
    expect(result.run.state).toBe("completed");
    expect(result.run.answer).toMatch(/backup drive/);
    // Well inside the 15-minute run, and every call inside the old 300 s one.
    expect(result.wallMs).toBeLessThan(300_000);
    expect(result.wallMs).toBeLessThan(budgetCeilings.runSeconds.default * 1000);
    for (const call of result.calls) expect(call.seconds, call.call).toBeLessThan(150);
    // The plan reads its own small prompt; the calls that act carry 8 of the 22 tools, and each
    // reads only what the last one added.
    const [plan, first, ...later] = result.calls;
    expect(plan).toMatchObject({ call: "plan", tools: 0 });
    expect(plan.promptTokens).toBeLessThan(800);
    expect(first.tools).toBe(8);
    expect(first.promptTokens).toBeLessThan(2_400);
    for (const call of later) {
      expect(call.tools).toBe(8);
      expect(call.readTokens, call.call).toBeLessThan(400);
      expect(call.cachedTokens, call.call).toBeGreaterThan(first.promptTokens);
    }
    expect(result.run.usage.cachedTokens).toBeGreaterThan(result.run.usage.readTokens);
  });
});
