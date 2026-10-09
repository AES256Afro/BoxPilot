/**
 * The agents runner's loop (M37): ask the web service for work, run one bounded agent loop, report
 * every step, finish, and go back to waiting. It runs inside boxpilot-agents.service, under hard
 * caps, and knows nothing of the server except what the web service's read-only tools tell it.
 *
 * Idle is a long poll: one HTTP request that waits up to half a minute, so an idle runner uses no
 * processor to speak of, and its model server is stopped once nothing has used it for a while.
 *
 * One run is intent, then plan, then act: the model first returns a structured understanding of
 * the request (JSON against a schema: goal, subject, constraints, confidence, a clarifying question
 * if it is too unclear to act on, and a short plan naming the tools it needs); then it works
 * through the plan with those tools; then it answers - as the owner's JSON fields when the agent
 * says so. Limits on steps, tokens, model time and wall time hold throughout. A heartbeat keeps the
 * run's lease and is how the web service says "stop" (a cancel, a pause, the kill switch). A model
 * that is missing, slow or failing does not leave a person without an answer: the run finishes
 * "degraded", with what the tools the plan named found.
 *
 * On a CPU, reading the prompt is most of the time (the first real run read at about 20 tokens a
 * second on one thread), so every call is built to be read once:
 * - The planner is a small conversation of its own whose system message is the same for every run
 *   of an agent (intent.mjs). The calls that act are one conversation that only grows at its end:
 *   tools, then BoxPilot's rules and the agent's prompt, then the task and the plan, then each
 *   tool round. Qwen's template renders the tools at the very top, so the tools are chosen once, by
 *   the plan, and kept in the catalog's order for every call after it - the last answer, a forced
 *   one ("tool_choice": "none" keeps the tools in the prompt) and a JSON rewrite included. Nothing
 *   is ever inserted before the end, and no user message is added after a tool round (Qwen then
 *   drops its earlier turns' empty think blocks, which would change the prompt behind them).
 * - `cache_prompt` is asked for (Unsloth drops the field and llama-server has it on anyway), and on
 *   a llama-server the runner started, slot 0: the only one.
 * - Each call's time is worked out from the tokens it will read and write at this server's
 *   measured speed (llama-server's `timings`, which Unsloth passes on, or the runner's own clock),
 *   within what the run and the day's model time have left. A call that cannot fit is not started,
 *   and the trace says why. The speeds go back to BoxPilot with the run's usage.
 * - A call given up on is closed, which stops llama-server at its next batch, and Unsloth is asked
 *   to cancel it by the `cancel_id` it carried.
 *
 * An index run has no conversation: it embeds the texts the web service hands it with the model
 * server's /v1/embeddings, for memory search by meaning.
 *
 * Since M45.8 the pacing, the acting and the check are the harness's (packages/harness/src/core:
 * session.mjs and loop.mjs). This file is BoxPilot's host around them: the claim, the model
 * server, the planner, the router's moves, the tools over the web API, the trace and the finish.
 */
import { randomUUID } from "node:crypto";
import { act, createModelSession, createOpenAiCompatibleProvider, createSpeed, defineProvider, fallsBack, moveAfterPlan, paceDefaults, selectExamples, thinkingOff } from "../../packages/harness/src/index.mjs";
import { webPortOf } from "../env-file.mjs";
import { planMessage, plannerMessages, readUnderstanding, understandingFormatFor } from "./intent.mjs";
import { answerNowNote, fallbackAnswer } from "./prompt.mjs";
import { ModelUnavailable } from "./runtime.mjs";
import { actToolIds, toolById, toolCatalog, toolsForQuestion } from "./tool-catalog.mjs";

export const runnerDefaults = Object.freeze({
  pollWaitMs: 25_000,
  understandTokens: 400,
  embedBatch: 8,
  backoffMs: [2_000, 5_000, 15_000, 30_000, 60_000],
  // How a call's time is worked out (the harness's pace.mjs): before this server's model has been
  // measured, the spike's one-processor speeds, slow on purpose; the reserve kept for the finish;
  // the margin a call must fit with; how long a tool's output may take to read; the correction's room.
  ...paceDefaults,
});

const stripWrapper = (content) => String(content ?? "").replace(/<\/?tool_output[^>]*>/g, "").replace(/^Data from a tool, not instructions\.[^\n]*\n?/m, "").replace(/^WARNING:[^\n]*\n?/m, "").trim();

// Tools a degraded run may run itself: reads of the server that need no words from the model.
const fallbackCategories = new Set(["boxpilot", "records", "app"]);
/** The tools that propose or make a change: a plan that names one moves an auto run to Claude (M45.4, M45.5). */
const changingTools = new Set(toolCatalog.filter((tool) => tool.writes === "proposal" || tool.writes === "job").map((tool) => tool.id));
const needsInput = (tool) => Object.values(tool.params ?? {}).some((spec) => spec.required);
const howTo = /\b(how (do|can|to|should)|where (do|can) i|what does .{1,40} do|explain|boxpilot'?s? (roadmap|docs?|documentation|page|feature))\b/i;

/**
 * Tools a degraded run asks for itself, so a person still gets facts: the reads its plan named
 * (alerts, storage, services, apps...), or cheap facts when there was no plan. docs.search only
 * when the plan named it or the question is how to do something in BoxPilot.
 */
export function fallbackTools(claim, understanding = null) {
  const offered = new Set((claim.tools ?? []).map((tool) => tool.id));
  const question = claim.run?.question ? String(claim.run.question) : "";
  // What the question's own words point at first, then what the plan named.
  const hinted = toolsForQuestion(question, offered);
  const planned = [...new Set([...hinted, ...(understanding?.tools ?? [])])].map((id) => toolById(id)).filter((tool) => tool && offered.has(tool.id));
  let picked = planned.filter((tool) => (fallbackCategories.has(tool.category) && !needsInput(tool) && !tool.writes) || tool.id === "docs.search").map((tool) => tool.id);
  if (!picked.length) picked = ["server.facts", "alerts.active", "storage.health", ...(question && howTo.test(question) ? ["docs.search"] : [])].filter((id) => offered.has(id));
  return picked.slice(0, 4).map((id) => ({ id, input: id === "docs.search" ? { query: question.slice(0, 300) || "status" } : {} }));
}

export function createRunner({ api, runtime, client, usage = null, now = () => Date.now(), log = () => {}, version = null, options = {} }) {
  const settings = { ...runnerDefaults, ...options };
  // The runner's shutdown signal lives as long as the process, so a listener left on it is kept
  // forever, with everything its closure holds: each sleep and each run takes its own off again.
  const sleep = (ms, signal) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener?.("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener?.("abort", done, { once: true });
  });
  const readUsage = async () => {
    const measured = usage ? await usage.read().catch(() => null) : null;
    const model = runtime.status();
    return { ...(measured ?? {}), state: model.state === "running" ? "running" : model.state, modelLoaded: model.modelLoaded, model: model.model };
  };

  /** The harness provider for a run's model server: the same client, bound to its address and key. */
  const providerFor = (model) => createOpenAiCompatibleProvider({ client, endpoint: model.endpoint, apiKey: model.apiKey ?? null });

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

  /**
   * A describe run (M38): the model reads each image the web service handed over - one an image
   * from #agent-files - and says what it shows. No tools, no conversation, thinking off.
   */
  async function executeDescribe(claim, controller, used, heartbeatStop, { ownDeadline = () => false } = {}) {
    const { run, lease } = claim;
    const descriptions = [];
    let error = null;
    let sight = null;
    try {
      const model = await runtime.ensure(claim.runtime, { signal: controller.signal });
      used.loadMs = model.loadMs ?? 0;
      // M40.6: a model server started without its vision projector cannot see; the images wait for
      // one that can, instead of each spending a try (and model time) on an error.
      sight = await runtime.vision?.().catch(() => null) ?? null;
      if (sight?.vision === false) {
        heartbeatStop();
        await api.finish(run.id, lease, { outcome: "failed", descriptions: [], usage: used, vision: sight, error: `The model server cannot see images: ${sight.reason}` });
        return { outcome: "failed" };
      }
      for (const item of claim.describe?.items ?? []) {
        if (controller.signal.aborted) break;
        const started = now();
        try {
          const result = await client.chat(model.endpoint, {
            model: model.model, temperature: 0.2, maxTokens: 320, extra: thinkingOff(claim.runtime.extra ?? {}),
            messages: [{ role: "user", content: [{ type: "text", text: String(claim.describe.prompt ?? "Describe this image.") }, { type: "image_url", image_url: { url: item.dataUrl } }] }],
          }, { apiKey: model.apiKey, signal: controller.signal, timeoutMs: Math.max(30_000, Date.parse(run.deadlineAt) - now()) });
          used.modelCalls += 1;
          used.promptTokens += result.usage?.promptTokens ?? 0;
          used.completionTokens += result.usage?.completionTokens ?? 0;
          descriptions.push({ key: item.key, text: typeof result.content === "string" ? result.content.slice(0, 4_000) : null });
        } catch (failed) {
          if (controller.signal.aborted) throw failed;
          descriptions.push({ key: item.key, text: null });
          error = String(failed?.message ?? failed).slice(0, 200);
        } finally {
          used.modelMs += now() - started;
          runtime.touch();
        }
      }
    } catch (failed) {
      error = String(failed?.message ?? failed).slice(0, 200);
    }
    // Failed before the model saw an image (it could not be started, say): each image handed over
    // still spends one of its tries, or one whose model never starts would be handed over every
    // night and never given up on (2026-10 sweep). Not when BoxPilot stopped the run - but the
    // run's own deadline is no stop of BoxPilot's: an image too slow to describe spends its tries
    // like one that failed (2026-10 sweep 2).
    if (!controller.signal.aborted || ownDeadline()) {
      for (const item of claim.describe?.items ?? []) if (!descriptions.some((entry) => entry.key === item.key)) descriptions.push({ key: item.key, text: null });
    }
    heartbeatStop();
    const described = descriptions.filter((entry) => entry.text).length;
    // What the model server said about seeing, or - when it did not say - what describing showed:
    // llama-server without --mmproj refuses an image with "image input is not supported".
    const refused = !described && /image input is not supported|mmproj|vision projector|does not support (?:image|vision)/i.test(error ?? "");
    const vision = sight?.vision !== null && sight?.vision !== undefined ? sight
      : described ? { vision: true, reason: "it described an image" }
        : refused ? { vision: false, reason: `the model server refused the image: ${error}` } : sight;
    await api.finish(run.id, lease, { outcome: described ? "completed" : "failed", descriptions, usage: used, ...(vision ? { vision } : {}), ...(described ? {} : { error: error ?? "The model described nothing" }) });
    return { outcome: described ? "completed" : "failed" };
  }

  async function execute(claim, { signal } = {}) {
    const { run, lease, limits } = claim;
    const controller = new AbortController();
    const stop = (reason) => { if (!controller.signal.aborted) controller.abort(new Error(reason)); };
    // Removed when the run ends: it holds the claim (messages, tool schemas, a describe's images) and
    // every output, and three hundred runs a day on the process's own signal kept every one of them.
    const onShutdown = () => stop("shutting down");
    signal?.addEventListener?.("abort", onShutdown, { once: true });
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

    const used = { modelMs: 0, loadMs: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, readTokens: 0, modelCalls: 0 };
    // A supervisor's follow-up starts with its specialists' answers as T1, T2 ... (sweep 3): what the
    // check holds a claim citing one to, and what a degraded answer is made of, rather than other reads.
    const outputs = (Array.isArray(claim.handoffs) ? claim.handoffs : []).map((entry) => ({ id: String(entry.id), title: String(entry.title ?? "A specialist's answer"), summary: String(entry.text ?? "") }));
    // The run's state, shared with the harness's session and loop (M45.8): why it is degraded, and
    // which limit it reached first - its steps, its tool calls or its tokens (said on the card, M44).
    const state = { degraded: null, limitReached: false, limitKind: null };
    let answer = null;
    let clarify = null;
    let understanding = null;
    let check = null;
    // The boxes only BoxPilot writes that the model wrote into its answer (A-1): taken out before the
    // check, so what it made up is never checked as if it were the answer, and told to BoxPilot.
    const boxes = [];
    // Other agents' findings it was offered before planning (M44): sources the check holds claims to.
    const findingSources = (claim.findings ?? []).map((finding) => ({ id: finding.id, title: finding.title, text: finding.text }));
    // The run's work in tokens: what the model read (not what it had cached) and what it wrote.
    const tokensUsed = () => used.readTokens + used.completionTokens;
    const system = (name, detail, state = "done") => api.steps(run.id, lease, [{ kind: "system", name, detail, state }]).catch(() => {});
    const record = (step) => api.steps(run.id, lease, [step]);
    // The model the run is on, which may change while it runs (M45.4): an auto run moves to Claude
    // after its plan, and a run on Claude goes on with the local model when Claude stops answering.
    // Each has its own pace; only the local model's is this server's, and only it is reported back.
    let driver = claim.runtime?.driver ?? null;
    let current = claim.runtime ?? {};
    const localRuntime = claim.router?.local ?? (driver === "claude" ? null : claim.runtime);
    const claudeRuntime = claim.router?.claude ?? (driver === "claude" ? claim.runtime : null);
    const speedOf = (runtimeClaim) => createSpeed(runtimeClaim?.speed?.promptPerSecond > 0 && runtimeClaim?.speed?.generatePerSecond > 0
      ? { promptPerSecond: runtimeClaim.speed.promptPerSecond, generatePerSecond: runtimeClaim.speed.generatePerSecond, source: "stored" }
      : { promptPerSecond: settings.promptPerSecond, generatePerSecond: settings.generatePerSecond });
    const speeds = { local: speedOf(localRuntime), claude: speedOf(claudeRuntime) };

    /** How much of the run is left for the model: the deadline (less the reserve) and the day's model time. */
    const timeLeft = () => {
      const byDeadline = deadline - now() - settings.reserveMs;
      const byBudget = limits.remainingModelMs - used.modelMs - used.loadMs;
      return { ms: Math.min(byDeadline, byBudget), binding: byBudget < byDeadline ? "budget" : "timeout" };
    };

    /**
     * Every call to plan, act or correct goes through the harness's model session (M45.1, M45.8): the
     * local provider binds this model server's address and key, each call's time is worked out from
     * this server's measured speed before it starts, and the answer is held to one shape. Unsloth is
     * asked to cancel a call given up on by the `cancel_id` it carried; llama-server keeps slot 0.
     */
    let fellBack = false;
    const session = createModelSession({
      signal: controller.signal, now, run: state, used, pace: settings, timeLeft, note: system,
      providerOf: (model) => model.provider ?? providerFor(model),
      fieldsFor: () => {
        const cancelId = driver === "unsloth" || driver === "fake" ? `boxpilot-${randomUUID()}` : null;
        return { cancelId, fields: { cache_prompt: true, ...(driver === "llama-server" ? { id_slot: 0 } : {}), ...(cancelId ? { cancel_id: cancelId } : {}) } };
      },
      called: () => { if (driver !== "claude") runtime.touch(); },
      // Claude did not answer and the local model can (M45.4): the same call again, there.
      recover: async (error) => Boolean(await fallBack(error)),
    });
    const useModel = (model, runtimeClaim, pace) => {
      driver = runtimeClaim?.driver ?? null;
      current = runtimeClaim ?? {};
      session.use(model, { settings: current, speed: pace });
    };
    session.use(null, { settings: current, speed: driver === "claude" ? speeds.claude : speeds.local });

    // `model`: the model to embed a memory search's query with; none for the tools a degraded run asks for itself.
    const callTool = async (name, input, model = session.model) => {
      // Memory search by meaning: the query's embedding goes with the call, made here where the model is.
      let extras = {};
      if (toolById(String(name))?.id === "memory.search" && current.embeddings && model) {
        let query = "";
        try { query = String((typeof input === "string" ? JSON.parse(input || "{}") : input ?? {}).query ?? ""); } catch { query = ""; }
        const vectors = query ? await embed(model, [query.slice(0, 1_000)], controller.signal) : null;
        if (vectors) extras = { vector: vectors[0] };
      }
      const result = await api.tool(run.id, lease, name, typeof input === "string" ? input : JSON.stringify(input ?? {}), extras);
      if (result.ok) outputs.push({ id: `T${result.index}`, title: result.title, summary: stripWrapper(result.content) });
      if (result.flags?.limit) { state.limitReached = true; state.limitKind ??= "toolCalls"; }
      return result;
    };

    /**
     * Claude, as this run reaches it (M45.3): no model server here. Each call goes to BoxPilot, which
     * sends it to the model gateway with the house's names replaced and turns the answer back.
     * `reason` is why the run moved there, told to BoxPilot with each call (M45.4).
     */
    const claudeModel = (reason) => ({
      model: claudeRuntime.model, loadMs: 0,
      provider: defineProvider({ id: "claude", kind: "remote", chat: (request, options = {}) => api.model(run.id, lease, request, { ...options, ...(reason ? { reason } : {}) }) }),
    });

    /** An auto run moves to Claude (M45.4): what failed on the local model is Claude's to do now. */
    const moveToClaude = async (reason) => {
      useModel(claudeModel(reason), claudeRuntime, speeds.claude);
      if (state.degraded === "model-unavailable" || state.degraded === "model-error") state.degraded = null;
      await system("model", `Moved to ${claudeRuntime.model}: ${reason}.`);
    };

    /**
     * Claude stopped answering partway (M45.4): its gateway down, its cap spent, the key refused. The
     * run goes on with the local model, from the same conversation, once: that model, when it can.
     */
    const fallBack = async (error) => {
      if (fellBack || driver !== "claude" || !localRuntime) return null;
      const code = String(error?.code ?? "").replace(/^model_/, "");
      if (!fallsBack(code === "not_cloud" ? "not-connected" : code)) return null;
      fellBack = true;
      await system("model", `Claude did not answer (${String(error?.message ?? error).slice(0, 160)}): going on with the local model.`, "failed");
      try {
        const loaded = await runtime.ensure(localRuntime, { signal: controller.signal });
        used.loadMs += loaded.loadMs ?? 0;
        useModel(loaded, localRuntime, speeds.local);
        await system("model", loaded.loadMs ? `The local model is ready (loaded in ${Math.round(loaded.loadMs / 1000)} s)` : "The local model is ready");
        return loaded;
      } catch (failed) {
        if (controller.signal.aborted) throw failed;
        await system("model", failed.message, "failed");
        return null;
      }
    };

    try {
      if (run.kind === "index") return await executeIndex(claim, controller, used, () => clearInterval(heartbeat));
      if (run.kind === "describe") return await executeDescribe(claim, controller, used, () => clearInterval(heartbeat), { ownDeadline: () => !stoppedBy && String(controller.signal.reason?.message) === "timeout" });
      if (driver === "claude") {
        useModel(claudeModel(null), current, speeds.claude);
      } else {
        try {
          await system("model", "Starting the model");
          const loaded = await runtime.ensure(claim.runtime, { signal: controller.signal });
          used.loadMs = loaded.loadMs ?? 0;
          useModel(loaded, current, speeds.local);
          await system("model", loaded.loadMs ? `The model is ready (loaded in ${Math.round(loaded.loadMs / 1000)} s)` : "The model is ready");
        } catch (error) {
          if (controller.signal.aborted) throw error;
          state.degraded = error instanceof ModelUnavailable ? error.reason : "model-unavailable";
          await system("model", error.message, "failed");
        }
        // An auto run whose local model could not start plans and acts on Claude instead (M45.4).
        if (!session.model && claim.router?.mode === "auto") {
          const decided = moveAfterPlan({ localProblem: "model-unavailable" });
          if (decided.move) await moveToClaude(decided.reason);
        }
      }

      const task = claim.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n\n");
      // The tools the question's own words point at (M40): "where does X run" is where.runs, whatever the plan says.
      const hinted = toolsForQuestion(claim.run?.question ?? "", (claim.tools ?? []).map((tool) => tool.id));
      // 1. Intent and plan, as JSON against a schema, before any tool is called: a small conversation of its own.
      // What the router reads of it (M45.4): null when there was no plan to make or the call never answered.
      let planned = null;
      let shown = [];
      let queryVector = null;
      if (session.model && claim.understand) {
        const tools = claim.understand.tools ?? [];
        const hints = hinted.map((id) => toolById(id)).filter((tool) => tool && tools.some((entry) => entry.fn === tool.fn)).map((tool) => ({ fn: tool.fn, title: tool.title }));
        // Demonstrations (M46): a few of the agent's approved examples near this request, picked by
        // geometry (nearest, one from the other side of its decision, the rest spread) from the pool
        // the web service sent. The request is embedded here, where the model is, when the local
        // model has embeddings; without them the pick goes by words.
        const pool = claim.understand.examples?.candidates ?? [];
        // The request itself is what the examples are compared with: the question someone asked, or
        // what the trigger asked for, not the task message with its notes and findings around it.
        const request = String(claim.run?.question ?? claim.run?.trigger?.title ?? task).slice(0, 1_000);
        if (pool.length && driver !== "claude" && current.embeddings && session.model) {
          const started = now();
          const vectors = await embed(session.model, [request], controller.signal);
          used.modelMs += now() - started;
          if (vectors?.[0]) queryVector = vectors[0];
        }
        shown = pool.length ? selectExamples({ query: request, queryVector, candidates: pool, limit: claim.understand.examples?.limit ?? 3 }) : [];
        const planner = { tools: null, messages: plannerMessages(claim.agent ?? {}, tools, task, { hints, examples: shown }), last: null };
        const format = understandingFormatFor(tools.map((tool) => tool.fn));
        const asked = await session.ask(planner, { maxTokens: settings.understandTokens, extra: (runtimeClaim) => ({ ...thinkingOff(runtimeClaim.extra ?? {}), response_format: format }), purpose: "plan" });
        if (asked) {
          const read = readUnderstanding(asked.result.content ?? "", { offered: tools.map((tool) => tool.fn) });
          planned = read.understanding ? { read: true, confidence: read.understanding.confidence, changes: read.understanding.tools.some((id) => changingTools.has(id)) } : { read: false };
          await api.steps(run.id, lease, [{ kind: "intent", understanding: read.understanding ?? asked.result.content ?? "", durationMs: asked.took, tokensIn: asked.result.usage?.promptTokens, tokensOut: asked.result.usage?.completionTokens, ...(shown.length ? { examples: shown.map((example) => ({ key: example.key, why: example.why })) } : {}) }]).catch(() => {});
          if (read.understanding?.clarify && ["ask", "manual"].includes(run.kind)) clarify = read.understanding.clarify;
          else if (read.understanding) understanding = read.understanding;
        }
      }

      // 2. Act, then check, in the harness's loop (M45.8): one conversation that only grows, carrying
      // the tools the plan named and the always-on ones. A plan that did not fit in the time or the
      // budget left leaves nothing for acting either.
      if (session.model && !clarify && !["budget", "timeout"].includes(state.degraded)) {
        const ids = actToolIds((claim.tools ?? []).map((tool) => tool.id), { planned: understanding?.tools?.length ? understanding.tools : null, hinted, kind: run.kind });
        const byId = new Map((claim.tools ?? []).map(({ id, ...tool }) => [id, tool]));
        const messages = claim.messages.map((message) => ({ ...message }));
        const lastUser = messages.findLastIndex((message) => message.role === "user");
        // Findings by meaning (M47.3): with the request embedded, the web service ranks the other
        // agents' findings by vector, beyond what words found before the plan; they go in as F<n>
        // beside the first ones, and the check holds citations of them too.
        if (queryVector && claim.findingsByMeaning && typeof api.findings === "function" && lastUser >= 0) {
          const more = await api.findings(run.id, lease, { vector: queryVector.map((value) => Math.round(value * 1e6) / 1e6) }).catch(() => null);
          const found = Array.isArray(more?.findings) ? more.findings : [];
          if (found.length) {
            for (const finding of found) findingSources.push({ id: finding.id, title: finding.title, text: finding.text });
            messages[lastUser] = { ...messages[lastUser], content: `${messages[lastUser].content}\n\n${found.map((finding) => finding.wrapped).join("\n\n")}` };
            await system("findings", `${found.length} more ${found.length === 1 ? "finding" : "findings"} offered by meaning: ${found.map((finding) => finding.id).join(", ")}`);
          }
        }
        if (understanding) {
          if (lastUser >= 0) messages[lastUser] = { ...messages[lastUser], content: `${messages[lastUser].content}\n\n${planMessage(understanding, { hinted: hinted.filter((id) => ids.includes(id)) })}` };
        }
        const conversation = { tools: ids.map((id) => byId.get(id)).filter(Boolean), messages, last: null };
        if (!conversation.tools.length) conversation.tools = null;
        // An auto run moves to Claude here when its plan says to (M45.4), and later, before any step
        // whose conversation has grown past what the local model holds well; never back to a Claude
        // it fell back from.
        const mayMove = () => claim.router?.mode === "auto" && driver !== "claude" && !fellBack;
        if (mayMove()) {
          const decided = moveAfterPlan({ plan: planned, localProblem: state.degraded, promptTokens: session.tokensOf(conversation), contextTokens: localRuntime?.contextTokens ?? null, unsureBelow: claim.router.unsureBelow, contextShare: claim.router.contextShare });
          if (decided.move) await moveToClaude(decided.reason);
        }
        const beforeStep = async () => {
          if (!mayMove()) return;
          const grown = moveAfterPlan({ promptTokens: session.tokensOf(conversation), contextTokens: localRuntime?.contextTokens ?? null, contextShare: claim.router.contextShare });
          if (grown.move) await moveToClaude(grown.reason);
        };
        const fields = claim.output?.format === "json" && (claim.output.fields ?? []).length > 0 ? claim.output.fields : null;
        const acted = await act({
          session, run: state, conversation, limits, tokensUsed, signal: controller.signal, fields, answerNow: answerNowNote, beforeStep, pace: settings,
          callTool: (call) => callTool(call.name, call.arguments),
          sources: () => [...outputs.map((output) => ({ id: output.id, title: output.title, text: output.summary })), ...findingSources],
          record, note: system,
        });
        answer = acted.answer;
        check = acted.check;
        boxes.push(...acted.boxes);
      }

      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("stopped");
      if (clarify) {
        await api.finish(run.id, lease, { outcome: "completed", clarify, usage: usageOf() });
        return { outcome: "completed" };
      }
      let outcome = "completed";
      const { degraded } = state;
      if (degraded || !answer) {
        if (!outputs.length) for (const tool of fallbackTools(claim, understanding)) { if (controller.signal.aborted) break; await callTool(tool.id, tool.input, null).catch(() => null); }
        answer = answer ? `${answer}\n\n(${degraded === "timeout" ? "The model took too long, so this may stop short." : "The model did not finish."})` : fallbackAnswer({ reason: degraded ?? "model-error", outputs });
        outcome = "degraded";
      }
      await api.finish(run.id, lease, { outcome, answer, usage: usageOf(), degradedReason: outcome === "degraded" ? degraded ?? "model-error" : null, limitReached: state.limitReached, ...(state.limitKind ? { limit: state.limitKind } : {}), ...(boxes.length ? { boxes: boxes.slice(0, 10) } : {}) });
      return { outcome };
    } catch (error) {
      // Stopped by BoxPilot (cancelled, paused, killed, timed out): the web service already ended
      // the run; there is nothing to finish. Anything else ends the run as failed, never retried.
      if (stoppedBy || controller.signal.aborted) {
        if (!stoppedBy && String(controller.signal.reason?.message) === "timeout") await api.finish(run.id, lease, { outcome: "degraded", answer: fallbackAnswer({ reason: "timeout", outputs }), usage: usageOf(), degradedReason: "timeout" }).catch(() => null);
        return { outcome: stoppedBy ?? "stopped" };
      }
      log(`run ${run.id} failed: ${error?.message ?? error}`);
      await api.finish(run.id, lease, { outcome: "failed", error: String(error?.message ?? error).slice(0, 300), usage: usageOf() }).catch(() => null);
      return { outcome: "failed" };
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadlineTimer);
      signal?.removeEventListener?.("abort", onShutdown);
    }

    /** The run's usage for BoxPilot, with this server's speed when a call measured it. */
    function usageOf() {
      const pace = speeds.local.get();
      return { ...used, ...(check?.claims ? { check: { ...check } } : {}), ...(pace.samples > 0 ? { speed: { promptPerSecond: pace.promptPerSecond, generatePerSecond: pace.generatePerSecond, source: pace.source, samples: pace.samples, threads: localRuntime?.threads ?? null } } : {}) };
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

/**
 * Where the runner finds BoxPilot's web API: BOXPILOT_AGENTS_API, or loopback on the web service's
 * port. Both services read BOXPILOT_PORT from the same env file, which systemd hands over whole -
 * `9000   # moved off 8787` - so it is taken the way the web service takes it (parseInt).
 */
export function runnerApiBase(env = process.env) {
  return (env.BOXPILOT_AGENTS_API ?? `http://127.0.0.1:${webPortOf(env.BOXPILOT_PORT)}`).replace(/\/$/, "");
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
    findings: (runId, lease, body) => post(`/runs/${encodeURIComponent(runId)}/findings`, { lease, ...body }, { timeoutMs: 30_000 }),
    finish: (runId, lease, body) => post(`/runs/${encodeURIComponent(runId)}/finish`, { lease, ...body }),
    usage: (body) => post("/usage", body),
    // M45.3: a run on Claude's model call, through BoxPilot to the model gateway; the answer on the contract.
    // M45.4: with why an auto run moved there.
    model: (runId, lease, request, { signal = null, timeoutMs = 180_000, reason = null } = {}) => post(`/runs/${encodeURIComponent(runId)}/model`, { lease, request, timeoutMs, ...(reason ? { reason } : {}) }, { timeoutMs: timeoutMs + 15_000, signal }),
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
    findings: (runId, lease, body) => Promise.resolve(service.runnerFindings(runId, lease, body)),
    finish: (runId, lease, body) => service.runnerFinish(runId, lease, body),
    usage: (body) => Promise.resolve(service.runnerUsage(runnerId, body)),
    model: (runId, lease, request, { timeoutMs = 180_000, reason = null } = {}) => service.runnerModel(runId, lease, { request, timeoutMs, ...(reason ? { reason } : {}) }),
  };
}

/** For tests and the benchmark: the catalog's tools a run with these ids acts with, as the model sees them. */
export const actToolsFor = (claimTools, understanding, kind) => actToolIds(claimTools.map((tool) => tool.id), { planned: understanding?.tools?.length ? understanding.tools : null, kind }).map((id) => toolCatalog.find((tool) => tool.id === id)?.fn);
