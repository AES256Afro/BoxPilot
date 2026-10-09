// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { assistantTurn, checkMessage, createFakeProvider, createOpenAiCompatibleProvider, defineProvider, messagesFor, readChatResult } from "../src/index.mjs";

/*
 * The model contract (M45.1): one request shape and one result shape for every provider, provider
 * blocks kept only for the provider that wrote them, and a broken answer refused where it arrives.
 */

const conversation = [
  { role: "system", content: "You read the server's facts." },
  { role: "user", content: "How full is the media drive?" },
];

describe("a provider", () => {
  it("is refused at once when a part is missing", () => {
    expect(() => defineProvider({ id: "x", kind: "local" })).toThrow(/no chat/);
    expect(() => defineProvider({ id: "X Y", kind: "local", chat: async () => ({}) })).toThrow(/id/);
    expect(() => defineProvider({ id: "x", kind: "cloud", chat: async () => ({}) })).toThrow(/local or remote/);
    expect(() => defineProvider({ id: "x", kind: "remote", chat: async () => ({}), cancel: "no" })).toThrow(/cancel/);
    expect(Object.isFrozen(defineProvider({ id: "x", kind: "remote", chat: async () => ({}) }))).toBe(true);
  });
});

describe("a model's answer", () => {
  it("comes back in the same shape whatever the provider sent", () => {
    const result = readChatResult({ content: "68% used", toolCalls: [{ name: "storage_health", arguments: { mount: "/mnt/media" } }], usage: { promptTokens: "120", completionTokens: 9, cachedTokens: 100 }, elapsedMs: 40 });
    expect(result).toEqual({
      content: "68% used",
      toolCalls: [{ id: "call_0", name: "storage_health", arguments: "{\"mount\":\"/mnt/media\"}" }],
      reason: null,
      usage: { promptTokens: 120, completionTokens: 9, cachedTokens: 100 },
      timings: null,
      firstTokenMs: null,
      elapsedMs: 40,
      costUsd: null,
      providerBlocks: null,
      refusal: null,
    });
  });

  it("is refused when it breaks the limits", () => {
    expect(() => readChatResult(null)).toThrow(/nothing/);
    expect(() => readChatResult({ toolCalls: Array.from({ length: 9 }, () => ({ name: "a", arguments: "{}" })) })).toThrow(/more than 8/);
    expect(() => readChatResult({ toolCalls: [{ name: "", arguments: "{}" }] })).toThrow(/no name/);
    expect(() => readChatResult({ toolCalls: [{ name: "a", arguments: "x".repeat(33 * 1024) }] })).toThrow(/longer than allowed/);
  });
});

describe("the conversation", () => {
  it("keeps a provider's blocks only for that provider and model", () => {
    const blocks = { provider: "anthropic", model: "claude-opus-5-5", blocks: [{ type: "thinking", thinking: "", signature: "abc" }] };
    const turn = assistantTurn({ content: "Reading the drives.", providerBlocks: blocks }, [{ id: "t1", name: "storage_health", arguments: "" }]);
    expect(turn).toEqual({ role: "assistant", content: "Reading the drives.", tool_calls: [{ id: "t1", type: "function", function: { name: "storage_health", arguments: "{}" } }], providerBlocks: blocks });
    const messages = [...conversation, turn];
    expect(messagesFor(messages, { provider: "anthropic", model: "claude-opus-5-5" })[2].providerBlocks).toBe(blocks);
    expect(messagesFor(messages, { provider: "anthropic", model: "claude-sonnet-5-5" })[2]).not.toHaveProperty("providerBlocks");
    expect(messagesFor(messages, { provider: "local" })[2]).not.toHaveProperty("providerBlocks");
    expect(messages[2].providerBlocks).toBe(blocks);
  });

  it("refuses messages it could not send", () => {
    expect(() => checkMessage({ role: "robot", content: "hi" })).toThrow(/role/);
    expect(() => checkMessage({ role: "tool", content: "42" })).toThrow(/names no tool call/);
    expect(() => checkMessage({ role: "user", tool_calls: [] })).toThrow(/not from the assistant/);
    expect(checkMessage({ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "x", arguments: "{}" } }] }).role).toBe("assistant");
  });
});

describe("the local provider", () => {
  it("binds the endpoint and key, and sends no other provider's blocks", async () => {
    const client = { chat: vi.fn(async () => ({ content: "ok", toolCalls: [], usage: null })), cancel: vi.fn(async () => true) };
    const local = createOpenAiCompatibleProvider({ client, endpoint: "http://127.0.0.1:8888", apiKey: "k" });
    expect(local.kind).toBe("local");
    const messages = [...conversation, { role: "assistant", content: "x", providerBlocks: { provider: "anthropic", model: "m", blocks: [] } }];
    await local.chat({ model: "qwen", messages, maxTokens: 64 }, { timeoutMs: 1000 });
    const [endpoint, request, options] = client.chat.mock.calls[0];
    expect(endpoint).toBe("http://127.0.0.1:8888");
    expect(request.messages[2]).not.toHaveProperty("providerBlocks");
    expect(options).toEqual({ apiKey: "k", signal: undefined, timeoutMs: 1000 });
    await local.cancel("boxpilot-1");
    expect(client.cancel).toHaveBeenCalledWith("http://127.0.0.1:8888", "boxpilot-1", { apiKey: "k" });
    expect(createOpenAiCompatibleProvider({ client: { chat: client.chat }, endpoint: "http://127.0.0.1:1" }).cancel).toBeUndefined();
  });
});

describe("the fake provider", () => {
  it("plays its script, keeps what it was sent and throws a scripted error", async () => {
    const { provider, calls } = createFakeProvider({ script: [{ content: "first" }, new Error("model down")] });
    expect((await provider.chat({ model: "m", messages: conversation, maxTokens: 10 })).content).toBe("first");
    await expect(provider.chat({ model: "m", messages: conversation, maxTokens: 10 })).rejects.toThrow("model down");
    await expect(provider.chat({ model: "m", messages: conversation, maxTokens: 10 })).rejects.toThrow(/no turn 3/);
    expect(calls).toHaveLength(3);
    expect(calls[0].messages[1].content).toBe("How full is the media drive?");
  });
});
