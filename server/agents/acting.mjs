/**
 * Agents acting under grants (M45.5, ADR-013) and carrying out plans (M45.6), in the web process:
 * whether a run may act, an operation staged as a job in the agent's maker's name behind every
 * fence, what became of it for the follow-up run, the drop of what nobody approved, and a plan
 * carried out one step at a time from its last checkpoint. The grants themselves are grants.mjs's.
 * Part of the agents service (service.mjs), which hands it what it uses.
 */
import { sanitizeUntrusted } from "../../packages/harness/src/index.mjs";
import { normalizeApprovalMode } from "../ops/risk.mjs";
import { startOfLocalDay } from "./budget.mjs";
import { actLimits, grantNow, grantProblem, grantsOf, planLimits, readPlanSteps } from "./grants.mjs";
import { finishedStates } from "./store.mjs";
import { roleAtLeast, toolById } from "./tool-catalog.mjs";

/**
 * @param {{
 *   store: any, state: any, registry: any, jobs: any, now: () => Date,
 *   audit: (type: string, entry: object) => void, redact: (text: string) => string,
 *   clip: (text: unknown, max: number) => string,
 *   refuse: (status: number, message: string, code?: string) => never, wake: () => void,
 *   personOf: (caller: any) => { id: string, role: string },
 *   canSeeRun: (caller: any, run: any, agent?: any) => boolean, moduleSettings: () => any,
 *   modulePaused: (settings?: any) => boolean, agentPaused: (agent: any) => boolean,
 * }} deps
 */
export function createAgentActing({ store, state, registry, jobs, now, audit, redact, clip, refuse, wake, personOf, canSeeRun, moduleSettings, modulePaused, agentPaused }) {
  /**
   * The runs that may act: a person's question or console run, or the agent's own schedule or a
   * server event. Not a webhook's: its caller chooses when a run starts, never what it does (ADR-002),
   * and what it sent is read by the run.
   */
  const actingKinds = new Set(["ask", "manual", "schedule", "event"]);
  /** The tools that read this server's live state: what a run reads before it changes anything (ADR-012). */
  const liveCategories = new Set(["boxpilot", "records", "app"]);

  /** Whether this run may act at all, whatever it would act on: `{ ok, reason }`. */
  function mayAct(run, spec) {
    if (!jobs) return { ok: false, reason: "Acting is not set up on this server" };
    if (!actingKinds.has(run.kind)) return { ok: false, reason: "This kind of run only reads and answers" };
    if (!roleAtLeast(run.readRole, "operator")) return { ok: false, reason: "A run a viewer started never changes anything" };
    if (!Object.keys(grantsOf(spec)).length) return { ok: false, reason: "This agent has leave to carry out nothing" };
    return { ok: true, reason: null };
  }

  /** The operations this agent may carry out now: granted, and still allowed that grant by the registry. */
  const actable = (spec) => Object.entries(grantsOf(spec)).filter(([operationId, level]) => level !== "propose" && !grantProblem(registry.get(operationId), level)).map(([operationId, level]) => ({ operationId, level, operation: registry.get(operationId) }));

  /** The acting tool as this agent's runs see it: its operations named, each with its leave. */
  function actTool(tool, spec) {
    const list = actable(spec);
    const named = list.map((entry) => `${entry.operationId} (${entry.level === "run" ? "runs at once" : "a person approves first"}, ${entry.operation.risk} risk)`).join("; ");
    if (!tool.params.operationId) return { ...tool, brief: `${tool.brief} Yours: ${named}.` };
    return { ...tool, brief: `${tool.brief} Yours: ${named}.`, params: { ...tool.params, operationId: { ...tool.params.operationId, enum: list.map((entry) => entry.operationId) } } };
  }

  const approvalModeNow = () => normalizeApprovalMode(state.getSetting?.("approvalMode", null) ?? process.env.BOXPILOT_APPROVAL_MODE ?? "tiered");

  /**
   * operations.run: one operation the agent has leave to carry out, staged as a job in its maker's
   * name. Every fence is checked here, whatever the runner sent: the run may act, it read nothing
   * that looked like an instruction, the operation is granted and still may be, the run read live
   * facts first, the limits hold, and the maker may still change the server. Run starts the job at
   * once under the maker's delegated consent, as a schedule does; Ask leaves it for a person. The
   * run is told to end; a follow-up run reads what became of the job and checks its effect.
   */
  /** A run that read trusted words reading like an instruction carries out nothing (M45.7); the run view says so. */
  const holdFromActing = (runId) => { try { if (!store.getRun(runId)?.flags?.actHeld) store.mergeRunFlags(runId, { actHeld: true }); } catch { /* the run goes on; acting is refused by the fence anyway */ } };

  /**
   * Whether this run may stage anything now, whatever it would stage: it may act, it read nothing
   * that looked like an instruction, and it read the server's live state first (ADR-012). The reason
   * it may not, or null.
   */
  function actFence(run, spec) {
    const may = mayAct(run, spec);
    if (!may.ok) return { text: `${may.reason}. Propose it instead.` };
    // A run that read something that looked like an instruction stages nothing (ADR-013).
    const flags = store.getRun(run.id)?.flags ?? {};
    if (flags.injection) return { text: "This run read something that looked like an instruction, so it changes nothing. Propose it instead: a person will look.", flags: { tainted: true } };
    if (flags.actHeld) return { text: "This run read words in your notes or the owner's documents that read like an instruction, so it carries out nothing on them. Propose it instead.", flags: { held: true } };
    const readLive = store.listSteps(run.id).some((step) => step.kind === "tool" && step.state === "done" && liveCategories.has(toolById(step.name)?.category));
    if (!readLive) return { text: "Read the live facts this changes with one of your tools first, then carry it out." };
    return null;
  }

  /**
   * One operation staged in the agent's maker's name, every fence that is about the operation checked
   * again now: granted by the agent's current definition and still allowed that grant, the day's
   * limit, the maker still able to change the server and allowed this operation, and the job's own
   * tier. Run starts it at once; Ask leaves it for a person.
   * `{ job, grant, operation, maker }`, or `{ refused, flags }` with a sentence for the model.
   */
  async function stageOperation(agent, spec, { runId, operationId, parameters = {} }) {
    const level = grantsOf(spec)[operationId] ?? "propose";
    const operation = registry.get(operationId);
    if (level === "propose") return { refused: `This agent has no leave to carry out ${operationId}. Propose it instead.` };
    const problem = grantProblem(operation, level);
    if (problem) return { refused: `${problem}. Propose it instead.` };
    if (store.countActionsSince(agent.id, startOfLocalDay(now()).toISOString()) >= actLimits.perDay) return { refused: `${agent.name} has carried out ${actLimits.perDay} operations today, its most. Propose it instead.`, flags: { limit: true } };
    // The job is its maker's, as a schedule's is (ADR-002): someone who may still change the server.
    const maker = agent.createdBy ? state.findOwnerById?.(agent.createdBy) : null;
    if (!maker || !["owner", "operator"].includes(maker.role)) return { refused: "The person who made this agent can no longer change the server, so it changes nothing. Propose it instead." };
    if (operation.minimumRole === "owner" && maker.role !== "owner") return { refused: `Only the owner may carry out ${operation.title}, and this agent was made by an operator. Propose it instead.` };
    let job;
    try {
      job = await jobs.createOperationJob(operationId, parameters, maker.id, { role: maker.role, origin: { agentId: agent.id, agentName: agent.name, runId } });
    } catch (error) {
      return { refused: `It could not be staged: ${clip(redact(String(error?.message ?? error)), 300)}` };
    }
    const grant = grantNow(level, { risk: job.risk, mode: approvalModeNow(), confirms: Boolean(operation.confirm?.(job.parameters ?? {})) });
    const withdraw = (reason) => { try { jobs.cancelJob(job.id, maker.id, { role: maker.role, reason }); } catch { /* already moved on */ } };
    if (grant === "propose") {
      withdraw("An agent may not carry this out: it is high risk here");
      return { refused: `${operation.title} is high risk here, so it is a card, not something an agent carries out. Propose it instead.` };
    }
    if (grant === "run") {
      try {
        await jobs.approveAndStart(job.id, maker.id, {});
      } catch (error) {
        withdraw(`It could not start: ${clip(String(error?.message ?? error), 200)}`);
        return { refused: `It could not start: ${clip(redact(String(error?.message ?? error)), 300)}` };
      }
    }
    return { job, grant, operation, maker };
  }

  /**
   * operations.run: one operation the agent has leave to carry out, staged as a job in its maker's
   * name. Every fence is checked here, whatever the runner sent. The run is told to end; a follow-up
   * run reads what became of the job and checks its effect.
   */
  async function actFor(run, spec, { operationId, parameters = {}, why }, answer) {
    const input = { operationId, parameters };
    const refused = (text, flags = {}) => answer("action", { state: "refused", text, input, flags: { refused: true, ...flags } });
    const fence = actFence(run, spec);
    if (fence) return refused(fence.text, fence.flags);
    if (store.countSteps(run.id, "action") >= actLimits.perRun * 2 || store.actionSteps(run.id).length >= actLimits.perRun) return refused(`A run carries out at most ${actLimits.perRun} operations, and this one has. Answer with what you have.`, { limit: true });
    const agent = store.getAgent(run.agentId);
    const staged = await stageOperation(agent, spec, { runId: run.id, operationId, parameters });
    if (staged.refused) return refused(staged.refused, staged.flags);
    const { job, grant, operation, maker } = staged;
    store.mergeRunFlags(run.id, { acted: true });
    audit("agents.run.acted", { actorId: maker.id, subjectId: job.id, details: { agentId: agent.id, agentName: agent.name, runId: run.id, operationId, grant, risk: job.risk, requestedBy: run.requestedBy } });
    const what = `${operation.title} (${job.risk} risk), as job ${job.id}`;
    const text = grant === "run"
      ? `Started ${what}, under your leave to run it. End this run now with what you did and why; a follow-up run reads how the job went and checks its effect.`
      : `Staged ${what} for a person to approve. End this run now saying what you asked for and why; a follow-up run reads what became of it. If nobody approves it within an hour it is dropped.`;
    return answer("action", { text, input: { operationId, parameters: job.parameters }, flags: { jobId: job.id, operationId, grant, risk: job.risk, why: clip(why, 300) } });
  }

  /** What became of a job a run staged, as its follow-up reads it. */
  function jobOutcome(act, job) {
    const title = job?.title ?? act.flags.operationId;
    if (!job) return `${title}: BoxPilot no longer has this job.`;
    const how = act.flags.grant === "run" ? "It ran under the agent's leave." : job.approvals?.length ? "A person approved it." : "It waited for a person.";
    const head = job.state === "completed" ? `${title} finished. ${how}`
      : job.state === "failed" ? `${title} failed: ${clip(job.error ?? "no reason given", 400)}. ${how}`
        : job.state === "cancelled" ? `${title} did not run: ${clip(job.error ?? "it was cancelled", 300)}.`
          : `${title} is still ${job.state}.`;
    const result = job.state === "completed" && job.result ? `\nWhat it reported: ${clip(JSON.stringify(job.result), 1_500)}` : "";
    return `${head} Job ${job.id}, ${job.risk} risk.${result}`;
  }

  const terminalJobStates = new Set(["completed", "failed", "cancelled"]);
  /** Whether every job a run staged has ended. */
  const actsSettled = (runId) => store.actionSteps(runId).every((step) => terminalJobStates.has(state.getJob?.(step.flags.jobId)?.state ?? "cancelled"));

  /**
   * Jobs agents staged that no one approved within the hour are dropped (ADR-013); each drop ends
   * the job, which brings its run's follow-up. With `all`, everything still waiting goes: the kill switch.
   */
  function dropUnapprovedActs({ all = false, reason = "Nobody approved it within an hour" } = {}) {
    const since = new Date(now().getTime() - 24 * 3_600_000).toISOString();
    let dropped = 0;
    for (const act of store.actionsSince(since)) {
      // A plan's step waits until the plan's own day is over (M45.6), unless everything goes.
      if (act.planId && !all) continue;
      const job = state.getJob?.(act.jobId);
      if (job?.state !== "awaiting_approval") continue;
      if (!all && now().getTime() - Date.parse(job.createdAt) < actLimits.approvalWaitMs) continue;
      try { jobs?.cancelJob(job.id, job.createdBy, { role: "owner", reason }); dropped += 1; } catch { /* approved or gone meanwhile */ }
    }
    return dropped;
  }

  // ---- plans (M45.6) ----

  /**
   * operations.plan: a plan of steps the agent has leave to carry out, kept in the store and carried
   * out by BoxPilot one step at a time (advancePlan), each operation under the same fences as
   * operations.run, a check between them made by a run of the agent. One open plan per agent.
   */
  async function planFor(run, spec, { title, steps: raw }, answer) {
    const input = { title, steps: raw };
    const refused = (text, flags = {}) => answer("action", { state: "refused", text, input, flags: { refused: true, ...flags } });
    const fence = actFence(run, spec);
    if (fence) return refused(fence.text, fence.flags);
    const agent = store.getAgent(run.agentId);
    if (store.openPlans(agent.id).length) return refused(`${agent.name} is already carrying out a plan. Answer with what you have; propose anything else.`);
    const read = readPlanSteps(raw, { grantOf: (id) => grantsOf(spec)[id], operationOf: (id) => registry.get(id), validate: (id, parameters) => registry.validate(id, parameters) });
    if (read.problem) return refused(`${read.problem}. Propose it instead.`);
    const named = clip(redact(String(title ?? "")), 120) || "A plan";
    const plan = store.createPlan({ agentId: agent.id, runId: run.id, title: named, steps: read.steps, deadlineAt: new Date(now().getTime() + planLimits.hours * 3_600_000).toISOString() });
    store.mergeRunFlags(run.id, { acted: true, planId: plan.id });
    audit("agents.plan.started", { actorId: run.requestedBy, subjectId: plan.id, details: { agentId: agent.id, runId: run.id, steps: read.steps.map((step) => step.operationId ?? "check") } });
    void advancePlan(plan.id).catch(() => {});
    return answer("action", {
      text: `Saved the plan "${named}": ${read.steps.length} steps. BoxPilot carries it out one step at a time, for up to ${planLimits.hours} hours, and runs you to make each check. End this run now saying what you planned and why; a follow-up run reports how it went.`,
      input, flags: { planId: plan.id },
    });
  }

  const stepWords = (plan, index) => `step ${index + 1} of the plan "${plan.title}"`;
  /** What one of a plan's operation steps is called. */
  const stepTitle = (step) => (step.kind === "check" ? `Check: ${step.check}` : registry.get(step.operationId)?.title ?? step.operationId);

  /**
   * A plan ended: its last checkpoint written, anything still waiting on a person withdrawn, and a
   * follow-up run to report how it went - unless a person stopped it or the kill switch did.
   */
  function finishPlan(plan, steps, endState, reason, { report = true } = {}) {
    const saved = store.savePlan(plan.id, { steps, cursor: plan.cursor, state: endState, reason: reason ? clip(reason, 300) : null }, plan.updatedAt);
    if (!saved) return null;
    for (const step of steps) {
      const job = step.jobId ? state.getJob?.(step.jobId) : null;
      if (job?.state === "awaiting_approval") { try { jobs?.cancelJob(job.id, job.createdBy, { role: "owner", reason: reason ?? "The plan ended" }); } catch { /* moved on */ } }
    }
    audit("agents.plan.ended", { subjectId: plan.id, details: { agentId: plan.agentId, state: endState, reason } });
    const agent = store.getAgent(plan.agentId);
    const origin = store.getRun(plan.runId);
    if (report && agent && origin && !moduleSettings().killedAt) {
      store.enqueueRun({
        agentId: agent.id, version: agent.version, kind: "continue", question: origin.question,
        trigger: { title: endState === "done" ? `The plan "${plan.title}" finished` : `The plan "${plan.title}" stopped`, plan: { id: plan.id, purpose: "report" } },
        requestedBy: origin.requestedBy, readRole: origin.readRole, readAs: origin.readAs, parentRunId: origin.id, rootRunId: origin.rootRunId ?? origin.id, depth: origin.depth ?? 0,
      });
      wake();
    }
    return saved;
  }

  /**
   * One step of a plan, from its last checkpoint: stage its operation, or read how its job went, or
   * start a run to make its check, or read that run's verdict. True when it moved on to the next step
   * (the caller takes that one too); false when it waits (on a job, a person, a run, a pause) or ended.
   */
  async function stepPlan(plan) {
    const steps = plan.steps.map((step) => ({ ...step }));
    const agent = store.getAgent(plan.agentId);
    if (!agent) { finishPlan(plan, steps, "cancelled", "The agent was deleted", { report: false }); return false; }
    if (now().getTime() > Date.parse(plan.deadlineAt)) { finishPlan(plan, steps, "expired", `It did not finish within ${planLimits.hours} hours`); return false; }
    const settings = moduleSettings();
    // Paused, by the owner or the kill switch: it waits where it is, and goes on at a tick once resumed.
    if (!settings.enabled || modulePaused(settings) || agentPaused(agent)) return false;
    if (plan.cursor >= steps.length) { finishPlan(plan, steps, "done", null); return false; }
    const index = plan.cursor;
    const step = steps[index];
    const checkpoint = (changes) => store.savePlan(plan.id, { steps, cursor: plan.cursor, state: plan.state, reason: plan.reason, ...changes }, plan.updatedAt);
    const fail = (why) => { step.state = "failed"; step.note = clip(why, 300); step.endedAt = now().toISOString(); finishPlan(plan, steps, "failed", `It stopped at ${stepWords(plan, index)}: ${clip(why, 240)}`); return false; };
    const done = (note) => { step.state = "done"; step.note = note ? clip(note, 300) : null; step.endedAt = now().toISOString(); return Boolean(checkpoint({ cursor: index + 1, state: "running" })); };

    if (step.kind === "operation") {
      if (!step.jobId) {
        const staged = await stageOperation(agent, agent.spec, { runId: plan.runId, operationId: step.operationId, parameters: step.parameters });
        if (staged.refused) return fail(staged.refused.replace(/ Propose it instead\.$/, ""));
        Object.assign(step, { jobId: staged.job.id, grant: staged.grant, risk: staged.job.risk, state: staged.grant === "run" ? "running" : "waiting", startedAt: now().toISOString() });
        // On the run that made the plan, as an act of its own: the day's limit counts it, and its job leads back here.
        store.addStep(plan.runId, { kind: "action", name: "operations.plan", input: { operationId: step.operationId, parameters: staged.job.parameters }, output: `${staged.grant === "run" ? "Started" : "Staged for a person to approve"}: ${staged.operation.title} (${staged.job.risk} risk), ${stepWords(plan, index)}, as job ${staged.job.id}.`, flags: { jobId: staged.job.id, planId: plan.id, operationId: step.operationId, grant: staged.grant, risk: staged.job.risk } });
        audit("agents.run.acted", { actorId: staged.maker.id, subjectId: staged.job.id, details: { agentId: agent.id, agentName: agent.name, runId: plan.runId, planId: plan.id, step: index + 1, operationId: step.operationId, grant: staged.grant, risk: staged.job.risk } });
        if (!checkpoint({ state: "waiting" })) return false;
        return true;
      }
      const job = state.getJob?.(step.jobId);
      if (!job) return fail("BoxPilot no longer has its job");
      if (job.state === "completed") return done(job.result ? `It finished: ${redact(JSON.stringify(job.result))}` : "It finished.");
      if (job.state === "failed") return fail(`${job.title} failed: ${job.error ?? "no reason given"}`);
      if (job.state === "cancelled") return fail(`${job.title} did not run: ${job.error ?? "it was cancelled"}`);
      return false;
    }

    // A check: a run of the agent reads what it should and answers passed or failed.
    if (!step.runId) {
      const origin = store.getRun(plan.runId);
      if (!origin) return fail("The run that made the plan is gone");
      const checking = store.enqueueRun({
        agentId: agent.id, version: agent.version, kind: "continue", question: origin.question,
        trigger: { title: `Checking ${stepWords(plan, index)}`, plan: { id: plan.id, purpose: "check", step: index, check: step.check } },
        requestedBy: origin.requestedBy, readRole: origin.readRole, readAs: origin.readAs, parentRunId: origin.id, rootRunId: origin.rootRunId ?? origin.id, depth: origin.depth ?? 0,
      });
      Object.assign(step, { runId: checking.id, state: "checking", tries: (step.tries ?? 0) + 1, startedAt: now().toISOString() });
      checkpoint({ state: "waiting" });
      wake();
      return false;
    }
    const checking = store.getRun(step.runId);
    if (!checking || !finishedStates.has(checking.state)) return false;
    if (checking.flags?.injection) return fail("The check read something that looked like an instruction, so the plan goes no further");
    const verdict = checking.flags?.planCheck ?? null;
    if (verdict?.passed) return done(verdict.found);
    // A check that never gave a verdict (a restart, the runner gone) is made again, once.
    if (!verdict && (step.tries ?? 1) < planLimits.checkTries) {
      Object.assign(step, { runId: null, state: "pending" });
      return Boolean(checkpoint({ state: "running" }));
    }
    return fail(verdict ? `The check failed: ${verdict.found}` : `The check did not finish (${checking.state})`);
  }

  /** Plans being carried out right now, and those asked to go on while they were. */
  const advancing = new Set();
  const advanceAgain = new Set();
  /** Carry a plan on from its last checkpoint, as far as it can go now. One at a time per plan. */
  async function advancePlan(planId) {
    if (advancing.has(planId)) { advanceAgain.add(planId); return; }
    advancing.add(planId);
    try {
      for (let guard = 0; guard <= planLimits.steps * 2 + 2; guard += 1) {
        const plan = store.getPlan(planId);
        if (!plan || !["running", "waiting"].includes(plan.state)) return;
        if (!(await stepPlan(plan))) return;
      }
    } finally {
      advancing.delete(planId);
      if (advanceAgain.delete(planId)) void advancePlan(planId).catch(() => {});
    }
  }

  /** A plan's run (a check or the report) ended, however it ended: the plan goes on. */
  function planRunEnded(run) {
    if (run?.trigger?.plan?.id && run.trigger.plan.purpose === "check") void advancePlan(run.trigger.plan.id).catch(() => {});
  }

  /** What a plan's run is shown of the plan: each step so far and how it went, as tool output. */
  function planOutputs(plan) {
    return plan.steps.slice(0, plan.state === "done" ? plan.steps.length : plan.cursor + 1).map((step, index) => {
      const job = step.jobId ? state.getJob?.(step.jobId) : null;
      const head = step.kind === "check" ? `Step ${index + 1}, a check: ${step.check}` : `Step ${index + 1}: ${stepTitle(step)}${job ? ` (job ${job.id}, ${job.risk} risk)` : ""}`;
      return { name: "operations.plan", input: { planId: plan.id, step: index + 1 }, output: `${head}\n${step.state === "done" ? "Done." : step.state === "failed" ? "Failed." : `Not done (${step.state}).`}${step.note ? ` ${step.note}` : ""}` };
    });
  }

  /** A person stops a plan: what waits on a person is withdrawn, and nothing more is staged. */
  function cancelPlan(caller, planId) {
    const person = personOf(caller);
    const plan = store.getPlan(planId);
    const origin = plan ? store.getRun(plan.runId) : null;
    if (!plan || !origin || !canSeeRun(person, origin)) refuse(404, "There is no plan with that id", "plan_not_found");
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot stop a plan", "forbidden");
    if (!["running", "waiting"].includes(plan.state)) refuse(409, `The plan has already ${plan.state === "done" ? "finished" : "ended"}`, "plan_ended");
    const ended = finishPlan(plan, plan.steps, "cancelled", `Stopped by ${person.role === "owner" ? "the owner" : "an operator"}`, { report: false });
    if (!ended) refuse(409, "The plan moved on just now; try again", "plan_moved");
    audit("agents.plan.cancelled", { actorId: person.id, subjectId: plan.id, details: { agentId: plan.agentId } });
    return presentPlan(ended);
  }

  /** A plan as a person sees it: its steps, where it is and how each went. */
  function presentPlan(plan) {
    if (!plan) return null;
    return {
      id: plan.id, title: plan.title, state: plan.state, reason: plan.reason, cursor: plan.cursor, createdAt: plan.createdAt, deadlineAt: plan.deadlineAt,
      steps: plan.steps.map((step) => ({ kind: step.kind, title: stepTitle(step), operationId: step.operationId ?? null, state: step.state, note: step.note ? sanitizeUntrusted(step.note, { maxChars: 300, redact }).text : null, jobId: step.jobId ?? null, grant: step.grant ?? null, risk: step.risk ?? null })),
    };
  }

  return { mayAct, actable, actTool, holdFromActing, actFor, jobOutcome, actsSettled, dropUnapprovedActs, planFor, finishPlan, advancePlan, planRunEnded, planOutputs, cancelPlan, presentPlan };
}
