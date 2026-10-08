/**
 * Claude, through the official SDK (M45.2, docs/HARNESS.md "Providers"). The loop speaks the chat
 * shape; this provider translates it to the Messages API and the answer back.
 *
 * - Thinking is on (adaptive, the only kind current models take); `effort` sets how hard. Thinking
 *   blocks go back exactly as they came, in `providerBlocks`, and a block the conversation no
 *   longer matches is dropped by the API rather than failing the request.
 * - Tools are strict where the schema allows it, `tool_choice` is `auto` or `none` (forcing a tool
 *   is refused on current models), and a turn cut off or refused runs no tools.
 * - A declined request is finished by the model Anthropic picks for that kind of decline
 *   (`fallbacks: "default"`), where the model has one. A decline that survives ends as `refusal`.
 * - The system prompt and tools are cached; the conversation is cached as it grows.
 * - Each answer carries its cost, priced per attempt from `anthropic-prices.mjs`.
 *
 * It is imported on its own (`@boxpilot/harness/anthropic`), so a host that never calls Claude
 * never loads the SDK. The key is never read from the environment: a host passes it, or a client.
 */
import Anthropic from "@anthropic-ai/sdk";
import { messagesFor } from "../messages.mjs";
import { defineProvider } from "../provider.mjs";
import { strictSchema } from "../schema.mjs";
import { costOf } from "./anthropic-prices.mjs";

export const anthropicBetas = Object.freeze({
  fallbacks: "server-side-fallback-2026-07-01",
  thinkingBinding: "thinking-binding-controls-2026-08-01",
  taskBudgets: "task-budgets-2026-03-13",
});

export const efforts = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/** Models with no server-side fallback: asking for one would keep a decline declined, or fail. */
const withoutFallback = /^claude-haiku-/;

/** The least a task budget may be, as the API takes it. */
const leastTaskBudget = 20_000;

const reasons = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", refusal: "refusal", pause_turn: "pause" };

const notRun = "Not run: the run did not use this call.";

function text(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (part?.type === "text" && typeof part.text === "string") return part.text ? [{ type: "text", text: part.text }] : [];
    const url = part?.type === "image_url" ? String(part.image_url?.url ?? part.image_url ?? "") : "";
    const image = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (image) return [{ type: "image", source: { type: "base64", media_type: image[1], data: image[2] } }];
    throw new TypeError(`Claude is not sent a ${part?.type ?? "part"} of this kind`);
  });
}

function input(argumentsText) {
  try {
    const value = JSON.parse(argumentsText || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function assistantBlocks(message) {
  return [
    ...text(message.content),
    ...(message.tool_calls ?? []).map((call) => ({ type: "tool_use", id: call.id, name: call.function.name, input: input(call.function.arguments) })),
  ];
}

function toolOf(tool) {
  const fn = tool?.function ?? tool;
  const parameters = fn.parameters ?? { type: "object", properties: {}, additionalProperties: false };
  const strict = strictSchema(parameters);
  return { name: fn.name, ...(fn.description ? { description: fn.description } : {}), input_schema: strict ?? parameters, ...(strict ? { strict: true } : {}) };
}

/**
 * The chat-shaped messages as the Messages API takes them: leading system messages as the system
 * prompt, a later one as the operator's message in place, tool results inside the next user turn,
 * and an answer for every tool call the loop chose not to run (Claude refuses a call left
 * unanswered, and changing its turn instead would throw its thinking away).
 */
function conversation(messages) {
  const system = [];
  const out = [];
  const add = (role, blocks) => {
    const last = out.at(-1);
    if (last && last.role === role && role === "user") last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const message of messages) {
    if (message.role === "system") {
      const said = typeof message.content === "string" ? message.content : text(message.content).map((block) => block.text ?? "").join("");
      if (!out.length) { if (said) system.push({ type: "text", text: said }); continue; }
      out.push({ role: "system", content: said });
      continue;
    }
    if (message.role === "user") add("user", text(message.content));
    else if (message.role === "tool") add("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") }]);
    else if (message.role === "assistant") {
      const blocks = message.providerBlocks?.blocks ?? assistantBlocks(message);
      if (blocks.length) out.push({ role: "assistant", content: structuredClone(blocks) });
    }
  }
  for (let index = 0; index < out.length; index += 1) {
    if (out[index].role !== "assistant") continue;
    const asked = out[index].content.filter((block) => block?.type === "tool_use").map((block) => block.id);
    if (!asked.length) continue;
    if (out[index + 1]?.role !== "user") out.splice(index + 1, 0, { role: "user", content: [] });
    const next = out[index + 1];
    const answered = new Set(next.content.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id));
    const missing = asked.filter((id) => !answered.has(id)).map((id) => ({ type: "tool_result", tool_use_id: id, content: notRun, is_error: true }));
    next.content.unshift(...missing);
  }
  if (system.length) system.at(-1).cache_control = { type: "ephemeral" };
  return { system, messages: out };
}

/**
 * The Messages API request for a chat request. Exported for tests and for a host that wants to see
 * what would be sent.
 *
 * @param {import("../provider.mjs").ChatRequest} request
 * @param {{ provider?: string, effort?: string, minMaxTokens?: number }} [options]
 */
export function toAnthropicRequest(request, { provider = "anthropic", effort = "medium", minMaxTokens = 16_000 } = {}) {
  if (typeof request?.model !== "string" || !request.model) throw new TypeError("A Claude request names its model");
  const chosen = request.effort ?? effort;
  if (!efforts.includes(chosen)) throw new TypeError(`Effort must be one of ${efforts.join(", ")}`);
  const { system, messages } = conversation(messagesFor(request.messages ?? [], { provider }));
  if (!messages.length) throw new TypeError("A Claude request needs a message after the system prompt");
  const tools = (request.tools ?? []).map(toolOf);
  const format = request.extra?.response_format?.type === "json_schema" ? strictSchema(request.extra.response_format.json_schema?.schema ?? {}) : null;
  const budget = Number.isFinite(request.taskBudget) ? Math.max(leastTaskBudget, Math.round(request.taskBudget)) : null;
  const fallback = !withoutFallback.test(request.model);
  return {
    model: request.model,
    max_tokens: Math.max(Math.round(request.maxTokens ?? 0), minMaxTokens),
    ...(system.length ? { system } : {}),
    messages,
    ...(tools.length ? { tools, tool_choice: { type: request.toolChoice === "none" ? "none" : "auto" } } : {}),
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: chosen, ...(format ? { format: { type: "json_schema", schema: format } } : {}), ...(budget ? { task_budget: { type: "tokens", total: budget } } : {}) },
    cache_control: { type: "ephemeral" },
    ...(fallback ? { fallbacks: "default" } : {}),
    betas: [...(fallback ? [anthropicBetas.fallbacks] : []), anthropicBetas.thinkingBinding, ...(budget ? [anthropicBetas.taskBudgets] : [])],
  };
}

/**
 * The blocks to send back next time. After a model declined partway and another finished, the
 * declined model's thinking and tool calls before the last switch are not sent back; its text,
 * the switch itself and everything after it are.
 */
export function echoBlocks(content) {
  const blocks = Array.isArray(content) ? content : [];
  const boundary = blocks.findLastIndex((block) => block?.type === "fallback");
  if (boundary < 0) return blocks;
  return blocks.filter((block, index) => index >= boundary || block?.type === "text" || block?.type === "fallback");
}

/**
 * The contract's answer for one Messages API response.
 *
 * @param {Record<string, any>} message
 * @param {{ provider?: string, requested?: string, elapsedMs?: number, firstTokenMs?: number | null }} [options]
 * @returns {import("../provider.mjs").ChatResult}
 */
export function fromAnthropicMessage(message, { provider = "anthropic", requested = message?.model, elapsedMs = 0, firstTokenMs = null } = {}) {
  const usage = message?.usage ?? {};
  const attempts = Array.isArray(usage.iterations) && usage.iterations.length ? usage.iterations : null;
  const costs = attempts ? attempts.map((attempt) => costOf(attempt.model ?? requested, attempt)) : [costOf(message?.model ?? requested, usage)];
  const costUsd = costs.some((cost) => cost === null) ? null : Math.round(costs.reduce((sum, cost) => sum + cost, 0) * 1_000_000) / 1_000_000;
  const read = Number(usage.cache_read_input_tokens) || 0;
  const written = Number(usage.cache_creation_input_tokens) || 0;
  const common = {
    usage: { promptTokens: (Number(usage.input_tokens) || 0) + read + written, completionTokens: Number(usage.output_tokens) || 0, cachedTokens: read, cacheWriteTokens: written },
    timings: null,
    firstTokenMs,
    elapsedMs,
    costUsd,
  };
  const reason = reasons[message?.stop_reason] ?? message?.stop_reason ?? null;
  if (message?.stop_reason === "refusal") {
    return { ...common, content: "", toolCalls: [], reason, providerBlocks: null, refusal: { category: message.stop_details?.category ?? null, explanation: message.stop_details?.explanation ?? null } };
  }
  const blocks = echoBlocks(message?.content);
  const after = blocks.slice(Math.max(0, blocks.findLastIndex((block) => block?.type === "fallback")));
  const toolCalls = message?.stop_reason === "max_tokens"
    ? []
    : after.filter((block) => block?.type === "tool_use").map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }));
  return {
    ...common,
    content: blocks.filter((block) => block?.type === "text").map((block) => block.text).join(""),
    toolCalls,
    reason,
    // Plain data: the SDK's blocks carry getters a host has no use for.
    providerBlocks: blocks.length ? { provider, model: message.model ?? requested, blocks: JSON.parse(JSON.stringify(blocks)) } : null,
    refusal: null,
  };
}

function said(error, message, code) {
  return Object.assign(new Error(message, { cause: error }), { code, status: error?.status ?? null });
}

const clip = (value) => String(value ?? "").replace(/\s+/g, " ").slice(0, 200);

/** An SDK error as a sentence and a code the router can act on; a stop the caller asked for, as theirs. */
export function explainError(error, signal) {
  if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : error;
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.AuthenticationError) return said(error, "Claude refused the API key", "auth");
  if (error instanceof Anthropic.PermissionDeniedError) return said(error, "Claude does not allow this key to do that", "forbidden");
  if (error instanceof Anthropic.RateLimitError) return said(error, "Claude is rate limited; try again later", "rate-limited");
  if (error instanceof Anthropic.BadRequestError) return said(error, `Claude refused the request: ${clip(error.message)}`, "bad-request");
  if (error instanceof Anthropic.NotFoundError) return said(error, `Claude does not know that model: ${clip(error.message)}`, "not-found");
  if (error instanceof Anthropic.APIConnectionTimeoutError) return said(error, "Claude did not answer in time", "timeout");
  if (error instanceof Anthropic.APIConnectionError) return said(error, "Claude could not be reached", "unreachable");
  if (error instanceof Anthropic.APIError && error.status === 529) return said(error, "Claude is overloaded; try again later", "overloaded");
  if (error instanceof Anthropic.APIError) return said(error, `Claude answered with an error${error.status ? ` (${error.status})` : ""}`, "api");
  return error;
}

export const anthropicOrigin = "https://api.anthropic.com";

/**
 * An SDK client that sends to Anthropic and nowhere else. The key, the address and the log level
 * are the ones given, never the environment's (the SDK would otherwise take ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL and ANTHROPIC_LOG from it), and a redirect is an error,
 * not a new destination.
 */
export function createAnthropicClient({ apiKey, baseURL = anthropicOrigin, fetch, maxRetries = 2 } = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw new TypeError("Claude needs an API key");
  return new Anthropic({ apiKey, authToken: null, baseURL, logLevel: "warn", ...(fetch ? { fetch } : {}), maxRetries, fetchOptions: { redirect: "error" } });
}

/**
 * The Claude provider. `client` is an SDK client (`createAnthropicClient`), or pass `apiKey` and
 * one is made. `effort` is the default for a request that names none; `minMaxTokens` leaves room
 * for thinking, which counts toward a call's tokens.
 */
export function createAnthropicProvider({ client = null, apiKey = null, id = "anthropic", effort = "medium", minMaxTokens = 16_000, now = () => Date.now() } = {}) {
  const sdk = client ?? createAnthropicClient({ apiKey });
  if (!efforts.includes(effort)) throw new TypeError(`Effort must be one of ${efforts.join(", ")}`);
  return defineProvider({
    id,
    kind: "remote",
    async chat(request, { signal, timeoutMs, onDelta } = {}) {
      const params = toAnthropicRequest(request, { provider: id, effort, minMaxTokens });
      const started = now();
      let firstAt = null;
      let stopped = false;
      let written = "";
      const stream = sdk.beta.messages.stream(params, { ...(signal ? { signal } : {}), ...(timeoutMs ? { timeout: timeoutMs } : {}) });
      stream.on("streamEvent", (event) => { if (firstAt === null && event?.type === "content_block_delta") firstAt = now(); });
      if (onDelta) stream.on("text", (delta) => {
        written += delta;
        if (!stopped && onDelta(delta) === false) { stopped = true; stream.abort(); }
      });
      try {
        const message = await stream.finalMessage();
        return fromAnthropicMessage(message, { provider: id, requested: params.model, elapsedMs: Math.max(0, now() - started), firstTokenMs: firstAt === null ? null : Math.max(0, firstAt - started) });
      } catch (error) {
        // The caller's own stop (onDelta answered false): what was written so far, and no tools.
        if (stopped && !signal?.aborted) return { content: written, toolCalls: [], reason: "stopped", usage: null, timings: null, firstTokenMs: firstAt === null ? null : Math.max(0, firstAt - started), elapsedMs: Math.max(0, now() - started), costUsd: null, providerBlocks: null, refusal: null };
        throw explainError(error, signal);
      }
    },
  });
}
