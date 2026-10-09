/**
 * The conversation a harness run carries (M45.1). Messages use the chat shape every local model
 * server already speaks: system, user, assistant (with `tool_calls`) and tool messages, tools as
 * function schemas. A provider that speaks something else (Claude) translates both ways.
 *
 * One addition: an assistant message may carry `providerBlocks`, what the provider sent that the
 * chat shape has no room for (Claude's thinking blocks, which must go back exactly as they came,
 * and only to the model that wrote them). Every other provider gets the message without them.
 *
 * @typedef {{ id: string, type: "function", function: { name: string, arguments: string } }} ToolCallMessage
 * @typedef {{ provider: string, model: string, blocks: unknown[] }} ProviderBlocks
 * @typedef {{
 *   role: "system" | "user" | "assistant" | "tool",
 *   content?: string | Array<Record<string, unknown>> | null,
 *   tool_calls?: ToolCallMessage[],
 *   tool_call_id?: string,
 *   name?: string,
 *   providerBlocks?: ProviderBlocks,
 * }} Message
 * @typedef {{ type: "function", function: { name: string, description?: string, parameters?: Record<string, unknown> } }} ToolSpec
 * @typedef {{ id: string, name: string, arguments: string }} ToolCall
 */

const roles = new Set(["system", "user", "assistant", "tool"]);

/** Whether a value is a message this harness can send. Throws a plain sentence when it is not. */
export function checkMessage(message, index = 0) {
  if (!message || typeof message !== "object") throw new TypeError(`Message ${index} is not an object`);
  if (!roles.has(message.role)) throw new TypeError(`Message ${index} has no known role`);
  if (message.role === "tool" && typeof message.tool_call_id !== "string") throw new TypeError(`Tool message ${index} names no tool call`);
  if (message.tool_calls !== undefined) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) throw new TypeError(`Message ${index} has tool calls but is not from the assistant`);
    for (const call of message.tool_calls) {
      if (typeof call?.id !== "string" || typeof call?.function?.name !== "string" || typeof call?.function?.arguments !== "string") throw new TypeError(`Message ${index} has a malformed tool call`);
    }
  }
  return message;
}

/**
 * The assistant turn to append after a model answered: its text, its tool calls in the chat
 * shape, and whatever the provider needs back on the next call (`providerBlocks`).
 *
 * @param {{ content?: string | null, providerBlocks?: ProviderBlocks | null }} result
 * @param {ToolCall[]} calls the tool calls to keep (a caller may drop some)
 * @returns {Message}
 */
export function assistantTurn(result, calls = []) {
  const turn = {
    role: "assistant",
    content: result?.content || null,
    tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } })),
  };
  if (result?.providerBlocks) turn.providerBlocks = result.providerBlocks;
  return turn;
}

/**
 * The messages as one provider should see them: provider blocks kept only where that provider and
 * model wrote them, dropped everywhere else. Never mutates what it is given.
 *
 * @param {Message[]} messages
 * @param {{ provider: string, model?: string }} target
 * @returns {Message[]}
 */
export function messagesFor(messages, { provider, model = null }) {
  return messages.map((message) => {
    if (!message.providerBlocks) return message;
    const own = message.providerBlocks.provider === provider && (model === null || message.providerBlocks.model === model);
    if (own) return message;
    const { providerBlocks: _dropped, ...rest } = message;
    return rest;
  });
}
