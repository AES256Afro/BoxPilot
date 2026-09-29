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
 *
 * It also keeps time the way a model on a CPU does, for the benchmark and the budget tests:
 * - Every request is rendered the way Qwen 3.5's chat template renders it (renderPrompt: the tools
 *   first in the system turn, empty think blocks on the turns after the last question, tool results
 *   as user turns), and Unsloth's routing is followed (a request that lets no tool be called and has
 *   no tool history loses its tools).
 * - One slot, as `--parallel 1`, holds the last prompt and what was written after it. A new prompt
 *   reuses the longest common start; where it parts inside what the slot holds, a hybrid model like
 *   Qwen 3.5 can only go back to a checkpoint (llama-server makes them at the last question's start,
 *   and 4 and 516 tokens before a prompt's end), else it reads everything again.
 * - With `state.speed` ({ promptPerSecond, generatePerSecond }) it takes as long as that reading and
 *   writing would, in real time (times `state.timeScale`) or on a simulated clock (`state.clock(ms)`),
 *   and reports llama-server's `timings` and the cached tokens on its last chunk.
 * - A request whose connection closes, or that Unsloth's POST /api/inference/cancel names by its
 *   `cancel_id`, stops at once; `state.log` says how far it got.
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

// The request is in the first user message (the task); the plan and the planner's instruction the
// runner adds after it, and later messages, are the runner's own words.
const lastUserText = (messages) => textOf(messages.find((message) => message?.role === "user")?.content ?? "").split(/\n\n(?:Your plan:|Work out what is asked and plan it\.)/)[0];

/** The tools the planner may name: the schema's list when it has one, else the system message's "Tools:" lines. */
function plannerTools(body) {
  const listed = body?.response_format?.json_schema?.schema?.properties?.plan?.items?.properties?.tool?.enum;
  if (Array.isArray(listed)) return listed.filter((name) => typeof name === "string").map((name) => name.replace(/_/g, "."));
  const text = (Array.isArray(body?.messages) ? body.messages : []).map((message) => textOf(message?.content)).join("\n");
  const section = text.split(/^Tools( you may use)?:$/m).at(-1) ?? "";
  return [...section.matchAll(/^- ([a-z_]+):/gm)].map((match) => match[1].replace(/_/g, "."));
}

/**
 * The structured replies: the understanding (intent and plan) the runner asks for first, and an
 * answer as the owner's JSON fields. `state.script(request)` may return { understanding } for the
 * first, and { content } for either.
 */
export function structuredReply(body) {
  const name = body?.response_format?.json_schema?.name;
  if (name === "understanding") {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const question = lastUserText(messages);
    const offered = plannerTools(body);
    const tools = pickTools(question, offered.filter((toolName) => !["notes.write", "plan.propose", "notify.owner"].includes(toolName)));
    const asked = /<question>\s*([\s\S]*?)\s*<\/question>/.exec(question)?.[1]?.trim();
    const understanding = {
      goal: asked ? `Answer “${asked.slice(0, 160)}”` : "Do my job once and report",
      subject: /pi-?hole/i.test(question) ? "Pi-hole" : /backup/i.test(question) ? "backups" : "this server",
      constraints: [],
      tools: tools.map((tool) => tool.replace(/\./g, "_")),
      confidence: asked && asked.length < 6 ? 0.3 : 0.9,
      clarify: null,
      plan: [...tools.map((tool) => ({ step: `Read ${tool}`, tool: tool.replace(/\./g, "_") })), { step: "Answer with citations", tool: null }],
    };
    return { content: JSON.stringify(understanding) };
  }
  if (name === "answer") {
    const fields = Object.keys(body.response_format.json_schema.schema?.properties ?? {});
    const said = policyReply({ ...body, tools: [] }).content ?? "";
    return { content: JSON.stringify(Object.fromEntries(fields.map((field, index) => [field, index === 0 ? said.split("\n").filter(Boolean).slice(0, 3).join(" ") : `See ${fields[0]}.`]))) };
  }
  return null;
}
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join(" ") : "");

/** The deterministic model: tool calls first, then an answer drawn from what the tools said. */
export function policyReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  // Offered as functions (server_facts); chosen by the catalog's names (server.facts).
  const offered = (Array.isArray(body?.tools) ? body.tools : []).map((tool) => tool?.function?.name).filter(Boolean).map((name) => name.replace(/_/g, "."));
  const question = lastUserText(messages);
  const toolResults = messages.filter((message) => message?.role === "tool");
  if (offered.length && toolResults.length === 0 && body?.tool_choice !== "none") {
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

/** Tokens for so many characters: about four a token, as Qwen's tokenizer reads BoxPilot's prompts. */
export const charsPerToken = 4;
export const fakeTokens = (chars) => Math.max(1, Math.ceil(chars / charsPerToken));

// The fixed words the template puts after the tool list, as long as Qwen's, in words of our own.
const toolsTail = `\n</tools>\n\n${"To call a function, reply with only a tool call block naming the function, with each parameter on lines of its own and nothing after the block. Give every required parameter. A sentence may come before a call, never after it. If no function fits, answer as usual without mentioning them. ".repeat(2).trim()}`;
const thinkingOff = (body) => body?.enable_thinking === false || body?.chat_template_kwargs?.enable_thinking === false;

function renderArguments(raw) {
  let value = raw;
  if (typeof raw === "string") { try { value = JSON.parse(raw || "{}"); } catch { return `<parameter=arguments>\n${raw}\n</parameter>\n`; } }
  return Object.entries(value && typeof value === "object" ? value : {}).map(([key, entry]) => `<parameter=${key}>\n${entry !== null && typeof entry === "object" ? JSON.stringify(entry) : String(entry)}\n</parameter>\n`).join("");
}

/** An assistant turn as the template writes it back: its words, then its tool calls. */
function assistantText(message) {
  const content = textOf(message?.content).trim();
  const calls = (Array.isArray(message?.tool_calls) ? message.tool_calls : []).map((call) => call?.function ?? call);
  return `${content}${calls.map((call, index) => `${index === 0 ? (content ? "\n\n" : "") : "\n"}<tool_call>\n<function=${call.name}>\n${renderArguments(call.arguments)}</function>\n</tool_call>`).join("")}`;
}

/**
 * A request's prompt as Qwen 3.5's template makes it, after Unsloth's routing: the tools first in
 * the system turn (dropped when none may be called and there is no tool history), the system
 * messages merged, empty think blocks on the assistant turns after the last question, tool results
 * as user turns, and the generation prompt with thinking on or off.
 */
export function renderPrompt(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const history = messages.some((message) => message?.role === "tool" || (message?.role === "assistant" && message?.tool_calls?.length));
  const tools = Array.isArray(body?.tools) && body.tools.length && !(body.tool_choice === "none" && !history) ? body.tools : [];
  const system = messages.filter((message) => message?.role === "system").map((message) => textOf(message.content).trim()).filter(Boolean).join("\n\n");
  let out = "";
  if (tools.length) out += `<|im_start|>system\n# Tools\n\nThe functions you can call:\n\n<tools>${tools.map((tool) => `\n${JSON.stringify(tool)}`).join("")}${toolsTail}${system ? `\n\n${system}` : ""}<|im_end|>\n`;
  else if (system) out += `<|im_start|>system\n${system}<|im_end|>\n`;
  const rest = messages.filter((message) => message?.role !== "system");
  const lastQuestion = rest.findLastIndex((message) => message?.role === "user");
  rest.forEach((message, index) => {
    if (message?.role === "user") out += `<|im_start|>user\n${textOf(message.content).trim()}<|im_end|>\n`;
    else if (message?.role === "assistant") out += `<|im_start|>assistant\n${index > lastQuestion ? "<think>\n\n</think>\n\n" : ""}${assistantText(message)}<|im_end|>\n`;
    else if (message?.role === "tool") {
      if (rest[index - 1]?.role !== "tool") out += "<|im_start|>user";
      out += `\n<tool_response>\n${textOf(message.content).trim()}\n</tool_response>`;
      if (rest[index + 1]?.role !== "tool") out += "<|im_end|>\n";
    }
  });
  return `${out}<|im_start|>assistant\n${thinkingOff(body) ? "<think>\n\n</think>\n\n" : "<think>\n"}`;
}

/** Where llama-server checkpoints a hybrid model's prompt: the last question's start, and 4 and 516 tokens before the end. */
function checkpointsOf(prompt, from) {
  let lastQuestion = -1;
  for (let at = prompt.lastIndexOf("<|im_start|>user\n"); at >= 0; at = at > 0 ? prompt.lastIndexOf("<|im_start|>user\n", at - 1) : -1) {
    if (!prompt.startsWith("<tool_response>", at + "<|im_start|>user\n".length)) { lastQuestion = at; break; }
  }
  return [lastQuestion, prompt.length - 4 * charsPerToken, prompt.length - 516 * charsPerToken].filter((position) => position > from);
}

/**
 * One slot's prompt cache, as `--parallel 1` keeps it for a hybrid model: how many characters of a
 * new prompt it already holds. All of what it holds when the new prompt starts with it; otherwise
 * back to the last checkpoint before the two part, or nothing. At least one token is always read.
 */
export function createSlot() {
  const slot = { text: "", checkpoints: [] };
  return {
    admit(prompt) {
      let common = 0;
      const limit = Math.min(slot.text.length, prompt.length);
      while (common < limit && slot.text.charCodeAt(common) === prompt.charCodeAt(common)) common += 1;
      let reused = common >= slot.text.length ? slot.text.length : Math.max(0, ...slot.checkpoints.filter((position) => position <= common));
      reused = Math.min(reused, prompt.length - charsPerToken);
      slot.checkpoints = [...slot.checkpoints.filter((position) => position <= reused), ...checkpointsOf(prompt, reused)].sort((a, b) => a - b).slice(-4);
      return Math.max(0, reused);
    },
    /** What the slot holds after an answer: the prompt and what was written after it (or as far as it got). */
    hold(text) { slot.text = text; },
    held: () => slot.text,
    clear() { slot.text = ""; slot.checkpoints = []; },
  };
}

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
  // speed: { promptPerSecond, generatePerSecond } makes it take as long as a CPU would; clock(ms)
  // spends that time on a simulated clock instead of the real one; log keeps each call's timing.
  const state = { chat: "policy", script: null, chunkSize: 24, delayMs: 0, busyThreads, busyMs, status: 500, speed: null, timeScale: 1, clock: null, log: [], cancels: [], ...options };
  const slot = createSlot();
  const running = new Map();   // cancel_id -> the call it names, while it runs
  const json = (response, status, value) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  /** Wait `ms` of real time in small pieces, giving up as soon as `call` is stopped. */
  const spend = async (ms, call) => {
    const until = Date.now() + ms;
    while (!call.stopped && Date.now() < until) await sleep(Math.min(20, until - Date.now()));
    return !call.stopped;
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
    // Unsloth Studio's cancel, by the cancel_id a chat request carried.
    if (path === "/api/inference/cancel") {
      const id = String(body?.cancel_id ?? "");
      state.cancels.push(id);
      const call = running.get(id);
      call?.stop("cancelled");
      return json(response, 200, { cancelled: call ? 1 : 0 });
    }
    if (path !== "/v1/chat/completions") return json(response, 404, { error: { message: "not found" } });
    if (state.chat === "error") return json(response, state.status, { error: { message: "the model crashed" } });
    if (state.chat === "missing") return json(response, 404, { error: { message: `model ${body?.model} not found` } });
    if (state.busyThreads > 0 && state.busyMs > 0) await burn({ threads: state.busyThreads, ms: state.busyMs });
    if (state.chat === "hang") { response.writeHead(200, { "Content-Type": "text/event-stream" }); return undefined; }
    const scripted = typeof state.script === "function" ? state.script(body) : null;
    const understanding = body?.response_format?.json_schema?.name === "understanding";
    // A script that answers the tool loop is not asked to understand: the fake does that itself,
    // unless the script returns { understanding } (or plain content) for it.
    const reply = understanding
      ? (scripted?.understanding ? { content: JSON.stringify(scripted.understanding) } : scripted?.raw ? { content: scripted.raw } : structuredReply(body))
      : scripted ?? structuredReply(body) ?? policyReply(body);
    const toolCalls = (reply.toolCalls ?? []).map((call, index) => ({ id: `call_${state.log.length}_${index}`, name: call.name, arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}) }));

    // What reading this prompt and writing this answer costs, against what the slot holds.
    const prompt = renderPrompt(body);
    // With thinking on, the model closes its (here empty) think block before it answers.
    const written = `${thinkingOff(body) ? "" : "\n</think>\n\n"}${assistantText({ content: reply.content ?? "", tool_calls: toolCalls.map((call) => ({ function: call })) })}`;
    const reusedChars = slot.admit(prompt);
    const promptTokens = fakeTokens(prompt.length);
    const cachedTokens = Math.min(promptTokens - 1, Math.floor(reusedChars / charsPerToken));
    const readTokens = promptTokens - cachedTokens;
    const completionTokens = fakeTokens(written.length);
    const speed = state.speed;
    const promptMs = speed ? Math.round((readTokens / speed.promptPerSecond) * 1000) : 0;
    const generateMs = speed ? Math.round((completionTokens / speed.generatePerSecond) * 1000) : 0;
    const entry = {
      promptTokens, cachedTokens, readTokens, completionTokens, promptMs, generateMs,
      thinking: !thinkingOff(body), toolChoice: body?.tool_choice ?? null, tools: Array.isArray(body?.tools) ? body.tools.length : 0,
      cancelId: typeof body?.cancel_id === "string" ? body.cancel_id : null, stopped: null, readBeforeStop: null,
    };
    state.log.push(entry);
    const readingSince = Date.now();
    let reading = true;
    // Stopped by a closed connection or Unsloth's cancel: noted at once, with how much it had read.
    const call = {
      stopped: false, cancelId: entry.cancelId,
      stop(reason) {
        if (call.stopped) return;
        call.stopped = reason;
        entry.stopped = reason;
        entry.readBeforeStop = reading ? Math.round(readTokens * Math.min(1, (Date.now() - readingSince) / Math.max(1, promptMs * state.timeScale))) : readTokens;
      },
    };
    if (call.cancelId) running.set(call.cancelId, call);
    response.once("close", () => { if (!response.writableEnded) call.stop("closed"); });
    const timings = {
      prompt_n: readTokens, cache_n: cachedTokens, predicted_n: completionTokens,
      ...(speed ? { prompt_ms: promptMs, prompt_per_second: speed.promptPerSecond, predicted_ms: generateMs, predicted_per_second: speed.generatePerSecond } : {}),
    };
    const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, prompt_tokens_details: { cached_tokens: cachedTokens } };
    const done = () => { running.delete(call.cancelId); };

    // Reading the prompt: on the simulated clock all at once, or in real time until it is stopped.
    if (speed && state.clock) state.clock(promptMs + generateMs);
    const realTime = speed && !state.clock;
    if (realTime && !(await spend(promptMs * state.timeScale, call))) {
      slot.hold(prompt.slice(0, reusedChars + (entry.readBeforeStop ?? 0) * charsPerToken));
      done();
      if (!response.destroyed) response.destroy();
      return undefined;
    }
    reading = false;
    slot.hold(`${prompt}${written}`);

    if (body?.stream === false) {
      done();
      return json(response, 200, { choices: [{ index: 0, message: { role: "assistant", content: reply.content ?? "", tool_calls: toolCalls.map((entryCall) => ({ id: entryCall.id, type: "function", function: { name: entryCall.name, arguments: entryCall.arguments } })) }, finish_reason: toolCalls.length ? "tool_calls" : "stop" }], usage, timings });
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    const send = (value) => { if (!response.destroyed) response.write(`data: ${JSON.stringify(value)}\n\n`); };
    if (state.chat === "broken") { send({ error: { message: "out of memory" } }); response.end(); done(); return undefined; }
    const choice = (delta, finish = null) => ({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] });
    const pieces = [];
    if (toolCalls.length) {
      toolCalls.forEach((toolCall, index) => {
        pieces.push({ tool_calls: [{ index, id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: "" } }] });
        for (let from = 0; from < toolCall.arguments.length; from += state.chunkSize) pieces.push({ tool_calls: [{ index, function: { arguments: toolCall.arguments.slice(from, from + state.chunkSize) } }] });
      });
    } else {
      const text = String(reply.content ?? "");
      for (let from = 0; from < text.length; from += state.chunkSize) pieces.push({ content: text.slice(from, from + state.chunkSize) });
    }
    // Writing: the pieces spread over the answer's time, stopping when the call is.
    const perPiece = realTime && pieces.length ? (generateMs * state.timeScale) / pieces.length : 0;
    for (const piece of pieces) {
      if (call.stopped || response.destroyed) { call.stop("closed"); done(); return undefined; }
      send(choice(piece));
      if (perPiece) await spend(perPiece, call);
      else if (state.delayMs && piece.content) await sleep(state.delayMs);
    }
    send(choice({}, toolCalls.length ? "tool_calls" : "stop"));
    // llama-server's last chunk: the usage, the cached tokens and its timings, as Unsloth relays them.
    send({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [], usage, timings });
    if (!response.destroyed) response.end("data: [DONE]\n\n");
    done();
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
    /** Each chat call's tokens (read, cached, written), its time, and whether it was stopped. */
    calls: () => state.log,
    reset: () => { requests.length = 0; state.log.length = 0; state.cancels.length = 0; slot.clear(); },
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
