// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../../packages/harness/src/providers/anthropic.mjs";
import { fakeClaude, fixture } from "../../packages/harness/test/anthropic-wire.mjs";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { createGateway } from "../model-gateway/gateway.mjs";
import { createLedger } from "../model-gateway/ledger.mjs";
import { createAgentsCloud } from "./cloud.mjs";

/*
 * Routing, end to end (M45.4): the real agents service and runner, the real gateway's handler, and
 * Claude's SDK against a scripted wire. An auto agent plans on the local model and moves to Claude
 * when its plan is unsure, proposes a change or could not be made; a run on Claude goes on with
 * the local model when the gateway stops answering; and a shaky local answer gets a second opinion.
 */

let h;
let wire;
let cloud;
let gatewayUp;

/** Claude's answers for one run's act steps: a tool call for the apps, then the answer naming the host. */
function script(answer = "host-1 runs three apps.") {
  const call = fixture("tool-call");
  return [{ ...call, content: [call.content[0], { type: "tool_use", id: "toolu_apps_1", name: "apps_list", input: {} }] }, { ...fixture("answer"), content: [fixture("answer").content[0], { type: "text", text: answer }] }];
}

async function setUp({ capUsd = 20, steps = script() } = {}) {
  wire = fakeClaude(steps);
  gatewayUp = true;
  let ledgerText = JSON.stringify({ month: "2026-09", spentUsd: 0, calls: 0 });
  const ledger = createLedger({ file: "/spend.json", now: () => Date.parse("2026-09-29T10:00:00Z"), read: async () => ledgerText, write: async (_file, text) => { ledgerText = text; } });
  const gateway = createGateway({ provider: createAnthropicProvider({ client: wire.client }), ledger, settings: async () => ({ capUsd }) });
  const client = {
    status: async () => ({ connected: true }),
    chat: async (request) => {
      if (!gatewayUp) throw Object.assign(new Error("The model gateway is not answering"), { code: "gateway-down" });
      const reply = await gateway.handle({ version: 1, id: 1, op: "chat", request });
      if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code });
      return reply.result;
    },
  };
  let real = null;
  const lazy = new Proxy({}, { get: (_target, key) => real[key] });
  h = await createAgentsHarness({ serviceOptions: { cloud: lazy, houseNamesFor: () => ({ hosts: ["testbox"], domains: [], users: ["jamie"] }) } });
  cloud = createAgentsCloud({ state: h.state, gateway: client, now: () => h.now().getTime() });
  real = cloud;
  cloud.connected({ capUsd }, { actorId: h.accounts.owner.id });
  await h.enable();
}

afterEach(async () => { await h?.close(); h = null; });

const routed = (agent, route, changes = {}) => h.service.updateAgent(h.caller("owner"), agent.id, { spec: { ...h.service.getAgent(h.caller("owner"), agent.id).spec, model: { thinking: false, route, dataPolicy: "redacted", claudeForViewers: false, ...changes } } });
const ask = (agent, role, question) => h.service.startRun(h.caller(role), agent.id, { kind: "ask", question });
/** What the model steps say: the service writes its own as output, the runner's as their detail. */
const modelSteps = (run) => run.steps.filter((step) => step.kind === "system" && step.name === "model").map((step) => step.output || step.flags?.detail);
const sure = { goal: "Say which apps run on this server", subject: "this server", constraints: [], tools: ["apps_list"], confidence: 0.9, clarify: null, plan: [{ step: "Read the apps", tool: "apps_list" }, { step: "Answer with citations", tool: null }] };
/** The local model plans as told, then answers from the apps it read. */
const localPlans = (understanding) => { h.fake.state.script = (body) => (body.response_format?.json_schema?.name === "understanding" ? { understanding } : null); };

describe("an auto agent", () => {
  it("is what a new agent is once Claude is connected, unless it names its model", async () => {
    await setUp();
    expect(h.service.createAgent(h.caller("owner"), { template: "server-keeper" }).spec.model.route).toBe("auto");
    const named = h.service.createAgent(h.caller("owner"), { spec: { ...h.service.createAgent(h.caller("owner"), { template: "pihole-watcher" }).spec, name: "Local watcher", model: { thinking: false, route: "local" } } });
    expect(named.spec.model.route).toBe("local");
    cloud.disconnected();
    expect(h.service.createAgent(h.caller("owner"), { template: "backup-auditor" }).spec.model.route).toBe("local");
  });

  it("stays on the local model when its plan is sure, and Claude is never asked", async () => {
    await setUp();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    routed(agent, "auto");
    localPlans(sure);
    ask(agent, "owner", "Which apps are running?");
    const run = await h.runNext();
    expect(run.state).toBe("completed");
    expect(wire.requests).toHaveLength(0);
    expect(run.usage.route).toBeUndefined();
    expect(modelSteps(run)[0]).toMatch(/^On the local model, with claude-opus-5-5 ready if the plan needs it\./);
  });

  it("moves to Claude when the local model is unsure of its plan, and says why", async () => {
    await setUp();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    routed(agent, "auto");
    localPlans({ ...sure, confidence: 0.3 });
    ask(agent, "owner", "jamie asks: which apps run on testbox?");
    const run = await h.runNext();
    expect(run.state).toBe("completed");
    expect(run.answer).toContain("testbox runs three apps.");
    expect(modelSteps(run)).toContain("Moved to claude-opus-5-5: The local model was unsure of its plan (confidence 0.3).");
    // The plan was the local model's; the acting was Claude's, with the house's names as stand-ins.
    expect(h.fake.prompts()).toHaveLength(1);
    expect(wire.requests).toHaveLength(2);
    expect(JSON.stringify(wire.requests.map((request) => request.body))).not.toMatch(/testbox|jamie/);
    expect(run.usage).toMatchObject({ route: "both", model: "claude-opus-5-5", cloudCalls: 2, routeReason: "The local model was unsure of its plan (confidence 0.3)" });
    expect(run.usage.costUsd).toBeGreaterThan(0);
  });

  it("moves to Claude when its plan proposes a change", async () => {
    await setUp();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    routed(agent, "auto");
    localPlans({ ...sure, tools: ["apps_list", "plan_propose"], plan: [{ step: "Read the apps", tool: "apps_list" }, { step: "Propose a restart", tool: "plan_propose" }] });
    ask(agent, "owner", "Restart whatever app is stuck.");
    const run = await h.runNext();
    expect(modelSteps(run)).toContain("Moved to claude-opus-5-5: The plan proposes a change, so the stronger model carries it out.");
    expect(run.usage.route).toBe("both");
  });

  it("moves to Claude when the local model stops while it plans, and the run is not cut short", async () => {
    await setUp();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    routed(agent, "auto");
    h.fake.state.chat = "error";
    h.fake.state.status = 500;
    ask(agent, "owner", "Which apps are running?");
    const run = await h.runNext();
    expect(run.state).toBe("completed");
    expect(run.flags.degraded).toBeUndefined();
    expect(modelSteps(run)).toContain("Moved to claude-opus-5-5: The local model stopped while it planned.");
    // The local model answered nothing, so the run was Claude's alone.
    expect(run.usage).toMatchObject({ route: "claude", routeReason: "The local model stopped while it planned" });
  });

  it("moves to Claude when the work is longer than the local model's context holds well", async () => {
    await setUp();
    h.state.setSetting("agentsRuntime", { ...h.state.getSetting("agentsRuntime"), contextTokens: 2_048 });
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    routed(agent, "auto");
    localPlans(sure);
    ask(agent, "owner", `Which apps are running? ${"Say it plainly, with what each one does. ".repeat(40)}`);
    const run = await h.runNext();
    expect(modelSteps(run).find((text) => text.startsWith("Moved to"))).toMatch(/^Moved to claude-opus-5-5: The work is about \d+ tokens, more than the local model's 2048-token context holds well\.$/);
    expect(run.usage.route).toBe("both");
  });

  it("keeps the owner's documents on the box from the start, since it may move", async () => {
    await setUp();
    const document = h.service.addDocument(h.caller("owner"), { title: "Media drive notes", text: "The media drive holds the films; the spare key is under the blue pot by the door." });
    h.service.pinDocument(h.caller("owner"), document.id, true);
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    routed(agent, "auto");
    localPlans({ ...sure, confidence: 0.2 });
    ask(agent, "owner", "What is on the media drive?");
    const run = await h.runNext();
    expect(JSON.stringify(wire.requests.map((request) => request.body))).not.toMatch(/blue pot/);
    expect(JSON.stringify(h.fake.state.log ?? [])).not.toMatch(/blue pot/);
    expect(modelSteps(run)[0]).toMatch(/Your documents stay on this server/);
  });

  it("is a local agent while Claude may not take the run: a viewer's question stays home", async () => {
    await setUp();
    const agent = h.service.createAgent(h.caller("owner"), { template: "it-support" });
    routed(agent, "auto");
    localPlans({ ...sure, confidence: 0.1 });
    ask(agent, "viewer", "How do I restore an app from a backup?");
    const run = await h.runNext();
    expect(wire.requests).toHaveLength(0);
    expect(modelSteps(run)[0]).toMatch(/viewer.*this run uses the local model/);
  });
});

describe("a run on Claude whose gateway stops answering", () => {
  it("goes on with the local model, and the next run starts there until the gateway answers", async () => {
    await setUp();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    routed(agent, "claude");
    gatewayUp = false;
    ask(agent, "owner", "Which apps are running?");
    const run = await h.runNext();
    expect(run.state).toBe("completed");
    expect(modelSteps(run)).toContain("Claude did not answer (The model gateway is not answering): going on with the local model.");
    expect(h.fake.prompts().length).toBeGreaterThan(0);
    expect(run.usage.route).toBeUndefined();
    // For a minute after, a run is not given Claude at all.
    ask(agent, "owner", "Which apps are running now?");
    const next = await h.runNext();
    expect(modelSteps(next)[0]).toBe("The model gateway stopped answering a moment ago: this run uses the local model.");
    h.advance(61_000);
    gatewayUp = true;
    expect(cloud.usable().ok).toBe(true);
  });
});

describe("a second opinion", () => {
  /** The local model plans surely, reads the apps, then stops answering partway. */
  const localStopsPartway = () => {
    h.fake.state.script = (body) => {
      if (body.response_format?.json_schema?.name === "understanding") return { understanding: sure };
      if (!body.messages.some((message) => message.role === "tool")) { h.fake.state.chat = "error"; h.fake.state.status = 500; return { toolCalls: [{ name: "apps_list", arguments: {} }] }; }
      return { content: "unreachable" };
    };
  };

  it("asks Claude again when an auto agent's local answer was cut short, once, as a run that names the first", async () => {
    await setUp();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    routed(agent, "auto");
    localStopsPartway();
    ask(agent, "owner", "Which apps are running?");
    const first = await h.runNext();
    expect(first.state).toBe("degraded");
    expect(first.flags.secondOpinion).toMatchObject({ reason: "The local model's answer was cut short (model-error)" });
    const second = await h.runNext();
    expect(second.id).toBe(first.flags.secondOpinion.runId);
    expect(second.trigger.secondOpinionOf).toBe(first.id);
    expect(second.question).toBe("Which apps are running?");
    expect(second.state).toBe("completed");
    expect(modelSteps(second)[0]).toMatch(/^A second opinion: On claude-opus-5-5 through the model gateway/);
    expect(second.usage.route).toBe("claude");
    expect(second.flags.secondOpinion).toBeUndefined();
  });

  it("is not asked for an agent on the local model, nor once the month is spent", async () => {
    await setUp();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    routed(agent, "local");
    localStopsPartway();
    ask(agent, "owner", "Which apps are running?");
    const first = await h.runNext();
    expect(first.state).toBe("degraded");
    expect(first.flags.secondOpinion).toBeUndefined();
    expect(await h.runNext()).toBeNull();

    routed(agent, "auto");
    h.state.setSetting("agentsCloudSpend", { month: "2026-09", spentUsd: 20, calls: 9 });
    h.fake.state.chat = undefined;
    localStopsPartway();
    ask(agent, "owner", "Which apps are running now?");
    const spent = await h.runNext();
    expect(spent.flags.secondOpinion).toBeUndefined();
    expect(await h.runNext()).toBeNull();
  });
});
