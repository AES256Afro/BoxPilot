#!/usr/bin/env node
// Client half of the Unsloth headless spike (docs/spikes/2026-09-unsloth-headless.md). It talks to
// an OpenAI-compatible server (Unsloth's `unsloth run`, or a bare llama-server) and prints one JSON
// object per command on stdout; tests/spikes/unsloth-headless.sh adds the cgroup numbers and keeps
// the record. No dependencies: Node 24's fetch, plus @huggingface/transformers loaded from --dir for
// the in-process embeddings measurement. Spike code, not product code.
//
//   node unsloth-probe.mjs <command> [--base URL] [--key KEY] [--model ID] [--timeout S] ...
//   commands: models, first-token, bench, tools, vision, json, thinking, security, embed,
//             onnx-embed, summarize

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const next = argv[i + 1];
    out[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? argv[(i += 1)] : "true";
  }
  return out;
}

const opt = parseArgs(process.argv.slice(2));
const command = opt._[0];
const base = (opt.base ?? "http://127.0.0.1:18888").replace(/\/$/, "");
const key = opt.key ?? process.env.UNSLOTH_KEY ?? "";
const timeoutMs = Number(opt.timeout ?? 900) * 1000;
const now = () => performance.now() / 1000;
const round = (value, places = 2) => (typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(places)) : value ?? null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function roundAll(value) {
  if (Array.isArray(value)) return value.map(roundAll);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundAll(v)]));
  return typeof value === "number" && !Number.isInteger(value) ? round(value, 3) : value;
}

function emit(object) {
  process.stdout.write(`${JSON.stringify(roundAll(object))}\n`);
}

function headers(extra = {}) {
  const result = { "content-type": "application/json", ...extra };
  if (key && !("authorization" in result)) result.authorization = `Bearer ${key}`;
  return result;
}

async function request(method, pathname, body, { auth } = {}) {
  const extra = auth === undefined ? {} : auth === null ? { authorization: undefined } : { authorization: auth };
  const h = headers(extra);
  if (h.authorization === undefined) delete h.authorization;
  const started = now();
  try {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: kept as text below.
    }
    return { status: response.status, ok: response.ok, json, text, seconds: now() - started, contentType: response.headers.get("content-type") };
  } catch (error) {
    return { status: 0, ok: false, json: null, text: String(error?.message ?? error), seconds: now() - started };
  }
}

let cachedModel = null;
async function modelId() {
  if (opt.model) return opt.model;
  if (cachedModel) return cachedModel;
  const response = await request("GET", "/v1/models");
  cachedModel = response.json?.data?.[0]?.id ?? null;
  return cachedModel;
}

// Unsloth's own switch for Qwen-style thinking. Sent on every request that wants it off, so the
// numbers below are answer tokens, not hidden reasoning.
const NO_THINK = { enable_thinking: false };

async function streamChat(body) {
  const started = now();
  const model = await modelId();
  let response;
  try {
    response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model, ...body, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error), total_s: now() - started };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, error: (await response.text()).slice(0, 600), total_s: now() - started };
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let firstAt = null;
  let lastAt = null;
  let firstEpoch = null;
  let content = "";
  let reasoning = "";
  let chunks = 0;
  let usage = null;
  let finish = null;
  let timings = null;
  let toolCallChunks = 0;
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.usage) usage = json.usage;
    if (json.timings) timings = json.timings;
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    const piece = typeof delta.content === "string" ? delta.content : "";
    const thought = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (piece || thought || delta.tool_calls) {
      const at = now();
      if (firstAt === null) {
        firstAt = at;
        firstEpoch = Date.now() / 1000;
      }
      lastAt = at;
      chunks += 1;
    }
    if (delta.tool_calls) toolCallChunks += 1;
    content += piece;
    reasoning += thought;
    if (choice.finish_reason) finish = choice.finish_reason;
  };
  try {
    for await (const part of response.body) {
      buffer += decoder.decode(part, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, index).trim());
        buffer = buffer.slice(index + 1);
      }
    }
    if (buffer.trim()) handle(buffer.trim());
  } catch (error) {
    return { ok: false, status: response.status, error: `stream: ${error?.message ?? error}`, total_s: now() - started };
  }
  const ended = now();
  const completionTokens = usage?.completion_tokens ?? chunks;
  const promptTokens = usage?.prompt_tokens ?? null;
  const ttft = firstAt === null ? null : firstAt - started;
  const decodeSpan = firstAt !== null && lastAt > firstAt ? lastAt - firstAt : null;
  return {
    ok: firstAt !== null,
    status: response.status,
    model,
    ttft_s: ttft,
    first_token_epoch: firstEpoch,
    total_s: ended - started,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    usage_reported: Boolean(usage),
    chunks,
    decode_tps: decodeSpan && completionTokens > 1 ? (completionTokens - 1) / decodeSpan : null,
    prompt_tps: promptTokens && ttft ? promptTokens / ttft : null,
    finish_reason: finish,
    reasoning_chars: reasoning.length,
    tool_call_chunks: toolCallChunks,
    content_head: content.slice(0, 200),
    server_timings: timings
      ? {
          prompt_n: timings.prompt_n,
          prompt_per_second: timings.prompt_per_second,
          predicted_n: timings.predicted_n,
          predicted_per_second: timings.predicted_per_second,
        }
      : null,
  };
}

async function chat(body) {
  const model = await modelId();
  const response = await request("POST", "/v1/chat/completions", { model, ...body });
  const message = response.json?.choices?.[0]?.message ?? null;
  return {
    status: response.status,
    seconds: response.seconds,
    message,
    usage: response.json?.usage ?? null,
    finish_reason: response.json?.choices?.[0]?.finish_reason ?? null,
    error: response.ok ? null : response.text.slice(0, 600),
    raw: response.json,
  };
}

// About 1,000 tokens of container logs; the nonce keeps llama-server's prompt cache from reusing
// an earlier run's prefix.
function logLines(count, nonce) {
  const services = ["pihole", "nextcloud", "jellyfin", "caddy", "postgres", "redis", "homeassistant", "vaultwarden"];
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const service = services[i % services.length];
    const minute = String(11 + Math.floor(i / 60)).padStart(2, "0");
    const second = String(i % 60).padStart(2, "0");
    const health = i % 7 === 3 ? "unhealthy" : "healthy";
    lines.push(
      `Sep 29 10:${minute}:${second} homebox dockerd[${812 + i}]: container ${service} run=${nonce}-${i} health=${health} cpu=${(i * 7) % 90}% mem=${100 + ((i * 37) % 900)}MiB restarts=${i % 5 === 0 ? 1 : 0}`,
    );
  }
  return lines.join("\n");
}

const LONG_QUESTION = "Here are recent container logs from a home server.\n\n";
const LONG_ASK = "\n\nIn one sentence, which containers look unhealthy?";

async function countPromptTokens(text) {
  const model = await modelId();
  for (const pathname of ["/v1/chat/count_tokens", "/v1/messages/count_tokens"]) {
    const response = await request("POST", pathname, { model, messages: [{ role: "user", content: text }] });
    if (!response.ok || !response.json) continue;
    const value = response.json.input_tokens ?? response.json.prompt_tokens ?? response.json.tokens ?? response.json.count ?? response.json.total_tokens;
    if (typeof value === "number") return value;
  }
  return null;
}

async function longPrompt(target) {
  const nonce = Math.random().toString(36).slice(2, 8);
  let lines = Number(opt.lines ?? 18);
  let text = `${LONG_QUESTION}${logLines(lines, nonce)}${LONG_ASK}`;
  let counted = await countPromptTokens(text);
  if (counted) {
    // Tokenising is cheap; prefill is not. Walk the line count to land near the target.
    for (let step = 0; step < 6 && Math.abs(counted - target) > target * 0.05; step += 1) {
      const perLine = Math.max(10, (counted - 30) / lines);
      lines = Math.max(1, Math.round(lines + (target - counted) / perLine));
      text = `${LONG_QUESTION}${logLines(lines, nonce)}${LONG_ASK}`;
      counted = (await countPromptTokens(text)) ?? counted;
    }
  }
  return { text, lines, counted };
}

const SHORT_PROMPT =
  "Write a detailed explanation, at least 300 words long, of how a reverse proxy such as Caddy or Traefik routes requests to Docker containers on a home server.";

async function commandBench() {
  const kind = opt.kind ?? "short";
  if (kind === "short") {
    const maxTokens = Number(opt["max-tokens"] ?? 150);
    const result = await streamChat({ messages: [{ role: "user", content: SHORT_PROMPT }], max_tokens: maxTokens, seed: 7, ...NO_THINK });
    emit({ kind, max_tokens: maxTokens, ...result });
    return;
  }
  const target = Number(opt["prompt-tokens"] ?? 1000);
  const prompt = await longPrompt(target);
  const maxTokens = Number(opt["max-tokens"] ?? 48);
  const result = await streamChat({ messages: [{ role: "user", content: prompt.text }], max_tokens: maxTokens, seed: 7, ...NO_THINK });
  emit({ kind, max_tokens: maxTokens, target_prompt_tokens: target, lines: prompt.lines, counted_tokens: prompt.counted, ...result });
}

// Waits for a chat request to succeed (the model may be reloading after an idle unload), then
// reports when its first token arrived as an epoch time so the shell can subtract its own t0.
async function commandFirstToken() {
  const deadline = now() + Number(opt.retry ?? 0);
  const statuses = [];
  for (;;) {
    const result = await streamChat({ messages: [{ role: "user", content: "Reply with the single word: ready" }], max_tokens: 8, ...NO_THINK });
    if (result.ok || now() >= deadline) {
      emit({ ...result, retried_statuses: statuses });
      return;
    }
    statuses.push(result.status);
    await sleep(1000);
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_container_status",
      description: "Get the current status of a Docker container on the home server.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The container name, for example pihole" } },
        required: ["name"],
      },
    },
  },
];

const TOOL_PROMPTS = [
  ["Is the pihole container running right now?", "pihole"],
  ["Check the status of the nextcloud container.", "nextcloud"],
  ["Jellyfin feels slow tonight. Can you look at its container?", "jellyfin"],
  ["What state is the container called caddy in?", "caddy"],
  ["Please get me the container status for vaultwarden.", "vaultwarden"],
];

async function commandTools() {
  const trials = Math.min(Number(opt.trials ?? 5), TOOL_PROMPTS.length);
  const results = [];
  let roundTrip = null;
  for (let i = 0; i < trials; i += 1) {
    const [prompt, expected] = TOOL_PROMPTS[i];
    const messages = [
      { role: "system", content: "You help run a home server. Call a tool when it helps answer." },
      { role: "user", content: prompt },
    ];
    const response = await chat({ messages, tools: TOOLS, tool_choice: "auto", max_tokens: 256, ...NO_THINK });
    const call = response.message?.tool_calls?.[0];
    let args = null;
    try {
      args = call ? JSON.parse(call.function?.arguments ?? "null") : null;
    } catch {
      args = null;
    }
    const valid = call?.function?.name === "get_container_status" && typeof args?.name === "string" && args.name.toLowerCase().includes(expected);
    results.push({
      trial: i + 1,
      expected,
      valid,
      status: response.status,
      seconds: response.seconds,
      name: call?.function?.name ?? null,
      arguments: call?.function?.arguments ?? null,
      finish_reason: response.finish_reason,
      content: call ? null : (response.message?.content ?? response.error ?? "").slice(0, 200),
    });
    if (valid && !roundTrip) {
      // Hand the result back and check the model finishes the turn in words.
      const followUp = await chat({
        messages: [
          ...messages,
          { role: "assistant", content: response.message.content ?? "", tool_calls: response.message.tool_calls },
          { role: "tool", tool_call_id: call.id ?? "call_0", content: JSON.stringify({ name: expected, state: "running", health: "healthy", uptime: "3 days" }) },
        ],
        tools: TOOLS,
        max_tokens: 128,
        ...NO_THINK,
      });
      roundTrip = { status: followUp.status, seconds: followUp.seconds, content: (followUp.message?.content ?? followUp.error ?? "").slice(0, 240) };
    }
  }
  emit({ trials, valid: results.filter((r) => r.valid).length, results, round_trip: roundTrip });
}

async function commandVision() {
  const image = await readFile(opt.image);
  const expect = String(opt.expect ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const response = await chat({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What does this image show? Read out any text and numbers you can see." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } },
        ],
      },
    ],
    max_tokens: 220,
    ...NO_THINK,
  });
  const content = response.message?.content ?? "";
  const hits = expect.filter((word) => content.toLowerCase().includes(word));
  emit({
    status: response.status,
    seconds: response.seconds,
    image_bytes: image.length,
    prompt_tokens: response.usage?.prompt_tokens ?? null,
    completion_tokens: response.usage?.completion_tokens ?? null,
    expected: expect,
    matched: hits,
    ok: response.status === 200 && hits.length === expect.length,
    content: content.slice(0, 600),
    error: response.error,
  });
}

async function commandJson() {
  const schema = {
    type: "object",
    properties: {
      container: { type: "string" },
      healthy: { type: "boolean" },
      action: { type: "string", enum: ["none", "restart", "investigate"] },
    },
    required: ["container", "healthy", "action"],
    additionalProperties: false,
  };
  const ask = "The container postgres has restarted 5 times in the last hour and its health check fails. Report its state.";
  const variants = [
    ["json_schema", { type: "json_schema", json_schema: { name: "container_report", strict: true, schema } }],
    ["json_object", { type: "json_object" }],
  ];
  const results = [];
  for (const [name, format] of variants) {
    const content = name === "json_object" ? `${ask} Reply as a JSON object with keys container, healthy and action.` : ask;
    const response = await chat({ messages: [{ role: "user", content }], response_format: format, max_tokens: 200, ...NO_THINK });
    const text = response.message?.content ?? "";
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const valid =
      parsed !== null &&
      typeof parsed === "object" &&
      (name === "json_object" || (typeof parsed.container === "string" && typeof parsed.healthy === "boolean" && ["none", "restart", "investigate"].includes(parsed.action)));
    results.push({ variant: name, status: response.status, seconds: response.seconds, valid, content: text.slice(0, 300), error: response.error });
  }
  emit({ valid: results.filter((r) => r.valid).length, of: results.length, results });
}

async function commandThinking() {
  const question =
    "A home server has 4 CPU cores. A container is capped at 0.5 CPU. What is the largest share of the whole server's CPU it can use, as a percentage? Answer with just the number.";
  const variants = [
    ["default", {}, 700],
    ["enable_thinking=false", { enable_thinking: false }, 700],
    ["chat_template_kwargs.enable_thinking=false", { chat_template_kwargs: { enable_thinking: false } }, 700],
    ["enable_thinking=true", { enable_thinking: true }, 1500],
  ];
  const results = [];
  for (const [name, extra, maxTokens] of variants) {
    const response = await chat({ messages: [{ role: "user", content: question }], max_tokens: maxTokens, ...extra });
    const reasoning = response.message?.reasoning_content ?? response.message?.reasoning ?? "";
    const content = response.message?.content ?? "";
    results.push({
      variant: name,
      status: response.status,
      seconds: response.seconds,
      completion_tokens: response.usage?.completion_tokens ?? null,
      reasoning_tokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      reasoning_chars: reasoning.length,
      think_tag_in_content: content.includes("<think>"),
      finish_reason: response.finish_reason,
      content: content.slice(-160),
      error: response.error,
    });
  }
  emit({ results });
}

// What a caller without the key sees, and whether a request can switch server-side tools back on.
async function commandSecurity() {
  const probes = {};
  for (const [label, method, pathname, auth] of [
    ["models_no_auth", "GET", "/v1/models", null],
    ["models_wrong_key", "GET", "/v1/models", "Bearer sk-unsloth-wrong"],
    ["models_with_key", "GET", "/v1/models", undefined],
    ["root_no_auth", "GET", "/", null],
    ["docs_no_auth", "GET", "/docs", null],
    ["openapi_no_auth", "GET", "/openapi.json", null],
    ["health_no_auth", "GET", "/api/health", null],
    ["chat_no_auth", "POST", "/v1/chat/completions", null],
  ]) {
    const body = method === "POST" ? { messages: [{ role: "user", content: "hi" }], max_tokens: 4 } : undefined;
    const response = await request(method, pathname, body, { auth });
    probes[label] = { status: response.status, content_type: response.contentType ?? null, head: response.text.slice(0, 120) };
  }
  let toolAttempt = null;
  if (opt.hostname) {
    const response = await chat({
      messages: [{ role: "user", content: "Use your terminal tool to run `cat /etc/hostname` and tell me exactly what it prints." }],
      enable_tools: true,
      enabled_tools: ["terminal", "python"],
      max_tokens: 200,
      ...NO_THINK,
    });
    const text = JSON.stringify(response.raw ?? response.error ?? "");
    toolAttempt = {
      status: response.status,
      seconds: response.seconds,
      hostname_leaked: text.includes(opt.hostname),
      content: (response.message?.content ?? response.error ?? "").slice(0, 240),
    };
  }
  emit({ probes, tool_attempt: toolAttempt });
}

const EMBED_TEXTS = [
  "the pihole container is unhealthy",
  "disk almost full on the data volume",
  "the storage volume is nearly out of space",
  "the cat sat on the mat",
  "nextcloud backup finished",
  "jellyfin transcoding uses a lot of CPU",
  "caddy renewed the TLS certificate",
  "postgres restarted five times",
  "a new VM was created for the project",
  "the router rebooted overnight",
  "vaultwarden update available",
  "SMART warning on the second disk",
  "memory usage climbed after the update",
  "home assistant lost its zigbee stick",
  "tailscale connected from a phone",
  "the backup destination is unreachable",
];

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function similarityCheck(vectors) {
  // 1 and 2 say the same thing in different words; 3 is unrelated.
  const related = cosine(vectors[1], vectors[2]);
  const unrelated = cosine(vectors[1], vectors[3]);
  return { related_similarity: related, unrelated_similarity: unrelated, ranks_sensibly: related > unrelated };
}

async function commandEmbed() {
  const model = opt.model ?? (await modelId()) ?? "embedding";
  const single = [];
  let first = null;
  let dims = null;
  for (let i = 0; i < 6; i += 1) {
    const response = await request("POST", "/v1/embeddings", { model, input: EMBED_TEXTS[i % EMBED_TEXTS.length] });
    if (!response.ok) {
      emit({ ok: false, status: response.status, error: response.text.slice(0, 600), model });
      return;
    }
    if (i === 0) first = response.seconds;
    else single.push(response.seconds);
    dims = response.json?.data?.[0]?.embedding?.length ?? dims;
  }
  const batch = await request("POST", "/v1/embeddings", { model, input: EMBED_TEXTS });
  const vectors = batch.json?.data?.map((d) => d.embedding) ?? [];
  emit({
    ok: batch.ok && vectors.length === EMBED_TEXTS.length,
    status: batch.status,
    model,
    dims,
    first_request_s: first,
    single_median_s: median(single),
    batch_size: EMBED_TEXTS.length,
    batch_s: batch.seconds,
    batch_texts_per_s: batch.ok ? EMBED_TEXTS.length / batch.seconds : null,
    ...(vectors.length > 3 ? similarityCheck(vectors) : { error: batch.text.slice(0, 300) }),
  });
}

// Embeddings inside this Node process, the way BoxPilot's server would hold them: no second service.
async function commandOnnxEmbed() {
  const dir = path.resolve(opt.dir);
  const require = createRequire(path.join(dir, "package.json"));
  const entry = require.resolve("@huggingface/transformers");
  const version = JSON.parse(await readFile(path.join(dir, "node_modules", "@huggingface", "transformers", "package.json"), "utf8")).version;
  const loaded = await import(pathToFileURL(entry).href);
  const tf = loaded.pipeline ? loaded : loaded.default;
  if (opt.cache) tf.env.cacheDir = opt.cache;
  const model = opt.model ?? "Xenova/all-MiniLM-L6-v2";
  const cpuBefore = process.cpuUsage();
  const loadStarted = now();
  const extractor = await tf.pipeline("feature-extraction", model, { dtype: opt.dtype ?? "q8" });
  const loadSeconds = now() - loadStarted;
  const pooling = opt.pooling ?? "mean";
  const embed = async (input) => {
    const output = await extractor(input, { pooling, normalize: true });
    return output.tolist();
  };
  const single = [];
  let first = null;
  for (let i = 0; i < 6; i += 1) {
    const started = now();
    await embed(EMBED_TEXTS[i]);
    if (i === 0) first = now() - started;
    else single.push(now() - started);
  }
  const batchStarted = now();
  const vectors = await embed(EMBED_TEXTS);
  const batchSeconds = now() - batchStarted;
  const busyCpu = process.cpuUsage(cpuBefore);
  // Idle: the pipeline stays loaded in this process; does anything keep burning CPU?
  const idleSeconds = Number(opt.idle ?? 20);
  const idleBefore = process.cpuUsage();
  await sleep(idleSeconds * 1000);
  const idle = process.cpuUsage(idleBefore);
  emit({
    ok: vectors.length === EMBED_TEXTS.length,
    runtime: `@huggingface/transformers ${version}`,
    model,
    dtype: opt.dtype ?? "q8",
    pooling,
    dims: vectors[0]?.length ?? null,
    load_s: loadSeconds,
    first_request_s: first,
    single_median_s: median(single),
    batch_size: EMBED_TEXTS.length,
    batch_s: batchSeconds,
    batch_texts_per_s: EMBED_TEXTS.length / batchSeconds,
    busy_cpu_s: (busyCpu.user + busyCpu.system) / 1e6,
    idle_cpu_pct: ((idle.user + idle.system) / 1e6 / idleSeconds) * 100,
    rss_mb: process.memoryUsage().rss / 1048576,
    ...similarityCheck(vectors),
  });
}

async function commandModels() {
  const response = await request("GET", "/v1/models");
  emit({ status: response.status, ids: response.json?.data?.map((d) => d.id) ?? null, head: response.text.slice(0, 300) });
}

// Markdown for the job summary: one table per section, scalar fields only.
async function commandSummarize() {
  const lines = (await readFile(opt.in, "utf8")).split("\n").filter(Boolean);
  const bySection = new Map();
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const section = record.section ?? "misc";
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(record);
  }
  const out = [`## ${opt.title ?? "Unsloth headless spike"}`, ""];
  for (const [section, records] of bySection) {
    const columns = [];
    for (const record of records) {
      for (const [k, v] of Object.entries(record)) {
        if (k === "section" || columns.includes(k)) continue;
        if (v === null || typeof v !== "object") columns.push(k);
      }
    }
    const shown = columns.filter((c) => !["content_head", "content", "head", "at", "host_cpu"].includes(c)).slice(0, 16);
    out.push(`### ${section}`, "", `| ${shown.join(" | ")} |`, `| ${shown.map(() => "---").join(" | ")} |`);
    for (const record of records) {
      out.push(`| ${shown.map((c) => String(record[c] ?? "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 60)).join(" | ")} |`);
    }
    out.push("");
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

const commands = {
  models: commandModels,
  "first-token": commandFirstToken,
  bench: commandBench,
  tools: commandTools,
  vision: commandVision,
  json: commandJson,
  thinking: commandThinking,
  security: commandSecurity,
  embed: commandEmbed,
  "onnx-embed": commandOnnxEmbed,
  summarize: commandSummarize,
};

if (!commands[command]) {
  console.error(`usage: unsloth-probe.mjs <${Object.keys(commands).join("|")}> [--options]`);
  process.exit(2);
}
try {
  await commands[command]();
} catch (error) {
  emit({ ok: false, error: String(error?.stack ?? error).slice(0, 800) });
  process.exitCode = 1;
}
