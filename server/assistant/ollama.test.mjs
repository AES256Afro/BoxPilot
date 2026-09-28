// @vitest-environment node
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOllama } from "../../test/fake-ollama.mjs";
import { createOllamaClient, isEmbeddingModel, isLocalAddress, normalizeEndpoint } from "./ollama.mjs";

let fake;
beforeAll(async () => { fake = await startFakeOllama({ answer: "Hello from the model [S1]." }); });
afterAll(async () => { await fake?.close(); });

describe("which addresses count as local", () => {
  it("accepts loopback, private, link-local, tailnet and unique-local addresses, and nothing public", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.20", "169.254.3.4", "100.101.102.103", "::1", "fd12::1", "fe80::1", "[::1]", "::ffff:192.168.1.2"]) expect(isLocalAddress(address), address).toBe(true);
    for (const address of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "not-an-ip"]) expect(isLocalAddress(address), address).toBe(false);
  });

  it("keeps an address to its origin and refuses anything that is not on this network", () => {
    expect(normalizeEndpoint("http://127.0.0.1:11434/")).toBe("http://127.0.0.1:11434");
    expect(normalizeEndpoint(" http://gpu-box:11434 ")).toBe("http://gpu-box:11434");
    expect(normalizeEndpoint("https://ollama.home.arpa")).toBe("https://ollama.home.arpa");
    expect(normalizeEndpoint("http://desktop.tail1234.ts.net:11434")).toBe("http://desktop.tail1234.ts.net:11434");
    expect(() => normalizeEndpoint("https://api.openai.com")).toThrow(/private, tailnet or loopback/);
    expect(() => normalizeEndpoint("http://8.8.8.8:11434")).toThrow(/private, tailnet or loopback/);
    expect(() => normalizeEndpoint("http://user:secret@192.168.1.20:11434")).toThrow(/user name or password/);
    expect(() => normalizeEndpoint("http://192.168.1.20:11434/v1?key=x")).toThrow(/no path/);
    expect(() => normalizeEndpoint("ftp://192.168.1.20")).toThrow(/http/);
    expect(() => normalizeEndpoint("")).toThrow();
  });

  it("refuses a local-looking name that resolves to a public address", async () => {
    const client = createOllamaClient({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    await expect(client.tags("http://gpu-box:11434")).rejects.toThrow(/does not resolve to an address on this network/);
  });

  it("tells embedding models from chat models by name", () => {
    expect(isEmbeddingModel("nomic-embed-text:latest")).toBe(true);
    expect(isEmbeddingModel("mxbai-embed-large")).toBe(true);
    expect(isEmbeddingModel("hermes3:8b")).toBe(false);
  });
});

describe("the client, against a stand-in model server", () => {
  const client = createOllamaClient();

  it("lists the models", async () => {
    expect((await client.tags(fake.url)).map((model) => model.name)).toEqual(["hermes3:8b", "nomic-embed-text:latest"]);
  });

  it("returns one embedding per input", async () => {
    const vectors = await client.embed(fake.url, "nomic-embed-text:latest", ["one", "two"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(8);
  });

  it("streams an answer piece by piece and says when the model finished", async () => {
    const pieces = [];
    const result = await client.chat(fake.url, { model: "hermes3:8b", messages: [{ role: "user", content: "hi" }] }, { onDelta: (piece) => { pieces.push(piece); } });
    expect(result.done).toBe(true);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe("Hello from the model [S1].");
  });

  it("stops reading when the caller has had enough", async () => {
    let received = "";
    const result = await client.chat(fake.url, { model: "hermes3:8b", messages: [] }, { onDelta: (piece) => { received += piece; return received.length < 10; } });
    expect(result).toMatchObject({ done: false, stopped: true });
  });

  it("names a missing model, and an error in the stream", async () => {
    fake.state.chat = "missing";
    await expect(client.chat(fake.url, { model: "llama9", messages: [] })).rejects.toMatchObject({ code: "model_missing" });
    fake.state.chat = "broken";
    await expect(client.chat(fake.url, { model: "hermes3:8b", messages: [] })).rejects.toThrow(/out of memory/);
    fake.state.chat = "answer";
  });

  it("gives up at its deadline", async () => {
    fake.state.chat = "hang";
    try {
      await expect(client.chat(fake.url, { model: "hermes3:8b", messages: [] }, { timeoutMs: 100 })).rejects.toThrow();
    } finally {
      fake.state.chat = "answer";
    }
  });

  it("does not follow a redirect somewhere else", async () => {
    const redirecting = http.createServer((_request, response) => { response.writeHead(302, { Location: "https://example.com/api/tags" }); response.end(); });
    redirecting.listen(0, "127.0.0.1");
    await new Promise((resolve) => redirecting.once("listening", resolve));
    try {
      await expect(client.tags(`http://127.0.0.1:${redirecting.address().port}`)).rejects.toThrow();
    } finally {
      redirecting.closeAllConnections?.();
      await new Promise((resolve) => redirecting.close(resolve));
    }
  });
});
