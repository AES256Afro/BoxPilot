/**
 * One way to talk to a local model, whatever serves it (M37). The default speaks the OpenAI chat
 * API; its client lives in the harness (`packages/harness/src/providers/openai-client.mjs`, M45.8).
 * The legacy provider is Ollama's own API (ollama.mjs), for an assistant set up before M37.
 *
 * Every client keeps the harness's local-endpoint rules: the address is on this server or the
 * owner's own network, checked before every request, and a redirect is refused. An agent's model is
 * narrower still (`loopbackOnly`): the agents runner starts it on 127.0.0.1 and talks to nothing else.
 */
import { createOpenAiClient } from "../../packages/harness/src/index.mjs";
import { createOllamaClient } from "./ollama.mjs";

export { createOpenAiClient, readTimings, streamLimits } from "../../packages/harness/src/index.mjs";

export const modelProviders = Object.freeze(["openai", "ollama"]);

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
