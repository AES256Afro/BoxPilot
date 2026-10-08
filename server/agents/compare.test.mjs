// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { fixture } from "../../packages/harness/test/anthropic-wire.mjs";
import { createRoutedHarness, routedAgent } from "../../test/agents-routes.mjs";

/*
 * The routes compared (M45.7): the same evaluation questions on this server's model and on Claude,
 * each side graded the same way, with how long a question took and what Claude cost; started by the
 * owner, or each night when the owner turned it on. Claude answers from recorded responses.
 */

let routed;

afterEach(async () => { await routed?.close(); routed = null; });

/** Claude's answers: whatever it is asked, a short answer naming the server. Enough for every question. */
function claudeAnswers(turns, count = 60) {
  const answer = fixture("answer");
  for (let index = 0; index < count; index += 1) turns.push({ ...answer, content: [answer.content[0], { type: "text", text: "It is testbox, running Ubuntu 24.04.3 LTS." }] });
}

/** Every queued run carried out. */
async function drain(h) {
  for (let index = 0; index < 40 && (await h.runNext()); index += 1) { /* each question in turn */ }
}

describe("comparing the routes", () => {
  it("asks every question on both models and shows them side by side, with seconds and dollars", async () => {
    routed = await createRoutedHarness("claude");
    const { h } = routed;
    claudeAnswers(routed.turns);
    const agent = routedAgent(routed, { model: { route: "local" } });
    const owner = h.caller("owner");
    expect(h.service.getEvaluation(owner, agent.id).canCompare).toBe(true);
    await h.service.runEvaluation(owner, agent.id, { compare: true });
    const runs = h.store.listEvalRuns(agent.id, 5);
    expect(runs.map((entry) => entry.route).sort()).toEqual(["claude", "local"]);
    expect(new Set(runs.map((entry) => entry.pairId)).size).toBe(1);
    expect(runs.find((entry) => entry.route === "claude").model).toBe("claude-opus-5-5");
    await drain(h);
    const [comparison] = h.service.getEvaluation(owner, agent.id).comparisons;
    expect(comparison.local).toMatchObject({ state: "done", dollars: 0, ranLocally: 0 });
    expect(comparison.claude).toMatchObject({ state: "done", ranLocally: 0 });
    expect(comparison.claude.questions).toBe(comparison.local.questions);
    expect(comparison.claude.dollars).toBeGreaterThan(0);
    expect(comparison.local.seconds).not.toBeNull();
    // A local agent's own evaluation never reaches Claude; its Claude side always did.
    const claudeSide = h.store.getEvalRun(comparison.claude.evalId);
    expect(claudeSide.results.every((result) => result.route === "claude")).toBe(true);
    expect(h.store.getEvalRun(comparison.local.evalId).results.every((result) => result.route === "local")).toBe(true);
  });

  it("is the owner's to start, and only while Claude may take the questions", async () => {
    routed = await createRoutedHarness("claude");
    // An operator's own agent: theirs to evaluate, not theirs to compare at the owner's cost.
    const operators = routed.h.service.createAgent(routed.h.caller("operator"), { template: "server-keeper" });
    expect(routed.h.service.getEvaluation(routed.h.caller("operator"), operators.id).canCompare).toBe(false);
    await expect(routed.h.service.runEvaluation(routed.h.caller("operator"), operators.id, { compare: true })).rejects.toThrow(/owner starts it/);
    await routed.close();

    routed = await createRoutedHarness("local");
    const local = routedAgent(routed, { model: { route: "local" } });
    expect(routed.h.service.getEvaluation(routed.h.caller("owner"), local.id).canCompare).toBe(false);
    await expect(routed.h.service.runEvaluation(routed.h.caller("owner"), local.id, { compare: true })).rejects.toThrow(/nothing to compare with/);
  });

  it("compares every night when the owner turned it on", async () => {
    routed = await createRoutedHarness("claude");
    const { h } = routed;
    claudeAnswers(routed.turns);
    const agent = routedAgent(routed, { model: { route: "local" } });
    h.service.saveModule(h.caller("owner"), { evaluation: { compareNightly: true } });
    expect(h.service.overview(h.caller("owner")).module.evaluation).toEqual({ compareNightly: true });
    // In quiet hours, the night's evaluation goes on both routes.
    h.setTime(new Date(2026, 8, 30, 3, 0, 0));
    await h.service.tick();
    const runs = h.store.listEvalRuns(agent.id, 5);
    expect(runs.map((entry) => entry.route).sort()).toEqual(["claude", "local"]);
    expect(runs.every((entry) => !entry.createdBy)).toBe(true);
  });
});
