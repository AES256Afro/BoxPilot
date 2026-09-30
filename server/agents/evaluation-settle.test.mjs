// @vitest-environment node
/**
 * An evaluation whose runs ended without the runner (reliability audit, 2026-09-29). Only the
 * runner's finish graded a question, so an evaluation run that was cancelled, waited too long in
 * the queue, lost its lease or was cut off by a restart left the evaluation "running" for good, and
 * every later evaluation of that agent was refused as "ran in the last hour": a refusal that could
 * never clear.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";

let h;
beforeEach(async () => { h = await createAgentsHarness(); });
afterEach(async () => { await h.close(); });

describe("an evaluation whose runs ended without the runner", () => {
  it("is graded as they ended, finishes, and lets the next one start an hour later", async () => {
    h.enable();
    const helper = h.service.createAgent(h.caller("owner"), { template: "it-support" });
    const started = await h.service.runEvaluation(h.caller("owner"), helper.id);
    for (const result of started.results) h.service.cancelRun(h.caller("owner"), result.runId);

    const [ended] = h.service.getEvaluation(h.caller("owner"), helper.id).runs;
    expect(ended).toMatchObject({ state: "done", score: 0 });
    // Its own two questions and the built-in ones its tools answer (M40): every one graded as it ended.
    expect(ended.results.length).toBeGreaterThan(2);
    expect(ended.results.map((result) => [result.passed, result.found])).toEqual(started.results.map(() => [false, "The run ended cancelled"]));

    h.advance(61 * 60_000);
    await expect(h.service.runEvaluation(h.caller("owner"), helper.id)).resolves.toMatchObject({ state: "running" });
  });

  it("leaves a question whose run is still going, or finished and about to be graded, as it is", async () => {
    h.enable();
    const helper = h.service.createAgent(h.caller("owner"), { template: "it-support" });
    const started = await h.service.runEvaluation(h.caller("owner"), helper.id);
    h.service.cancelRun(h.caller("owner"), started.results[0].runId);
    // One ended, the rest still queued: the evaluation goes on running, with the ended one graded.
    const [partly] = h.store.listEvalRuns(helper.id, 1);
    expect(partly.state).toBe("running");
    expect(partly.results.map((result) => result.passed)).toEqual([false, ...started.results.slice(1).map(() => null)]);
    // The runner marks a run completed a moment before it grades the answer: never graded here.
    h.store.finishRun(started.results[1].runId, { state: "completed", answer: "It is called testbox." });
    expect(h.store.listEvalRuns(helper.id, 1)[0].results[1].passed).toBeNull();
  });
});
