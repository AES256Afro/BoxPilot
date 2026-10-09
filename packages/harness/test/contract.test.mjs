// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { assistantTurn, createOpenAiCompatibleProvider, readChatResult } from "../src/index.mjs";
import { createAnthropicProvider } from "../src/providers/anthropic.mjs";
import { fakeClaude, fixture } from "./anthropic-wire.mjs";

/*
 * The contract, held to both real providers (M45.2): the same scripted conversation through the
 * local provider and through Claude comes back in the same shape, and a loop written against the
 * contract carries it to the end on either. Neither reaches a network: the local model's client is
 * scripted, and Claude's is the real SDK with a scripted `fetch`.
 */

const storage = { type: "function", function: { name: "storage_health", description: "How full each drive is", parameters: { type: "object", properties: { mount: { type: "string" } }, required: ["mount"], additionalProperties: false } } };
const service = { type: "function", function: { name: "service_status", description: "Whether a service runs", parameters: { type: "object", properties: { unit: { type: "string" } }, required: ["unit"], additionalProperties: false } } };
const opening = [
  { role: "system", content: "You read the server's facts and answer from them." },
  { role: "user", content: "How full is the media drive?" },
];

function local(script) {
  const client = { chat: vi.fn(async () => script.shift()) };
  return { provider: createOpenAiCompatibleProvider({ client, endpoint: "http://127.0.0.1:8888" }), sent: () => client.chat.mock.calls.map(([, request]) => request) };
}

function claude(names) {
  const wire = fakeClaude(names.map(fixture));
  return { provider: createAnthropicProvider({ client: wire.client }), sent: () => wire.requests.map((request) => request.body) };
}

const providers = {
  local: () => local([
    { content: "", toolCalls: [{ id: "call_1", name: "storage_health", arguments: "{\"mount\":\"/mnt/media\"}" }], reason: "tool_calls", usage: { promptTokens: 120, completionTokens: 9 } },
    { content: "The media drive is 68% full.", toolCalls: [], reason: "stop", usage: { promptTokens: 150, completionTokens: 8 } },
  ]),
  claude: () => claude(["tool-call", "answer"]),
};

/** A loop as a host writes it, against the contract alone. */
async function ask(provider) {
  const messages = [...opening];
  const request = () => ({ model: "m", messages, tools: [storage, service], maxTokens: 512 });
  const first = readChatResult(await provider.chat({ ...request(), model: provider.kind === "remote" ? "claude-opus-5-5" : "qwen" }));
  messages.push(assistantTurn(first, first.toolCalls));
  for (const call of first.toolCalls) messages.push({ role: "tool", tool_call_id: call.id, content: "/mnt/media: 68% used" });
  const second = readChatResult(await provider.chat({ ...request(), model: provider.kind === "remote" ? "claude-opus-5-5" : "qwen" }));
  return { first, second, messages };
}

describe.each(Object.keys(providers))("the %s provider, on the contract", (name) => {
  it("asks for a tool, then answers from its output", async () => {
    const { provider } = providers[name]();
    const { first, second } = await ask(provider);
    expect(first.reason).toBe("tool_calls");
    expect(first.toolCalls.map((call) => [call.name, JSON.parse(call.arguments)])).toEqual([["storage_health", { mount: "/mnt/media" }]]);
    expect(first.usage.promptTokens).toBeGreaterThan(0);
    expect(second.reason).toBe("stop");
    expect(second.toolCalls).toEqual([]);
    expect(second.content).toBe("The media drive is 68% full.");
    expect(second.refusal).toBeNull();
  });
});

describe("what each provider was sent", () => {
  it("the local model gets the chat shape and nothing of Claude's", async () => {
    const { provider, sent } = providers.local();
    await ask(provider);
    const second = sent()[1];
    expect(second.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(second.messages[2].tool_calls[0].function).toEqual({ name: "storage_health", arguments: "{\"mount\":\"/mnt/media\"}" });
    expect(second.messages.some((message) => "providerBlocks" in message)).toBe(false);
  });

  it("Claude gets its own turn back exactly, thinking and all, and the tool's output paired to its call", async () => {
    const { provider, sent } = providers.claude();
    await ask(provider);
    const second = sent()[1];
    expect(second.system).toEqual([{ type: "text", text: opening[0].content, cache_control: { type: "ephemeral" } }]);
    expect(second.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[1].content).toEqual(fixture("tool-call").content);
    expect(second.messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "toolu_storage_1", content: "/mnt/media: 68% used" }]);
  });

  it("Claude gets an answer for every call the loop chose not to run, and its own turn unchanged", async () => {
    const { provider, sent } = claude(["many-calls", "answer"]);
    const messages = [...opening];
    const first = readChatResult(await provider.chat({ model: "claude-opus-5-5", messages, tools: [storage, service], maxTokens: 512 }));
    expect(first.toolCalls).toHaveLength(4);
    const kept = first.toolCalls.slice(0, 3);
    messages.push(assistantTurn(first, kept));
    for (const call of kept) messages.push({ role: "tool", tool_call_id: call.id, content: "ok" });
    await provider.chat({ model: "claude-opus-5-5", messages, tools: [storage, service], maxTokens: 512 });
    const second = sent()[1];
    expect(second.messages[1].content).toEqual(fixture("many-calls").content);
    expect(second.messages[2].content.map((block) => [block.tool_use_id, block.is_error ?? false])).toEqual([["toolu_d", true], ["toolu_a", false], ["toolu_b", false], ["toolu_c", false]]);
  });
});
