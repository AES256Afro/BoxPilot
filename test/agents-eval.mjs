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

/**
 * The boundary set (M46): questions worded so that two tools look plausible and only one reads the
 * fact. The built-in six never trip the base model, so they measure cost, not gain; these sit where
 * the planner slipped before ("where does Pi-hole run" was apps.list, M40) and where a demonstration
 * can tip it. Each names the tool a right plan reads, graded beside the fact.
 */
export const boundarySet = Object.freeze([
  { id: "pihole-kind", question: "Is Pi-hole a BoxPilot app, another container, or running on the host?", fact: "piholePlacement", tool: "where.runs" },
  { id: "pihole-blocked", question: "Did Pi-hole block anything today?", fact: "piholeBlocking", tool: "pihole.stats" },
  { id: "not-running", question: "Is anything on this server not running that should be?", fact: "stoppedApps", tool: "apps.list" },
  { id: "service-died", question: "Has any service on the box died?", fact: "failedServices", tool: "services.status" },
  { id: "disk-full", question: "Is the main disk close to full?", fact: "rootDiskPercent", tool: "storage.health" },
  { id: "machine-name", question: "What's the name of this machine, and what does it run?", fact: "operatingSystem", tool: "server.facts" },
  // A stopped app is the one that needs a restart: both models said nextcloud, and the grader asked for "none is unhealthy" (bench run 37936411358).
  { id: "needs-restart", question: "Which of my apps need a restart?", fact: "stoppedApps", tool: "apps.list" },
  { id: "media-drive", question: "Which drive holds the media, and is it the system disk?", fact: "drives", tool: "storage.health" },
]);

export const evalSets = Object.freeze({ builtin: evalSet, boundary: boundarySet });

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
    // The boundary set's facts: Pi-hole blocks (the harness's Pi-hole answers so), smartd failed, no app is unhealthy, the host's name.
    piholeBlocking: "on", failedServices: ["smartd.service"], unhealthyApps: [], hostname: h.snapshot.host.hostname,
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
      // The boundary set names the tool a right plan reads: whether the plan named it, and whether it was read.
      const planned = (run.steps ?? []).find((step) => step.kind === "plan")?.input ?? [];
      const toolRight = entry.tool ? (Array.isArray(planned) && planned.some((step) => step?.tool === entry.tool)) || tools.includes(entry.tool) : null;
      const examples = (run.steps ?? []).find((step) => step.kind === "intent")?.flags?.examples?.length ?? 0;
      const result = { id: entry.id, question: entry.question, passed: grade.passed, found: grade.found, state: run.state, tools, ...(entry.tool ? { tool: entry.tool, toolRight } : {}), examples, answer: run.answer, check: run.flags?.check ?? null, seconds: Math.round((Date.now() - started) / 100) / 10, modelMs: run.usage?.modelMs ?? null, usage: run.usage ?? null };
      results.push(result);
      log(result);
    } finally {
      await h.close();
    }
  }
  const right = results.filter((result) => result.passed).length;
  const graded = results.filter((result) => typeof result.toolRight === "boolean");
  const toolsRight = graded.filter((result) => result.toolRight).length;
  return { results, right, questions: results.length, score: Math.round((right / results.length) * 100) / 100, ...(graded.length ? { toolsRight, toolsGraded: graded.length } : {}) };
}

export function describeEval(outcome, label = "The built-in evaluation") {
  const tools = typeof outcome.toolsGraded === "number" ? `; the right tool ${outcome.toolsRight} of ${outcome.toolsGraded}` : "";
  return [
    `${label}: ${outcome.right} of ${outcome.questions} right (${Math.round(outcome.score * 100)}%)${tools}`,
    ...outcome.results.map((result) => `${result.passed ? "right" : "WRONG"}  ${result.id.padEnd(14)} tools ${result.tools.join(", ") || "none"}${typeof result.toolRight === "boolean" ? ` (${result.toolRight ? "planned" : "MISSED"} ${result.tool})` : ""}${result.examples ? `, ${result.examples} examples shown` : ""}; ${result.found}${result.check?.mismatches || result.check?.found ? `; check found ${result.check.found ?? result.check.mismatches}, corrected ${result.check.corrected}` : ""}`),
  ].join("\n");
}

if (import.meta.main) {
  const which = process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1] : "builtin";
  const outcome = await runEvalSet({ questions: evalSets[which] ?? evalSet });
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(outcome, null, 1)}\n`);
  else process.stdout.write(`${describeEval(outcome, `The ${which} evaluation on the stand-in model`)}\n`);
}
