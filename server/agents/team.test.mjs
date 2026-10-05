// @vitest-environment node
/**
 * Agents working together, and the brain's oversight (M37), end to end with the real service, the
 * real runner and the stand-in model: a supervisor hands subtasks to specialists on the one queue
 * and answers from theirs; hand-offs are bounded and never loop; an unclear request becomes a
 * question card rather than a guess; low confidence, limits and risk are escalated, never acted on;
 * an answer can be the owner's JSON; an agent proposes only the operations it is allowed; and a
 * conversation with a person carries over between their questions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";

let h;
beforeEach(async () => { h = await createAgentsHarness(); h.enable(); });
afterEach(async () => { await h.close(); });

const make = (template, role = "owner") => h.service.createAgent(h.caller(role), { template });
const ask = (agent, role, question) => h.service.startRun(h.caller(role), agent.id, { kind: "ask", question });
const edit = (agent, change) => h.service.updateAgent(h.caller("owner"), agent.id, { spec: { ...h.service.getAgent(h.caller("owner"), agent.id).spec, ...change } });
const withTools = (body) => body.messages.filter((message) => message.role === "tool").length;
const system = (body) => String(body.messages[0]?.content ?? "");
const thrown = (fn) => { try { fn(); } catch (error) { return error; } return null; };

describe("the orchestrator", () => {
  it("hands a subtask to a specialist as the same person, then answers from its answer, as one tree", async () => {
    const keeper = make("server-keeper");
    const watcher = make("pihole-watcher");
    h.fake.state.script = (body) => {
      if (system(body).includes("Your name is Server Keeper") && !/The specialists you handed work to/.test(JSON.stringify(body.messages))) {
        return withTools(body) === 0 ? { toolCalls: [{ name: "agents_handoff", arguments: { agent: "Pi-hole Watcher", task: "Is Pi-hole blocking?" } }] } : { content: "I asked the Pi-hole Watcher [T1]." };
      }
      if (system(body).includes("Your name is Pi-hole Watcher")) return withTools(body) === 0 ? { toolCalls: [{ name: "pihole_stats", arguments: {} }] } : { content: "Blocking is on; 15% blocked [T1]." };
      return { content: "Pi-hole is blocking, the watcher says [T1]." };
    };
    // The supervisor's prompt lists who it may hand work to.
    ask(keeper, "operator", "Is Pi-hole doing its job?");
    const parent = await h.runNext();
    expect(parent).toMatchObject({ state: "completed", kind: "ask", depth: 0 });
    expect(h.fake.prompts()[1].messages[0].content).toMatch(/You are a supervisor[\s\S]*- Pi-hole Watcher: Check that Pi-hole is blocking/);
    const handoff = parent.steps.find((step) => step.kind === "handoff");
    expect(handoff).toMatchObject({ state: "done", input: { agent: "Pi-hole Watcher", task: "Is Pi-hole blocking?" } });

    // The specialist runs next, as the operator who asked, one level down.
    const child = await h.runNext();
    expect(child).toMatchObject({ agentId: watcher.id, kind: "handoff", parentRunId: parent.id, rootRunId: parent.id, depth: 1, readRole: "operator", question: "Is Pi-hole blocking?", state: "completed" });
    // Then the supervisor's follow-up, with the specialist's answer as its first tool output.
    const follow = await h.runNext();
    expect(follow).toMatchObject({ agentId: keeper.id, kind: "continue", parentRunId: parent.id, state: "completed", answer: "Pi-hole is blocking, the watcher says [T1]." });
    expect(follow.steps.find((step) => step.kind === "tool" && step.name === "agents.handoff").output).toMatch(/Pi-hole Watcher answered: Blocking is on/);
    expect(follow.flags.citations).toEqual({ cited: 1, unknown: [] });
    // One trace tree, to anyone who may see the root.
    const tree = h.service.getRun(h.caller("operator"), parent.id).tree;
    expect(tree.map((entry) => [entry.agentName, entry.kind, entry.depth])).toEqual([["Server Keeper", "ask", 0], ["Pi-hole Watcher", "handoff", 1], ["Server Keeper", "continue", 0]]);
    expect(await h.runNext()).toBeNull();
    expect(h.state.listAudit(100).map((event) => event.type)).toContain("agents.handoff");
    // The conversation keeps the question once, with the final answer, not the interim one.
    expect(h.store.getThread(keeper.id, h.caller("operator").id).turns.map((turn) => [turn.role, turn.text])).toEqual([["user", "Is Pi-hole doing its job?"], ["agent", "Pi-hole is blocking, the watcher says [T1]."]]);
  });

  it("with two supervisors, follows up at the root only once the second has followed up, with its answer (R2B1-5)", async () => {
    const keeper = make("server-keeper");
    const relay = make("server-keeper");
    edit(relay, { name: "Relay" });
    const watcher = make("pihole-watcher");
    const named = (body, name) => system(body).includes(`Your name is ${name}`);
    const followUp = (body) => /The specialists you handed work to/.test(JSON.stringify(body.messages));
    h.fake.state.script = (body) => {
      if (named(body, "Server Keeper")) {
        if (followUp(body)) return { content: "Pi-hole is blocking, Relay says [T1]." };
        return withTools(body) === 0 ? { toolCalls: [{ name: "agents_handoff", arguments: { agent: "Relay", task: "Check Pi-hole for me" } }] } : { content: "I asked Relay [T1]." };
      }
      if (named(body, "Relay")) {
        if (followUp(body)) return { content: "RELAY-FINAL: the watcher says blocking is on [T1]." };
        return withTools(body) === 0 ? { toolCalls: [{ name: "agents_handoff", arguments: { agent: "Pi-hole Watcher", task: "Is Pi-hole blocking?" } }] } : { content: "RELAY-INTERIM: I asked the watcher [T1]." };
      }
      return withTools(body) === 0 ? { toolCalls: [{ name: "pihole_stats", arguments: {} }] } : { content: "Blocking is on [T1]." };
    };
    ask(keeper, "owner", "Is Pi-hole doing its job?");
    const ran = [];
    for (let run = await h.runNext(); run; run = await h.runNext()) ran.push(run);
    // The root's follow-up waits for the second supervisor's own follow-up, two levels down.
    expect(ran.map((run) => [h.store.getAgent(run.agentId).name, run.kind, run.depth])).toEqual([
      ["Server Keeper", "ask", 0], ["Relay", "handoff", 1], ["Pi-hole Watcher", "handoff", 2], ["Relay", "continue", 1], ["Server Keeper", "continue", 0],
    ]);
    const [root, , specialist, relayed, final] = ran;
    expect(specialist).toMatchObject({ agentId: watcher.id, parentRunId: ran[1].id, rootRunId: root.id });
    expect(relayed).toMatchObject({ agentId: relay.id, parentRunId: ran[1].id, state: "completed" });
    expect(final).toMatchObject({ agentId: keeper.id, parentRunId: root.id, state: "completed" });
    // What the root's follow-up was handed is Relay's answer from its follow-up, not its interim one.
    const handed = final.steps.find((step) => step.kind === "tool" && step.name === "agents.handoff").output;
    expect(handed).toMatch(/Relay answered: RELAY-FINAL/);
    expect(handed).not.toMatch(/RELAY-INTERIM/);
  });

  it("never loops, never hands work to itself or past its depth, and hands off only as a supervisor", async () => {
    const keeper = make("server-keeper");
    make("pihole-watcher");
    const attempts = [];
    h.fake.state.script = (body) => {
      if (withTools(body) === 0) return { toolCalls: [{ name: "agents_handoff", arguments: { agent: "Server Keeper", task: "Do it yourself" } }, { name: "agents_handoff", arguments: { agent: "Nobody", task: "x" } }] };
      attempts.push(JSON.stringify(body.messages.filter((message) => message.role === "tool")));
      return { content: "Done." };
    };
    ask(keeper, "owner", "Hand this around");
    const run = await h.runNext();
    const refusals = run.steps.filter((step) => step.kind === "handoff").map((step) => [step.state, step.output]);
    expect(refusals).toEqual([["refused", "An agent cannot hand work to itself."], ["refused", "There is no agent by that name."]]);
    expect(await h.runNext()).toBeNull();
    // A specialist is offered no hand-off tool at all.
    const watcher = h.service.overview(h.caller("owner")).agents.find((agent) => agent.name === "Pi-hole Watcher");
    ask(watcher, "owner", "Is Pi-hole blocking?");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(claim.tools.map((tool) => tool.id)).not.toContain("agents.handoff");
    await h.runner.execute(claim);
    // Depth: a supervisor at its limit is offered no hand-off either.
    edit(keeper, { orchestration: { supervisor: true, delegates: "*", maxDepth: 1 } });
    const deep = h.store.enqueueRun({ agentId: keeper.id, version: h.store.getAgent(keeper.id).version, kind: "handoff", question: "Deep", requestedBy: h.accounts.owner.id, readRole: "owner", readAs: h.accounts.owner.id, depth: 1, parentRunId: run.id });
    const deepClaim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(deepClaim.run.id).toBe(deep.id);
    expect(deepClaim.tools.map((tool) => tool.id)).not.toContain("agents.handoff");
    await h.runner.execute(deepClaim);
  });
});

describe("intent, plan, act: oversight", () => {
  it("asks back rather than guess, as a question card, and stops there", async () => {
    const keeper = make("server-keeper");
    h.fake.state.script = (body) => (body.response_format ? { understanding: { goal: "Fix a drive", subject: "a drive", constraints: [], tools: [], confidence: 0.4, clarify: "Which drive do you mean: the media drive or the backup drive?", plan: [] } } : { content: "should not be asked" });
    ask(keeper, "owner", "Fix the drive");
    const run = await h.runNext();
    expect(run).toMatchObject({ state: "completed", outputKind: "question", answer: "Which drive do you mean: the media drive or the backup drive?", flags: { clarify: true } });
    expect(run.steps.some((step) => step.kind === "model")).toBe(false);
    // The intent shows the question; no plan is shown, since none was followed.
    expect(run.steps.filter((step) => ["intent", "plan"].includes(step.kind)).map((step) => step.kind)).toEqual(["intent"]);
    const [card] = h.service.listProposals(h.caller("owner"));
    expect(card).toMatchObject({ kind: "question", runId: run.id, question: "Which drive do you mean: the media drive or the backup drive?", steps: [] });
  });

  it("escalates low confidence and a limit reached as cards, and never acts", async () => {
    const helper = make("it-support");
    const keeper = make("server-keeper");
    // The stand-in model is unsure of a question of a few letters.
    ask(keeper, "owner", "Hm?");
    const unsure = await h.runNext();
    expect(unsure.flags.confidence).toBe(0.3);
    expect(h.service.listProposals(h.caller("owner")).find((card) => card.runId === unsure.id)).toMatchObject({ kind: "escalation", reason: expect.stringMatching(/only 30% sure/) });
    // The IT helper does not escalate a low confidence (its template says so).
    ask(helper, "owner", "Hm?");
    const quiet = await h.runNext();
    expect(h.service.listProposals(h.caller("owner")).find((card) => card.runId === quiet.id)).toBeUndefined();
    // A run that used every step it had is escalated as having reached a limit.
    edit(keeper, { budget: { ...h.store.getAgent(keeper.id).spec.budget, stepsPerRun: 1 } });
    h.fake.state.script = (body) => (body.response_format ? null : { toolCalls: [{ name: "server_facts", arguments: {} }] });
    ask(keeper, "owner", "What is this server called and what runs on it?");
    const limited = await h.runNext();
    expect(limited.flags.limitReached).toBe(true);
    expect(h.service.listProposals(h.caller("owner")).find((card) => card.runId === limited.id)).toMatchObject({ kind: "escalation", reason: expect.stringMatching(/limit/) });
    expect(h.state.listJobs(50)).toEqual([]);
  });

  it("answers as the owner's JSON fields when the agent says so", async () => {
    const keeper = make("server-keeper");
    edit(keeper, { prompt: { rules: [], steps: [], output: { format: "json", fields: [{ name: "name", description: "The server's name" }, { name: "system", description: "Its operating system" }] }, escalate: [] } });
    ask(keeper, "owner", "What is this server called?");
    const run = await h.runNext();
    expect(run.flags.structured).toEqual({ ok: true });
    expect(Object.keys(JSON.parse(run.answer))).toEqual(["name", "system"]);
  });

  it("proposes only the operations the agent is allowed, and reads only the apps it may", async () => {
    const auditor = make("backup-auditor");
    h.fake.state.script = (body) => {
      if (withTools(body) === 0) return { toolCalls: [{ name: "plan_propose", arguments: { title: "Fix", reason: "Because [T1]", steps: [{ operationId: "app.backup", parameters: { id: "jellyfin" } }, { operationId: "apt.refresh", parameters: {} }] } }] };
      return { content: "Proposed [T1]." };
    };
    ask(auditor, "owner", "Are the backups fine?");
    await h.runNext();
    const [card] = h.service.listProposals(h.caller("owner")).filter((entry) => entry.kind === "plan");
    expect(card.steps.map((step) => step.operationId)).toEqual(["app.backup"]);
    expect(card.dropped).toEqual([{ index: 1, operationId: "apt.refresh", reason: "not on this agent's list of operations it may propose" }]);
    // An agent limited to Pi-hole sees only Pi-hole among the apps.
    const keeper = make("server-keeper");
    edit(keeper, { allow: { apps: ["pi-hole"], operations: "*" } });
    h.fake.state.script = (body) => (withTools(body) === 0 ? { toolCalls: [{ name: "apps_list", arguments: {} }] } : { content: "Listed [T1]." });
    ask(keeper, "owner", "Which apps run?");
    const run = await h.runNext();
    const listed = run.steps.find((step) => step.name === "apps.list").output;
    expect(listed).toMatch(/pi-hole/i);
    expect(listed).not.toMatch(/jellyfin/i);
  });

  it("carries the conversation with one person into their next question, folded to fit", async () => {
    const keeper = make("server-keeper");
    ask(keeper, "operator", "What is this server called?");
    const first = await h.runNext();
    ask(keeper, "operator", "And what does it run?");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    const task = claim.messages[1].content;
    expect(task).toMatch(/<conversation trust="untrusted">[\s\S]*They asked: What is this server called\?[\s\S]*You answered: /);
    expect(task).toContain(first.answer.replace(/\s+/g, " ").slice(0, 40));
    await h.runner.execute(claim);
    // Another person's conversation is their own.
    ask(keeper, "owner", "Hello?");
    const other = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(other.messages[1].content).not.toMatch(/<conversation/);
    await h.runner.execute(other);
    expect(thrown(() => h.service.forgetMemory(h.caller("viewer"), keeper.id, { kind: "thread" }))).toMatchObject({ status: 404 });
    expect(h.service.forgetMemory(h.caller("operator"), keeper.id, { kind: "thread" })).toEqual({ forgotten: true });
    expect(h.store.getThread(keeper.id, h.accounts.operator.id)).toBeFalsy();
  });

  it("stops at the module's own budget across all agents", async () => {
    const helper = make("it-support");
    h.service.saveModule(h.caller("owner"), { budget: { runsPerDay: 10, modelSecondsPerDay: 7_200 } });
    for (let index = 0; index < 10; index += 1) { ask(helper, "owner", `Question ${index} about the server?`); await h.runNext(); }
    expect(thrown(() => ask(helper, "owner", "One more?"))).toMatchObject({ status: 429, message: expect.stringMatching(/all agents together have used their 10 runs/i) });
    expect(h.service.usage(h.caller("owner")).module.budget).toMatchObject({ runsUsed: 10, runsPerDay: 10 });
  });
});
