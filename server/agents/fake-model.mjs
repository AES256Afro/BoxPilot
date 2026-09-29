#!/usr/bin/env node
/**
 * A stand-in for a local model server (M37): the OpenAI-compatible API that `unsloth run` serves,
 * with a deterministic "model" behind it. It is what the tests, the demo and the real-systemd cap
 * test run instead of Qwen, so every path an agent takes - tool calls, answers, errors, a model
 * that hangs, one that is slow, one that keeps the processor busy - can be driven on purpose.
 *
 * In-process: `startFakeModel(options)` returns its address, the requests it saw and a `state` a
 * test may change between requests. As a process (the runner's "fake" driver, and the systemd
 * test): `node server/agents/fake-model.mjs --port 0 [--busy-threads N --busy-ms M]` prints the
 * same "API Key: ..." line Unsloth prints, then "Listening on http://127.0.0.1:<port>".
 *
 * The default behaviour ("policy") acts like a small agent: on a question it first asks for one or
 * two of the tools it was offered, chosen by the words in the question, and once it has their
 * output it answers from it, citing each tool's output as [T1], [T2]. `state.script(request)` may
 * return a reply of its own instead: { content } or { toolCalls: [{ name, arguments }] }.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { Worker } from "node:worker_threads";
import { setTimeout as sleep } from "node:timers/promises";

/** A tiny deterministic vector: counts of a few letters, so similar words land near each other. */
export function letterVector(text) {
  const vector = new Array(8).fill(0);
  for (const character of String(text).toLowerCase()) {
    const code = character.charCodeAt(0);
    if (code >= 97 && code <= 122) vector[code % 8] += 1;
  }
  return vector.map((value) => value + 0.01);
}

const topics = [
  [/\b(called|named|hostname|operating system|kernel|memory|processor|cpu|uptime|address)\b/i, ["server.facts"]],
  [/pi-?hole|dns|block|ads?\b|gravity/i, ["pihole.stats", "where.runs"]],
  [/where|which (container|host)|runs? (on|in)|native/i, ["where.runs"]],
  [/log|journal|error|crash/i, ["logs.query", "alerts.active"]],
  [/backup|restore|snapshot/i, ["backups.status", "jobs.recent"]],
  [/disk|storage|drive|smart|space/i, ["storage.health"]],
  [/app|container|docker|running/i, ["apps.list"]],
  [/service|systemd|unit/i, ["services.status"]],
  [/job|fail/i, ["jobs.recent", "alerts.active"]],
  [/how (do|to)|what is|document|docs?\b|explain/i, ["docs.search"]],
  [/note|remember|learn/i, ["notes.read"]],
];

/** Which offered tools a question points at, at most two, facts first when nothing else fits. */
export function pickTools(question, offered) {
  const names = new Set(offered);
  const chosen = [];
  for (const [pattern, tools] of topics) {
    if (!pattern.test(question)) continue;
    for (const tool of tools) if (names.has(tool) && !chosen.includes(tool)) chosen.push(tool);
  }
  if (!chosen.length) for (const tool of ["server.facts", "alerts.active", "docs.search"]) if (names.has(tool)) chosen.push(tool);
  return chosen.slice(0, 2);
}

const argumentsFor = (tool, question) => {
  if (tool === "docs.search") return { query: question.slice(0, 200) };
  if (tool === "logs.query") return { target: "boxpilot", kind: "group", lines: 50 };
  if (tool === "where.runs") return { name: /pi-?hole/i.test(question) ? "pihole" : question.split(/\s+/).find((word) => word.length > 3) ?? "docker" };
  return {};
};

const lastUserText = (messages) => [...messages].reverse().find((message) => message?.role === "user")?.content ?? "";
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join(" ") : "");

/** The deterministic model: tool calls first, then an answer drawn from what the tools said. */
export function policyReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  // Offered as functions (server_facts); chosen by the catalog's names (server.facts).
  const offered = (Array.isArray(body?.tools) ? body.tools : []).map((tool) => tool?.function?.name).filter(Boolean).map((name) => name.replace(/_/g, "."));
  const question = textOf(lastUserText(messages));
  const toolResults = messages.filter((message) => message?.role === "tool");
  if (offered.length && toolResults.length === 0) {
    const tools = pickTools(question, offered.filter((name) => !["notes.write", "plan.propose", "notify.owner"].includes(name)));
    if (tools.length) return { toolCalls: tools.map((name) => ({ name: name.replace(/\./g, "_"), arguments: argumentsFor(name, question) })) };
  }
  if (!toolResults.length) return { content: "I have no tool output to go on, so I cannot say anything about this server yet." };
  const lines = toolResults.slice(0, 4).map((message, index) => {
    const text = textOf(message.content).replace(/<\/?tool_output[^>]*>/g, "").replace(/\s+/g, " ").trim();
    const first = text.replace(/^Data from [^:]*:\s*/i, "").slice(0, 180);
    return `- ${first}${first.length >= 180 ? "…" : ""} [T${index + 1}]`;
  });
  return { content: `Here is what I found.\n\n${lines.join("\n")}` };
}

const tokens = (text) => Math.max(1, Math.ceil(String(text ?? "").length / 4));

/** Keep `threads` processor threads fully busy for `ms` milliseconds: what a model does while it writes. */
export async function burn({ threads = 1, ms = 1000 } = {}) {
  if (threads <= 0 || ms <= 0) return;
  const code = "const { workerData } = require('node:worker_threads'); const end = Date.now() + workerData; let x = 0; while (Date.now() < end) { x = (x * 31 + 7) % 1000003; }";
  const workers = Array.from({ length: threads }, () => new Worker(code, { eval: true, workerData: ms }));
  await Promise.all(workers.map((worker) => new Promise((resolve) => { worker.once("exit", resolve); worker.once("error", resolve); })));
}

export async function startFakeModel({
  port = 0,
  host = "127.0.0.1",
  apiKey = null,
  model = "fake/qwen-agent",
  busyThreads = 0,
  busyMs = 0,
  ...options
} = {}) {
  const requests = [];
  const state = { chat: "policy", script: null, chunkSize: 24, delayMs: 0, busyThreads, busyMs, status: 500, ...options };
  const json = (response, status, value) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) { raw += chunk; if (raw.length > 4 * 1024 * 1024) { response.destroy(); return undefined; } }
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const path = String(request.url ?? "").split("?")[0];
    requests.push({ method: request.method, path, body, authorization: request.headers.authorization ?? null });
    if (path === "/health") return json(response, 200, { status: "ok" });
    if (apiKey && request.headers.authorization !== `Bearer ${apiKey}`) return json(response, 401, { error: { message: "missing or wrong key" } });
    if (path === "/v1/models") return json(response, 200, { object: "list", data: [{ id: model, object: "model", owned_by: "boxpilot-fake" }] });
    if (path === "/v1/embeddings") {
      const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ""];
      return json(response, 200, { data: inputs.map((text, index) => ({ index, embedding: letterVector(text) })), model });
    }
    if (path !== "/v1/chat/completions") return json(response, 404, { error: { message: "not found" } });
    if (state.chat === "error") return json(response, state.status, { error: { message: "the model crashed" } });
    if (state.chat === "missing") return json(response, 404, { error: { message: `model ${body?.model} not found` } });
    if (state.busyThreads > 0 && state.busyMs > 0) await burn({ threads: state.busyThreads, ms: state.busyMs });
    if (state.chat === "hang") { response.writeHead(200, { "Content-Type": "text/event-stream" }); return undefined; }
    const reply = (typeof state.script === "function" ? state.script(body) : null) ?? policyReply(body);
    const prompt = (Array.isArray(body?.messages) ? body.messages : []).map((message) => textOf(message?.content)).join("\n");
    const usage = { prompt_tokens: tokens(prompt), completion_tokens: tokens(reply.content ?? JSON.stringify(reply.toolCalls ?? [])) };
    if (body?.stream === false) {
      return json(response, 200, { choices: [{ index: 0, message: { role: "assistant", content: reply.content ?? "", tool_calls: (reply.toolCalls ?? []).map((call, index) => ({ id: `call_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })) }, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" }], usage });
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    const send = (value) => { if (!response.destroyed) response.write(`data: ${JSON.stringify(value)}\n\n`); };
    if (state.chat === "broken") { send({ error: { message: "out of memory" } }); response.end(); return undefined; }
    const choice = (delta, finish = null) => ({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] });
    if (reply.toolCalls?.length) {
      reply.toolCalls.forEach((call, index) => {
        const argumentsText = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
        send(choice({ tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name: call.name, arguments: "" } }] }));
        for (let from = 0; from < argumentsText.length; from += state.chunkSize) send(choice({ tool_calls: [{ index, function: { arguments: argumentsText.slice(from, from + state.chunkSize) } }] }));
      });
      send(choice({}, "tool_calls"));
    } else {
      const text = String(reply.content ?? "");
      for (let from = 0; from < text.length; from += state.chunkSize) {
        if (response.destroyed) return undefined;
        send(choice({ content: text.slice(from, from + state.chunkSize) }));
        if (state.delayMs) await sleep(state.delayMs);
      }
      send(choice({}, "stop"));
    }
    send({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [], usage });
    if (!response.destroyed) response.end("data: [DONE]\n\n");
    return undefined;
  });
  server.listen(port, host);
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    apiKey,
    model,
    state,
    requests,
    /** Every chat request's body, as the model received it. */
    prompts: () => requests.filter((entry) => entry.path === "/v1/chat/completions").map((entry) => entry.body),
    reset: () => { requests.length = 0; },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// As a process: the runner's "fake" driver starts this the way it starts `unsloth run`.
if (import.meta.main) {
  const argument = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
  };
  const apiKey = `sk-fake-${randomBytes(12).toString("hex")}`;
  const fake = await startFakeModel({
    port: Number(argument("port", "0")),
    apiKey,
    model: argument("model", "fake/qwen-agent"),
    busyThreads: Number(argument("busy-threads", "0")),
    busyMs: Number(argument("busy-ms", "0")),
  });
  process.stdout.write(`API Key: ${apiKey}\nListening on ${fake.url}\n`);
  const stop = () => { void fake.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
