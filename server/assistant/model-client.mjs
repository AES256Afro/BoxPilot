/**
 * One way to talk to a local model, whatever serves it (M37). The default speaks the OpenAI chat
 * API that Unsloth (`unsloth run`), llama.cpp's llama-server, vLLM and Ollama all answer: GET
 * /v1/models, POST /v1/chat/completions (streamed, with tool calls), POST /v1/embeddings. The
 * legacy provider is Ollama's own API (ollama.mjs), for an assistant set up before M37.
 *
 * Every client keeps local-endpoint.mjs's rules: the address is on this server or the owner's own
 * network, checked before every request, and a redirect is refused. An agent's model is narrower
 * still (`loopbackOnly`): the agents runner starts it on 127.0.0.1 and talks to nothing else.
 *
 * Everything that comes back is bounded: the whole body, one line of the stream, a tool call's
 * arguments and how many tool calls one answer may make.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { createEndpointGuard, readBounded } from "./local-endpoint.mjs";
import { createOllamaClient } from "./ollama.mjs";

export const modelProviders = Object.freeze(["openai", "ollama"]);

export const streamLimits = Object.freeze({
  totalBytes: 8 * 1024 * 1024,
  lineBytes: 256 * 1024,
  toolArgumentChars: 32 * 1024,
  toolCalls: 8,
});

function modelError(message, code = "model_error") {
  return Object.assign(new Error(message), { code });
}

const count = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);

/**
 * llama-server's `timings` in the names BoxPilot uses: how many prompt tokens it read (prompt_n, the
 * ones it did not have cached), how long that took, how many it wrote, how long that took, and how
 * many it had cached (cache_n). Null for anything the server left out.
 */
export function readTimings(timings) {
  if (!timings || typeof timings !== "object") return null;
  const read = {
    promptTokens: count(timings.prompt_n), promptMs: count(timings.prompt_ms), promptPerSecond: count(timings.prompt_per_second),
    predictedTokens: count(timings.predicted_n), predictedMs: count(timings.predicted_ms), predictedPerSecond: count(timings.predicted_per_second),
    cachedTokens: count(timings.cache_n),
  };
  return Object.values(read).some((value) => value !== null) ? read : null;
}

/** The OpenAI-compatible client. `apiKey` is the per-start key Unsloth prints; none for most servers. */
export function createOpenAiClient({
  fetch: fetchImpl = globalThis.fetch,
  lookup = dnsLookup,
  now = () => Date.now(),
  resolveTtlMs = 60_000,
  loopbackOnly = false,
  limits = streamLimits,
} = {}) {
  const guard = createEndpointGuard({ lookup, now, resolveTtlMs, loopbackOnly });

  async function send(endpoint, pathname, { method = "GET", body, signal, timeoutMs, apiKey = null, stream = false }) {
    const origin = await guard(endpoint);
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const headers = { Accept: stream ? "text/event-stream, application/json" : "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return fetchImpl(`${origin}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any(signals),
      redirect: "error",
    });
  }

  async function failure(response, model) {
    const text = await readBounded(response, 16 * 1024).catch(() => "");
    let message = text;
    try { const parsed = JSON.parse(text); message = parsed?.error?.message ?? parsed?.error ?? parsed?.detail ?? text; } catch { /* plain text */ }
    if (response.status === 404 && model) return modelError(`The model ${model} is not on the model server`, "model_missing");
    if (response.status === 401 || response.status === 403) return modelError("The model server refused the request's key");
    return modelError(`The model server answered ${response.status}${message ? `: ${String(typeof message === "string" ? message : JSON.stringify(message)).slice(0, 200)}` : ""}`);
  }

  /** The models the server offers, by id. */
  async function models(endpoint, { signal, timeoutMs = 3_000, apiKey = null } = {}) {
    const response = await send(endpoint, "/v1/models", { signal, timeoutMs, apiKey });
    if (!response.ok) throw await failure(response);
    let parsed;
    try { parsed = JSON.parse(await readBounded(response, 1024 * 1024)); } catch { throw modelError("The model server's list of models could not be read"); }
    const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
    return list.slice(0, 200).flatMap((entry) => {
      const name = typeof entry?.id === "string" ? entry.id : typeof entry?.name === "string" ? entry.name : null;
      return name && name.length <= 200 ? [{ name, size: null, family: null }] : [];
    });
  }

  /** One vector per input, in order. */
  async function embed(endpoint, model, inputs, { signal, timeoutMs = 15_000, apiKey = null } = {}) {
    const response = await send(endpoint, "/v1/embeddings", { method: "POST", body: { model, input: inputs }, signal, timeoutMs, apiKey });
    if (!response.ok) throw await failure(response, model);
    const parsed = JSON.parse(await readBounded(response, 16 * 1024 * 1024));
    const rows = Array.isArray(parsed?.data) ? [...parsed.data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)) : null;
    if (!rows || rows.length !== inputs.length) throw modelError("The model server returned the wrong number of embeddings");
    return rows.map((row) => {
      const vector = row?.embedding;
      if (!Array.isArray(vector) || !vector.length || vector.length > 8192 || !vector.every(Number.isFinite)) throw modelError("The model server returned an embedding that is not a vector");
      return vector;
    });
  }

  /**
   * A chat completion, streamed. Text goes to `onDelta` as it arrives (answer false to stop
   * reading); tool calls are put together from their pieces and returned whole at the end, with
   * the token counts the server reported. A server that ignores `stream` and answers with one JSON
   * body is read the same way.
   *
   * Also returned, for the caller's timing: llama-server's own `timings` when the server passes them
   * on (Unsloth relays them on its last chunk), how many of the prompt's tokens it had cached, how
   * long the first token took (the prompt being read) and how long the whole answer took.
   * `toolChoice` "none" keeps the tools in the prompt, so it stays the same, and lets none be called.
   * Aborting (`signal`, or `timeoutMs` passing) closes the connection, which is what makes
   * llama-server stop working on the request.
   */
  async function chat(endpoint, { model, messages, tools = null, toolChoice = "auto", temperature = 0.2, maxTokens = 1024, extra = {} }, { signal, timeoutMs = 120_000, onDelta = () => {}, apiKey = null } = {}) {
    const body = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature,
      max_tokens: maxTokens,
      ...(tools?.length ? { tools, tool_choice: toolChoice } : {}),
      ...extra,
    };
    const started = now();
    const response = await send(endpoint, "/v1/chat/completions", { method: "POST", body, signal, timeoutMs, apiKey, stream: true });
    if (!response.ok) throw await failure(response, model);
    const state = { content: "", toolCalls: [], usage: null, timings: null, reason: null, stopped: false, done: false, firstAt: null };
    const addToolDelta = (delta) => {
      const index = Number.isInteger(delta?.index) ? delta.index : state.toolCalls.length;
      if (index < 0 || index >= limits.toolCalls) throw modelError(`The model asked for more than ${limits.toolCalls} tools at once`);
      const call = state.toolCalls[index] ??= { id: null, name: "", arguments: "" };
      if (typeof delta.id === "string") call.id = delta.id.slice(0, 80);
      if (typeof delta.function?.name === "string") call.name = (call.name + delta.function.name).slice(0, 120);
      if (typeof delta.function?.arguments === "string") {
        call.arguments += delta.function.arguments;
        if (call.arguments.length > limits.toolArgumentChars) throw modelError("A tool call's arguments were longer than allowed");
      }
    };
    const handle = (event) => {
      if (event?.error) throw modelError(`The model stopped with an error: ${String(event.error?.message ?? event.error).slice(0, 200)}`);
      if (event?.usage) {
        const cached = Number(event.usage.prompt_tokens_details?.cached_tokens);
        state.usage = { promptTokens: Number(event.usage.prompt_tokens) || 0, completionTokens: Number(event.usage.completion_tokens) || 0, ...(Number.isFinite(cached) ? { cachedTokens: cached } : {}) };
      }
      if (event?.timings && typeof event.timings === "object") state.timings = readTimings(event.timings);
      const choice = Array.isArray(event?.choices) ? event.choices[0] : null;
      if (!choice) return true;
      const delta = choice.delta ?? choice.message ?? {};
      if (state.firstAt === null && ((typeof delta.content === "string" && delta.content) || (Array.isArray(delta.tool_calls) && delta.tool_calls.length) || (typeof delta.reasoning_content === "string" && delta.reasoning_content))) state.firstAt = now();
      if (typeof delta.content === "string" && delta.content) {
        state.content += delta.content;
        if (onDelta(delta.content) === false) { state.stopped = true; return false; }
      }
      if (Array.isArray(delta.tool_calls)) for (const piece of delta.tool_calls) addToolDelta(piece);
      if (typeof choice.finish_reason === "string") { state.reason = choice.finish_reason; state.done = true; }
      return true;
    };
    const finished = () => ({
      done: state.done,
      stopped: state.stopped,
      reason: state.reason,
      content: state.content,
      toolCalls: state.toolCalls.filter((call) => call.name).map((call, index) => ({ id: call.id ?? `call_${index}`, name: call.name, arguments: call.arguments })),
      usage: state.usage,
      timings: state.timings,
      firstTokenMs: state.firstAt === null ? null : Math.max(0, state.firstAt - started),
      elapsedMs: Math.max(0, now() - started),
    });

    if (!/\btext\/event-stream\b/.test(response.headers.get("content-type") ?? "")) {
      let parsed;
      try { parsed = JSON.parse(await readBounded(response, limits.totalBytes)); } catch { throw modelError("The model server sent something that is not a chat answer"); }
      const choice = parsed?.choices?.[0];
      if (!choice) throw modelError("The model server sent no answer");
      handle({ usage: parsed.usage, timings: parsed.timings, choices: [{ delta: { content: choice.message?.content ?? "", tool_calls: (choice.message?.tool_calls ?? []).map((call, index) => ({ index, ...call })) }, finish_reason: choice.finish_reason ?? "stop" }] });
      return finished();
    }

    const reader = response.body?.getReader();
    if (!reader) throw modelError("The model server sent no answer");
    const decoder = new TextDecoder();
    let pending = "";
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limits.totalBytes) throw modelError("The model server sent more than expected");
        pending += decoder.decode(value, { stream: true });
        if (pending.length > limits.lineBytes && !pending.includes("\n")) throw modelError("The model server sent a line that is too long");
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") { state.done = true; return finished(); }
          let event;
          try { event = JSON.parse(data); } catch { throw modelError("The model server sent something that is not a chat stream"); }
          if (handle(event) === false) return finished();
        }
      }
      return finished();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * Ask Unsloth Studio to stop a chat it is still working on: POST /api/inference/cancel with the
   * `cancel_id` the request carried. Closing the connection already stops it; this also reaches a
   * request Studio has not started yet. Never throws: false when it could not be asked.
   */
  async function cancel(endpoint, cancelId, { apiKey = null, timeoutMs = 3_000 } = {}) {
    if (typeof cancelId !== "string" || !cancelId) return false;
    try {
      const response = await send(endpoint, "/api/inference/cancel", { method: "POST", body: { cancel_id: cancelId }, timeoutMs, apiKey });
      await readBounded(response, 4 * 1024).catch(() => "");
      return response.ok;
    } catch {
      return false;
    }
  }

  return { provider: "openai", models, chat, embed, cancel, guard };
}

/**
 * Ollama's API behind the same interface, for an assistant saved before M37. It has no tool calls
 * here: an agent always uses the OpenAI-compatible provider.
 */
export function createOllamaAdapter(options = {}) {
  const client = options.client ?? createOllamaClient(options);
  return {
    provider: "ollama",
    models: (endpoint, { signal, timeoutMs } = {}) => client.tags(endpoint, { signal, timeoutMs }),
    embed: (endpoint, model, inputs, { signal, timeoutMs } = {}) => client.embed(endpoint, model, inputs, { signal, timeoutMs }),
    async chat(endpoint, { model, messages, temperature = 0.2, maxTokens = 1024, contextTokens = 8192 }, { signal, timeoutMs, onDelta = () => {} } = {}) {
      let content = "";
      const result = await client.chat(endpoint, { model, messages, options: { temperature, num_predict: maxTokens, num_ctx: contextTokens } }, {
        signal, timeoutMs, onDelta: (piece) => { content += piece; return onDelta(piece); },
      });
      return { ...result, content, toolCalls: [], usage: null };
    },
    guard: client.guard,
  };
}

/** The client for a provider: "openai" (the default) or "ollama" (legacy). */
export function createModelClient({ provider = "openai", ...options } = {}) {
  return provider === "ollama" ? createOllamaAdapter(options) : createOpenAiClient(options);
}
