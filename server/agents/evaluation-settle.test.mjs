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

describe("a nightly evaluation's question cancelled before it was asked (sweep 4)", () => {
  /** The nightly evaluation of a new Server Keeper, queued in quiet hours (02:30) and not yet asked. */
  const nightly = async () => {
    h.enable();
    h.service.saveModule(h.caller("owner"), { embeddings: false });
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await h.service.tick();
    const [evaluation] = h.store.listEvalRuns(keeper.id, 1);
    expect(evaluation).toMatchObject({ state: "running", createdBy: null });
    return { keeper, evaluation };
  };

  it("R4B1-3: is not graded wrong when its agent was paused, and leaves no score to drop", async () => {
    const { keeper, evaluation } = await nightly();
    h.service.pauseAgent(h.caller("owner"), keeper.id);
    const [settled] = h.service.getEvaluation(h.caller("owner"), keeper.id).runs;
    expect(settled).toMatchObject({ id: evaluation.id, state: "done", score: null });
    expect(settled.results.every((result) => result.skipped && result.passed === null)).toBe(true);
    expect(settled.results[0].found).toMatch(/^Not asked: The agent was paused/);
    expect(h.service.getEvaluation(h.caller("owner"), keeper.id).history).toEqual([]);
  });

  it("R4B1-3: is not graded wrong when it waited too long to start", async () => {
    const { keeper, evaluation } = await nightly();
    // Nothing took the questions: two days later they have waited past any quiet hours' allowance.
    h.setTime(new Date(2026, 9, 2, 20, 30, 0));
    await h.service.tick();
    expect(h.store.listRuns({ agentId: keeper.id, limit: 20 }).filter((run) => run.kind === "eval").every((run) => run.state === "cancelled")).toBe(true);
    const [settled] = h.service.getEvaluation(h.caller("owner"), keeper.id).runs;
    expect(settled).toMatchObject({ id: evaluation.id, state: "done", score: null });
    expect(settled.results.every((result) => result.skipped)).toBe(true);
  });

  it("a person's evaluation cancelled is still graded as it ended: they asked for it now", async () => {
    h.enable();
    const helper = h.service.createAgent(h.caller("owner"), { template: "it-support" });
    const started = await h.service.runEvaluation(h.caller("owner"), helper.id);
    h.service.pauseAgent(h.caller("owner"), helper.id);
    expect(h.service.getEvaluation(h.caller("owner"), helper.id).runs[0].results.map((result) => result.passed)).toEqual(started.results.map(() => false));
  });

  it("R4B1-4: counts in its history only the questions that were graded, and says how many were not", () => {
    h.enable();
    const helper = h.service.createAgent(h.caller("owner"), { template: "it-support" });
    const questions = ["q1", "q2", "q3"].map((questionId) => ({ questionId, question: questionId, expected: { includes: ["x"] }, runId: null, passed: null, found: null }));
    const evaluation = h.store.createEvalRun({ agentId: helper.id, version: 1, results: questions, createdBy: null });
    h.store.gradeEval(evaluation.id, "q1", { passed: true, found: "Every expected word is there" });
    h.store.gradeEval(evaluation.id, "q2", { passed: null, skipped: true, found: "Not asked: The agent was paused" });
    h.store.gradeEval(evaluation.id, "q3", { passed: null, skipped: true, found: "Not asked: It waited too long to start" });
    const [point] = h.service.getEvaluation(h.caller("owner"), helper.id).history;
    expect(point).toMatchObject({ score: 1, right: 1, questions: 1, skipped: 2 });
  });
});
