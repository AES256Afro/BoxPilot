/**
 * The built-in evaluation, asked of a Server Keeper on a server laid out like the owner's (M40):
 * which drives, how full the root filesystem is, where Pi-hole runs, which apps are stopped, the OS
 * and its version - each asked as a person would ask it (the planner, the tools, the check before
 * answering), and graded against the facts the way the Evaluation tab grades them.
 *
 * Against the stand-in model (fake-model.mjs), in CI (evaluation.test.mjs holds the score), or a
 * real one (tests/bench/agents-real.mjs --eval starts Unsloth with BoxPilot's runtime).
 *
 *   node test/agents-eval.mjs [--json]
 *
 * It needs only the harness, the tools' facts (tool-text.mjs) and the graders (grade.mjs), so the
 * same file measures an older BoxPilot too, for a before and after.
 */
import { createAgentsHarness } from "./agents-harness.mjs";
import { ownerLikeStorage } from "./fixtures/agents-storage.mjs";
import { createOpenAiClient } from "../server/assistant/model-client.mjs";
import { createRunner, directRunnerApi } from "../server/agents/runner.mjs";
import { agentsRuntimeKey, defaultRuntimeSettings } from "../server/agents/service.mjs";
import { gradeFact } from "../server/agents/grade.mjs";
import { drivesOf } from "../server/agents/tool-text.mjs";

export const evalSet = Object.freeze([
  { id: "drives", question: "Which drives are connected to this server?", fact: "drives" },
  { id: "root", question: "How full is the root filesystem, as a percentage?", fact: "rootDiskPercent" },
  { id: "pihole", question: "Where does Pi-hole run on this server?", fact: "piholePlacement" },
  { id: "stopped", question: "Which BoxPilot apps are stopped?", fact: "stoppedApps" },
  { id: "os", question: "Which operating system and version does this server run?", fact: "operatingSystem" },
  // The owner's own words, 2026-09-29.
  { id: "owner-drives", question: "List the drives connected to BoxPilot", fact: "drives" },
]);

/** The world: the owner's layout of drives, Pi-hole as a BoxPilot app, one app stopped. */
function ownersWorld(h) {
  h.snapshot.storage = ownerLikeStorage();
  h.helperAnswers["app.inspect"] = () => ({ applications: [
    { id: "pi-hole", name: "Pi-hole", installed: true, container: { running: true, status: "running", health: "healthy", restarts: 0 }, urls: [{ host: 8080 }] },
    { id: "jellyfin", name: "Jellyfin", installed: true, container: { running: true, status: "running", health: "healthy", restarts: 0 }, urls: [{ host: 8096 }] },
    { id: "nextcloud", name: "Nextcloud", installed: true, container: { running: false, status: "exited", health: "none", restarts: 0 }, urls: [] },
  ] });
  return {
    drives: drivesOf(h.snapshot), rootDiskPercent: 31, piholePlacement: "boxpilot-app", stoppedApps: ["nextcloud"], operatingSystem: h.snapshot.host.operatingSystem,
  };
}

/**
 * Ask every question once and grade it, each of a fresh Server Keeper on a fresh server, so no
 * answer leans on what an earlier one left in memory. `real` is { runtime, threads } for a real
 * model server (its prompt cache carries over, as on the owner's server); without it the stand-in
 * answers. Returns each question's result and the score.
 */
export async function runEvalSet({ real = null, questions = evalSet, log = () => {} } = {}) {
  const results = [];
  for (const entry of questions) {
    const h = await createAgentsHarness(real ? { start: new Date() } : {});
    try {
      h.enable();
      if (real) h.state.setSetting(agentsRuntimeKey, defaultRuntimeSettings());
      const facts = ownersWorld(h);
      const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
      const started = Date.now();
      const queued = h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: entry.question });
      if (real) {
        const runner = createRunner({ api: directRunnerApi(h.service, h.runnerId), runtime: real.runtime, client: createOpenAiClient({ loopbackOnly: true }), now: () => Date.now() });
        const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
        if (real.threads) claim.runtime = { ...claim.runtime, threads: real.threads };
        await runner.execute(claim);
      } else {
        await h.runNext();
      }
      const run = h.service.getRun(h.caller("owner"), queued.id);
      const grade = run.state === "completed" ? gradeFact(entry.fact, facts[entry.fact], run.answer) : { passed: false, found: `The run ended ${run.state}` };
      const tools = (run.steps ?? []).filter((step) => step.kind === "tool").map((step) => step.name);
      const result = { id: entry.id, question: entry.question, passed: grade.passed, found: grade.found, state: run.state, tools, answer: run.answer, check: run.flags?.check ?? null, seconds: Math.round((Date.now() - started) / 100) / 10, modelMs: run.usage?.modelMs ?? null, usage: run.usage ?? null };
      results.push(result);
      log(result);
    } finally {
      await h.close();
    }
  }
  const right = results.filter((result) => result.passed).length;
  return { results, right, questions: results.length, score: Math.round((right / results.length) * 100) / 100 };
}

export function describeEval(outcome, label = "The built-in evaluation") {
  return [
    `${label}: ${outcome.right} of ${outcome.questions} right (${Math.round(outcome.score * 100)}%)`,
    ...outcome.results.map((result) => `${result.passed ? "right" : "WRONG"}  ${result.id.padEnd(13)} tools ${result.tools.join(", ") || "none"}; ${result.found}${result.check?.mismatches || result.check?.found ? `; check found ${result.check.found ?? result.check.mismatches}, corrected ${result.check.corrected}` : ""}`),
  ].join("\n");
}

if (import.meta.main) {
  const outcome = await runEvalSet();
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(outcome, null, 1)}\n`);
  else process.stdout.write(`${describeEval(outcome, "The built-in evaluation on the stand-in model")}\n`);
}
