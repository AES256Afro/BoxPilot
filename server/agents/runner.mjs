/**
 * The agents runner's loop (M37): ask the web service for work, run one bounded agent loop, report
 * every step, finish, and go back to waiting. It runs inside boxpilot-agents.service, under hard
 * caps, and knows nothing of the server except what the web service's read-only tools tell it.
 *
 * Idle is a long poll: one HTTP request that waits up to half a minute, so an idle runner uses no
 * processor to speak of, and its model server is stopped once nothing has used it for a while.
 *
 * One run is a small loop - plan, call tools, answer - with limits on steps, tokens, model time and
 * wall time. A heartbeat keeps the run's lease and is how the web service says "stop" (a cancel, a
 * pause, the kill switch). A model that is missing, slow or failing does not leave a person
 * without an answer: the run finishes "degraded", with what the tools found.
 */
import { fallbackAnswer } from "./prompt.mjs";
import { ModelUnavailable } from "./runtime.mjs";

export const runnerDefaults = Object.freeze({
  pollWaitMs: 25_000,
  modelCallMs: 5 * 60_000,
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
    const tokensUsed = () => used.promptTokens + used.completionTokens;
    const system = (name, detail, state = "done") => api.steps(run.id, lease, [{ kind: "system", name, detail, state }]).catch(() => {});

    const callTool = async (name, input) => {
      const result = await api.tool(run.id, lease, name, typeof input === "string" ? input : JSON.stringify(input ?? {}));
      if (result.ok) outputs.push({ id: `T${result.index}`, title: result.title, summary: stripWrapper(result.content) });
      return result;
    };

    try {
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

      if (model) {
        const messages = [...claim.messages];
        const tools = (claim.tools ?? []).map(({ id: _id, ...tool }) => tool);
        let toolCalls = 0;
        for (let step = 0; step < limits.steps && !answer; step += 1) {
          if (controller.signal.aborted) break;
          if (used.modelMs + used.loadMs >= limits.remainingModelMs) { degraded = "budget"; break; }
          const lastStep = step === limits.steps - 1 || tokensUsed() >= limits.tokens * 0.85 || toolCalls >= limits.maxToolCalls;
          if (lastStep && step > 0) messages.push({ role: "user", content: "Answer now with what you have. Do not call more tools." });
          const started = now();
          let result;
          try {
            result = await client.chat(model.endpoint, {
              model: model.model,
              messages,
              tools: lastStep && step > 0 ? null : tools,
              temperature: claim.runtime.temperature ?? 0.2,
              maxTokens: Math.max(64, Math.min(claim.runtime.maxTokens ?? 1024, limits.tokens - tokensUsed())),
              extra: claim.runtime.extra ?? {},
            }, {
              apiKey: model.apiKey,
              signal: controller.signal,
              timeoutMs: Math.max(1_000, Math.min(settings.modelCallMs, deadline - now(), limits.remainingModelMs - used.modelMs - used.loadMs + 1_000)),
            });
          } catch (error) {
            used.modelMs += now() - started;
            if (controller.signal.aborted) throw error;
            degraded = /timed? ?out|aborted|TimeoutError/i.test(`${error?.name} ${error?.message}`) ? "timeout" : "model-error";
            await system("model", `The model stopped: ${String(error?.message ?? error).slice(0, 200)}`, "failed");
            break;
          }
          const took = now() - started;
          used.modelMs += took;
          used.modelCalls += 1;
          used.promptTokens += result.usage?.promptTokens ?? 0;
          used.completionTokens += result.usage?.completionTokens ?? 0;
          runtime.touch();
          const calls = (result.toolCalls ?? []).slice(0, limits.toolCallsPerStep ?? 3);
          await api.steps(run.id, lease, [{ kind: "model", name: model.model, text: result.content, toolCalls: calls, durationMs: took, tokensIn: result.usage?.promptTokens, tokensOut: result.usage?.completionTokens }]);
          if (!calls.length || (lastStep && step > 0)) { answer = String(result.content ?? "").trim() || null; if (!answer) degraded = "model-error"; break; }
          messages.push({ role: "assistant", content: result.content || null, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } })) });
          for (const call of calls) {
            if (controller.signal.aborted) break;
            toolCalls += 1;
            const reply = await callTool(call.name, call.arguments);
            messages.push({ role: "tool", tool_call_id: call.id, content: reply.content });
          }
        }
        if (!answer && !degraded && !controller.signal.aborted) degraded = "model-error";
      }

      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("stopped");
      let outcome = "completed";
      if (degraded || !answer) {
        if (!outputs.length) for (const tool of fallbackTools(claim)) { if (controller.signal.aborted) break; await callTool(tool.id, tool.input).catch(() => null); }
        answer = answer ? `${answer}\n\n(${degraded === "timeout" ? "The model took too long, so this may stop short." : "The model did not finish."})` : fallbackAnswer({ reason: degraded ?? "model-error", outputs });
        outcome = "degraded";
      }
      await api.finish(run.id, lease, { outcome, answer, usage: used, degradedReason: outcome === "degraded" ? degraded ?? "model-error" : null });
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
    tool: (runId, lease, name, input) => post(`/runs/${encodeURIComponent(runId)}/tools`, { lease, name, input }, { timeoutMs: 60_000 }),
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
    tool: (runId, lease, name, input) => service.runnerTool(runId, lease, name, input),
    finish: (runId, lease, body) => service.runnerFinish(runId, lease, body),
    usage: (body) => Promise.resolve(service.runnerUsage(runnerId, body)),
  };
}
