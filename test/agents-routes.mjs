/**
 * The agents harness on either route (M45.7): the real job service, so what an agent stages is a
 * real job; and, for Claude, the real gateway's handler and Claude's SDK against recorded responses
 * (the fixtures follow the documented shape). `record` scripts what the model does the same way on
 * both routes: read once, make some calls, answer. Nothing here calls a real model.
 */
import { createAnthropicProvider } from "../packages/harness/src/providers/anthropic.mjs";
import { fakeClaude, fixture } from "../packages/harness/test/anthropic-wire.mjs";
import { createAgentsCloud } from "../server/agents/cloud.mjs";
import { createJobService } from "../server/jobs.mjs";
import { createGateway } from "../server/model-gateway/gateway.mjs";
import { createLedger } from "../server/model-gateway/ledger.mjs";
import { createAgentsHarness } from "./agents-harness.mjs";

export const routes = Object.freeze(["local", "claude"]);

export async function createRoutedHarness(route) {
  const turns = [];
  let cloudReal = null;
  let jobsReal = null;
  const lazy = (get) => new Proxy({}, { get: (_target, key) => get()[key] });
  const h = await createAgentsHarness({
    serviceOptions: { jobs: lazy(() => jobsReal), ...(route === "claude" ? { cloud: lazy(() => cloudReal), houseNamesFor: () => ({ hosts: ["testbox"], domains: [], users: [] }) } : {}) },
  });
  jobsReal = createJobService(h.state, h.helper, { now: () => h.now().getTime() });
  Object.assign(h.helperAnswers, {
    "app.action": (parameters) => ({ id: parameters.id, action: parameters.action, running: true }),
    "app.backup": (parameters) => ({ id: parameters.id, archive: `${parameters.id}.tar.gz` }),
    "job.output.release": () => ({}),
  });
  let wire = { requests: [] };
  if (route === "claude") {
    wire = fakeClaude(turns);
    let ledgerText = JSON.stringify({ month: "2026-09", spentUsd: 0, calls: 0 });
    const ledger = createLedger({ file: "/spend.json", now: () => Date.parse("2026-09-29T10:00:00Z"), read: async () => ledgerText, write: async (_file, text) => { ledgerText = text; } });
    const gateway = createGateway({ provider: createAnthropicProvider({ client: wire.client }), ledger, settings: async () => ({ capUsd: 20 }) });
    const chat = async (request) => { const reply = await gateway.handle({ version: 1, id: 1, op: "chat", request }); if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code }); return reply.result; };
    cloudReal = createAgentsCloud({ state: h.state, now: () => h.now().getTime(), gateway: { status: async () => ({ connected: true }), chat } });
    cloudReal.connected({ capUsd: 20 }, { actorId: h.accounts.owner.id });
  }
  const stop = h.service.start({ subscribeJobs: (listener) => h.state.subscribeJobs(listener) });
  await h.enable();
  return { h, jobs: jobsReal, route, turns, wire, close: async () => { stop(); await h.close(); } };
}

/**
 * What the model does in the next run, on either route: read with `read` (a tool call), then make
 * each of `calls` in turn, then answer `answer`. On Claude it first gives a plan that cannot be read,
 * which leaves the run as it is.
 */
export function record(routed, { read, calls = [], answer = "Done [T1]." }) {
  const { h, route, turns } = routed;
  if (route === "claude") {
    const call = fixture("tool-call");
    const done = fixture("answer");
    const use = (name, input, n) => ({ ...call, content: [call.content[0], { type: "tool_use", id: `toolu_${turns.length}_${n}`, name, input }] });
    const said = { ...done, content: [done.content[0], { type: "text", text: answer }] };
    turns.push(said, use(read.name, read.arguments, 0), ...calls.map((entry, index) => use(entry.name, entry.arguments, index + 1)), said, said, said);
    return;
  }
  h.fake.state.script = (body) => {
    if (body.response_format?.json_schema?.name === "understanding") return { understanding: { goal: "Do as asked", subject: "this server", constraints: [], tools: [read.name], confidence: 0.9, clarify: null, plan: [{ step: "Read", tool: read.name }] } };
    const tools = body.messages.filter((message) => message.role === "tool").length;
    if (tools === 0) return { toolCalls: [read] };
    if (tools <= calls.length) return { toolCalls: [calls[tools - 1]] };
    return { content: answer };
  };
}

/** An agent made from a template, on the route, with the grants (and any change to its definition). */
export function routedAgent(routed, { template = "server-keeper", grants = {}, model = {} } = {}) {
  const { h, route } = routed;
  const owner = h.caller("owner");
  const agent = h.service.createAgent(owner, { template });
  const spec = h.service.getAgent(owner, agent.id).spec;
  h.service.updateAgent(owner, agent.id, { spec: { ...spec, model: { ...spec.model, route, ...model }, allow: { ...spec.allow, ...(Object.keys(grants).length ? { grants } : {}) } } });
  return h.service.getAgent(owner, agent.id);
}
