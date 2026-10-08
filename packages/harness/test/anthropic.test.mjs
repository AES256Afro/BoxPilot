// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readChatResult } from "../src/index.mjs";
import { anthropicBetas, createAnthropicClient, createAnthropicProvider, echoBlocks, toAnthropicRequest } from "../src/providers/anthropic.mjs";
import { costOf, priceFor } from "../src/providers/anthropic-prices.mjs";
import { fakeClaude, fixture } from "./anthropic-wire.mjs";

/*
 * Claude's provider (M45.2): what it sends, what it makes of each kind of answer (tools, a
 * refusal, a turn cut off, a decline finished by another model), what it costs, and how a
 * failure reads. The SDK is real; the network is a script.
 */

const opening = [
  { role: "system", content: "You read the server's facts." },
  { role: "user", content: "How full is the media drive?" },
];
const strictTool = { type: "function", function: { name: "storage_health", description: "How full each drive is", parameters: { type: "object", properties: { mount: { type: "string", maxLength: 200 } }, required: ["mount"], additionalProperties: false } } };
const openTool = { type: "function", function: { name: "plan_steps", description: "Stage steps", parameters: { type: "object", properties: { steps: { type: "array", items: { type: "object", properties: { parameters: { type: "object" } } } } }, required: ["steps"], additionalProperties: false } } };

afterEach(() => vi.unstubAllEnvs());

describe("a request to Claude", () => {
  it("thinks adaptively at the effort asked, leaves room to think, and keeps no sampling settings", () => {
    const sent = toAnthropicRequest({ model: "claude-opus-5-5", messages: opening, maxTokens: 512, temperature: 0.2 });
    expect(sent.model).toBe("claude-opus-5-5");
    expect(sent.max_tokens).toBe(16_000);
    expect(sent.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(sent.output_config).toEqual({ effort: "medium" });
    expect(sent).not.toHaveProperty("temperature");
    expect(toAnthropicRequest({ model: "claude-opus-5-5", messages: opening, maxTokens: 40_000, effort: "high" })).toMatchObject({ max_tokens: 40_000, output_config: { effort: "high" } });
    expect(() => toAnthropicRequest({ model: "claude-opus-5-5", messages: opening, maxTokens: 1, effort: "huge" })).toThrow(/Effort/);
  });

  it("caches the system prompt and the growing conversation", () => {
    const sent = toAnthropicRequest({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 });
    expect(sent.system).toEqual([{ type: "text", text: "You read the server's facts.", cache_control: { type: "ephemeral" } }]);
    expect(sent.cache_control).toEqual({ type: "ephemeral" });
    expect(sent.messages).toEqual([{ role: "user", content: [{ type: "text", text: "How full is the media drive?" }] }]);
  });

  it("asks for a fallback on a decline where the model has one, and not on Haiku", () => {
    const opus = toAnthropicRequest({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 });
    expect(opus.fallbacks).toBe("default");
    expect(opus.betas).toEqual([anthropicBetas.fallbacks, anthropicBetas.thinkingBinding]);
    const haiku = toAnthropicRequest({ model: "claude-haiku-5-5", messages: opening, maxTokens: 512 });
    expect(haiku).not.toHaveProperty("fallbacks");
    expect(haiku.betas).toEqual([anthropicBetas.thinkingBinding]);
  });

  it("makes a tool strict when its schema can be, and leaves an open one as it is", () => {
    const sent = toAnthropicRequest({ model: "claude-opus-5-5", messages: opening, tools: [strictTool, openTool], toolChoice: "none", maxTokens: 512 });
    expect(sent.tools[0]).toEqual({ name: "storage_health", description: "How full each drive is", strict: true, input_schema: { type: "object", properties: { mount: { type: "string", description: "{maxLength: 200}" } }, required: ["mount"], additionalProperties: false } });
    expect(sent.tools[1]).not.toHaveProperty("strict");
    expect(sent.tools[1].input_schema).toEqual(openTool.function.parameters);
    expect(sent.tool_choice).toEqual({ type: "none" });
    expect(toAnthropicRequest({ model: "claude-opus-5-5", messages: opening, tools: [strictTool], maxTokens: 512 }).tool_choice).toEqual({ type: "auto" });
  });

  it("holds a structured answer to its schema, and a long job to a task budget", () => {
    const schema = { type: "object", additionalProperties: false, required: ["clarify"], properties: { clarify: { type: ["string", "null"], maxLength: 200 } } };
    const sent = toAnthropicRequest({ model: "claude-opus-5-5", messages: opening, maxTokens: 512, taskBudget: 5_000, extra: { response_format: { type: "json_schema", json_schema: { name: "x", strict: true, schema } } } });
    expect(sent.output_config.format).toEqual({ type: "json_schema", schema: { type: "object", additionalProperties: false, required: ["clarify"], properties: { clarify: { anyOf: [{ type: "string", description: "{maxLength: 200}" }, { type: "null" }] } } } });
    expect(sent.output_config.task_budget).toEqual({ type: "tokens", total: 20_000 });
    expect(sent.betas).toContain(anthropicBetas.taskBudgets);
  });

  it("sends a later system message in place, an image as an image, and refuses what it cannot send", () => {
    const messages = [...opening, { role: "assistant", content: "Reading." }, { role: "user", content: [{ type: "text", text: "This one" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }, { role: "system", content: "Answer in one line." }];
    const sent = toAnthropicRequest({ model: "claude-opus-5-5", messages, maxTokens: 512 });
    expect(sent.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(sent.messages[2].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
    expect(sent.messages[3]).toEqual({ role: "system", content: "Answer in one line." });
    expect(() => toAnthropicRequest({ model: "claude-opus-5-5", messages: [{ role: "user", content: [{ type: "audio", data: "x" }] }], maxTokens: 1 })).toThrow(/not sent/);
    expect(() => toAnthropicRequest({ model: "claude-opus-5-5", messages: [opening[0]], maxTokens: 1 })).toThrow(/needs a message/);
  });

  it("drops another provider's blocks and sends the assistant turn from its text and calls", () => {
    const turn = { role: "assistant", content: "Checking.", tool_calls: [{ id: "call_1", type: "function", function: { name: "storage_health", arguments: "{\"mount\":\"/\"}" } }], providerBlocks: { provider: "local", model: "qwen", blocks: [{ type: "reasoning" }] } };
    const sent = toAnthropicRequest({ model: "claude-opus-5-5", messages: [...opening, turn, { role: "tool", tool_call_id: "call_1", content: "41%" }], maxTokens: 512 });
    expect(sent.messages[1].content).toEqual([{ type: "text", text: "Checking." }, { type: "tool_use", id: "call_1", name: "storage_health", input: { mount: "/" } }]);
    expect(sent.messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "call_1", content: "41%" }]);
  });

  it("gives another model's tool call ids the characters Claude takes, the same at both ends", () => {
    const turn = { role: "assistant", content: null, tool_calls: [{ id: "call:7/a b", type: "function", function: { name: "storage_health", arguments: "{}" } }] };
    const sent = toAnthropicRequest({ model: "claude-opus-5-5", messages: [...opening, turn, { role: "tool", tool_call_id: "call:7/a b", content: "41%" }], maxTokens: 512 });
    expect(sent.messages[1].content[0].id).toBe("call_7_a_b");
    expect(sent.messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "call_7_a_b", content: "41%" }]);
  });

  it("goes to Anthropic with the key it was given, refusing redirects, whatever the environment says", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://somewhere-else.example");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-the-environment");
    const { client, requests } = fakeClaude([fixture("answer")]);
    await createAnthropicProvider({ client }).chat({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 });
    expect(requests[0].url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(requests[0].headers["x-api-key"]).toBe("sk-ant-test-key");
    expect(requests[0].headers["anthropic-beta"]).toBe(`${anthropicBetas.fallbacks},${anthropicBetas.thinkingBinding}`);
    expect(requests[0].redirect).toBe("error");
    expect(requests[0].body.stream).toBe(true);
    expect(() => createAnthropicClient({})).toThrow(/API key/);
    expect(() => createAnthropicProvider({})).toThrow(/API key/);
  });
});

describe("Claude's answer", () => {
  it("comes back on the contract, with its thinking kept for the next call and its cost", async () => {
    let clock = 1_000;
    const { client } = fakeClaude([fixture("tool-call")]);
    const provider = createAnthropicProvider({ client, now: () => (clock += 5) });
    const result = readChatResult(await provider.chat({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 }));
    expect(result.content).toBe("Checking the drive.");
    expect(result.toolCalls).toEqual([{ id: "toolu_storage_1", name: "storage_health", arguments: "{\"mount\":\"/mnt/media\"}" }]);
    expect(result.reason).toBe("tool_calls");
    expect(result.usage).toEqual({ promptTokens: 1240, completionTokens: 61, cachedTokens: 0, cacheWriteTokens: 1200 });
    expect(result.costUsd).toBe(0.00738);
    expect(result.providerBlocks).toEqual({ provider: "anthropic", model: "claude-opus-5-5", blocks: fixture("tool-call").content });
    expect(result.firstTokenMs).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(result.firstTokenMs);
  });

  it("ends as a refusal with its category, and runs nothing", async () => {
    const { client } = fakeClaude([fixture("refusal")]);
    const result = readChatResult(await createAnthropicProvider({ client }).chat({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 }));
    expect(result).toMatchObject({ content: "", toolCalls: [], reason: "refusal", providerBlocks: null, refusal: { category: "cyber", explanation: "This request was declined." }, costUsd: 0.0012 });
  });

  it("runs no tool from a turn cut off at its token limit", async () => {
    const { client } = fakeClaude([fixture("cut-off")]);
    const result = readChatResult(await createAnthropicProvider({ client }).chat({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 }));
    expect(result.reason).toBe("length");
    expect(result.toolCalls).toEqual([]);
  });

  it("finished by a fallback model: the declined part's thinking and calls dropped, each part priced at its model", async () => {
    const { client } = fakeClaude([fixture("fallback")]);
    const result = readChatResult(await createAnthropicProvider({ client }).chat({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 }));
    expect(result.content).toBe("Looking at the firewall rules: port 22 is open to the LAN only.");
    expect(result.toolCalls).toEqual([]);
    expect(result.providerBlocks.model).toBe("claude-opus-5");
    expect(result.providerBlocks.blocks.map((block) => block.signature ?? block.type)).toEqual(["text", "fallback", "sig-fallback-0006", "text"]);
    // 500 in and 30 out on Opus 5.5, then 500 in and 80 out on Opus 5.
    expect(result.costUsd).toBe(0.0071);
    expect(echoBlocks(fixture("tool-call").content)).toEqual(fixture("tool-call").content);
  });

  it("streams its text to the caller, and stops when the caller says so", async () => {
    const pieces = [];
    const { client } = fakeClaude([fixture("answer"), fixture("answer")]);
    const provider = createAnthropicProvider({ client });
    await provider.chat({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 }, { onDelta: (piece) => { pieces.push(piece); } });
    expect(pieces.join("")).toBe("The media drive is 68% full.");
    const stopped = await provider.chat({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 }, { onDelta: () => false });
    expect(stopped).toMatchObject({ reason: "stopped", toolCalls: [], content: "The media drive is 68% full." });
  });
});

describe("a failure", () => {
  const failing = async (step) => {
    const { client } = fakeClaude([step]);
    return createAnthropicProvider({ client }).chat({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 }).catch((error) => error);
  };

  it("reads as a sentence with a code the router can act on", async () => {
    expect(await failing({ status: 401, type: "authentication_error" })).toMatchObject({ code: "auth", status: 401, message: "Claude refused the API key" });
    expect(await failing({ status: 429, type: "rate_limit_error" })).toMatchObject({ code: "rate-limited", status: 429 });
    expect(await failing({ status: 529, type: "overloaded_error" })).toMatchObject({ code: "overloaded", status: 529 });
    expect(await failing({ status: 400, type: "invalid_request_error", message: "max_tokens: too large" })).toMatchObject({ code: "bad-request", message: expect.stringContaining("max_tokens: too large") });
    expect(await failing({ status: 500, type: "api_error" })).toMatchObject({ code: "api", status: 500 });
  });

  it("is the caller's own reason when the caller stopped it", async () => {
    const controller = new AbortController();
    controller.abort(new Error("timeout"));
    const { client } = fakeClaude([fixture("answer")]);
    const error = await createAnthropicProvider({ client }).chat({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 }, { signal: controller.signal }).catch((caught) => caught);
    expect(error.message).toBe("timeout");
  });

  it("says Claude could not be reached when the connection fails", async () => {
    const client = createAnthropicClient({ apiKey: "sk-ant-test-key", maxRetries: 0, fetch: async () => { throw new TypeError("fetch failed"); } });
    const error = await createAnthropicProvider({ client }).chat({ model: "claude-opus-5-5", messages: opening, maxTokens: 512 }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "unreachable", message: "Claude could not be reached" });
  });
});

describe("the price list", () => {
  it("prices each kind of token, Haiku's long prompts on their own card, and nothing it does not list", () => {
    expect(priceFor("claude-opus-5-5")).toMatchObject({ input: 4, output: 20 });
    expect(priceFor("claude-haiku-4-5-20251001")).toBeNull();
    expect(costOf("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 })).toBe(14.7);
    expect(costOf("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 1_000 })).toBe(0.0105);
    expect(costOf("claude-haiku-5-5", { input_tokens: 100_001, output_tokens: 1_000 })).toBe(0.052501);
    expect(costOf("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } })).toBe(8);
    expect(costOf("claude-unknown-1", { input_tokens: 1 })).toBeNull();
  });
});
