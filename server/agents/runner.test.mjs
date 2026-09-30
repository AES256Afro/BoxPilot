// @vitest-environment node
/**
 * How the runner talks to a model on a CPU (M37), shown with the real service, tools and runner and
 * the stand-in model: which tools each call carries, that each call's prompt is the last one grown
 * so the model server reads only the new part, that thinking stays off, that a call's time comes
 * from the speed measured on this server, that a call given up on is stopped, and what a run that
 * ran out of time still answers with.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBench, ownerQuestion, ownerScript } from "../../test/agents-bench.mjs";
import { agentsRuntimeKey, defaultRuntimeSettings } from "./service.mjs";
import { toolCatalog } from "./tool-catalog.mjs";

let bench;
afterEach(async () => { await bench?.close(); bench = null; });

const names = (request) => (request.tools ?? []).map((tool) => tool.function.name);
const withSpec = (agent, change) => bench.h.service.updateAgent(bench.h.caller("owner"), agent.id, { spec: change(bench.h.store.getAgent(agent.id).spec) });

describe("the tools each call carries", () => {
  it("carries the plan's tools and the always-on ones, the same bytes from call to call, so each prompt is the last one grown", async () => {
    bench = await createBench({ promptPerSecond: 20, generatePerSecond: 4 });
    const result = await bench.ask(ownerQuestion);
    expect(result.run.state).toBe("completed");
    const [plan, ...act] = result.requests;
    expect(plan.tools ?? null).toBeNull();
    // Always-on first, then the plan's, each in the catalog's order: 8 of the 22 Steve may use.
    expect(result.claim.tools).toHaveLength(22);
    for (const request of act) expect(names(request)).toEqual(["memory_search", "plan_propose", "notify_owner", "agents_handoff", "apps_list", "services_status", "storage_health", "alerts_active"]);
    for (let index = 1; index < act.length; index += 1) {
      expect(act[index].tools).toEqual(act[0].tools);
      expect(act[index].messages.slice(0, act[index - 1].messages.length)).toEqual(act[index - 1].messages);
    }
    // The model server read only what each call added: the rest came from its cache.
    const calls = bench.h.fake.calls();
    for (let index = 2; index < calls.length; index += 1) expect(calls[index].cachedTokens, `call ${index}`).toBeGreaterThanOrEqual(calls[index - 1].promptTokens);
    expect(result.run.usage.cachedTokens).toBeGreaterThan(result.run.usage.readTokens);
  });

  it("caps them at ten when the plan names everything, keeping the always-on ones and the plan's first steps", async () => {
    const everything = toolCatalog.filter((tool) => !["web.search"].includes(tool.id)).map((tool) => ({ step: `Use ${tool.title}`, tool: tool.fn }));
    bench = await createBench({ promptPerSecond: 1_000, generatePerSecond: 100, script: { ...ownerScript, understanding: { ...ownerScript.understanding, plan: everything.slice(0, 5) } } });
    const planned = await bench.ask(ownerQuestion);
    // The plan's schema holds five steps: server.facts, apps.list, services.status, logs.query, storage.health;
    // the question's own words ("issue") point at alerts.active too, which is carried beside them (M40).
    expect(names(planned.requests[1])).toEqual(["memory_search", "plan_propose", "notify_owner", "agents_handoff", "server_facts", "apps_list", "services_status", "logs_query", "storage_health", "alerts_active"]);
    await bench.close();
    // An old reply with a long "tools" list is capped too.
    bench = await createBench({ promptPerSecond: 1_000, generatePerSecond: 100, script: { ...ownerScript, understanding: { ...ownerScript.understanding, tools: everything.map((entry) => entry.tool), plan: [] } } });
    const listed = await bench.ask(ownerQuestion);
    expect(names(listed.requests[1])).toHaveLength(10);
    expect(names(listed.requests[1]).slice(0, 4)).toEqual(["memory_search", "plan_propose", "notify_owner", "agents_handoff"]);
  });

  it("asks the model server to reuse its cache: cache_prompt always, slot 0 on a llama-server BoxPilot started, and a cancel id for Unsloth", async () => {
    bench = await createBench({ promptPerSecond: 1_000, generatePerSecond: 100 });
    const unsloth = await bench.ask(ownerQuestion);
    for (const request of unsloth.requests) {
      expect(request.extra).toMatchObject({ cache_prompt: true, cancel_id: expect.stringMatching(/^boxpilot-[0-9a-f-]{36}$/) });
      expect(request.extra.id_slot).toBeUndefined();
    }
    bench.h.state.setSetting(agentsRuntimeKey, { ...defaultRuntimeSettings(), driver: "llama-server" });
    const llama = await bench.ask(ownerQuestion);
    for (const request of llama.requests) {
      expect(request.extra).toMatchObject({ cache_prompt: true, id_slot: 0, chat_template_kwargs: { enable_thinking: false } });
      expect(request.extra.cancel_id).toBeUndefined();
    }
  });
});

describe("thinking", () => {
  it("stays off for every call unless the agent turns it on, and the plan never thinks", async () => {
    bench = await createBench({ promptPerSecond: 1_000, generatePerSecond: 100 });
    await bench.ask(ownerQuestion);
    for (const call of bench.h.fake.calls()) expect(call.thinking).toBe(false);
    for (const body of bench.h.fake.prompts()) {
      expect(body.enable_thinking).toBe(false);
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.chat_template_kwargs?.enable_thinking).not.toBe(true);
    }
    bench.h.fake.reset();
    withSpec(bench.keeper, (spec) => ({ ...spec, model: { thinking: true } }));
    await bench.ask(ownerQuestion);
    const [plan, ...act] = bench.h.fake.calls();
    expect(plan.thinking).toBe(false);
    expect(act.every((call) => call.thinking)).toBe(true);
  });
});

describe("each call's time", () => {
  it("is worked out from the speed BoxPilot measured before, and the new measurement is kept for the Usage tab and the next run", async () => {
    bench = await createBench({ promptPerSecond: 25, generatePerSecond: 5, stored: { promptPerSecond: 20, generatePerSecond: 4 } });
    const first = await bench.ask(ownerQuestion);
    // A person's question runs at eight threads (M40); with nothing measured at eight yet, the
    // four threads' speed plans its first call: slower, so no call is planned too short.
    expect(first.claim.runtime).toMatchObject({ threads: 8, speed: { promptPerSecond: 20, generatePerSecond: 4, threads: 4 } });
    // llama-server's own timings, as Unsloth passes them on: 25 read and 5 written a second.
    expect(first.run.usage.speed).toMatchObject({ promptPerSecond: 25, generatePerSecond: 5, threads: 8 });
    expect(bench.usage().modelSpeed).toMatchObject({ promptPerSecond: 25, generatePerSecond: 5, source: "server", model: "unsloth/Qwen3.5-4B-GGUF", threads: 8, runs: 2, byThreads: { 4: { promptPerSecond: 20 }, 8: { promptPerSecond: 25 } } });
    const second = await bench.ask(ownerQuestion);
    expect(second.claim.runtime.speed).toMatchObject({ promptPerSecond: 25, generatePerSecond: 5, threads: 8 });
  });

  it("is not started when it cannot fit in what the run has left, and the run answers from the tools the plan named", async () => {
    bench = await createBench({ promptPerSecond: 20, generatePerSecond: 4 });
    withSpec(bench.keeper, (spec) => ({ ...spec, budget: { ...spec.budget, runSeconds: 150 } }));
    const result = await bench.ask(ownerQuestion);
    expect(result.run).toMatchObject({ state: "degraded", flags: { degraded: "timeout" } });
    // The plan fit (75 s at 20 and 4 tokens a second); acting on it would not have, and the trace said so first.
    expect(result.requests).toHaveLength(1);
    expect(result.run.steps.find((step) => step.kind === "system" && step.state === "failed").flags.detail).toMatch(/^Not starting the next step: it needs about \d+ s \(\d+ tokens to read at 20 a second, then a short answer\) and the run has \d+ s left\.$/);
    // Alerts, storage, services and apps, as the plan said; not memory, and not BoxPilot's own documents.
    expect(result.run.steps.filter((step) => step.kind === "tool").map((step) => step.name)).toEqual(["alerts.active", "storage.health", "services.status", "apps.list"]);
    expect(result.run.answer).toMatch(/^The model took too long, so this is what the tools found/);
    expect(result.run.answer).toMatch(/reallocated sectors/);
    expect(result.run.answer).not.toMatch(/ROADMAP|DECISIONS/);
  });

  it("may use all the run has left: a call given up on is closed, the model server stops reading it, and Unsloth is asked to cancel it", async () => {
    bench = await createBench({ runnerOptions: { reserveMs: 0, minAnswerTokens: 1 }, stored: { promptPerSecond: 1_000_000, generatePerSecond: 1_000_000 } });
    // Real time now: a model that reads 300 tokens a second, so the plan's prompt takes about two seconds.
    Object.assign(bench.h.fake.state, { clock: null, speed: { promptPerSecond: 300, generatePerSecond: 1_000 } });
    withSpec(bench.keeper, (spec) => ({ ...spec, budget: { ...spec.budget, runSeconds: 30 } }));
    const started = Date.now();
    const result = await bench.ask(ownerQuestion, { beforeExecute: () => bench.h.advance(29_800) });
    expect(Date.now() - started).toBeLessThan(5_000);
    const [call] = bench.h.fake.calls();
    // The runner had what was left of the run (never less than a second): it closed the connection,
    // the stand-in stopped reading, and Unsloth's cancel was asked for.
    await expect.poll(() => call.stopped).toMatch(/^(closed|cancelled)$/);
    expect(call.readBeforeStop).toBeLessThan(call.readTokens);
    await expect.poll(() => bench.h.fake.state.cancels).toContain(call.cancelId);
    expect(result.run).toMatchObject({ state: "degraded", flags: { degraded: "timeout" } });
  });
});

describe("a structured answer", () => {
  it("is asked for again with the same prompt, held to the owner's JSON, when the model wrote prose", async () => {
    bench = await createBench({ promptPerSecond: 20, generatePerSecond: 4 });
    withSpec(bench.keeper, (spec) => ({ ...spec, prompt: { ...spec.prompt, output: { format: "json", fields: [{ name: "issue", description: "The most important issue" }, { name: "next", description: "What to do next" }] } } }));
    let asked = 0;
    bench.h.fake.state.script = (body) => {
      if (body.response_format?.json_schema?.name === "understanding") return { understanding: ownerScript.understanding };
      if (body.response_format?.json_schema?.name === "answer") return { content: JSON.stringify({ issue: "The backup drive is failing [T1].", next: "Replace it [T1]." }) };
      asked += 1;
      return asked === 1 ? { toolCalls: [{ name: "alerts_active", arguments: {} }] } : { content: "The backup drive is failing [T1]." };
    };
    const result = await bench.ask(ownerQuestion);
    expect(result.run.state).toBe("completed");
    expect(JSON.parse(result.run.answer)).toEqual({ issue: "The backup drive is failing [T1].", next: "Replace it [T1]." });
    const [answered, rewrite] = result.requests.slice(-2);
    expect(rewrite.messages).toEqual(answered.messages);
    expect(rewrite.tools).toEqual(answered.tools);
    expect(rewrite).toMatchObject({ toolChoice: "none", extra: { response_format: { json_schema: { name: "answer" } } } });
    // Read again: only the last few tokens, from the checkpoint llama-server keeps just before a prompt's end.
    expect(bench.h.fake.calls().at(-1).readTokens).toBeLessThanOrEqual(5);
  });
});
