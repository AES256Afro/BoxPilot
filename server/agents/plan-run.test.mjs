// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { createJobService } from "../jobs.mjs";

/*
 * Plans (M45.6), end to end: the real agents service, runner and job service, the stand-in model
 * and the stub helper. An agent's plan is kept with a checkpoint after each step and carried out one
 * step at a time: an operation under its grant, a check made by a run of the agent, an operation a
 * person approves, then a report. It survives a restart in the middle, stops at the first step that
 * fails, ends after a day, and stops when a person or the kill switch says so.
 */

let h;
let jobs;
let stop;

async function setUp({ grants = { "app.action": "run", "app.backup": "ask" } } = {}) {
  let real = null;
  const lazy = new Proxy({}, { get: (_target, key) => real[key] });
  h = await createAgentsHarness({ serviceOptions: { jobs: lazy } });
  jobs = createJobService(h.state, h.helper, { now: () => h.now().getTime() });
  real = jobs;
  Object.assign(h.helperAnswers, {
    "app.action": (parameters) => ({ id: parameters.id, action: parameters.action, running: true }),
    "app.backup": (parameters) => ({ id: parameters.id, archive: `${parameters.id}.tar.gz` }),
    "job.output.release": () => ({}),
  });
  stop = h.service.start({ subscribeJobs: (listener) => h.state.subscribeJobs(listener) });
  await h.enable();
  const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
  h.service.updateAgent(h.caller("owner"), agent.id, { spec: { ...agent.spec, allow: { ...agent.spec.allow, grants } } });
  return h.service.getAgent(h.caller("owner"), agent.id);
}

afterEach(async () => { stop?.(); stop = null; await h?.close(); h = null; });

const restartBackup = [
  { operationId: "app.action", parameters: { id: "jellyfin", action: "restart" }, why: "Jellyfin is unhealthy [T1]." },
  { check: "Jellyfin is running and healthy again" },
  { operationId: "app.backup", parameters: { id: "jellyfin" }, why: "Keep a copy once it is well [T1]." },
];
const understanding = { goal: "Restart Jellyfin, check it, back it up", subject: "Jellyfin", constraints: [], tools: ["apps_list"], confidence: 0.9, clarify: null, plan: [{ step: "Read the apps", tool: "apps_list" }, { step: "Answer", tool: null }] };

/**
 * The model: the first run reads the apps and makes the plan; a check reads again and gives its
 * verdict; the report answers. `verdict` is what each check says.
 */
function script({ steps = restartBackup, verdict = "passed", read = true } = {}) {
  h.fake.state.script = (body) => {
    if (body.response_format?.json_schema?.name === "understanding") return { understanding };
    const said = JSON.stringify(body.messages);
    const tools = body.messages.filter((message) => message.role === "tool").length;
    if (said.includes("check this with your read tools")) {
      if (body.response_format?.json_schema?.name === "answer" || tools > 0) return { content: JSON.stringify({ verdict, found: verdict === "passed" ? "Jellyfin runs and is healthy [T2]." : "Jellyfin still restarts [T2]." }) };
      return { toolCalls: [{ name: "apps_list", arguments: {} }] };
    }
    if (said.includes("The plan you were carrying out has ended")) return tools ? { content: "Jellyfin was restarted, checked and backed up [T1] [T2] [T3]." } : { toolCalls: [{ name: "apps_list", arguments: {} }] };
    if (!tools && read) return { toolCalls: [{ name: "apps_list", arguments: {} }] };
    if (!said.includes("operations_plan\\\"") && !said.includes("Saved the plan") && !said.includes("did not run")) return { toolCalls: [{ name: "operations_plan", arguments: { title: "Restart and back up Jellyfin", steps } }] };
    return { content: "I made a plan to restart Jellyfin, check it and back it up [T2]." };
  };
}
const ask = (agent) => h.service.startRun(h.caller("owner"), agent.id, { kind: "ask", question: "Jellyfin is unhealthy. Restart it, make sure it is well, then back it up." });
const planOf = (run) => h.service.getRun(h.caller("owner"), run.id).plan;
const until = (check) => vi.waitFor(check, { timeout: 5_000 });

describe("a plan", () => {
  it("carries out three steps one at a time, survives a restart in the middle, and reports when it finishes", async () => {
    const agent = await setUp();
    script();
    ask(agent);
    const origin = await h.runNext();
    expect(origin.state).toBe("completed");
    expect(origin.steps.find((step) => step.kind === "action" && step.flags?.planId)).toBeTruthy();
    // Step 1 runs under the agent's leave; the plan moves to its check, which a run of the agent makes.
    await until(() => expect(planOf(origin)).toMatchObject({ cursor: 1, state: "waiting", steps: [{ state: "done", grant: "run" }, { state: "checking" }, { state: "pending" }] }));
    expect(h.helperCalls.filter((call) => call.operation === "app.action")).toHaveLength(1);

    // BoxPilot restarts while the check is being made: the check run is cut off, and made again.
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(claim.run.trigger.plan).toMatchObject({ purpose: "check", step: 1 });
    h.service.recoverAtStartup();
    expect(h.service.getRun(h.caller("owner"), claim.run.id).state).toBe("interrupted");
    await until(() => expect(h.store.activeRuns().filter((run) => run.state === "queued")).toHaveLength(1));

    const check = await h.runNext();
    expect(check).toMatchObject({ kind: "continue", state: "completed", flags: { planCheck: { passed: true } } });
    // Step 3 waits for a person; once approved and done, the plan ends and reports.
    await until(() => expect(planOf(origin)).toMatchObject({ cursor: 2, state: "waiting", steps: [{ state: "done" }, { state: "done" }, { state: "waiting", grant: "ask" }] }));
    const backup = planOf(origin).steps[2].jobId;
    expect(h.state.getJob(backup).state).toBe("awaiting_approval");
    await jobs.approveAndRun(backup, h.accounts.owner.id, {});
    await until(() => expect(planOf(origin)).toMatchObject({ state: "done", cursor: 3 }));
    const report = await h.runNext();
    expect(report).toMatchObject({ kind: "continue", state: "completed", trigger: { plan: { purpose: "report" } } });
    expect(report.steps.filter((step) => step.name === "operations.plan")).toHaveLength(3);
    expect(await h.runNext()).toBeNull();
  });

  it("stops at the first step that fails, withdraws nothing it did not stage, and reports", async () => {
    const agent = await setUp();
    h.helperAnswers["app.action"] = () => { throw new Error("the container would not start"); };
    script();
    ask(agent);
    const origin = await h.runNext();
    await until(() => expect(planOf(origin)).toMatchObject({ state: "failed", cursor: 0 }));
    expect(planOf(origin).reason).toMatch(/stopped at step 1 of the plan .*failed/);
    expect(planOf(origin).steps[1].state).toBe("pending");
    const report = await h.runNext();
    expect(report.trigger.plan.purpose).toBe("report");
    expect(report.trigger.title).toMatch(/stopped/);
  });

  it("stops when a check fails", async () => {
    const agent = await setUp();
    script({ verdict: "failed" });
    ask(agent);
    const origin = await h.runNext();
    await until(() => expect(planOf(origin).steps[1].state).toBe("checking"));
    await h.runNext();
    await until(() => expect(planOf(origin)).toMatchObject({ state: "failed", cursor: 1 }));
    expect(planOf(origin).steps[1].note).toMatch(/still restarts/);
    expect(h.helperCalls.some((call) => call.operation === "app.backup")).toBe(false);
  });

  it("ends after a day, withdrawing what still waits on a person", async () => {
    const agent = await setUp();
    script({ steps: [{ operationId: "app.backup", parameters: { id: "jellyfin" }, why: "[T1]" }] });
    ask(agent);
    const origin = await h.runNext();
    await until(() => expect(planOf(origin).steps[0].state).toBe("waiting"));
    const waiting = planOf(origin).steps[0].jobId;
    // An hour is not a day: a plan's step waits longer than a single act's.
    h.advance(2 * 3_600_000);
    await h.service.tick();
    expect(h.state.getJob(waiting).state).toBe("awaiting_approval");
    h.advance(23 * 3_600_000);
    await h.service.tick();
    await until(() => expect(planOf(origin)).toMatchObject({ state: "expired" }));
    expect(h.state.getJob(waiting).state).toBe("cancelled");
  });

  it("stops when a person says so, or the kill switch does, and nothing reports", async () => {
    const agent = await setUp();
    script({ steps: [{ operationId: "app.backup", parameters: { id: "jellyfin" }, why: "[T1]" }] });
    ask(agent);
    const origin = await h.runNext();
    await until(() => expect(planOf(origin).steps[0].state).toBe("waiting"));
    const plan = planOf(origin);
    expect(() => h.service.cancelPlan(h.caller("viewer"), plan.id)).toThrow();
    expect(h.service.cancelPlan(h.caller("owner"), plan.id)).toMatchObject({ state: "cancelled", reason: "Stopped by the owner" });
    expect(h.state.getJob(plan.steps[0].jobId).state).toBe("cancelled");
    expect(await h.runNext()).toBeNull();

    ask(agent);
    const again = await h.runNext();
    await until(() => expect(planOf(again).steps[0].state).toBe("waiting"));
    h.service.killSwitch(h.caller("owner"));
    expect(planOf(again)).toMatchObject({ state: "cancelled", reason: "Stopped by the agents' kill switch" });
  });
});

describe("what a plan may hold", () => {
  const refusalOf = async (agent, steps) => {
    script({ steps });
    ask(agent);
    const run = await h.runNext();
    // Refused by the plan's own rules (an action step) or, past ten steps, by the tool's input check.
    return run.steps.find((step) => step.name === "operations.plan" && step.state === "refused");
  };

  it("refuses an operation it has no leave for, checks alone, and more than ten steps", async () => {
    const agent = await setUp({ grants: { "app.action": "run" } });
    expect((await refusalOf(agent, [{ operationId: "app.backup", parameters: { id: "jellyfin" } }])).output).toMatch(/Step 1: this agent has no leave to carry out app\.backup/);
    expect((await refusalOf(agent, [{ check: "Jellyfin runs" }])).output).toMatch(/at least one operation/);
    expect((await refusalOf(agent, Array.from({ length: 11 }, () => ({ check: "x" })))).output).toMatch(/at most 10/);
    expect((await refusalOf(agent, [{ operationId: "app.action", parameters: { id: "jellyfin", action: "explode" } }])).output).toMatch(/Step 1:/);
  });

  it("holds one plan an agent at a time", async () => {
    const agent = await setUp();
    script({ steps: [{ operationId: "app.backup", parameters: { id: "jellyfin" }, why: "[T1]" }] });
    ask(agent);
    await h.runNext();
    ask(agent);
    const second = await h.runNext();
    expect(second.steps.find((step) => step.kind === "action")).toMatchObject({ state: "refused" });
    expect(second.steps.find((step) => step.kind === "action").output).toMatch(/already carrying out a plan/);
  });
});
