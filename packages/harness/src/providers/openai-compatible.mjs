/**
 * The local provider (M45.1): any server that speaks the OpenAI chat API on this machine or the
 * owner's network (Unsloth, llama.cpp's llama-server, vLLM, Ollama). It wraps a chat client the
 * host made, so the host keeps its own rules about which addresses may be reached; BoxPilot's is
 * `server/assistant/model-client.mjs`, loopback only for agents.
 *
 * The client's `chat(endpoint, request, options)` takes the request in the chat shape already, so
 * this only strips what belongs to other providers and binds the endpoint and key.
 */
import { defineProvider } from "../provider.mjs";
import { messagesFor } from "../messages.mjs";

/**
 * @param {{
 *   client: { chat: Function, cancel?: Function, embed?: Function },
 *   endpoint: string,
 *   apiKey?: string | null,
 *   id?: string,
 * }} options
 * @returns {Readonly<import("../provider.mjs").Provider>}
 */
export function createOpenAiCompatibleProvider({ client, endpoint, apiKey = null, id = "local" }) {
  if (!client || typeof client.chat !== "function") throw new TypeError("The local provider needs a chat client");
  if (typeof endpoint !== "string" || !endpoint) throw new TypeError("The local provider needs an endpoint");
  return defineProvider({
    id,
    kind: "local",
    async chat(request, { signal, timeoutMs, onDelta } = {}) {
      const messages = messagesFor(request.messages, { provider: id });
      return client.chat(endpoint, { ...request, messages }, { apiKey, signal, timeoutMs, ...(onDelta ? { onDelta } : {}) });
    },
    ...(typeof client.cancel === "function" ? { cancel: (cancelId) => client.cancel(endpoint, cancelId, { apiKey }) } : {}),
    ...(typeof client.embed === "function" ? { embed: (model, texts, options = {}) => client.embed(endpoint, model, texts, { apiKey, ...options }) } : {}),
  });
}

/**
 * Thinking off, however a local server is told: Unsloth's own field, or llama.cpp's template
 * argument. For the calls that need no thinking: a plan held to a schema, a correction, a picture.
 */
export function thinkingOff(extra = {}) {
  const out = { ...extra };
  if ("enable_thinking" in out) out.enable_thinking = false;
  if (out.chat_template_kwargs && typeof out.chat_template_kwargs === "object") out.chat_template_kwargs = { ...out.chat_template_kwargs, enable_thinking: false };
  delete out.reasoning_effort;
  return out;
}
