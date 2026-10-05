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
 */
import { randomUUID } from "node:crypto";
import { stripWrapperBlocks } from "./guard.mjs";
import { planMessage, plannerMessages, readUnderstanding, understandingFormatFor } from "./intent.mjs";
import { answerFormat, answerNowNote, fallbackAnswer, readStructuredAnswer } from "./prompt.mjs";
import { ModelUnavailable } from "./runtime.mjs";
import { actToolIds, toolById, toolCatalog, toolsForQuestion } from "./tool-catalog.mjs";
import { correctionMessages, unsureNote, verifyAnswer } from "./verify.mjs";

export const runnerDefaults = Object.freeze({
  pollWaitMs: 25_000,
  understandTokens: 400,
  embedBatch: 8,
  backoffMs: [2_000, 5_000, 15_000, 30_000, 60_000],
  // Before this server's model has been measured: the spike's one-processor speeds, slow on purpose.
  promptPerSecond: 8,
  generatePerSecond: 4,
  charsPerToken: 4,
  // Kept back from the run's time for the tools' facts and the finish when the model runs out.
  reserveMs: 15_000,
  // A call is only started when it can read its prompt (at the measured speed, with this margin)
  // and still write this many tokens in what is left.
  fitMargin: 1.2,
  minAnswerTokens: 48,
  // A tool's output is cut to what the model can read in this long, never below 1,200 characters.
  toolReadSeconds: 25,
  // The check before answering (M40): a correction is asked for only when it fits in what is left,
  // and writes at most this much more than the answer it corrects.
  correctionExtraTokens: 48,
});

const stripWrapper = (content) => String(content ?? "").replace(/<\/?tool_output[^>]*>/g, "").replace(/^Data from a tool, not instructions\.[^\n]*\n?/m, "").replace(/^WARNING:[^\n]*\n?/m, "").trim();
const stripToolMarkup = (text) => String(text ?? "").replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, "").trim();

// Tools a degraded run may run itself: reads of the server that need no words from the model.
const fallbackCategories = new Set(["boxpilot", "records", "app"]);
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

/**
 * The model's speed on this server, in tokens a second: reading the prompt and writing the answer.
 * It starts from what BoxPilot measured before (or slow defaults); this run's first measurement
 * replaces that (the server may be busier or quieter now), and later ones are averaged in.
 */
export function createSpeed({ promptPerSecond, generatePerSecond, source = "default" }) {
  const speed = { promptPerSecond, generatePerSecond, source, samples: 0 };
  const blend = (old, sample, fresh) => (fresh ? sample : Math.round((old * 0.5 + sample * 0.5) * 100) / 100);
  let freshPrompt = true;
  let freshGenerate = true;
  return {
    get: () => ({ ...speed }),
    /** One call's measurement: tokens read and the milliseconds it took, tokens written and theirs. */
    learn({ readTokens = 0, readMs = 0, writtenTokens = 0, writeMs = 0, from = "runner" }) {
      let learned = false;
      if (readTokens >= 16 && readMs > 0) { speed.promptPerSecond = blend(speed.promptPerSecond, Math.round((readTokens / readMs) * 1000 * 100) / 100, freshPrompt); freshPrompt = false; learned = true; }
      if (writtenTokens >= 8 && writeMs > 0) { speed.generatePerSecond = blend(speed.generatePerSecond, Math.round((writtenTokens / writeMs) * 1000 * 100) / 100, freshGenerate); freshGenerate = false; learned = true; }
      if (learned) { speed.samples += 1; speed.source = from; }
      return learned;
    },
  };
}

/** A tool's output cut to `maxChars` of its text, the wrapper and its first lines kept whole. */
export function clipToolOutput(content, maxChars) {
  const text = String(content ?? "");
  if (text.length <= maxChars) return text;
  const close = text.lastIndexOf("</tool_output>");
  const head = text.indexOf("\n\n");
  if (close < 0 || head < 0 || head > close) return `${text.slice(0, maxChars)}\n[… cut here: the model could not read more in time]`;
  const body = text.slice(head + 2, close);
  const room = Math.max(200, maxChars - head - 2 - 20);
  const cut = body.lastIndexOf("\n", room);
  const kept = body.slice(0, cut > room * 0.6 ? cut : room);
  return `${text.slice(0, head + 2)}${kept}\n[… ${body.length - kept.length} more characters not shown: the model could not read them in time]\n</tool_output>`;
}

/** Thinking off, however this server is told: Unsloth's own field, or llama.cpp's template argument. */
function thinkingOff(extra = {}) {
  const out = { ...extra };
  if ("enable_thinking" in out) out.enable_thinking = false;
  if (out.chat_template_kwargs && typeof out.chat_template_kwargs === "object") out.chat_template_kwargs = { ...out.chat_template_kwargs, enable_thinking: false };
  delete out.reasoning_effort;
  return out;
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
    let degraded = null;
    let answer = null;
    let clarify = null;
    let understanding = null;
    let limitReached = false;
    // Which limit it reached first: its steps, its tool calls or its tokens (said on the card, M44).
    let limitKind = null;
    // The boxes only BoxPilot writes that the model wrote into its answer (A-1): taken out before the
    // check, so what it made up is never checked as if it were the answer, and told to BoxPilot.
    const boxes = [];
    const unboxed = (text) => { const stripped = stripWrapperBlocks(text); boxes.push(...stripped.removed); return stripped.text; };
    // Other agents' findings it was offered before planning (M44): sources the check holds claims to.
    const findingSources = (claim.findings ?? []).map((finding) => ({ id: finding.id, title: finding.title, text: finding.text }));
    // The run's work in tokens: what the model read (not what it had cached) and what it wrote.
    const tokensUsed = () => used.readTokens + used.completionTokens;
    const system = (name, detail, state = "done") => api.steps(run.id, lease, [{ kind: "system", name, detail, state }]).catch(() => {});
    const driver = claim.runtime?.driver ?? null;
    const speed = createSpeed(claim.runtime?.speed?.promptPerSecond > 0 && claim.runtime?.speed?.generatePerSecond > 0
      ? { promptPerSecond: claim.runtime.speed.promptPerSecond, generatePerSecond: claim.runtime.speed.generatePerSecond, source: "stored" }
      : { promptPerSecond: settings.promptPerSecond, generatePerSecond: settings.generatePerSecond });
    let charsPerToken = settings.charsPerToken;

    const callTool = async (name, input, model) => {
      // Memory search by meaning: the query's embedding goes with the call, made here where the model is.
      let extras = {};
      if (toolById(String(name))?.id === "memory.search" && claim.runtime?.embeddings && model) {
        let query = "";
        try { query = String((typeof input === "string" ? JSON.parse(input || "{}") : input ?? {}).query ?? ""); } catch { query = ""; }
        const vectors = query ? await embed(model, [query.slice(0, 1_000)], controller.signal) : null;
        if (vectors) extras = { vector: vectors[0] };
      }
      const result = await api.tool(run.id, lease, name, typeof input === "string" ? input : JSON.stringify(input ?? {}), extras);
      if (result.ok) outputs.push({ id: `T${result.index}`, title: result.title, summary: stripWrapper(result.content) });
      if (result.flags?.limit) { limitReached = true; limitKind ??= "toolCalls"; }
      return result;
    };

    /** How much of the run is left for the model: the deadline (less the reserve) and the day's model time. */
    const timeLeft = () => {
      const byDeadline = deadline - now() - settings.reserveMs;
      const byBudget = limits.remainingModelMs - used.modelMs - used.loadMs;
      return { ms: Math.min(byDeadline, byBudget), binding: byBudget < byDeadline ? "budget" : "timeout" };
    };

    const promptChars = (conversation) => (conversation.tools?.length ? JSON.stringify(conversation.tools).length : 0)
      + conversation.messages.reduce((sum, message) => sum + String(typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")).length + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0) + 16, 0);

    /**
     * One call to the model, counted against the run's budget. Its time is worked out first: the
     * tokens it will read (what the conversation grew by since its last call, or all of it) and the
     * tokens it may write, at this server's speed. A call that cannot fit is not started.
     */
    // `optional`: a call the run can do without (the correction after the check): one that does not
    // fit, or fails, leaves the run as it was instead of ending it degraded.
    const ask = async (model, conversation, { maxTokens, toolChoice = "auto", extra = claim.runtime.extra ?? {}, purpose = "call", optional = false, minTokens = settings.minAnswerTokens }) => {
      const chars = promptChars(conversation);
      const newChars = conversation.last ? Math.max(0, chars - conversation.last.chars) : chars;
      const readTokens = Math.max(1, Math.ceil(newChars / charsPerToken));
      const pace = speed.get();
      const readMs = (readTokens / pace.promptPerSecond) * 1000;
      const writeMsPerToken = 1000 / pace.generatePerSecond;
      const left = timeLeft();
      const needed = readMs * settings.fitMargin + minTokens * writeMsPerToken;
      if (left.ms <= 0 || needed > left.ms) {
        if (!optional) {
          degraded = left.binding;
          limitReached = true;
        }
        const seconds = (ms) => Math.max(0, Math.round(ms / 1000));
        await system("model", left.binding === "budget"
          ? `Not starting the ${purpose}: it needs about ${seconds(needed)} s of model time (${readTokens} tokens to read at ${pace.promptPerSecond} a second, then a short answer) and ${seconds(left.ms)} s are left today.`
          : `Not starting the ${purpose}: it needs about ${seconds(needed)} s (${readTokens} tokens to read at ${pace.promptPerSecond} a second, then a short answer) and the run has ${seconds(left.ms)} s left.`, optional ? "done" : "failed");
        return null;
      }
      const fitTokens = Math.floor((left.ms - readMs * settings.fitMargin) / writeMsPerToken);
      const tokens = Math.max(minTokens, Math.min(maxTokens, fitTokens));
      const cancelId = driver === "unsloth" || driver === "fake" ? `boxpilot-${randomUUID()}` : null;
      const fields = { cache_prompt: true, ...(driver === "llama-server" ? { id_slot: 0 } : {}), ...(cancelId ? { cancel_id: cancelId } : {}) };
      const started = now();
      try {
        const result = await client.chat(model.endpoint, {
          model: model.model, temperature: claim.runtime.temperature ?? 0.2, messages: conversation.messages, tools: conversation.tools, toolChoice, maxTokens: tokens, extra: { ...extra, ...fields },
        }, { apiKey: model.apiKey, signal: controller.signal, timeoutMs: Math.max(1_000, left.ms) });
        const took = now() - started;
        used.modelMs += took;
        used.modelCalls += 1;
        const promptTokens = result.usage?.promptTokens ?? 0;
        const completionTokens = result.usage?.completionTokens ?? 0;
        const cached = result.timings?.cachedTokens ?? result.usage?.cachedTokens ?? null;
        const read = result.timings?.promptTokens ?? (cached !== null ? Math.max(0, promptTokens - cached) : promptTokens);
        used.promptTokens += promptTokens;
        used.completionTokens += completionTokens;
        used.cachedTokens += cached ?? 0;
        used.readTokens += read;
        if (promptTokens >= 100) charsPerToken = Math.min(8, Math.max(2, Math.round(((charsPerToken + chars / promptTokens) / 2) * 100) / 100));
        // The server's own timings when it passes them on; else the runner's clock, when it knows what was read.
        if (result.timings?.promptMs || result.timings?.predictedMs) {
          speed.learn({ readTokens: result.timings.promptTokens ?? 0, readMs: result.timings.promptMs ?? 0, writtenTokens: result.timings.predictedTokens ?? 0, writeMs: result.timings.predictedMs ?? 0, from: "server" });
        } else if (result.firstTokenMs !== null && result.firstTokenMs !== undefined) {
          speed.learn({ readTokens: cached !== null || !conversation.last ? read : 0, readMs: result.firstTokenMs, writtenTokens: Math.max(0, completionTokens - 1), writeMs: Math.max(0, (result.elapsedMs ?? took) - result.firstTokenMs), from: "runner" });
        }
        conversation.last = { chars, promptTokens, completionTokens };
        runtime.touch();
        return { result, took, cached, read, maxTokens: tokens };
      } catch (error) {
        used.modelMs += now() - started;
        // Closing the connection stops llama-server at its next batch; Unsloth is also asked to stop.
        if (cancelId) void client.cancel?.(model.endpoint, cancelId, { apiKey: model.apiKey });
        if (controller.signal.aborted) throw error;
        if (!optional) degraded = /timed? ?out|aborted|TimeoutError/i.test(`${error?.name} ${error?.message}`) ? "timeout" : "model-error";
        await system("model", `The model stopped${optional ? ` during the ${purpose}` : ""}: ${String(error?.message ?? error).slice(0, 200)}`, "failed");
        return null;
      }
    };
    const stepOf = (model, asked, text, toolCalls = []) => ({ kind: "model", name: model.model, text, toolCalls, durationMs: asked.took, tokensIn: asked.result.usage?.promptTokens, tokensOut: asked.result.usage?.completionTokens });

    /**
     * The check before answering (M40). Every claim in the draft is held to the tool output it
     * cites (verify.mjs, no model). When one does not match, the model is asked once to correct the
     * draft - a small conversation of its own: the failing claims, the output's lines about them -
     * if that fits in what the run and the day have left; the correction is checked the same way
     * and kept only if it is better. Whatever still does not match is said plainly under the answer.
     * A JSON answer is only checked: rewriting it could break the owner's fields.
     */
    const check = { claims: 0, checked: 0, found: 0, left: 0, corrected: false, unsure: false, checkMs: 0, correctionMs: 0 };
    const checkAnswer = async (model, draft, { structured }) => {
      const sources = [...outputs.map((output) => ({ id: output.id, title: output.title, text: output.summary })), ...findingSources];
      const timed = (work) => { const started = performance.now(); const value = work(); check.checkMs += Math.round((performance.now() - started) * 100) / 100; return value; };
      const first = timed(() => verifyAnswer(draft, sources));
      Object.assign(check, { claims: first.claims, checked: first.checked, found: first.issues.length, left: first.issues.length });
      if (!first.issues.length) {
        await system("check", `Checked the answer against the tool output it cites: ${first.checked} ${first.checked === 1 ? "statement" : "statements"} with facts to check, all match.`);
        return draft;
      }
      let answer = draft;
      let remaining = first.issues;
      if (!structured && model) {
        const fixer = { tools: null, messages: correctionMessages(draft, first.issues, sources), last: null };
        const draftTokens = Math.ceil(draft.length / charsPerToken);
        const asked = await ask(model, fixer, {
          maxTokens: Math.min(claim.runtime.maxTokens ?? 1024, draftTokens + settings.correctionExtraTokens),
          minTokens: Math.min(draftTokens, 256), extra: thinkingOff(claim.runtime.extra ?? {}), purpose: "correction", optional: true,
        });
        if (asked?.result?.content) {
          check.correctionMs = asked.took;
          await api.steps(run.id, lease, [stepOf(model, asked, asked.result.content)]);
          const corrected = stripWrapperBlocks(stripToolMarkup(asked.result.content));
          const candidate = corrected.text;
          const again = timed(() => verifyAnswer(candidate, sources));
          // Better means fewer mismatches while still an answer: as many statements that checked out,
          // at least half as long, and citing the tools if the draft did. "I cannot say anything"
          // has no mismatch either.
          const matched = (result) => result.checked - new Set(result.issues.map((issue) => issue.claim)).size;
          const cites = (text) => /\[[TF]\d+\]/.test(text);
          const better = again.issues.length < first.issues.length && matched(again) >= matched(first)
            && candidate.length * 2 >= draft.length && (!cites(draft) || cites(candidate));
          if (candidate && better) { answer = candidate; remaining = again.issues; check.corrected = true; boxes.push(...corrected.removed); }
        }
      }
      check.left = remaining.length;
      if (remaining.length && !structured) { answer = `${answer}${unsureNote(remaining)}`; check.unsure = true; }
      const words = (count) => `${count} ${count === 1 ? "statement" : "statements"}`;
      await system("check", check.corrected
        ? `Checked the answer against the tool output it cites: ${words(first.issues.length)} did not match; the model corrected ${remaining.length ? `${first.issues.length - remaining.length} of them, and the answer says it is not sure of the rest` : "them"} (${Math.round(check.correctionMs / 100) / 10} s).`
        : `Checked the answer against the tool output it cites: ${words(first.issues.length)} did not match${structured ? "" : "; the answer says it is not sure of them"}.`, remaining.length ? "failed" : "done");
      return answer;
    };

    try {
      if (run.kind === "index") return await executeIndex(claim, controller, used, () => clearInterval(heartbeat));
      if (run.kind === "describe") return await executeDescribe(claim, controller, used, () => clearInterval(heartbeat), { ownDeadline: () => !stoppedBy && String(controller.signal.reason?.message) === "timeout" });
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

      const task = claim.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n\n");
      // The tools the question's own words point at (M40): "where does X run" is where.runs, whatever the plan says.
      const hinted = toolsForQuestion(claim.run?.question ?? "", (claim.tools ?? []).map((tool) => tool.id));
      // 1. Intent and plan, as JSON against a schema, before any tool is called: a small conversation of its own.
      if (model && claim.understand) {
        const tools = claim.understand.tools ?? [];
        const hints = hinted.map((id) => toolById(id)).filter((tool) => tool && tools.some((entry) => entry.fn === tool.fn)).map((tool) => ({ fn: tool.fn, title: tool.title }));
        const planner = { tools: null, messages: plannerMessages(claim.agent ?? {}, tools, task, { hints }), last: null };
        const asked = await ask(model, planner, { maxTokens: settings.understandTokens, extra: { ...thinkingOff(claim.runtime.extra ?? {}), response_format: understandingFormatFor(tools.map((tool) => tool.fn)) }, purpose: "plan" });
        if (asked) {
          const read = readUnderstanding(asked.result.content ?? "", { offered: tools.map((tool) => tool.fn) });
          await api.steps(run.id, lease, [{ kind: "intent", understanding: read.understanding ?? asked.result.content ?? "", durationMs: asked.took, tokensIn: asked.result.usage?.promptTokens, tokensOut: asked.result.usage?.completionTokens }]).catch(() => {});
          if (read.understanding?.clarify && ["ask", "manual"].includes(run.kind)) clarify = read.understanding.clarify;
          else if (read.understanding) understanding = read.understanding;
        }
      }

      // 2. Act: one conversation that only grows, carrying the tools the plan named and the always-on ones.
      // A plan that did not fit in the time or the budget left leaves nothing for acting either.
      if (model && !clarify && !["budget", "timeout"].includes(degraded)) {
        const ids = actToolIds((claim.tools ?? []).map((tool) => tool.id), { planned: understanding?.tools?.length ? understanding.tools : null, hinted, kind: run.kind });
        const byId = new Map((claim.tools ?? []).map(({ id, ...tool }) => [id, tool]));
        const messages = claim.messages.map((message) => ({ ...message }));
        if (understanding) {
          const lastUser = messages.findLastIndex((message) => message.role === "user");
          if (lastUser >= 0) messages[lastUser] = { ...messages[lastUser], content: `${messages[lastUser].content}\n\n${planMessage(understanding, { hinted: hinted.filter((id) => ids.includes(id)) })}` };
        }
        const act = { tools: ids.map((id) => byId.get(id)).filter(Boolean), messages, last: null };
        if (!act.tools.length) act.tools = null;
        const readChars = () => Math.max(1_200, Math.round(settings.toolReadSeconds * speed.get().promptPerSecond * charsPerToken));
        let toolCalls = 0;
        const structured = claim.output?.format === "json" && (claim.output.fields ?? []).length > 0;
        const answerExtra = structured ? { ...(claim.runtime.extra ?? {}), response_format: answerFormat(claim.output.fields) } : claim.runtime.extra ?? {};
        for (let step = 0; step < limits.steps && !answer; step += 1) {
          if (controller.signal.aborted) break;
          const byTokens = tokensUsed() >= limits.tokens * 0.85;
          const lastStep = step === limits.steps - 1 || byTokens || toolCalls >= limits.maxToolCalls;
          // The last step it may take: told to answer with what it has, which is a limit reached -
          // its steps, its tool calls, or its tokens nearly spent (M44: tokens were not said).
          if (lastStep) { limitReached = true; limitKind ??= step === limits.steps - 1 ? "steps" : toolCalls >= limits.maxToolCalls ? "toolCalls" : "tokens"; }
          const final = lastStep && step > 0 && Boolean(act.tools);
          if (final) {
            // Told at the end of the last tool round, so nothing before it changes.
            const last = act.messages.at(-1);
            if (last?.role === "tool") act.messages[act.messages.length - 1] = { ...last, content: `${last.content}${answerNowNote(structured)}` };
            else act.messages.push({ role: "user", content: answerNowNote(structured).trim() });
          }
          const asked = await ask(model, act, {
            maxTokens: Math.max(64, Math.min(claim.runtime.maxTokens ?? 1024, limits.tokens - tokensUsed())),
            toolChoice: final ? "none" : "auto",
            ...(final && structured ? { extra: answerExtra } : {}),
            purpose: final ? "last answer" : "next step",
          });
          if (!asked) break;
          const { result } = asked;
          const calls = final ? [] : (result.toolCalls ?? []).slice(0, limits.toolCallsPerStep ?? 3);
          await api.steps(run.id, lease, [stepOf(model, asked, result.content, calls)]);
          if (!calls.length) { answer = stripToolMarkup(result.content) || null; if (!answer) degraded = "model-error"; break; }
          act.messages.push({ role: "assistant", content: result.content || null, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } })) });
          for (const call of calls) {
            if (controller.signal.aborted) break;
            toolCalls += 1;
            const reply = await callTool(call.name, call.arguments, model);
            act.messages.push({ role: "tool", tool_call_id: call.id, content: clipToolOutput(reply.content, readChars()) });
          }
        }
        // 3. A structured answer that is not the owner's JSON: the same prompt again, held to the JSON.
        if (answer && structured && readStructuredAnswer(answer, claim.output.fields).problem && !degraded) {
          const asked = await ask(model, act, { maxTokens: Math.max(128, Math.min(claim.runtime.maxTokens ?? 1024, limits.tokens - tokensUsed())), toolChoice: "none", extra: answerExtra, purpose: "JSON answer" });
          if (asked?.result?.content) {
            await api.steps(run.id, lease, [stepOf(model, asked, asked.result.content)]);
            answer = stripToolMarkup(asked.result.content);
          }
        }
        // Its scratch notes and any tool output it wrote itself are not its answer (A-1).
        if (answer) answer = unboxed(answer) || null;
        // 4. The check before answering (M40): each claim against the output or finding it cites.
        if (answer && !degraded && !controller.signal.aborted && (outputs.length || findingSources.length)) answer = await checkAnswer(model, answer, { structured });
        if (!answer && !degraded && !controller.signal.aborted) degraded = "model-error";
      }

      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("stopped");
      if (clarify) {
        await api.finish(run.id, lease, { outcome: "completed", clarify, usage: usageOf() });
        return { outcome: "completed" };
      }
      let outcome = "completed";
      if (degraded || !answer) {
        if (!outputs.length) for (const tool of fallbackTools(claim, understanding)) { if (controller.signal.aborted) break; await callTool(tool.id, tool.input, null).catch(() => null); }
        answer = answer ? `${answer}\n\n(${degraded === "timeout" ? "The model took too long, so this may stop short." : "The model did not finish."})` : fallbackAnswer({ reason: degraded ?? "model-error", outputs });
        outcome = "degraded";
      }
      await api.finish(run.id, lease, { outcome, answer, usage: usageOf(), degradedReason: outcome === "degraded" ? degraded ?? "model-error" : null, limitReached, ...(limitKind ? { limit: limitKind } : {}), ...(boxes.length ? { boxes: boxes.slice(0, 10) } : {}) });
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
      const pace = speed.get();
      return { ...used, ...(check.claims ? { check: { ...check } } : {}), ...(pace.samples > 0 ? { speed: { promptPerSecond: pace.promptPerSecond, generatePerSecond: pace.generatePerSecond, source: pace.source, samples: pace.samples, threads: claim.runtime?.threads ?? null } } : {}) };
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

/** For tests and the benchmark: the catalog's tools a run with these ids acts with, as the model sees them. */
export const actToolsFor = (claimTools, understanding, kind) => actToolIds(claimTools.map((tool) => tool.id), { planned: understanding?.tools?.length ? understanding.tools : null, kind }).map((id) => toolCatalog.find((tool) => tool.id === id)?.fn);
