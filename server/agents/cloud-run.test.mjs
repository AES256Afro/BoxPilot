// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../../packages/harness/src/providers/anthropic.mjs";
import { fakeClaude, fixture } from "../../packages/harness/test/anthropic-wire.mjs";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { createGateway } from "../model-gateway/gateway.mjs";
import { createLedger } from "../model-gateway/ledger.mjs";
import { createAgentsCloud } from "./cloud.mjs";

/*
 * A run on Claude, end to end (M45.3): the real agents service and runner, the real gateway's
 * handler, and Claude's SDK against a scripted wire. The house's names leave as stand-ins and come
 * back in the answer; the cost is counted twice and recorded on the run; the local model is never
 * asked; and an agent that may not use Claude, or a month spent, runs locally and says why.
 */

let h;
let wire;
let cloud;
let ledgerText;

/** Claude's answers for one run: a tool call for the drive, then the answer naming the host. */
function script(answer = "host-1's media drive is 68% full.") {
  const call = fixture("tool-call");
  return [{ ...call, content: [call.content[0], { type: "tool_use", id: "toolu_storage_1", name: "apps_status", input: {} }] }, { ...fixture("answer"), content: [fixture("answer").content[0], { type: "text", text: answer }] }];
}

async function setUp({ capUsd = 20, spentUsd = 0, steps = script() } = {}) {
  wire = fakeClaude(steps);
  ledgerText = JSON.stringify({ month: "2026-09", spentUsd: 0, calls: 0 });
  const ledger = createLedger({ file: "/spend.json", now: () => Date.parse("2026-09-29T10:00:00Z"), read: async () => ledgerText, write: async (_file, text) => { ledgerText = text; } });
  const gateway = createGateway({ provider: createAnthropicProvider({ client: wire.client }), ledger, settings: async () => ({ capUsd }) });
  const client = { status: async () => ({ connected: true }), chat: async (request) => { const reply = await gateway.handle({ version: 1, id: 1, op: "chat", request }); if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code }); return reply.result; } };
  // The cloud module needs the harness's state store, so the service is given one that asks for it later.
  let real = null;
  const lazy = new Proxy({}, { get: (_target, key) => real[key] });
  h = await createAgentsHarness({ serviceOptions: { cloud: lazy, houseNamesFor: () => ({ hosts: ["testbox"], domains: [], users: ["jamie"] }) } });
  cloud = createAgentsCloud({ state: h.state, gateway: client, now: () => h.now().getTime() });
  real = cloud;
  cloud.connected({ capUsd }, { actorId: h.accounts.owner.id });
  if (spentUsd) h.state.setSetting("agentsCloudSpend", { month: "2026-09", spentUsd, calls: 3 });
  await h.enable();
}

afterEach(async () => { await h?.close(); h = null; });

const onClaude = (agent, changes = {}) => h.service.updateAgent(h.caller("owner"), agent.id, { spec: { ...h.service.getAgent(h.caller("owner"), agent.id).spec, model: { thinking: false, route: "claude", dataPolicy: "redacted", claudeForViewers: false, ...changes } } });
const ask = (agent, role, question) => h.service.startRun(h.caller(role), agent.id, { kind: "ask", question });
/** A document every run of an agent that reads documents recalls, pinned, with words that must not leave unless allowed. */
const pinnedDocument = () => {
  const document = h.service.addDocument(h.caller("owner"), { title: "Media drive notes", text: "The media drive holds the films; the spare key is under the blue pot by the door." });
  h.service.pinDocument(h.caller("owner"), document.id, true);
};

describe("a run on Claude", () => {
  beforeEach(async () => { await setUp(); });

  it("sends the house's names as stand-ins, turns the answer back, and never asks the local model", async () => {
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    onClaude(agent);
    ask(agent, "owner", "jamie asks: how full is the media drive on testbox at 192.168.1.20?");
    const run = await h.runNext();
    expect(run.state).toBe("completed");
    expect(run.answer).toContain("testbox's media drive is 68% full.");
    const sent = JSON.stringify(wire.requests.map((request) => request.body));
    expect(sent).not.toMatch(/testbox|jamie|192\.168\.1\.20/);
    expect(sent).toMatch(/host-1/);
    expect(sent).toMatch(/user-1/);
    expect(h.fake.prompts()).toEqual([]);
    expect(run.steps.find((step) => step.kind === "system" && step.name === "model").output).toMatch(/On claude-opus-5-5 through the model gateway.*stand-ins/);
  });

  it("records the model and the cost on the run, counted by BoxPilot and by the gateway", async () => {
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    onClaude(agent);
    ask(agent, "owner", "Which apps are running?");
    const run = await h.runNext();
    expect(run.usage).toMatchObject({ route: "claude", model: "claude-opus-5-5", cloudCalls: 2 });
    expect(run.usage.costUsd).toBeGreaterThan(0);
    expect(cloud.spend().spentUsd).toBeCloseTo(run.usage.costUsd, 6);
    expect(JSON.parse(ledgerText).spentUsd).toBeCloseTo(run.usage.costUsd, 6);
  });

  it("keeps the owner's documents on the box unless the agent names them", async () => {
    pinnedDocument();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    onClaude(agent);
    ask(agent, "owner", "What is on the media drive?");
    const run = await h.runNext();
    expect(JSON.stringify(wire.requests.map((request) => request.body))).not.toMatch(/blue pot/);
    expect(run.steps.find((step) => step.kind === "system" && step.name === "model").output).toMatch(/Your documents stay on this server/);
  });

  it("sends the owner's documents when the agent says so by name", async () => {
    pinnedDocument();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    onClaude(agent, { claudeReadsDocuments: true });
    ask(agent, "owner", "What is on the media drive?");
    await h.runNext();
    expect(JSON.stringify(wire.requests.map((request) => request.body))).toMatch(/blue pot/);
  });

  it("sends the text as it is when the agent's data policy says so", async () => {
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    onClaude(agent, { dataPolicy: "as-is" });
    ask(agent, "owner", "How is testbox?");
    await h.runNext();
    expect(JSON.stringify(wire.requests[0].body)).toMatch(/testbox/);
  });
});

describe("a run that may not use Claude", () => {
  it("runs locally when a viewer asks an agent that keeps viewers' words on the box", async () => {
    await setUp();
    const agent = h.service.createAgent(h.caller("owner"), { template: "it-support" });
    onClaude(agent);
    ask(agent, "viewer", "How do I restore an app from a backup?");
    const run = await h.runNext();
    expect(wire.requests).toHaveLength(0);
    expect(h.fake.prompts().length).toBeGreaterThan(0);
    expect(run.steps.find((step) => step.kind === "system" && step.name === "model").output).toMatch(/viewer.*local model/);
  });

  it("runs locally when this month's cap is spent", async () => {
    await setUp({ capUsd: 5, spentUsd: 5 });
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    onClaude(agent);
    ask(agent, "owner", "Which apps are running?");
    const run = await h.runNext();
    expect(wire.requests).toHaveLength(0);
    expect(run.steps.find((step) => step.kind === "system" && step.name === "model").output).toMatch(/cap of \$5 for Claude is spent: this run uses the local model/);
  });
});
