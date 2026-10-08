/**
 * The one contract every model provider meets (M45.1). A provider is an object with an id, a kind
 * (`local` on this machine or network, `remote` beyond it), and `chat`; `cancel` and `embed` are
 * optional. The loop never knows which provider it is talking to.
 *
 * @typedef {import("./messages.mjs").Message} Message
 * @typedef {import("./messages.mjs").ToolSpec} ToolSpec
 * @typedef {import("./messages.mjs").ToolCall} ToolCall
 * @typedef {import("./messages.mjs").ProviderBlocks} ProviderBlocks
 *
 * @typedef {{
 *   model: string,
 *   messages: Message[],
 *   tools?: ToolSpec[] | null,
 *   toolChoice?: "auto" | "none",
 *   maxTokens: number,
 *   temperature?: number,
 *   extra?: Record<string, unknown>,
 * }} ChatRequest
 *
 * @typedef {{
 *   promptTokens: number,
 *   completionTokens: number,
 *   cachedTokens?: number,
 *   cacheWriteTokens?: number,
 * }} Usage
 *
 * @typedef {{
 *   content: string,
 *   toolCalls: ToolCall[],
 *   reason: string | null,
 *   usage: Usage | null,
 *   timings?: Record<string, number> | null,
 *   firstTokenMs: number | null,
 *   elapsedMs: number,
 *   costUsd?: number | null,
 *   providerBlocks?: ProviderBlocks | null,
 *   refusal?: { category: string | null, explanation: string | null } | null,
 * }} ChatResult
 *
 * @typedef {{ signal?: AbortSignal, timeoutMs?: number, onDelta?: (text: string) => unknown }} ChatOptions
 *
 * @typedef {{
 *   id: string,
 *   kind: "local" | "remote",
 *   chat: (request: ChatRequest, options?: ChatOptions) => Promise<ChatResult>,
 *   cancel?: (cancelId: string) => Promise<boolean>,
 *   embed?: (model: string, texts: string[], options?: ChatOptions) => Promise<number[][] | null>,
 * }} Provider
 */

const kinds = new Set(["local", "remote"]);

/** Most tool calls one answer may carry, and the longest pieces of one, whatever the provider. */
export const resultLimits = Object.freeze({ toolCalls: 8, toolNameChars: 120, toolIdChars: 80, toolArgumentChars: 32 * 1024, contentChars: 256 * 1024 });

/**
 * A provider, checked and frozen. Throws when a required part is missing, so a mistake shows when
 * the provider is made rather than on a run's first call.
 *
 * @param {Provider} provider
 * @returns {Readonly<Provider>}
 */
export function defineProvider(provider) {
  if (!provider || typeof provider !== "object") throw new TypeError("A provider is an object");
  if (typeof provider.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(provider.id)) throw new TypeError("A provider needs an id of lower-case letters, digits and hyphens");
  if (!kinds.has(provider.kind)) throw new TypeError(`Provider ${provider.id} must be local or remote`);
  if (typeof provider.chat !== "function") throw new TypeError(`Provider ${provider.id} has no chat`);
  for (const optional of ["cancel", "embed"]) {
    if (provider[optional] !== undefined && typeof provider[optional] !== "function") throw new TypeError(`Provider ${provider.id}'s ${optional} is not a function`);
  }
  return Object.freeze({ ...provider });
}

const count = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);

/**
 * What a provider answered, held to the contract: the same fields every time, numbers that are
 * numbers, and nothing longer than the limits. A provider that breaks the contract fails here,
 * with a sentence, not three calls later.
 *
 * @param {Partial<ChatResult>} result
 * @returns {ChatResult}
 */
export function readChatResult(result) {
  if (!result || typeof result !== "object") throw new TypeError("The provider answered nothing");
  const content = typeof result.content === "string" ? result.content : "";
  if (content.length > resultLimits.contentChars) throw new RangeError("The provider's answer was longer than allowed");
  const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  if (calls.length > resultLimits.toolCalls) throw new RangeError(`The model asked for more than ${resultLimits.toolCalls} tools at once`);
  const toolCalls = calls.map((call, index) => {
    if (typeof call?.name !== "string" || !call.name) throw new TypeError(`Tool call ${index} has no name`);
    const args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
    if (args.length > resultLimits.toolArgumentChars) throw new RangeError("A tool call's arguments were longer than allowed");
    return { id: String(call.id ?? `call_${index}`).slice(0, resultLimits.toolIdChars), name: call.name.slice(0, resultLimits.toolNameChars), arguments: args };
  });
  const usage = result.usage && typeof result.usage === "object"
    ? {
        promptTokens: count(result.usage.promptTokens),
        completionTokens: count(result.usage.completionTokens),
        ...(result.usage.cachedTokens !== undefined ? { cachedTokens: count(result.usage.cachedTokens) } : {}),
        ...(result.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: count(result.usage.cacheWriteTokens) } : {}),
      }
    : null;
  return {
    content,
    toolCalls,
    reason: typeof result.reason === "string" ? result.reason : null,
    usage,
    timings: result.timings && typeof result.timings === "object" ? result.timings : null,
    firstTokenMs: Number.isFinite(result.firstTokenMs) ? result.firstTokenMs : null,
    elapsedMs: count(result.elapsedMs),
    costUsd: Number.isFinite(result.costUsd) ? result.costUsd : null,
    providerBlocks: result.providerBlocks ?? null,
    refusal: result.refusal ?? null,
  };
}
