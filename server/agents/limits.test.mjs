// @vitest-environment node
/**
 * Every limit an agent lives under (M37), each shown to hold: steps, tool calls, tokens, model time
 * and runs a day; one run at a time for the whole server and one question at a time per person; a
 * queue that drops unattended work rather than growing; rate limits; timeouts; the pause and the
 * kill switch; and a run cut off by a crash or a restart, which is marked and never retried.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { agentsRuntimeKey, defaultRuntimeSettings } from "./service.mjs";

let h;
afterEach(async () => { await h?.close(); h = null; });

const setup = async (options = {}) => { h = await createAgentsHarness(options); h.enable(); return h; };
const make = (template, role = "owner") => h.service.createAgent(h.caller(role), { template });
const ask = (agent, role, question = "How is the server?") => h.service.startRun(h.caller(role), agent.id, { kind: "ask", question });
const thrown = (fn) => { try { fn(); } catch (error) { return error; } return null; };
const withBudget = (agent, budget) => h.service.updateAgent(h.caller("owner"), agent.id, { spec: { ...agent.spec, budget: { ...agent.spec.budget, ...budget } } });
/** A model that asks for a tool whenever it is offered one, and answers only when it is not. */
const toolHungry = (body) => (body.tools?.length ? { toolCalls: [{ name: "server_facts", arguments: {} }, { name: "alerts_active", arguments: {} }] } : { content: "Out of steps, so here is what I have [T1]." });

describe("steps, tool calls and tokens a run", () => {
  it("stops a model that keeps calling tools at its steps, and asks it for an answer without tools", async () => {
    await setup();
    const agent = withBudget(make("it-support"), { stepsPerRun: 3 });
    h.fake.state.script = toolHungry;
    ask(agent, "owner");
    const run = await h.runNext();
    expect(run.state).toBe("completed");
    expect(run.steps.filter((step) => step.kind === "model")).toHaveLength(3);
    const last = h.fake.prompts().at(-1);
    expect(last.tools).toBeUndefined();
    expect(last.messages.at(-1)).toEqual({ role: "user", content: "Answer now with what you have. Do not call more tools." });
  });

  it("refuses tool calls past the run's allowance, whatever the runner asks", async () => {
    await setup();
    const agent = withBudget(make("it-support"), { stepsPerRun: 1 });
    ask(agent, "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(claim.limits.maxToolCalls).toBe(3);
    const answers = [];
    for (let call = 0; call < 5; call += 1) answers.push(await h.service.runnerTool(claim.run.id, claim.lease, "server_facts", "{}"));
    expect(answers.map((answer) => answer.ok)).toEqual([true, true, true, false, false]);
    expect(answers[3].content).toMatch(/used all its tool calls/);
  });

  it("stops early once the run's tokens are nearly spent", async () => {
    await setup();
    const agent = withBudget(make("it-support"), { stepsPerRun: 6, tokensPerRun: 500 });
    h.fake.state.script = toolHungry;
    ask(agent, "owner");
    const run = await h.runNext();
    expect(run.steps.filter((step) => step.kind === "model").length).toBeLessThan(6);
    expect(h.fake.prompts().at(-1).max_tokens).toBeLessThanOrEqual(500);
  });
});

describe("budgets a day", () => {
  it("refuses a question once the agent has used its runs for today, and starts again tomorrow", async () => {
    await setup();
    const agent = withBudget(make("it-support"), { runsPerDay: 1 });
    ask(agent, "owner");
    await h.runNext();
    expect(thrown(() => ask(agent, "owner"))).toMatchObject({ status: 429, code: "agent_budget" });
    h.advance(24 * 3600_000);
    expect(ask(agent, "owner").state).toBe("queued");
  });

  it("records an unattended run it refused, once an hour at most, rather than running it", async () => {
    await setup();
    const auditor = withBudget(make("backup-auditor"), { runsPerDay: 1 });
    ask(auditor, "owner");
    await h.runNext();
    h.service.onJob({ state: "failed", title: "one" });
    h.advance(31 * 60_000);
    h.service.onJob({ state: "failed", title: "two" });
    const refused = h.store.listRuns({ agentId: auditor.id, states: ["refused"] });
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatch(/1 runs for today/);
  });

  it("gives a run only the model time left today, and refuses the next once it is spent", async () => {
    await setup();
    const agent = withBudget(make("it-support"), { modelSecondsPerDay: 10 });
    ask(agent, "owner");
    const first = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    await h.service.runnerFinish(first.run.id, first.lease, { outcome: "completed", answer: "ok", usage: { modelMs: 9_500 } });
    ask(agent, "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(claim.limits.remainingModelMs).toBe(500);
    await h.service.runnerFinish(claim.run.id, claim.lease, { outcome: "completed", answer: "ok", usage: { modelMs: 600 } });
    expect(thrown(() => ask(agent, "owner"))).toMatchObject({ status: 429, code: "agent_budget" });
    expect(h.service.usage(h.caller("owner")).today.perAgent[0]).toMatchObject({ modelSeconds: 10, modelSecondsPerDay: 10 });
  });

  it("ends a run degraded, with the tools' facts, when its model time runs out mid-way", async () => {
    await setup();
    const agent = withBudget(make("it-support"), { modelSecondsPerDay: 10 });
    ask(agent, "owner");
    const first = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    await h.service.runnerFinish(first.run.id, first.lease, { outcome: "completed", answer: "ok", usage: { modelMs: 9_500 } });
    // Each call of this model takes 400 ms by the harness's clock; half a second is left.
    h.fake.state.script = (body) => { h.advance(400); return toolHungry(body); };
    ask(agent, "owner", "What is this server called?");
    const run = await h.runNext();
    expect(run).toMatchObject({ state: "degraded", flags: { degraded: "budget" } });
    expect(run.steps.filter((step) => step.kind === "model")).toHaveLength(2);
    expect(run.answer).toMatch(/model time for today is used up/);
  });
});

describe("one run at a time", () => {
  it("hands out nothing else while a run holds its lease, then the next", async () => {
    await setup();
    const agent = make("it-support");
    ask(agent, "owner");
    ask(agent, "operator");
    const first = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(first).toBeTruthy();
    expect(await h.service.runnerNext(h.runnerId, { waitMs: 0 })).toBeNull();
    await h.runner.execute(first);
    const second = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(second.run.id).not.toBe(first.run.id);
  });

  it("takes one question at a time from each person", async () => {
    await setup();
    const agent = make("it-support");
    ask(agent, "operator");
    expect(thrown(() => ask(agent, "operator"))).toMatchObject({ status: 429, code: "agent_busy" });
    expect(ask(agent, "owner").state).toBe("queued");
  });

  it("wakes a waiting runner the moment a question is asked", async () => {
    await setup();
    const agent = make("it-support");
    const waiting = h.service.runnerNext(h.runnerId, { waitMs: 20_000 });
    setTimeout(() => ask(agent, "owner"), 20);
    const started = Date.now();
    expect(await waiting).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("backpressure and rate limits", () => {
  it("drops unattended runs when the queue is full, and tells a person to try later", async () => {
    await setup({ limits: { queueMax: 2 } });
    const auditor = make("backup-auditor");
    const helper = make("it-support");
    ask(helper, "owner");
    ask(helper, "operator");
    h.service.onJob({ state: "failed", title: "one" });
    expect(h.store.activeRuns().filter((run) => run.agentId === auditor.id)).toEqual([]);
    expect(h.service.usage(h.caller("owner")).queue).toMatchObject({ queued: 2, dropped: 1 });
    expect(thrown(() => h.service.startRun(h.caller("viewer"), helper.id, { kind: "ask", question: "x" }))).toMatchObject({ status: 503, code: "agents_backlog" });
  });

  it("limits how often one person may ask", async () => {
    await setup({ limits: { asksPerHour: 2 } });
    const agent = make("it-support");
    for (let index = 0; index < 2; index += 1) { ask(agent, "owner"); await h.runNext(); }
    expect(thrown(() => ask(agent, "owner"))).toMatchObject({ status: 429, code: "agent_rate_limited" });
  });

  it("keeps only two of one agent's runs waiting", async () => {
    await setup();
    const keeper = make("server-keeper");
    h.service.onHealthRound({ active: [] });
    h.service.onHealthRound({ active: ["docker.unhealthy"] });
    h.advance(31 * 60_000);
    h.service.onHealthRound({ active: ["docker.unhealthy", "system.reboot"] });
    h.advance(31 * 60_000);
    h.service.onHealthRound({ active: ["docker.unhealthy", "system.reboot", "storage.smart"] });
    // An event run already waiting is not queued twice.
    expect(h.store.activeRuns().filter((run) => run.agentId === keeper.id)).toHaveLength(1);
  });
});

describe("timeouts, crashes and restarts", () => {
  it("stops a run that goes past its time, and tells the runner", async () => {
    await setup();
    const agent = withBudget(make("it-support"), { runSeconds: 30 });
    ask(agent, "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    h.advance(91_000);
    expect(h.service.runnerHeartbeat(claim.run.id, claim.lease)).toEqual({ continue: false, reason: "timeout", stopModel: false });
    expect(h.store.getRun(claim.run.id)).toMatchObject({ state: "timeout" });
  });

  it("marks a run interrupted when its runner stops answering, and does not try it again", async () => {
    await setup();
    const agent = make("it-support");
    ask(agent, "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    h.advance(61_000);
    await h.service.tick();
    expect(h.store.getRun(claim.run.id)).toMatchObject({ state: "interrupted", reason: expect.stringMatching(/not tried again/) });
    expect(await h.service.runnerNext(h.runnerId, { waitMs: 0 })).toBeNull();
  });

  it("marks what another runner held as interrupted when a runner starts", async () => {
    await setup();
    ask(make("it-support"), "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(h.service.runnerHello("7f1b8f8e-4d0a-4f7e-8f55-0c7a2b1d9e10", {}).interrupted).toBe(1);
    expect(h.store.getRun(claim.run.id).state).toBe("interrupted");
    expect(h.service.runnerHeartbeat(claim.run.id, claim.lease).continue).toBe(false);
  });

  it("marks a run that was going when BoxPilot stopped, at the next start", async () => {
    await setup();
    ask(make("it-support"), "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(h.service.recoverAtStartup()).toBe(1);
    expect(h.store.getRun(claim.run.id).state).toBe("interrupted");
  });

  it("refuses a runner's call on a run it does not hold", async () => {
    await setup();
    ask(make("it-support"), "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    await expect(h.service.runnerTool(claim.run.id, "not-the-lease", "server_facts", "{}")).rejects.toMatchObject({ status: 409, code: "lease_lost" });
    expect(() => h.service.runnerSteps(claim.run.id, "not-the-lease", [])).toThrow();
  });
});

describe("a model that is missing, broken or slow", () => {
  it("answers from the tools when nothing listens at the model's address", async () => {
    await setup();
    const closed = http.createServer();
    closed.listen(0, "127.0.0.1");
    await new Promise((resolve) => closed.once("listening", resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    h.state.setSetting(agentsRuntimeKey, { ...defaultRuntimeSettings(), driver: "external", endpoint: `http://127.0.0.1:${port}` });
    ask(make("it-support"), "owner", "What is this server called?");
    const run = await h.runNext();
    expect(run).toMatchObject({ state: "degraded", flags: { degraded: "model-unavailable" } });
    expect(run.answer).toMatch(/^The model could not be started, so this is what the tools found/);
    expect(run.answer).toContain("testbox");
    expect(run.steps.find((step) => step.kind === "system" && step.state === "failed")).toBeTruthy();
  });

  it("answers from the tools when the model stops with an error", async () => {
    await setup();
    h.fake.state.chat = "error";
    ask(make("it-support"), "owner");
    const run = await h.runNext();
    expect(run).toMatchObject({ state: "degraded", flags: { degraded: "model-error" } });
    expect(run.answer).toMatch(/stopped with an error/);
  });

  it("gives up on a model that never answers, and still answers", async () => {
    h = await createAgentsHarness({ runnerOptions: { modelCallMs: 300 } });
    h.enable();
    h.fake.state.chat = "hang";
    ask(make("it-support"), "owner");
    const run = await h.runNext();
    expect(run).toMatchObject({ state: "degraded", flags: { degraded: "timeout" } });
    expect(run.answer).toMatch(/took too long/);
  });
});

describe("pausing and the kill switch", () => {
  it("pauses everything until tomorrow morning, and resumes on its own", async () => {
    await setup();
    const agent = make("it-support");
    const module = h.service.pauseModule(h.caller("operator"), { until: "tomorrow" });
    expect(new Date(module.pausedUntil)).toEqual(new Date(2026, 8, 30, 7, 0));
    expect(thrown(() => ask(agent, "owner"))).toMatchObject({ status: 409, code: "agents_paused" });
    expect(h.service.runnerAdvice()).toMatchObject({ stopModel: true, paused: true });
    h.setTime(new Date(2026, 8, 30, 7, 1));
    await h.service.tick();
    expect(h.service.overview(h.caller("owner")).module.paused).toBe(false);
    expect(ask(agent, "owner").state).toBe("queued");
  });

  it("pauses one agent, cancelling what it had waiting", async () => {
    await setup();
    const agent = make("it-support");
    const queued = ask(agent, "operator");
    h.service.pauseAgent(h.caller("operator"), agent.id);
    expect(h.store.getRun(queued.id).state).toBe("cancelled");
    expect(thrown(() => ask(agent, "owner"))).toMatchObject({ status: 409, code: "agent_paused" });
    expect(h.service.overview(h.caller("owner")).agents[0].status).toBe("paused");
    h.service.resumeAgent(h.caller("owner"), agent.id);
    expect(ask(agent, "owner").state).toBe("queued");
    expect(thrown(() => h.service.pauseAgent(h.caller("viewer"), agent.id))).toMatchObject({ status: 403 });
  });

  it("stops everything at once: cancels what waits, stops what runs, tells the runner to stop its model", async () => {
    await setup();
    const agent = make("it-support");
    ask(agent, "owner");
    ask(agent, "operator");
    const running = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    const result = h.service.killSwitch(h.caller("operator"));
    expect(result).toMatchObject({ cancelled: 1, stopped: 1, module: { paused: true } });
    expect(h.service.runnerHeartbeat(running.run.id, running.lease)).toEqual({ continue: false, reason: "killed", stopModel: true });
    expect(h.service.runnerAdvice().stopModel).toBe(true);
    expect(await h.service.runnerNext(h.runnerId, { waitMs: 0 })).toBeNull();
    // After the kill switch, only the owner starts agents again.
    expect(thrown(() => h.service.resumeModule(h.caller("operator")))).toMatchObject({ status: 403 });
    h.service.resumeModule(h.caller("owner"));
    expect(ask(agent, "operator").state).toBe("queued");
    expect(h.state.listAudit(50).map((event) => event.type)).toContain("agents.module.killed");
  });

  it("stops a run mid-way when it is cancelled, and the runner leaves it as cancelled", async () => {
    await setup();
    h.fake.state.delayMs = 100;
    h.fake.state.script = () => ({ content: "word ".repeat(60) });
    const agent = make("it-support");
    const queued = ask(agent, "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    const executing = h.runner.execute(claim);
    h.service.cancelRun(h.caller("owner"), queued.id);
    await executing;
    expect(h.store.getRun(queued.id).state).toBe("cancelled");
  });
});
