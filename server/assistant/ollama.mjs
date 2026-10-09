/**
 * Ollama's own HTTP API (M34), kept as the legacy way to reach a model: the assistant's default is
 * now the OpenAI-compatible client in model-client.mjs (M37), which Ollama also answers. No cloud
 * endpoint and no API key: the address rules are the harness's local-endpoint.mjs, checked when an
 * address is saved and again before every request, and a redirect is refused rather than followed
 * elsewhere.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { createEndpointGuard, isLocalAddress, normalizeEndpoint, readBounded } from "../../packages/harness/src/index.mjs";

// The address rules moved to local-endpoint.mjs (M37), where the OpenAI-compatible client shares
// them; both live in the harness since M45.8.
export { isLocalAddress, normalizeEndpoint };

export const ollamaApiPort = 11434;

const embeddingName = /embed|minilm|bge-|e5-|arctic-embed/i;
export const isEmbeddingModel = (name) => embeddingName.test(String(name ?? ""));

export function createOllamaClient({
  fetch: fetchImpl = globalThis.fetch,
  lookup = dnsLookup,
  now = () => Date.now(),
  resolveTtlMs = 60_000,
} = {}) {
  const guard = createEndpointGuard({ lookup, now, resolveTtlMs });

  async function send(endpoint, pathname, { method = "GET", body, signal, timeoutMs }) {
    const origin = await guard(endpoint);
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    return fetchImpl(`${origin}${pathname}`, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any(signals),
      redirect: "error",
    });
  }

  async function failure(response, model) {
    const text = await readBounded(response, 16 * 1024).catch(() => "");
    let message = text;
    try { message = JSON.parse(text)?.error ?? text; } catch { /* plain text */ }
    const error = new Error(response.status === 404 && model ? `The model ${model} is not on the model server` : `The model server answered ${response.status}${message ? `: ${String(message).slice(0, 200)}` : ""}`);
    error.code = response.status === 404 ? "model_missing" : "model_error";
    return error;
  }

  /** The models the server has, by name. */
  async function tags(endpoint, { signal, timeoutMs = 3_000 } = {}) {
    const response = await send(endpoint, "/api/tags", { signal, timeoutMs });
    if (!response.ok) throw await failure(response);
    const parsed = JSON.parse(await readBounded(response, 1024 * 1024));
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    return models.slice(0, 200).flatMap((entry) => (typeof entry?.name === "string" && entry.name.length <= 200
      ? [{ name: entry.name, size: Number.isFinite(entry.size) ? entry.size : null, family: typeof entry.details?.family === "string" ? entry.details.family.slice(0, 40) : null }]
      : []));
  }

  /** One vector per input, in order. */
  async function embed(endpoint, model, inputs, { signal, timeoutMs = 15_000 } = {}) {
    const response = await send(endpoint, "/api/embed", { method: "POST", body: { model, input: inputs, truncate: true }, signal, timeoutMs });
    if (!response.ok) throw await failure(response, model);
    const parsed = JSON.parse(await readBounded(response, 16 * 1024 * 1024));
    const vectors = parsed?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== inputs.length) throw new Error("The model server returned the wrong number of embeddings");
    return vectors.map((vector) => {
      if (!Array.isArray(vector) || !vector.length || vector.length > 8192 || !vector.every(Number.isFinite)) throw new Error("The model server returned an embedding that is not a vector");
      return vector;
    });
  }

  /**
   * Stream a chat completion. Each piece of text goes to `onDelta` as it arrives; nothing is kept
   * here, so a caller that is cut off by its own deadline still has what came before. Resolves with
   * whether the model finished; rejects on an HTTP error, a malformed stream, or the signal.
   */
  async function chat(endpoint, { model, messages, options = {} }, { signal, timeoutMs = 120_000, onDelta = () => {} } = {}) {
    const response = await send(endpoint, "/api/chat", { method: "POST", body: { model, messages, stream: true, options }, signal, timeoutMs });
    if (!response.ok) throw await failure(response, model);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("The model server sent no answer");
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        if (pending.length > 256 * 1024 && !pending.includes("\n")) throw new Error("The model server sent a line that is too long");
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { throw new Error("The model server sent something that is not a chat stream"); }
          if (event?.error) throw Object.assign(new Error(`The model stopped with an error: ${String(event.error).slice(0, 200)}`), { code: "model_error" });
          const piece = event?.message?.content;
          if (typeof piece === "string" && piece) {
            // The caller answers false when it has had enough (the size bound): stop reading.
            if (onDelta(piece) === false) return { done: false, stopped: true };
          }
          if (event?.done) return { done: true, stopped: false, reason: typeof event.done_reason === "string" ? event.done_reason : null };
        }
      }
      return { done: false, stopped: false };
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  return { tags, embed, chat, guard };
}
