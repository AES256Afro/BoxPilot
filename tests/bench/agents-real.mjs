#!/usr/bin/env node
/**
 * The owner's question on a real model (M37): BoxPilot's runtime starts Unsloth the way the agents
 * runner does (server/agents/runtime.mjs: `unsloth run ... --threads N ...`, offline, loopback,
 * tools off), and the real service, tools and runner ask Qwen 3.5 4B. Run it under the cap it is
 * measuring, for example:
 *
 *   sudo systemd-run --scope --uid "$(id -u)" --gid "$(id -g)" -p CPUQuota=400% -p CPUWeight=idle \
 *     nice -n 19 ionice -c 3 node tests/bench/agents-real.mjs --runtime DIR --state DIR --threads 4 --out FILE
 *
 * It asks the owner's question twice (the second time the model server has the agent's prompts
 * cached) and one typical question, each with the run's own 15 minutes, and writes each call's
 * tokens and llama-server's own timings to --out as JSON, and a table to stdout.
 *
 * With --eval (M40) it asks the built-in evaluation instead (test/agents-eval.mjs: which drives,
 * how full the root filesystem is, where Pi-hole runs, which apps are stopped, the OS and version,
 * and the owner's own "List the drives connected to BoxPilot"), on a server laid out like the
 * owner's, and grades each answer. .github/workflows/agents-bench.yml runs it.
 */
import { writeFile } from "node:fs/promises";
import { createBench, describe, ownerQuestion, typicalQuestion } from "../../test/agents-bench.mjs";
import { createOpenAiClient } from "../../server/assistant/model-client.mjs";
import { createRuntime } from "../../server/agents/runtime.mjs";

const argument = (name, fallback = null) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const runtimeDir = argument("runtime");
const stateDir = argument("state");
const threads = Number(argument("threads", "4"));
const out = argument("out");
if (!runtimeDir || !stateDir) { console.error("usage: agents-real.mjs --runtime DIR --state DIR [--threads 4] [--out FILE] [--eval]"); process.exit(2); }

const log = (line) => console.error(`[runtime] ${line}`);
const runtime = createRuntime({ client: createOpenAiClient({ loopbackOnly: true }), runtimeDir, stateDir, log });

if (process.argv.includes("--eval")) {
  const { describeEval, runEvalSet } = await import("../../test/agents-eval.mjs");
  let outcome = null;
  try {
    outcome = await runEvalSet({
      real: { runtime, threads },
      log: (result) => console.log(`${result.passed ? "right" : "WRONG"}  ${result.id}: ${result.found} (${result.seconds} s; tools ${result.tools.join(", ") || "none"}${result.check ? `; check ${JSON.stringify(result.check)}` : ""})\n  answer: ${String(result.answer ?? "").slice(0, 700).replace(/\n/g, " | ")}`),
    });
    console.log(`\n${describeEval(outcome, `The built-in evaluation on the real model (${threads} thread${threads === 1 ? "" : "s"})`)}`);
  } finally {
    if (out) await writeFile(out, `${JSON.stringify({ threads, eval: outcome }, null, 1)}\n`);
    await runtime.stop("bench over");
  }
} else {
  const bench = await createBench({ real: { runtime, threads } });
  const results = [];
  try {
    for (const [label, question] of [["owner's question, cold", ownerQuestion], ["owner's question again, warm", ownerQuestion], ["a typical question", typicalQuestion]]) {
      const started = Date.now();
      const result = await bench.ask(question);
      const entry = { label, question, threads, wallMs: result.wallMs, state: result.run.state, degraded: result.run.flags?.degraded ?? null, usage: result.run.usage, calls: result.calls, answer: result.run.answer, plan: result.run.steps.find((step) => step.kind === "plan")?.output ?? null, steps: result.run.steps.map((step) => ({ kind: step.kind, name: step.name, state: step.state, detail: step.flags?.detail ?? null, durationMs: step.durationMs ?? null })) };
      results.push(entry);
      const failed = entry.steps.filter((step) => step.state === "failed").map((step) => `${step.name}: ${step.detail ?? "(no detail)"}`);
      console.log(`${describe(result, `${label} (${threads} thread${threads === 1 ? "" : "s"}): "${question}"`)}\n  plan: ${String(entry.plan).replace(/\n/g, " | ")}\n${failed.length ? `  failed: ${failed.join(" | ")}\n` : ""}  answer: ${String(entry.answer).slice(0, 600).replace(/\n/g, " ")}\n  (${Math.round((Date.now() - started) / 1000)} s)\n`);
    }
    console.log(`modelSpeed kept for the Usage tab: ${JSON.stringify(bench.usage().modelSpeed)}`);
  } finally {
    if (out) await writeFile(out, `${JSON.stringify({ threads, results, modelSpeed: bench.usage().modelSpeed }, null, 1)}\n`);
    await runtime.stop("bench over");
    await bench.close();
  }
}
