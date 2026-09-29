// @vitest-environment node
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeModel } from "../agents/fake-model.mjs";
import { startFakeOllama } from "../../test/fake-ollama.mjs";
import { createModelClient, createOllamaAdapter, createOpenAiClient } from "./model-client.mjs";
import { createEndpointGuard, isLoopbackAddress } from "./local-endpoint.mjs";

let fake;
beforeAll(async () => { fake = await startFakeModel({ apiKey: "sk-test-key" }); });
afterAll(async () => { await fake?.close(); });
afterEach(() => { fake.reset(); Object.assign(fake.state, { chat: "policy", script: null, delayMs: 0 }); });

describe("the OpenAI-compatible client, against a stand-in model server", () => {
  const client = createOpenAiClient();

  it("lists the models, sending the server's key", async () => {
    expect((await client.models(fake.url, { apiKey: "sk-test-key" })).map((model) => model.name)).toEqual(["fake/qwen-agent"]);
    expect(fake.requests[0].authorization).toBe("Bearer sk-test-key");
    await expect(client.models(fake.url, { apiKey: "wrong" })).rejects.toThrow(/refused the request's key/);
  });

  it("streams an answer piece by piece, with the token counts", async () => {
    fake.state.script = () => ({ content: "The server is well [T1]." });
    const pieces = [];
    const result = await client.chat(fake.url, { model: "fake/qwen-agent", messages: [{ role: "user", content: "hi" }] }, { apiKey: "sk-test-key", onDelta: (piece) => { pieces.push(piece); } });
    expect(result).toMatchObject({ done: true, reason: "stop", content: "The server is well [T1].", toolCalls: [] });
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(pieces.join("")).toBe("The server is well [T1].");
  });

  it("puts a streamed tool call back together", async () => {
    fake.state.script = () => ({ toolCalls: [{ name: "logs.query", arguments: { kind: "group", target: "boxpilot", lines: 50, filter: "a long enough filter to cross chunks" } }] });
    const tools = [{ type: "function", function: { name: "logs.query", parameters: { type: "object" } } }];
    const result = await client.chat(fake.url, { model: "m", messages: [{ role: "user", content: "logs" }], tools }, { apiKey: "sk-test-key" });
    expect(result.reason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("logs.query");
    expect(JSON.parse(result.toolCalls[0].arguments)).toMatchObject({ target: "boxpilot", lines: 50 });
    expect(fake.prompts()[0]).toMatchObject({ tool_choice: "auto", stream: true });
  });

  it("refuses more tool calls, or longer arguments, than it allows", async () => {
    const tight = createOpenAiClient({ limits: { totalBytes: 1e6, lineBytes: 1e5, toolArgumentChars: 20, toolCalls: 1 } });
    fake.state.script = () => ({ toolCalls: [{ name: "a", arguments: {} }, { name: "b", arguments: {} }] });
    await expect(tight.chat(fake.url, { model: "m", messages: [] }, { apiKey: "sk-test-key" })).rejects.toThrow(/more than 1 tools/);
    fake.state.script = () => ({ toolCalls: [{ name: "a", arguments: { text: "x".repeat(100) } }] });
    await expect(tight.chat(fake.url, { model: "m", messages: [] }, { apiKey: "sk-test-key" })).rejects.toThrow(/longer than allowed/);
  });

  it("stops reading when the caller has had enough", async () => {
    fake.state.script = () => ({ content: "word ".repeat(100) });
    let received = "";
    const result = await client.chat(fake.url, { model: "m", messages: [] }, { apiKey: "sk-test-key", onDelta: (piece) => { received += piece; return received.length < 30; } });
    expect(result.stopped).toBe(true);
  });

  it("names a missing model, a server error and an error in the stream", async () => {
    fake.state.chat = "missing";
    await expect(client.chat(fake.url, { model: "llama9", messages: [] }, { apiKey: "sk-test-key" })).rejects.toMatchObject({ code: "model_missing" });
    fake.state.chat = "error";
    await expect(client.chat(fake.url, { model: "m", messages: [] }, { apiKey: "sk-test-key" })).rejects.toMatchObject({ code: "model_error" });
    fake.state.chat = "broken";
    await expect(client.chat(fake.url, { model: "m", messages: [] }, { apiKey: "sk-test-key" })).rejects.toThrow(/out of memory/);
  });

  it("gives up at its deadline", async () => {
    fake.state.chat = "hang";
    await expect(client.chat(fake.url, { model: "m", messages: [] }, { apiKey: "sk-test-key", timeoutMs: 150 })).rejects.toThrow();
  });

  it("returns one embedding per input, in order", async () => {
    const vectors = await client.embed(fake.url, "m", ["one", "two", "three"], { apiKey: "sk-test-key" });
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toHaveLength(8);
  });

  it("reads a server that answers in one JSON body instead of a stream", async () => {
    const plain = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "whole answer", tool_calls: [{ id: "x", function: { name: "server.facts", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
    plain.listen(0, "127.0.0.1");
    await new Promise((resolve) => plain.once("listening", resolve));
    try {
      const result = await client.chat(`http://127.0.0.1:${plain.address().port}`, { model: "m", messages: [] });
      expect(result).toMatchObject({ content: "whole answer", reason: "tool_calls", usage: { promptTokens: 5, completionTokens: 2 } });
      expect(result.toolCalls).toEqual([{ id: "x", name: "server.facts", arguments: "{}" }]);
    } finally {
      plain.closeAllConnections?.();
      await new Promise((resolve) => plain.close(resolve));
    }
  });

  it("does not follow a redirect somewhere else", async () => {
    const redirecting = http.createServer((_request, response) => { response.writeHead(302, { Location: "https://example.com/v1/models" }); response.end(); });
    redirecting.listen(0, "127.0.0.1");
    await new Promise((resolve) => redirecting.once("listening", resolve));
    try {
      await expect(client.models(`http://127.0.0.1:${redirecting.address().port}`)).rejects.toThrow();
    } finally {
      redirecting.closeAllConnections?.();
      await new Promise((resolve) => redirecting.close(resolve));
    }
  });
});

describe("where a model may be", () => {
  it("refuses a cloud address, and for an agent anything but this machine", async () => {
    const client = createOpenAiClient();
    await expect(client.models("https://api.openai.com")).rejects.toThrow(/private, tailnet or loopback/);
    const agentOnly = createOpenAiClient({ loopbackOnly: true });
    await expect(agentOnly.models("http://192.168.1.20:8888")).rejects.toThrow(/not on this server/);
    const named = createEndpointGuard({ loopbackOnly: true, lookup: async () => [{ address: "192.168.1.5", family: 4 }] });
    await expect(named("http://gpu-box:8888")).rejects.toThrow(/does not resolve/);
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });

  it("refuses a local-looking name that resolves to a public address", async () => {
    const client = createOpenAiClient({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    await expect(client.models("http://gpu-box:8888")).rejects.toThrow(/does not resolve to an address on this network/);
  });
});

describe("the legacy Ollama provider behind the same interface", () => {
  let ollama;
  beforeAll(async () => { ollama = await startFakeOllama({ answer: "From Ollama [S1]." }); });
  afterAll(async () => { await ollama?.close(); });

  it("lists, chats and embeds, mapping the limits to Ollama's options", async () => {
    const client = createModelClient({ provider: "ollama" });
    expect(client.provider).toBe("ollama");
    expect((await client.models(ollama.url)).map((model) => model.name)).toContain("hermes3:8b");
    const result = await client.chat(ollama.url, { model: "hermes3:8b", messages: [], maxTokens: 64, contextTokens: 2048 });
    expect(result).toMatchObject({ done: true, content: "From Ollama [S1].", toolCalls: [] });
    expect(ollama.prompts()[0].options).toMatchObject({ num_predict: 64, num_ctx: 2048 });
    expect(await createOllamaAdapter().embed(ollama.url, "nomic-embed-text:latest", ["a"])).toHaveLength(1);
  });

  it("defaults to the OpenAI-compatible provider", () => {
    expect(createModelClient().provider).toBe("openai");
  });
});
