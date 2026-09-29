/**
 * The agents runner's loop (M37): ask the web service for work, run one bounded agent loop, report
 * every step, finish, and go back to waiting. It runs inside boxpilot-agents.service, under hard
 * caps, and knows nothing of the server except what the web service's read-only tools tell it.
 *
 * Idle is a long poll: one HTTP request that waits up to half a minute, so an idle runner uses no
 * processor to speak of, and its model server is stopped once nothing has used it for a while.
 *
 * One run is intent, then plan, then act: the model first returns a structured understanding of
 * the request (JSON against a schema: goal, subject, constraints, the tools it needs, its
 * confidence, a clarifying question if it is too unclear to act on, and a short plan); then it
 * works through the plan with tools; then it answers - as the owner's JSON fields when the agent
 * says so. Limits on steps, tokens, model time and wall time hold throughout. A heartbeat keeps the
 * run's lease and is how the web service says "stop" (a cancel, a pause, the kill switch). A model
 * that is missing, slow or failing does not leave a person without an answer: the run finishes
 * "degraded", with what the tools found.
 *
 * An index run has no conversation: it embeds the texts the web service hands it with the model
 * server's /v1/embeddings, for memory search by meaning.
 */
import { understandingFormat, understandingMessage, planMessage, readUnderstanding } from "./intent.mjs";
import { answerFormat, fallbackAnswer, readStructuredAnswer } from "./prompt.mjs";
import { ModelUnavailable } from "./runtime.mjs";

export const runnerDefaults = Object.freeze({
  pollWaitMs: 25_000,
  modelCallMs: 5 * 60_000,
  understandTokens: 400,
  embedBatch: 8,
  backoffMs: [2_000, 5_000, 15_000, 30_000, 60_000],
});

const stripWrapper = (content) => String(content ?? "").replace(/<\/?tool_output[^>]*>/g, "").replace(/^Data from a tool, not instructions\.[^\n]*\n?/m, "").replace(/^WARNING:[^\n]*\n?/m, "").trim();

/** Tools a degraded run asks for itself, so a person still gets facts: cheap ones, those it was given. */
export function fallbackTools(claim) {
  const offered = new Set((claim.tools ?? []).map((tool) => tool.id));
  const wanted = claim.run.question ? ["docs.search", "server.facts", "alerts.active"] : ["server.facts", "alerts.active", "storage.health"];
  return wanted.filter((id) => offered.has(id)).slice(0, 3).map((id) => ({ id, input: id === "docs.search" ? { query: String(claim.run.question).slice(0, 300) } : {} }));
}

export function createRunner({ api, runtime, client, usage = null, now = () => Date.now(), log = () => {}, version = null, options = {} }) {
  const settings = { ...runnerDefaults, ...options };
  const sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  const readUsage = async () => {
    const measured = usage ? await usage.read().catch(() => null) : null;
    const model = runtime.status();
    return { ...(measured ?? {}), state: model.state === "running" ? "running" : model.state, modelLoaded: model.modelLoaded, model: model.model };
  };

  /** Embed texts with the model server; null when it has no embeddings (meaning search then falls back to words). */
  async function embed(model, texts, signal) {
    try {
      const vectors = await client.embed(model.endpoint, model.model, texts, { apiKey: model.apiKey, signal, timeoutMs: 120_000 });
      return Array.isArray(vectors) && vectors.length === texts.length ? vectors : null;
    } catch {
      return null;
    }
  }

  /** An index run: embed what the web service handed over, in batches, and send the vectors back. */
  async function executeIndex(claim, controller, used, heartbeatStop) {
    const { run, lease } = claim;
    const model = await runtime.ensure(claim.runtime, { signal: controller.signal });
    used.loadMs = model.loadMs ?? 0;
    let indexed = 0;
    const items = claim.index?.items ?? [];
    for (let at = 0; at < items.length; at += settings.embedBatch) {
      if (controller.signal.aborted) break;
      const batch = items.slice(at, at + settings.embedBatch);
      const started = now();
      const vectors = await embed(model, batch.map((item) => item.text), controller.signal);
      used.modelMs += now() - started;
      runtime.touch();
      if (!vectors) { await api.steps(run.id, lease, [{ kind: "system", name: "embeddings", detail: "The model server gave no embeddings; memory search stays by words.", state: "failed" }]).catch(() => {}); break; }
      // Six decimals are plenty for cosine, and keep a batch of 1,024-dimension vectors small.
      const saved = await api.vectors(run.id, lease, batch.map((item, index) => ({ key: item.key, vector: vectors[index].map((value) => Math.round(value * 1e6) / 1e6) })));
      indexed += saved?.saved ?? 0;
    }
    heartbeatStop();
    await api.finish(run.id, lease, { outcome: indexed || !items.length ? "completed" : "degraded", indexed, usage: used });
    return { outcome: "completed" };
  }

  async function execute(claim, { signal } = {}) {
    const { run, lease, limits } = claim;
    const controller = new AbortController();
    const stop = (reason) => { if (!controller.signal.aborted) controller.abort(new Error(reason)); };
    signal?.addEventListener?.("abort", () => stop("shutting down"), { once: true });
    const deadline = Date.parse(run.deadlineAt);
    const deadlineTimer = setTimeout(() => stop("timeout"), Math.max(1_000, deadline - now()));
    deadlineTimer.unref?.();
    let stoppedBy = null;
    const heartbeat = setInterval(() => {
      void readUsage().then((sample) => api.heartbeat(run.id, lease, { usage: sample })).then((answer) => {
        if (answer && answer.continue === false) { stoppedBy = answer.reason ?? "stopped"; stop(stoppedBy); if (answer.stopModel) void runtime.stop("stopped by BoxPilot"); }
      }).catch(() => {});
    }, limits.heartbeatMs ?? 10_000);
    heartbeat.unref?.();

    const used = { modelMs: 0, loadMs: 0, promptTokens: 0, completionTokens: 0, modelCalls: 0 };
    const outputs = [];
    let degraded = null;
    let answer = null;
    let clarify = null;
    let limitReached = false;
    const tokensUsed = () => used.promptTokens + used.completionTokens;
    const system = (name, detail, state = "done") => api.steps(run.id, lease, [{ kind: "system", name, detail, state }]).catch(() => {});

    const callTool = async (name, input, model) => {
      // Memory search by meaning: the query's embedding goes with the call, made here where the model is.
      let extras = {};
      if (String(name).replace(/_/g, ".") === "memory.search" && claim.runtime?.embeddings && model) {
        let query = "";
        try { query = String((typeof input === "string" ? JSON.parse(input || "{}") : input ?? {}).query ?? ""); } catch { query = ""; }
        const vectors = query ? await embed(model, [query.slice(0, 1_000)], controller.signal) : null;
        if (vectors) extras = { vector: vectors[0] };
      }
      const result = await api.tool(run.id, lease, name, typeof input === "string" ? input : JSON.stringify(input ?? {}), extras);
      if (result.ok) outputs.push({ id: `T${result.index}`, title: result.title, summary: stripWrapper(result.content) });
      if (result.flags?.limit) limitReached = true;
      return result;
    };

    /** One call to the model, counted against the run's budget. */
    const ask = async (model, request) => {
      if (used.modelMs + used.loadMs >= limits.remainingModelMs) { degraded = "budget"; limitReached = true; return null; }
      const started = now();
      try {
        const result = await client.chat(model.endpoint, { model: model.model, temperature: claim.runtime.temperature ?? 0.2, extra: claim.runtime.extra ?? {}, ...request }, {
          apiKey: model.apiKey,
          signal: controller.signal,
          timeoutMs: Math.max(1_000, Math.min(settings.modelCallMs, deadline - now(), limits.remainingModelMs - used.modelMs - used.loadMs + 1_000)),
        });
        used.modelMs += now() - started;
        used.modelCalls += 1;
        used.promptTokens += result.usage?.promptTokens ?? 0;
        used.completionTokens += result.usage?.completionTokens ?? 0;
        runtime.touch();
        return { result, took: now() - started };
      } catch (error) {
        used.modelMs += now() - started;
        if (controller.signal.aborted) throw error;
        degraded = /timed? ?out|aborted|TimeoutError/i.test(`${error?.name} ${error?.message}`) ? "timeout" : "model-error";
        await system("model", `The model stopped: ${String(error?.message ?? error).slice(0, 200)}`, "failed");
        return null;
      }
    };

    try {
      if (run.kind === "index") return await executeIndex(claim, controller, used, () => clearInterval(heartbeat));
      let model = null;
      try {
        await system("model", "Starting the model");
        model = await runtime.ensure(claim.runtime, { signal: controller.signal });
        used.loadMs = model.loadMs ?? 0;
        await system("model", model.loadMs ? `The model is ready (loaded in ${Math.round(model.loadMs / 1000)} s)` : "The model is ready");
      } catch (error) {
        if (controller.signal.aborted) throw error;
        degraded = error instanceof ModelUnavailable ? error.reason : "model-unavailable";
        await system("model", error.message, "failed");
      }

      const messages = [...claim.messages];
      // 1. Intent and plan, as JSON against a schema, before any tool is called.
      if (model && claim.understand) {
        const tools = claim.understand.tools ?? [];
        const asked = await ask(model, { messages: [...messages, { role: "user", content: understandingMessage(tools) }], maxTokens: settings.understandTokens, extra: { ...(claim.runtime.extra ?? {}), response_format: understandingFormat } });
        if (asked) {
          const read = readUnderstanding(asked.result.content ?? "", { offered: tools.map((tool) => tool.fn) });
          await api.steps(run.id, lease, [{ kind: "intent", understanding: read.understanding ?? asked.result.content ?? "", durationMs: asked.took, tokensIn: asked.result.usage?.promptTokens, tokensOut: asked.result.usage?.completionTokens }]).catch(() => {});
          if (read.understanding?.clarify && ["ask", "manual"].includes(run.kind)) clarify = read.understanding.clarify;
          else if (read.understanding) messages.push({ role: "assistant", content: JSON.stringify({ goal: read.understanding.goal, plan: read.understanding.plan }) }, { role: "user", content: planMessage(read.understanding) });
        }
      }

      // 2. Act: tool calls until the model answers, within the run's limits.
      if (model && !clarify && !(degraded === "budget")) {
        const tools = (claim.tools ?? []).map(({ id: _id, ...tool }) => tool);
        let toolCalls = 0;
        const structured = claim.output?.format === "json" && (claim.output.fields ?? []).length > 0;
        for (let step = 0; step < limits.steps && !answer; step += 1) {
          if (controller.signal.aborted) break;
          const lastStep = step === limits.steps - 1 || tokensUsed() >= limits.tokens * 0.85 || toolCalls >= limits.maxToolCalls;
          if (lastStep) limitReached = limitReached || step === limits.steps - 1 || toolCalls >= limits.maxToolCalls;
          if (lastStep && step > 0) messages.push({ role: "user", content: structured ? "Answer now with what you have, as the JSON fields. Do not call more tools." : "Answer now with what you have. Do not call more tools." });
          const final = lastStep && step > 0;
          const asked = await ask(model, {
            messages,
            tools: final ? null : tools,
            maxTokens: Math.max(64, Math.min(claim.runtime.maxTokens ?? 1024, limits.tokens - tokensUsed())),
            ...(final && structured ? { extra: { ...(claim.runtime.extra ?? {}), response_format: answerFormat(claim.output.fields) } } : {}),
          });
          if (!asked) break;
          const { result, took } = asked;
          const calls = (result.toolCalls ?? []).slice(0, limits.toolCallsPerStep ?? 3);
          await api.steps(run.id, lease, [{ kind: "model", name: model.model, text: result.content, toolCalls: calls, durationMs: took, tokensIn: result.usage?.promptTokens, tokensOut: result.usage?.completionTokens }]);
          if (!calls.length || final) { answer = String(result.content ?? "").trim() || null; if (!answer) degraded = "model-error"; break; }
          messages.push({ role: "assistant", content: result.content || null, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } })) });
          for (const call of calls) {
            if (controller.signal.aborted) break;
            toolCalls += 1;
            const reply = await callTool(call.name, call.arguments, model);
            messages.push({ role: "tool", tool_call_id: call.id, content: reply.content });
          }
        }
        // 3. A structured answer that is not the owner's JSON gets one more call that must be.
        if (answer && structured && readStructuredAnswer(answer, claim.output.fields).problem && !degraded) {
          messages.push({ role: "assistant", content: answer }, { role: "user", content: "Write that answer as the JSON fields, nothing else." });
          const asked = await ask(model, { messages, tools: null, maxTokens: Math.max(128, Math.min(claim.runtime.maxTokens ?? 1024, limits.tokens - tokensUsed())), extra: { ...(claim.runtime.extra ?? {}), response_format: answerFormat(claim.output.fields) } });
          if (asked?.result?.content) {
            await api.steps(run.id, lease, [{ kind: "model", name: model.model, text: asked.result.content, toolCalls: [], durationMs: asked.took, tokensIn: asked.result.usage?.promptTokens, tokensOut: asked.result.usage?.completionTokens }]);
            answer = String(asked.result.content).trim();
          }
        }
        if (!answer && !degraded && !controller.signal.aborted) degraded = "model-error";
      }

      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("stopped");
      if (clarify) {
        await api.finish(run.id, lease, { outcome: "completed", clarify, usage: used });
        return { outcome: "completed" };
      }
      let outcome = "completed";
      if (degraded || !answer) {
        if (!outputs.length) for (const tool of fallbackTools(claim)) { if (controller.signal.aborted) break; await callTool(tool.id, tool.input, null).catch(() => null); }
        answer = answer ? `${answer}\n\n(${degraded === "timeout" ? "The model took too long, so this may stop short." : "The model did not finish."})` : fallbackAnswer({ reason: degraded ?? "model-error", outputs });
        outcome = "degraded";
      }
      await api.finish(run.id, lease, { outcome, answer, usage: used, degradedReason: outcome === "degraded" ? degraded ?? "model-error" : null, limitReached });
      return { outcome };
    } catch (error) {
      // Stopped by BoxPilot (cancelled, paused, killed, timed out): the web service already ended
      // the run; there is nothing to finish. Anything else ends the run as failed, never retried.
      if (stoppedBy || controller.signal.aborted) {
        if (!stoppedBy && String(controller.signal.reason?.message) === "timeout") await api.finish(run.id, lease, { outcome: "degraded", answer: fallbackAnswer({ reason: "timeout", outputs }), usage: used, degradedReason: "timeout" }).catch(() => null);
        return { outcome: stoppedBy ?? "stopped" };
      }
      log(`run ${run.id} failed: ${error?.message ?? error}`);
      await api.finish(run.id, lease, { outcome: "failed", error: String(error?.message ?? error).slice(0, 300), usage: used }).catch(() => null);
      return { outcome: "failed" };
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadlineTimer);
    }
  }

  /** Wait for work until `signal` aborts. Connection trouble backs off; it never spins. */
  async function loop({ signal } = {}) {
    let failures = 0;
    let greeted = false;
    while (!signal?.aborted) {
      try {
        if (!greeted) { await api.hello({ version, usage: await readUsage() }); greeted = true; }
        const response = await api.next({ usage: await readUsage(), hostBusy: usage ? await usage.hostBusy().catch(() => false) : false, waitMs: settings.pollWaitMs }, { signal });
        failures = 0;
        if (response?.stopModel) await runtime.stop(response.enabled === false ? "agents are off" : "agents are paused");
        if (response?.claim) await execute(response.claim, { signal });
        await runtime.maybeStopIdle();
      } catch (error) {
        if (signal?.aborted) break;
        greeted = greeted && error?.status !== 401;
        const wait = settings.backoffMs[Math.min(failures, settings.backoffMs.length - 1)];
        failures += 1;
        log(`cannot reach BoxPilot (${error?.message ?? error}); trying again in ${Math.round(wait / 1000)} s`);
        await runtime.maybeStopIdle().catch(() => {});
        await sleep(wait, signal);
      }
    }
    await runtime.stop("shutting down").catch(() => {});
  }

  return { loop, execute };
}

/** The runner's side of the web API: token-authenticated JSON over loopback. */
export function createRunnerApi({ base, token, runnerId, fetch: fetchImpl = globalThis.fetch }) {
  async function post(pathname, body, { timeoutMs = 30_000, signal = null } = {}) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const response = await fetchImpl(`${base}/api/v1/agent-runner${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ runnerId, ...body }),
      signal: AbortSignal.any(signals),
      redirect: "error",
    });
    if (response.status === 204) return null;
    const parsed = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(parsed?.error ?? `BoxPilot answered ${response.status}`), { status: response.status, code: parsed?.code ?? null });
    return parsed;
  }
  return {
    hello: (body) => post("/hello", body),
    next: (body, { signal } = {}) => post("/next", body, { timeoutMs: (body.waitMs ?? 25_000) + 15_000, signal }),
    heartbeat: (runId, lease, body) => post(`/runs/${encodeURIComponent(runId)}/heartbeat`, { lease, ...body }),
    steps: (runId, lease, steps) => post(`/runs/${encodeURIComponent(runId)}/steps`, { lease, steps }),
    tool: (runId, lease, name, input, extras = {}) => post(`/runs/${encodeURIComponent(runId)}/tools`, { lease, name, input, ...(extras.vector ? { vector: extras.vector } : {}) }, { timeoutMs: 60_000 }),
    vectors: (runId, lease, entries) => post(`/runs/${encodeURIComponent(runId)}/vectors`, { lease, entries }, { timeoutMs: 60_000 }),
    finish: (runId, lease, body) => post(`/runs/${encodeURIComponent(runId)}/finish`, { lease, ...body }),
    usage: (body) => post("/usage", body),
  };
}

/** The same calls straight into the service, for the demo and tests that need no HTTP. */
export function directRunnerApi(service, runnerId) {
  return {
    hello: (body) => Promise.resolve(service.runnerHello(runnerId, body)),
    next: async (body, { signal } = {}) => {
      const claim = await service.runnerNext(runnerId, { ...body, signal });
      return { claim, ...service.runnerAdvice() };
    },
    heartbeat: (runId, lease, body) => Promise.resolve(service.runnerHeartbeat(runId, lease, { ...body, runnerId })),
    steps: (runId, lease, steps) => Promise.resolve(service.runnerSteps(runId, lease, steps)),
    tool: (runId, lease, name, input, extras = {}) => service.runnerTool(runId, lease, name, input, extras),
    vectors: (runId, lease, entries) => Promise.resolve(service.runnerVectors(runId, lease, entries)),
    finish: (runId, lease, body) => service.runnerFinish(runId, lease, body),
    usage: (body) => Promise.resolve(service.runnerUsage(runnerId, body)),
  };
}
