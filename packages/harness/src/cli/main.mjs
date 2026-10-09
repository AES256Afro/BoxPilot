/**
 * The harness's own host (M45.8): a command line that runs an agent in one folder, without BoxPilot.
 * It proves the harness stands on its own: the same loop, check, safety, router and providers
 * BoxPilot's agents use, with tools of its own, approvals asked at the terminal and a SQLite file
 * for runs and memory.
 *
 * `main(argv, io)` is the whole program and returns its exit code, so tests run it in-process with
 * their own streams, clock and network.
 */
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { runDefaults, runTask } from "../core/run.mjs";
import { createToolbox } from "../core/tools.mjs";
import { createFakeProvider } from "../providers/fake.mjs";
import { createOpenAiClient } from "../providers/openai-client.mjs";
import { normalizeEndpoint } from "../providers/local-endpoint.mjs";
import { createOpenAiCompatibleProvider } from "../providers/openai-compatible.mjs";
import { createRedactor, redactText } from "../safety/redaction.mjs";
import { createStandIns, hideRequest, showResult } from "../safety/stand-ins.mjs";
import { createApprover, terminalSafe } from "./approve.mjs";
import { cliRules } from "./prompt.mjs";
import { openStore } from "./store.mjs";
import { createFolder, defaultPrograms, folderTools } from "./tools.mjs";

export const usage = `boxpilot-harness: an agent that works in one folder.

Usage:
  boxpilot-harness run "<task>" [options]   Run a task (the word run may be left out)
  boxpilot-harness runs [--limit N]         The latest runs
  boxpilot-harness show <run>               One run's answer and trace
  boxpilot-harness notes [words]            The notes the agent saved
  boxpilot-harness eval <cases.json>        Run cases, each in a copy of the folder, and grade them

The model, one or more of:
  --endpoint <url> [--model <name>]   A model server on this machine or your network that speaks
                                      the OpenAI chat API (llama-server, Unsloth, Ollama, vLLM)
  --claude-key-file <file>            Claude, for --route remote or auto (--claude-model, --effort)
  --fake <turns.json>                 Scripted turns instead of a model (--fake-remote for the remote side)

Options:
  --dir <folder>        The working folder (default: this one)
  --route <route>       local (default), remote, or auto: local, moving to the remote model when
                        the local one fails or the work outgrows its context (--context N tokens)
  --yes                 Approve every change without asking
  --read-only           Approve no change
  --allow <program>     A program shell_run may start; repeat it (replaces the default list)
  --web                 Let the agent read public web pages
  --names as-is         Send this machine's names to Claude unchanged (default: replaced)
  --steps N  --seconds N  --tool-calls N
  --db <file>           Where runs and notes are kept (default: <folder>/.harness/harness.db)
  --json                Print the result as JSON
  --quiet               Print only the answer
`;

const optionSpec = {
  dir: { type: "string" }, db: { type: "string" },
  endpoint: { type: "string" }, model: { type: "string" }, "api-key-file": { type: "string" }, context: { type: "string" },
  fake: { type: "string" }, "fake-remote": { type: "string" },
  "claude-key-file": { type: "string" }, "claude-model": { type: "string" }, effort: { type: "string" }, names: { type: "string" },
  route: { type: "string" },
  yes: { type: "boolean" }, "read-only": { type: "boolean" }, allow: { type: "string", multiple: true }, web: { type: "boolean" },
  steps: { type: "string" }, seconds: { type: "string" }, "tool-calls": { type: "string" },
  json: { type: "boolean" }, quiet: { type: "boolean" }, limit: { type: "string" },
  help: { type: "boolean", short: "h" }, version: { type: "boolean" },
};
const commands = new Set(["run", "runs", "show", "notes", "eval", "help"]);
// Before a model has been measured here: a modest machine's local speeds, and a hosted model's.
const firstSpeeds = { local: { promptPerSecond: 30, generatePerSecond: 6 }, remote: { promptPerSecond: 1_000, generatePerSecond: 50 } };

class UsageError extends Error {}

const whole = (value, name, { min = 1, max = 100_000 } = {}) => {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new UsageError(`--${name} takes a whole number from ${min} to ${max}`);
  return number;
};

/**
 * Scripted turns from a file: `[{ content }, { toolCalls: [{ name, arguments }] }, { error, code }, ...]`
 * or `{ turns: [...] }`. An `error` turn fails that call, with the code a router reads (overloaded...).
 */
export function readTurns(text, origin = "the turns file") {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new UsageError(`${origin} is not JSON`); }
  const turns = Array.isArray(parsed) ? parsed : parsed?.turns;
  if (!Array.isArray(turns) || !turns.length) throw new UsageError(`${origin} holds no turns`);
  return turns.map((turn, at) => (typeof turn?.error === "string" ? Object.assign(new Error(turn.error), { code: turn.code ?? null }) : {
    ...turn,
    toolCalls: (turn.toolCalls ?? []).map((call, index) => ({ id: call.id ?? `call_${at + 1}_${index + 1}`, name: String(call.name), arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}) })),
  }));
}

/** A remote provider whose requests carry stand-ins for this machine's names, turned back in its answers. */
export function withStandIns(provider, standIns) {
  return { ...provider, chat: async (request, options) => showResult(await provider.chat(hideRequest(request, standIns), options), standIns) };
}

/**
 * @param {string[]} argv
 * @param {{
 *   stdin?: NodeJS.ReadableStream & { isTTY?: boolean }, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream,
 *   cwd?: string, now?: () => number, fetch?: typeof globalThis.fetch, lookup?: Function, env?: Record<string, string | undefined>,
 *   signal?: AbortSignal, client?: ReturnType<typeof createOpenAiClient>,
 * }} io
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io) {
  const out = (text) => io.stdout.write(`${text}\n`);
  try {
    const { values: opts, positionals } = parseArgs({ args: argv, options: optionSpec, allowPositionals: true, strict: true });
    if (opts.version) {
      const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
      out(`${manifest.name} ${manifest.version}`);
      return 0;
    }
    const command = commands.has(positionals[0]) ? positionals[0] : "run";
    const rest = commands.has(positionals[0]) ? positionals.slice(1) : positionals;
    if (opts.help || command === "help" || (command === "run" && !rest.length)) { out(usage); return opts.help || command === "help" ? 0 : 64; }
    const folderPath = path.resolve(io.cwd ?? process.cwd(), opts.dir ?? ".");
    const folderStat = await stat(folderPath).catch(() => null);
    if (!folderStat?.isDirectory()) throw new UsageError(`${folderPath} is not a folder`);
    const store = openStore(opts.db ? path.resolve(io.cwd ?? process.cwd(), opts.db) : path.join(folderPath, ".harness", "harness.db"), { now: io.now });
    try {
      if (command === "runs") return listRuns(store, opts, out);
      if (command === "show") return showRun(store, rest[0], opts, out);
      if (command === "notes") return listNotes(store, rest.join(" "), opts, out);
      const models = await modelsFrom(opts, io);
      if (command === "eval") return await evaluate(rest[0], { opts, io, store, models, folderPath, out });
      const result = await runOnce({ task: rest.join(" "), opts, io, store, models, folderPath });
      if (opts.json) out(JSON.stringify(result, null, 2));
      else {
        out(terminalSafe(result.answer ?? result.error ?? "No answer."));
        if (result.citations?.unknown?.length && !opts.quiet) io.stderr.write(`Note: the answer cites ${result.citations.unknown.join(", ")}, which no tool returned in this run.\n`);
      }
      return { completed: 0, degraded: 0, declined: 3, stopped: 130 }[result.outcome] ?? 1;
    } finally {
      store.close();
    }
  } catch (error) {
    io.stderr.write(`${error instanceof UsageError || error?.code?.startsWith?.("ERR_PARSE_ARGS") ? error.message : `Stopped: ${error?.message ?? error}`}\n`);
    return error instanceof UsageError || error?.code?.startsWith?.("ERR_PARSE_ARGS") ? 64 : 1;
  }
}

/** The models the options name: local (a server, or scripted turns) and remote (Claude, or scripted turns). */
async function modelsFrom(opts, io) {
  const route = opts.route ?? "local";
  if (!["local", "remote", "auto"].includes(route)) throw new UsageError("--route is local, remote or auto");
  if (opts.fake && opts.endpoint) throw new UsageError("Give --fake or --endpoint, not both");
  if (opts["fake-remote"] && opts["claude-key-file"]) throw new UsageError("Give --fake-remote or --claude-key-file, not both");
  if (opts.names && opts.names !== "as-is") throw new UsageError("--names takes as-is");
  const contextTokens = whole(opts.context, "context", { min: 512, max: 10_000_000 }) ?? null;
  // Files named on the command line are the caller's: relative to where it was run.
  const read = (name) => readFile(path.resolve(io.cwd ?? process.cwd(), name), "utf8");
  const models = { local: null, remote: null, route };
  if (opts.fake) {
    const turns = readTurns(await read(opts.fake), opts.fake);
    models.local = { provider: createFakeProvider({ script: turns, id: "fake" }).provider, model: opts.model ?? "fake", contextTokens, turns };
  } else if (opts.endpoint) {
    try { normalizeEndpoint(opts.endpoint); } catch (error) { throw new UsageError(`--endpoint: ${error.message}`); }
    const client = io.client ?? createOpenAiClient({ fetch: io.fetch });
    const apiKey = opts["api-key-file"] ? (await read(opts["api-key-file"])).trim() : null;
    let model = opts.model;
    if (!model) {
      const offered = await client.models(opts.endpoint, { apiKey }).catch((error) => { throw new UsageError(`The model server at ${opts.endpoint} did not answer: ${error.message}`); });
      model = offered[0]?.name;
      if (!model) throw new UsageError(`The model server at ${opts.endpoint} offers no model; name one with --model`);
    }
    models.local = { provider: createOpenAiCompatibleProvider({ client, endpoint: opts.endpoint, apiKey }), model, settings: { temperature: 0.2, maxTokens: 1024 }, contextTokens };
  }
  if (opts["fake-remote"]) {
    models.remote = { provider: createFakeProvider({ script: readTurns(await read(opts["fake-remote"]), opts["fake-remote"]), id: "fake-remote", kind: "remote" }).provider, model: "fake-remote" };
  } else if (opts["claude-key-file"]) {
    const apiKey = (await read(opts["claude-key-file"])).trim();
    if (!apiKey) throw new UsageError(`${opts["claude-key-file"]} is empty`);
    // Claude's SDK is loaded only for a run that may use it.
    const { createAnthropicProvider } = await import("../providers/anthropic.mjs");
    const claude = createAnthropicProvider({ apiKey, effort: opts.effort ?? "medium" });
    const standIns = createStandIns({ hosts: [os.hostname()], users: [os.userInfo().username] });
    models.remote = { provider: opts.names === "as-is" ? claude : withStandIns(claude, standIns), model: opts["claude-model"] ?? "claude-opus-5-5", settings: { maxTokens: 4096 } };
  }
  if (!models.local && !models.remote) throw new UsageError("Give a model: --endpoint (and --model), --claude-key-file with --route remote, or --fake");
  return models;
}

/** One run in `folder`, recorded in the store; its trace printed as it goes unless --quiet or --json. */
async function runOnce({ task, opts, io, store, models, folderPath, approveMode = null, turns = null }) {
  const now = io.now ?? (() => Date.now());
  const print = (line) => { if (!opts.quiet && !opts.json) io.stderr.write(`${line}\n`); };
  const folder = createFolder(folderPath);
  const runId = store.startRun({ task, folder: folderPath, route: models.route });
  const programs = opts.allow?.length ? opts.allow : defaultPrograms;
  const tools = folderTools({ folder, store, runId, programs, web: Boolean(opts.web), fetch: io.fetch, lookup: io.lookup, env: io.env ?? process.env });
  const mode = approveMode ?? (opts.yes ? "yes" : opts["read-only"] ? "no" : "ask");
  const approver = createApprover({ mode, input: io.stdin, output: io.stderr, signal: io.signal ?? null });
  const redactor = createRedactor();
  const toolbox = createToolbox({
    tools, approve: approver.approve, redact: (text) => redactText(text, redactor), signal: io.signal ?? null, now,
    maxCalls: whole(opts["tool-calls"], "tool-calls", { max: 200 }) ?? runDefaults.maxToolCalls,
    onCall: (entry) => {
      store.step(runId, { kind: "tool", name: entry.name, state: entry.state, input: entry.input, index: entry.index, output: String(entry.output ?? "").slice(0, 4_000), flags: entry.flags, durationMs: entry.durationMs });
      print(entry.state === "done" ? `  [T${entry.index}] ${terminalSafe(entry.title ?? entry.name)}${entry.flags?.injection ? " (reads like an instruction: this run changes nothing now)" : ""}` : `  ${entry.state}: ${terminalSafe(entry.output).slice(0, 300)}`);
    },
  });
  const sides = { local: models.local && { ...models.local, ...(turns ? { provider: createFakeProvider({ script: readTurns(JSON.stringify(turns)), id: "fake" }).provider } : {}) }, remote: models.remote };
  const speedKey = (side) => `${side}:${sides[side]?.model}`;
  for (const side of ["local", "remote"]) if (sides[side]) sides[side] = { ...sides[side], speed: store.speedOf(speedKey(side)) ?? firstSpeeds[side] };
  const result = await runTask({
    task, toolbox, route: models.route, now, signal: io.signal ?? null,
    system: cliRules({ folder: folderPath, today: new Date(now()).toISOString().slice(0, 10), tools: tools.map((tool) => tool.name), web: Boolean(opts.web) }),
    models: { local: sides.local, remote: sides.remote },
    limits: { ...(opts.steps ? { steps: whole(opts.steps, "steps", { max: 50 }) } : {}), ...(opts.seconds ? { seconds: whole(opts.seconds, "seconds", { min: 5, max: 86_400 }) } : {}), ...(opts["tool-calls"] ? { maxToolCalls: whole(opts["tool-calls"], "tool-calls", { max: 200 }) } : {}) },
    trace: (step) => {
      store.step(runId, step);
      if (step.kind === "system") print(`· ${step.name}: ${terminalSafe(step.detail)}`);
      else if (step.kind === "model") for (const call of step.toolCalls ?? []) print(`→ ${terminalSafe(call.name)} ${terminalSafe(call.arguments).slice(0, 160)}`);
    },
  });
  approver.close();
  store.finishRun(runId, result);
  for (const side of ["local", "remote"]) if (sides[side] && result.speeds?.[side]?.samples > 0) store.saveSpeed(speedKey(side), result.speeds[side]);
  return { runId, ...result };
}

function listRuns(store, opts, out) {
  const runs = store.listRuns(whole(opts.limit, "limit", { max: 200 }) ?? 20);
  if (opts.json) { out(JSON.stringify(runs, null, 2)); return 0; }
  if (!runs.length) { out("No runs yet."); return 0; }
  for (const run of runs) out(`${run.id.slice(0, 8)}  ${run.startedAt.slice(0, 16).replace("T", " ")}  ${(run.outcome ?? "running").padEnd(9)} ${(run.route ?? "").padEnd(6)} ${terminalSafe(run.task).slice(0, 70)}`);
  return 0;
}

function showRun(store, key, opts, out) {
  if (!key) throw new UsageError("Name a run: its id, or the start of it as `runs` prints it");
  const run = store.getRun(key);
  if (!run) throw new UsageError(`No single run matches ${key}`);
  if (opts.json) { out(JSON.stringify(run, null, 2)); return 0; }
  out(`Run ${run.id}\nTask: ${terminalSafe(run.task)}\nFolder: ${run.folder}\nStarted ${run.startedAt}, ${run.outcome ?? "running"}${run.route ? ` on ${run.model} (${run.route})` : ""}${run.degradedReason ? `, ${run.degradedReason}` : ""}${run.taint ? `\nRead something that looked like an instruction at ${run.taint.at}` : ""}\n`);
  for (const step of run.steps) {
    if (step.kind === "system") out(`· ${step.name}: ${terminalSafe(step.detail)}`);
    else if (step.kind === "model") out(step.toolCalls?.length ? step.toolCalls.map((call) => `→ ${terminalSafe(call.name)} ${terminalSafe(call.arguments).slice(0, 200)}`).join("\n") : `model: ${terminalSafe(step.text).slice(0, 400)}`);
    else if (step.kind === "tool") out(`  ${step.state === "done" ? `[T${step.index}]` : step.state}: ${terminalSafe(step.output).split("\n").slice(0, 3).join(" / ").slice(0, 300)}`);
  }
  out(`\n${terminalSafe(run.answer ?? run.error ?? "")}`);
  return 0;
}

function listNotes(store, query, opts, out) {
  const notes = store.searchNotes(query, 20);
  if (opts.json) { out(JSON.stringify(notes, null, 2)); return 0; }
  if (!notes.length) { out("No notes."); return 0; }
  for (const note of notes) out(`${note.createdAt.slice(0, 10)}  ${terminalSafe(note.title)}\n  ${terminalSafe(note.body).replace(/\n/g, "\n  ")}`);
  return 0;
}

/**
 * Cases run and graded without a model's judgement: each in a fresh copy of the folder, its answer
 * held to patterns and the files it left held to theirs. A case may carry its own scripted turns,
 * used when the run's local model is scripted.
 *
 * `{ "cases": [{ "id", "task", "approve": "yes" | "no", "turns"?: [...],
 *   "expect": { "outcome"?, "answer"?: [regex], "notAnswer"?: [regex], "files"?: { "path": regex | false } } }] }`
 */
async function evaluate(file, { opts, io, store, models, folderPath, out }) {
  if (!file) throw new UsageError("Name the cases file");
  let parsed;
  try { parsed = JSON.parse(await readFile(path.resolve(io.cwd ?? process.cwd(), file), "utf8")); } catch { throw new UsageError(`${file} is not a cases file`); }
  const cases = Array.isArray(parsed) ? parsed : parsed?.cases;
  if (!Array.isArray(cases) || !cases.length) throw new UsageError(`${file} holds no cases`);
  const graded = [];
  for (const entry of cases) {
    const copy = await mkdtemp(path.join(os.tmpdir(), "harness-eval-"));
    try {
      await cp(folderPath, copy, { recursive: true, filter: (source) => path.relative(folderPath, source).split(path.sep)[0] !== ".harness" });
      const result = await runOnce({ task: String(entry.task), opts: { ...opts, quiet: true }, io, store, models, folderPath: copy, approveMode: entry.approve === "yes" ? "yes" : "no", turns: models.local?.turns && entry.turns ? entry.turns : null });
      const problems = [];
      const expect = entry.expect ?? {};
      if (expect.outcome && result.outcome !== expect.outcome) problems.push(`it ended ${result.outcome}, not ${expect.outcome}`);
      for (const pattern of expect.answer ?? []) if (!new RegExp(pattern, "iu").test(result.answer ?? "")) problems.push(`its answer does not match /${pattern}/`);
      for (const pattern of expect.notAnswer ?? []) if (new RegExp(pattern, "iu").test(result.answer ?? "")) problems.push(`its answer matches /${pattern}/`);
      for (const [name, pattern] of Object.entries(expect.files ?? {})) {
        const text = await readFile(path.join(copy, name), "utf8").catch(() => null);
        if (pattern === false) { if (text !== null) problems.push(`it left ${name}`); }
        else if (text === null) problems.push(`it did not write ${name}`);
        else if (!new RegExp(String(pattern), "iu").test(text)) problems.push(`${name} does not match /${pattern}/`);
      }
      graded.push({ id: String(entry.id ?? graded.length + 1), passed: !problems.length, problems, runId: result.runId, outcome: result.outcome });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }
  const passed = graded.filter((entry) => entry.passed).length;
  if (opts.json) out(JSON.stringify({ passed, total: graded.length, cases: graded }, null, 2));
  else {
    for (const entry of graded) out(`${entry.passed ? "PASS" : "FAIL"}  ${terminalSafe(entry.id)}${entry.passed ? "" : `: ${entry.problems.join("; ")}`}`);
    out(`${passed} of ${graded.length} passed`);
  }
  return passed === graded.length ? 0 : 1;
}
