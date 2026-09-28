/**
 * A stand-in for Ollama's HTTP API, for tests (M34): scripted models, embeddings and chat answers,
 * served on a loopback port so the assistant reaches it exactly as it reaches the real one - over
 * fetch, with its own deadlines and a streamed NDJSON answer. Every request is kept, so a test can
 * read the prompt the model was given.
 *
 * `state` can be changed between requests:
 * - models: the names /api/tags lists.
 * - answer: the chat text, or a function of the request body returning it.
 * - chat: "answer" (default), "hang" (never answers; ends when the caller hangs up), "error" (500),
 *   "missing" (404, as Ollama answers for a model it does not have), "broken" (a stream error).
 * - embed: text => vector, for /api/embed.
 * - chunkSize, delayMs: how the answer is cut up and paced.
 */
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const parse = (raw) => {
  try { return raw ? JSON.parse(raw) : null; } catch { return raw; }
};

/** A tiny deterministic vector: counts of a few letters, so similar words land near each other. */
export function letterVector(text) {
  const vector = new Array(8).fill(0);
  for (const character of String(text).toLowerCase()) {
    const code = character.charCodeAt(0);
    if (code >= 97 && code <= 122) vector[code % 8] += 1;
  }
  return vector.map((value) => value + 0.01);
}

export async function startFakeOllama(options = {}) {
  const requests = [];
  const state = { models: ["hermes3:8b", "nomic-embed-text:latest"], answer: "", chat: "answer", embed: letterVector, chunkSize: 16, delayMs: 0, ...options };
  const json = (response, status, value) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = parse(raw);
    requests.push({ method: request.method, path: request.url, body });
    if (request.url === "/api/tags") return json(response, 200, { models: state.models.map((name) => ({ name, size: 1024, details: { family: "test" } })) });
    if (request.url === "/api/embed") {
      if (!state.models.includes(body?.model)) return json(response, 404, { error: `model "${body?.model}" not found` });
      return json(response, 200, { model: body.model, embeddings: body.input.map((text) => state.embed(text)) });
    }
    if (request.url === "/api/chat") {
      if (state.chat === "error") return json(response, 500, { error: "the model crashed" });
      if (state.chat === "missing") return json(response, 404, { error: `model "${body?.model}" not found, try pulling it first` });
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (state.chat === "hang") return undefined;
      if (state.chat === "broken") { response.end(`${JSON.stringify({ error: "out of memory" })}\n`); return undefined; }
      const text = typeof state.answer === "function" ? state.answer(body) : state.answer;
      for (let from = 0; from < text.length; from += state.chunkSize) {
        if (response.destroyed) return undefined;
        response.write(`${JSON.stringify({ model: body?.model, message: { role: "assistant", content: text.slice(from, from + state.chunkSize) }, done: false })}\n`);
        if (state.delayMs) await sleep(state.delayMs);
      }
      response.end(`${JSON.stringify({ model: body?.model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`);
      return undefined;
    }
    return json(response, 404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    requests,
    /** Every chat request's messages, as the model received them. */
    prompts: () => requests.filter((entry) => entry.path === "/api/chat").map((entry) => entry.body),
    reset: () => { requests.length = 0; },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
