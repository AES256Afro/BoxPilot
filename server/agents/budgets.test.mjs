/**
 * Budgets that follow the work (M48.6): a scheduled run that ran out of tokens, steps or time as the
 * one before it did raises that field to its template's, once, with a version note; the Usage tab is
 * told how many runs this week answered early because what they read filled the model's context.
 * The nightly gate's "only what fits" is in background.test.mjs and evaluation.test.mjs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { templateById } from "./templates.mjs";

let h;
afterEach(async () => { await h?.close(); h = null; });

/** A scheduled run of the agent, finished as the runner would finish one that hit a limit. */
async function scheduledRunHitting(agent, { limit = null, degraded = null } = {}) {
  const run = h.store.enqueueRun({ agentId: agent.id, version: h.store.getAgent(agent.id).version, kind: "schedule", trigger: { title: "Its schedule" }, requestedBy: null, readRole: "owner", readAs: h.accounts.owner.id });
  const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
  expect(claim.run.id).toBe(run.id);
  await h.service.runnerFinish(run.id, claim.lease, { outcome: degraded ? "degraded" : "completed", answer: "Where to focus: nothing [T1].", usage: { modelMs: 10_000 }, ...(limit ? { limitReached: true, limit } : {}), ...(degraded ? { degradedReason: degraded } : {}) });
  return h.store.getRun(run.id);
}

describe("budgets that follow the work", () => {
  it("raises a field to the template's after two scheduled runs in a row ran out of it, and says so in a version", async () => {
    h = await createAgentsHarness();
    h.enable();
    const watch = h.service.createAgent(h.caller("owner"), { template: "resource-watch" });
    const template = templateById("resource-watch").spec.budget;
    const spec = h.service.getAgent(h.caller("owner"), watch.id).spec;
    h.service.updateAgent(h.caller("owner"), watch.id, { spec: { ...spec, budget: { ...spec.budget, tokensPerRun: 10_000 } } });
    // One run out of tokens is a day; two running is a budget the work has outgrown.
    expect((await scheduledRunHitting(watch, { limit: "tokens" })).flags.limit).toBe("tokens");
    expect(h.store.getAgent(watch.id).spec.budget.tokensPerRun).toBe(10_000);
    await scheduledRunHitting(watch, { limit: "tokens" });
    const raised = h.service.getAgent(h.caller("owner"), watch.id);
    expect(raised.spec.budget.tokensPerRun).toBe(template.tokensPerRun);
    expect(raised.versions[0].note).toBe(`BoxPilot raised its tokens a run from 10000 to ${template.tokensPerRun}, the template's: its last two scheduled runs ran out`);
    // Already at the template's: left to the owner, however many runs run out.
    await scheduledRunHitting(watch, { limit: "tokens" });
    await scheduledRunHitting(watch, { limit: "tokens" });
    expect(h.service.getAgent(h.caller("owner"), watch.id).versions).toHaveLength(raised.versions.length);
    // Time, too: two runs that timed out raise the seconds a run.
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    const keeperSpec = h.service.getAgent(h.caller("owner"), keeper.id).spec;
    h.service.updateAgent(h.caller("owner"), keeper.id, { spec: { ...keeperSpec, budget: { ...keeperSpec.budget, runSeconds: 600 } } });
    await scheduledRunHitting(keeper, { degraded: "timeout" });
    await scheduledRunHitting(keeper, { degraded: "timeout" });
    expect(h.service.getAgent(h.caller("owner"), keeper.id).spec.budget.runSeconds).toBe(templateById("server-keeper").spec.budget.runSeconds);
    // A question someone asked that ran out raises nothing: the rule is for the agent's own routine.
    const guide = h.service.createAgent(h.caller("owner"), { template: "house-guide" });
    const guideSpec = h.service.getAgent(h.caller("owner"), guide.id).spec;
    h.service.updateAgent(h.caller("owner"), guide.id, { spec: { ...guideSpec, budget: { ...guideSpec.budget, tokensPerRun: 4_000 } } });
    for (let asked = 0; asked < 2; asked += 1) {
      h.service.startRun(h.caller("owner"), guide.id, { kind: "ask", question: `What is Pi-hole for? (${asked})` });
      const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
      await h.service.runnerFinish(claim.run.id, claim.lease, { outcome: "completed", answer: "It blocks ads [T1].", usage: { modelMs: 5_000 }, limitReached: true, limit: "tokens" });
    }
    expect(h.service.getAgent(h.caller("owner"), guide.id).spec.budget.tokensPerRun).toBe(4_000);
  });

  it("tells the Usage tab the context and how many runs this week filled it", async () => {
    h = await createAgentsHarness();
    h.enable();
    expect(h.service.usage(h.caller("owner")).context).toMatchObject({ days: 7, limitedRuns: 0 });
    expect(typeof h.service.usage(h.caller("owner")).context.tokens).toBe("number");
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Which apps are stopped?" });
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    await h.service.runnerFinish(claim.run.id, claim.lease, { outcome: "completed", answer: "None [T1].", usage: { modelMs: 5_000 }, limitReached: true, limit: "context" });
    expect(h.service.usage(h.caller("owner")).context.limitedRuns).toBe(1);
    expect(h.service.getRun(h.caller("owner"), claim.run.id).flags).toMatchObject({ limitReached: true, limit: "context" });
  });
});
