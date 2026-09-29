/**
 * The agents service (M37), in the web process: everything about agents except running a model.
 *
 * - Agents and their versions (spec.mjs), created from templates, edited, rolled back, paused.
 * - The run queue. A run is queued by a person (ask, the test console), a schedule, an event or a
 *   quiet-hours learning pass, and handed to the capped runner one at a time for the whole server.
 *   Budgets are checked when a run is queued and again when it is handed out; a queue that is full
 *   drops unattended runs rather than growing; a run whose runner stops answering is marked
 *   interrupted and never retried on its own.
 * - The runner's side of the conversation: it asks for work, sends its steps, asks for tools by
 *   name, and finishes. Every tool runs here, as the run's person (tools.mjs); every plan is
 *   checked against the registry and that person (assistant/plan.mjs) and becomes a card that
 *   waits for a person to approve each step at its own tier through the ordinary job path.
 * - The module switch, the pause (for an agent, or everything, "until tomorrow"), and the kill
 *   switch, which cancels what is queued, stops what runs and tells the runner to stop its model.
 *
 * The audit trail records who started what, when, how long it took and how it ended; never a
 * question, an answer or a tool's output.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validatePlan } from "../assistant/plan.mjs";
import { finalRedaction } from "../assistant/prompt.mjs";
import { normalizeEndpoint, isLoopbackAddress } from "../assistant/local-endpoint.mjs";
import { createRedactor, loadRedactionPolicy } from "../redaction.mjs";
import { budgetState, createRateLimit, defaultQuietHours, inQuietHours, nextScheduledRun, normalizeQuietHours, startOfLocalDay, tomorrowMorning } from "./budget.mjs";
import { runnerCaps, runnerUnit } from "./caps.mjs";
import { sanitizeUntrusted, wrapNote, wrapToolOutput } from "./guard.mjs";
import { defaultModelId, downloadPreview, findNewerQwen, modelById, modelLibrary, unslothModelSpec } from "./models.mjs";
import { checkCitations, systemMessage, taskMessage } from "./prompt.mjs";
import { SpecError, agentEvents, budgetCeilings, diffSpecs, normalizeSpec, specText } from "./spec.mjs";
import { digestToken, finishedStates } from "./store.mjs";
import { agentTemplates, templateById, templateQuestions } from "./templates.mjs";
import { describeTools, readToolInput, roleAtLeast, toModelTool, toolAllowed, toolById, toolCatalog } from "./tool-catalog.mjs";
import { ToolError, createToolRunner } from "./tools.mjs";

export const agentsSettingKey = "agents";
export const agentsRuntimeKey = "agentsRuntime";
export const agentsKnowledgeKey = "agentsKnowledge";
export const runnerTokenKey = "agentsRunnerToken";
export const runtimeCheckKey = "agentsRuntimeCheck";

export const serviceLimits = Object.freeze({
  leaseMs: 60_000,
  pollWaitMs: 25_000,
  heartbeatMs: 10_000,
  runnerOnlineMs: 90_000,
  queueMax: 20,
  queuePerAgent: 2,
  askTtlMs: 2 * 3600_000,
  systemTtlMs: 18 * 3600_000,
  eventCooldownMs: 30 * 60_000,
  refusedEveryMs: 3600_000,
  notifyCooldownMs: 6 * 3600_000,
  notifyPerDay: 4,
  toolCallsPerStep: 3,
  maxToolCallsPerRun: 24,
  proposalsPerRun: 2,
  noteWritesPerRun: 5,
  answerChars: 12_000,
  questionChars: 2_000,
  toolOutputChars: 4_000,
  stepTextChars: 6_000,
  modelStepsPerRun: 40,
  proposalTtlMs: 7 * 86_400_000,
  asksPerHour: 30,
  runGraceMs: 60_000,
  tickMs: 60_000,
  notesInPrompt: 8,
  toolTimeoutMs: 35_000,
  evalQuestions: 10,
  evalEveryMs: 3600_000,
});

export const runtimeDrivers = Object.freeze(["unsloth", "external", "fake"]);

export class AgentError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

const refuse = (status, message, code) => { throw new AgentError(status, message, code); };
const personKinds = new Set(["ask", "manual", "eval"]);
const kindRank = { ask: 0, manual: 0, eval: 1, event: 2, schedule: 3, learn: 4 };
const clip = (text, max) => { const value = String(text ?? ""); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const finite = (value, max) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(Number(value), max) : 0);

export const defaultModuleSettings = Object.freeze({ enabled: false, paused: false, pausedUntil: null, pausedBy: null, killedAt: null, quietHours: defaultQuietHours, notify: true });

export function defaultRuntimeSettings() {
  const model = modelById(defaultModelId);
  return { driver: "unsloth", repo: model.repo, file: model.file, projector: model.projector, quant: model.quant, endpoint: null, contextTokens: model.contextTokens, idleStopMinutes: 10, maxTokens: 1_024, temperature: 0.2 };
}

/** The owner's runtime choices as stored; the model itself changes only through agents.model.switch. */
export function normalizeRuntimeSettings(input, current = defaultRuntimeSettings()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgentError(400, "Send the runtime's settings", "invalid_setting");
  const driver = input.driver ?? current.driver;
  if (!runtimeDrivers.includes(driver) || (driver === "fake" && process.env.BOXPILOT_AGENTS_ALLOW_FAKE !== "1")) throw new AgentError(400, "The runtime is Unsloth, or a model server already running on this machine", "invalid_setting");
  let endpoint = null;
  if (driver === "external") {
    try { endpoint = normalizeEndpoint(input.endpoint ?? current.endpoint ?? ""); } catch (error) { throw new AgentError(400, error.message, "invalid_setting"); }
    // The runner may reach this machine and nothing else (IPAddressDeny=any in its unit).
    if (!isLoopbackAddress(new URL(endpoint).hostname) && new URL(endpoint).hostname !== "localhost") throw new AgentError(400, "An agent's model server must be on this machine: use http://127.0.0.1:<port>", "invalid_setting");
  }
  const integer = (value, fallback, min, max, what) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new AgentError(400, `${what} must be ${min} to ${max}`, "invalid_setting");
    return value;
  };
  return {
    ...current,
    driver,
    endpoint,
    contextTokens: integer(input.contextTokens, current.contextTokens, 2_048, 32_768, "The context"),
    idleStopMinutes: integer(input.idleStopMinutes, current.idleStopMinutes, 1, 120, "Minutes before an idle model stops"),
    maxTokens: integer(input.maxTokens, current.maxTokens, 128, 4_096, "The longest answer in tokens"),
  };
}

export function createAgentService({
  state,
  store,
  registry,
  helper = null,
  inventory = null,
  knowledge = null,
  secretEnvNamesFor = null,
  healthAlerts = null,
  redactor = null,
  loadRedaction = loadRedactionPolicy,
  tokenPath = null,
  fetchJson = null,
  now = () => new Date(),
  limits: overrides = {},
  hostLoad = () => os.loadavg()[0] / Math.max(1, os.cpus().length),
} = {}) {
  const limits = { ...serviceLimits, ...overrides };
  const tools = createToolRunner({ state, store, registry, helper, inventory, knowledge, secretEnvNamesFor, now });
  const audit = (type, entry) => { try { state.recordAudit?.(type, entry); } catch { /* the audit never stops a run */ } };
  const askLimit = createRateLimit({ capacity: limits.asksPerHour, refillPerSecond: limits.asksPerHour / 3600, now: () => now().getTime() });
  let redactorReady = redactor ? Promise.resolve(redactor) : null;
  const redactorFor = () => (redactorReady ??= Promise.resolve().then(() => loadRedaction()).then((policy) => createRedactor(policy), () => createRedactor()));
  let syncRedactor = redactor ?? createRedactor();
  void redactorFor().then((ready) => { syncRedactor = ready; });
  const redact = (text) => finalRedaction(text, syncRedactor);
  // Kept across the service's life: when housekeeping last ran, and the alerts the last round saw.
  let lastPrune = 0;
  let lastModelCheck = 0;
  let previousAlerts = null;
  let droppedRuns = 0;
  let stopModelRequested = false;
  // Step kinds whose output the model is given, numbered T1, T2 ... in the order they happened.
  const outputKinds = ["tool", "proposal", "note", "notify"];
  const outputsSoFar = (runId) => store.listSteps(runId).filter((step) => outputKinds.includes(step.kind) && step.state === "done").length;

  // ---- settings ----

  function moduleSettings() {
    const saved = state.getSetting?.(agentsSettingKey, null) ?? {};
    return { ...defaultModuleSettings, ...saved, quietHours: saved.quietHours ?? defaultQuietHours };
  }
  function runtimeSettings() {
    return { ...defaultRuntimeSettings(), ...(state.getSetting?.(agentsRuntimeKey, null) ?? {}) };
  }
  function knowledgeSettings() {
    return { docs: true, registry: true, catalog: true, notes: true, documents: true, ...(state.getSetting?.(agentsKnowledgeKey, null) ?? {}) };
  }
  /** Paused now: by the switch, until a time that has not come yet, or by the kill switch. */
  function modulePaused(settings = moduleSettings()) {
    if (!settings.paused) return false;
    return !settings.pausedUntil || Date.parse(settings.pausedUntil) > now().getTime();
  }
  const agentPaused = (agent) => agent.paused && (!agent.pausedUntil || Date.parse(agent.pausedUntil) > now().getTime());

  // ---- who may do what ----

  const personOf = (caller) => {
    if (!caller?.id) refuse(401, "Sign in first", "unauthorized");
    return { id: caller.id, role: ["owner", "operator", "viewer"].includes(caller.role) ? caller.role : "viewer" };
  };
  const canEdit = (caller, agent) => caller.role === "owner" || (caller.role === "operator" && agent.createdBy === caller.id);
  const canAsk = (caller, agent) => Boolean(agent.spec?.triggers?.ask) && (agent.spec?.audience ?? []).includes(caller.role);
  /** Another account's work is the owner's to see (M29.4): runs follow the jobs rule. */
  function canSeeRun(caller, run, agent = store.getAgent(run.agentId, { includeDeleted: true })) {
    if (caller.role === "owner") return true;
    if (run.requestedBy && run.requestedBy === caller.id) return true;
    return caller.role === "operator" && !run.requestedBy && agent?.createdBy === caller.id;
  }
  /** Another account's id is the owner's to see (M29.4): anyone else sees their own, or nothing. */
  const ownActor = (caller, id) => (caller.role === "owner" || id === caller.id ? id ?? null : null);
  const canSeeProposal = (caller, proposal) => caller.role === "owner" || (proposal.requestedBy && proposal.requestedBy === caller.id)
    || (caller.role === "operator" && proposal.source === "agent" && !proposal.requestedBy && store.getAgent(proposal.agentId, { includeDeleted: true })?.createdBy === caller.id);

  function agentFor(caller, id, { edit = false } = {}) {
    const agent = store.getAgent(id);
    if (!agent) refuse(404, "There is no agent with that id", "agent_not_found");
    if (edit && !canEdit(caller, agent)) refuse(403, caller.role === "operator" ? "Operators change the agents they made; the owner changes any" : "Only the owner and operators change agents", "forbidden");
    if (!edit && caller.role === "viewer" && !canAsk(caller, agent)) refuse(404, "There is no agent with that id", "agent_not_found");
    return agent;
  }

  // ---- the runner's presence and usage ----

  let runner = { id: null, version: null, lastSeenAt: null, usage: null, hostBusy: false, startedAt: null };
  const runnerOnline = () => Boolean(runner.lastSeenAt && now().getTime() - Date.parse(runner.lastSeenAt) < limits.runnerOnlineMs);
  function noteRunner(runnerId, usage = null, hostBusy = undefined) {
    if (runnerId !== runner.id) runner = { id: runnerId, version: null, lastSeenAt: null, usage: null, hostBusy: false, startedAt: now().toISOString() };
    runner.lastSeenAt = now().toISOString();
    if (usage && typeof usage === "object") runner.usage = sanitizeUsage(usage);
    if (typeof hostBusy === "boolean") runner.hostBusy = hostBusy;
  }
  function sanitizeUsage(usage) {
    return {
      state: ["idle", "starting", "loading", "running", "stopping"].includes(usage.state) ? usage.state : "idle",
      cpuPercent: Math.round(finite(usage.cpuPercent, 1600) * 10) / 10,
      memoryBytes: finite(usage.memoryBytes, 64 * 1024 ** 3),
      memoryPeakBytes: finite(usage.memoryPeakBytes, 64 * 1024 ** 3),
      cpuQuotaPercent: usage.cpuQuotaPercent === null ? null : finite(usage.cpuQuotaPercent, 1600) || null,
      memoryMaxBytes: usage.memoryMaxBytes === null ? null : finite(usage.memoryMaxBytes, 256 * 1024 ** 3) || null,
      throttledMs: finite(usage.throttledMs, 1e12),
      modelLoaded: usage.modelLoaded === true,
      model: typeof usage.model === "string" ? usage.model.slice(0, 160) : null,
      cgroup: usage.cgroup === true,
      readAt: now().toISOString(),
    };
  }
  function runnerStatus() {
    return { online: runnerOnline(), lastSeenAt: runner.lastSeenAt, version: runner.version, startedAt: runner.startedAt, hostBusy: runner.hostBusy, usage: runner.usage };
  }

  // ---- waking the runner's long poll ----

  const waiters = new Set();
  function wake() { for (const resolve of [...waiters]) resolve(); waiters.clear(); }

  // ---- live traces ----

  const subscribers = new Map();
  function emit(runId, event, data) {
    for (const listener of subscribers.get(runId) ?? []) { try { listener(event, data); } catch { /* a broken page must not stop a run */ } }
  }
  function subscribeRun(caller, runId, listener) {
    const person = personOf(caller);
    const run = store.getRun(runId);
    if (!run || !canSeeRun(person, run)) refuse(404, "There is no run with that id", "run_not_found");
    if (!subscribers.has(runId)) subscribers.set(runId, new Set());
    subscribers.get(runId).add(listener);
    return () => { subscribers.get(runId)?.delete(listener); if (!subscribers.get(runId)?.size) subscribers.delete(runId); };
  }

  // ---- budgets ----

  function usedToday(agentId) {
    return store.usageSince(agentId, startOfLocalDay(now()).toISOString());
  }
  function budgetOf(agent) {
    return budgetState(agent.spec.budget, usedToday(agent.id));
  }

  // ---- queueing ----

  function queueCounts() {
    const active = store.activeRuns();
    return { queued: active.filter((run) => run.state === "queued").length, running: active.filter((run) => run.state === "running").length, active };
  }

  /** A run nobody is waiting on: a schedule, an event, a learning pass. Skipped quietly when it cannot run. */
  function enqueueSystem(agent, kind, trigger = {}) {
    const settings = moduleSettings();
    if (!settings.enabled || modulePaused(settings) || agentPaused(agent)) return { skipped: "paused" };
    const creator = agent.createdBy ? state.findOwnerById?.(agent.createdBy) : null;
    const role = creator?.role;
    const { active, queued } = queueCounts();
    if (active.some((run) => run.agentId === agent.id && run.kind === kind && run.state === "queued")) return { skipped: "already-queued" };
    const recordRefusal = (reason) => {
      const last = store.listRuns({ agentId: agent.id, limit: 5, states: ["refused"] })[0];
      if (last && now().getTime() - Date.parse(last.queuedAt) < limits.refusedEveryMs) return { skipped: "refused" };
      return { refused: store.enqueueRun({ agentId: agent.id, version: agent.version, kind, trigger, requestedBy: null, readRole: role ?? "viewer", readAs: agent.createdBy, state: "refused", reason }) };
    };
    if (!["owner", "operator"].includes(role)) return recordRefusal("The person who made this agent can no longer change the server, so it does not run on its own");
    const budget = budgetOf(agent);
    if (budget.refusal) return recordRefusal(budget.refusal);
    if (queued >= limits.queueMax || active.filter((run) => run.agentId === agent.id).length >= limits.queuePerAgent) {
      droppedRuns += 1;
      return { skipped: "queue-full" };
    }
    const run = store.enqueueRun({ agentId: agent.id, version: agent.version, kind, trigger, requestedBy: null, readRole: role, readAs: agent.createdBy });
    wake();
    return { run };
  }

  /** A person's run: an ask, or a run from the test console. Refused with a reason rather than dropped. */
  function startRun(caller, agentId, body = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    const kind = body.kind === "manual" ? "manual" : "ask";
    const settings = moduleSettings();
    if (!settings.enabled) refuse(409, "Agents are off. The owner turns them on in the Agents section.", "agents_off");
    if (modulePaused(settings)) refuse(409, settings.pausedUntil ? `Agents are paused until ${new Date(settings.pausedUntil).toLocaleString()}` : "Agents are paused", "agents_paused");
    if (agentPaused(agent)) refuse(409, `${agent.name} is paused`, "agent_paused");
    if (kind === "manual" && !canEdit(person, agent)) refuse(403, "Only the owner and the person who made this agent run it from the console", "forbidden");
    if (kind === "ask" && !canAsk(person, agent)) refuse(403, `${agent.name} does not take questions from you`, "forbidden");
    let question = typeof body.question === "string" ? body.question.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim() : "";
    if (kind === "ask" && !question) refuse(400, "Ask a question", "invalid_question");
    if (question.length > limits.questionChars) refuse(400, `Keep the question under ${limits.questionChars} characters`, "question_too_long");
    // A password pasted into a question is not kept, and never reaches the model.
    question = question ? redact(question) : null;
    const { active, queued } = queueCounts();
    if (active.some((run) => run.requestedBy === person.id && personKinds.has(run.kind) && run.kind !== "eval")) refuse(429, "One of your questions is already waiting or being answered. Wait for it, then ask again.", "agent_busy");
    const budget = budgetOf(agent);
    if (budget.refusal) refuse(429, `${agent.name} cannot run again today: ${budget.refusal.toLowerCase()}.`, "agent_budget");
    if (queued >= limits.queueMax) refuse(503, "Agents have too much waiting right now. Try again in a few minutes.", "agents_backlog");
    if (!askLimit.take(person.id)) refuse(429, `You have asked ${limits.asksPerHour} times in the last hour. Wait a little.`, "agent_rate_limited");
    const run = store.enqueueRun({ agentId: agent.id, version: agent.version, kind, question, trigger: {}, requestedBy: person.id, readRole: person.role, readAs: person.id });
    wake();
    return presentRun(person, run, { steps: [] });
  }

  function cancelRun(caller, runId) {
    const person = personOf(caller);
    const run = store.getRun(runId);
    if (!run || !canSeeRun(person, run)) refuse(404, "There is no run with that id", "run_not_found");
    if (person.role === "viewer" && run.requestedBy !== person.id) refuse(403, "Viewers cancel only their own questions", "forbidden");
    const finished = store.finishRun(run.id, { state: "cancelled", reason: "Cancelled by a person" });
    if (!finished) refuse(409, "That run has already finished", "run_finished");
    emit(run.id, "state", { state: "cancelled" });
    return presentRun(person, finished);
  }

  // ---- the claim ----

  function chooseRun(queued, { hostBusy = false } = {}) {
    const at = now();
    const quiet = inQuietHours(at, moduleSettings().quietHours);
    const eligible = [];
    for (const run of queued) {
      const agent = store.getAgent(run.agentId);
      if (!agent) { store.finishRun(run.id, { state: "cancelled", reason: "The agent was deleted" }); continue; }
      if (agentPaused(agent)) continue;
      const ttl = personKinds.has(run.kind) ? limits.askTtlMs : limits.systemTtlMs;
      if (at.getTime() - Date.parse(run.queuedAt) > ttl) { store.finishRun(run.id, { state: "cancelled", reason: "It waited too long to start" }); continue; }
      if (run.trigger?.quietHours && !quiet) continue;
      // The server is busy: people's questions still go, everything else waits.
      if ((hostBusy || hostLoad() > 0.85) && !personKinds.has(run.kind)) continue;
      eligible.push(run);
    }
    eligible.sort((a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9) || a.queuedAt.localeCompare(b.queuedAt));
    return eligible[0] ?? null;
  }

  function claimPayload(run, lease) {
    const agent = store.getAgent(run.agentId, { includeDeleted: true });
    const version = store.getVersion(run.agentId, run.version) ?? { spec: agent.spec };
    const spec = version.spec;
    const offered = toolCatalog.filter((tool) => toolAllowed(tool, spec.tools?.[tool.id], { kind: run.kind, readRole: run.readRole }) && (tool.id !== "docs.search" || Object.values(spec.knowledge ?? {}).some(Boolean)));
    const notes = spec.memory?.enabled && spec.knowledge?.notes !== false && knowledgeSettings().notes !== false
      ? store.listNotes(agent.id, { limit: limits.notesInPrompt }).map((note) => wrapNote({ ...note, stale: note.freshUntil ? Date.parse(note.freshUntil) < now().getTime() : false }, { redact }))
      : [];
    const runtime = runtimeSettings();
    const budget = budgetOf({ ...agent, spec });
    const deadlineAt = new Date(Date.parse(run.startedAt) + spec.budget.runSeconds * 1000).toISOString();
    return {
      run: { id: run.id, kind: run.kind, question: run.question, trigger: run.trigger, readRole: run.readRole, startedAt: run.startedAt, deadlineAt },
      lease,
      agent: { id: agent.id, name: spec.name, version: run.version, outputs: spec.outputs },
      messages: [
        { role: "system", content: systemMessage(spec) },
        { role: "user", content: taskMessage({ kind: run.kind, question: run.question, trigger: run.trigger, notes, now: now() }) },
      ],
      tools: offered.map((tool) => ({ id: tool.id, ...toModelTool(tool) })),
      runtime: {
        driver: runtime.driver,
        model: runtime.driver === "unsloth" ? unslothModelSpec({ repo: runtime.repo, quant: runtime.quant }) : null,
        repo: runtime.repo, file: runtime.file, projector: runtime.projector,
        endpoint: runtime.driver === "external" ? runtime.endpoint : null,
        contextTokens: runtime.contextTokens, threads: runnerCaps.modelThreads, idleStopMs: runtime.idleStopMinutes * 60_000,
        maxTokens: runtime.maxTokens, temperature: runtime.temperature,
        // Qwen's thinking is left off: on a CPU it doubles the time to an answer (the spike measures it).
        extra: runtime.driver === "unsloth" || runtime.driver === "fake" ? { enable_thinking: false } : {},
      },
      limits: {
        steps: spec.budget.stepsPerRun,
        tokens: spec.budget.tokensPerRun,
        runSeconds: spec.budget.runSeconds,
        remainingModelMs: run.kind === "eval" ? spec.budget.modelSecondsPerDay * 1000 : budget.modelMsLeft,
        toolCallsPerStep: limits.toolCallsPerStep,
        maxToolCalls: Math.min(limits.maxToolCallsPerRun, spec.budget.stepsPerRun * limits.toolCallsPerStep),
        heartbeatMs: limits.heartbeatMs,
      },
    };
  }

  /**
   * The runner's long poll: the next run, or null after `waitMs` with nothing to do. Nothing is
   * handed out while Agents are off or paused, or while another run holds a live lease.
   */
  async function runnerNext(runnerId, { usage = null, hostBusy = false, waitMs = limits.pollWaitMs, signal = null } = {}) {
    noteRunner(runnerId, usage, hostBusy);
    const deadline = now().getTime() + Math.min(Math.max(Number(waitMs) || 0, 0), limits.pollWaitMs);
    while (true) {
      expireLeases();
      const settings = moduleSettings();
      if (settings.enabled && !modulePaused(settings)) {
        const claimed = store.claimNext({ runnerId, leaseMs: limits.leaseMs, choose: (queued) => chooseRun(queued, { hostBusy }) });
        if (claimed) {
          store.addStep(claimed.run.id, { kind: "system", name: "claimed", output: "The runner took this run." });
          emit(claimed.run.id, "state", { state: "running" });
          return claimPayload(claimed.run, claimed.lease);
        }
      }
      const left = deadline - now().getTime();
      if (left <= 0 || signal?.aborted) return null;
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(left, 5_000));
        timer.unref?.();
        function done() { clearTimeout(timer); waiters.delete(done); signal?.removeEventListener?.("abort", done); resolve(); }
        waiters.add(done);
        signal?.addEventListener?.("abort", done, { once: true });
      });
    }
  }

  function runnerHello(runnerId, { version = null, usage = null } = {}) {
    noteRunner(runnerId, usage);
    runner.version = typeof version === "string" ? version.slice(0, 40) : null;
    // A run another runner held is one this runner will never finish: say so, and never retry it.
    let interrupted = 0;
    for (const run of store.activeRuns().filter((entry) => entry.state === "running" && entry.runnerId !== runnerId)) {
      if (store.finishRun(run.id, { state: "interrupted", reason: "The agents runner restarted while this run was going. It was not tried again." })) interrupted += 1;
      emit(run.id, "state", { state: "interrupted" });
    }
    return { interrupted, pollWaitMs: limits.pollWaitMs, heartbeatMs: limits.heartbeatMs };
  }

  /** Runs whose runner stopped answering, or that ran past their own deadline. */
  function expireLeases() {
    const at = now().getTime();
    for (const run of store.activeRuns().filter((entry) => entry.state === "running")) {
      const spec = store.getVersion(run.agentId, run.version)?.spec;
      const deadline = Date.parse(run.startedAt) + (spec?.budget?.runSeconds ?? 600) * 1000 + limits.runGraceMs;
      if (at > deadline) {
        if (store.finishRun(run.id, { state: "timeout", reason: "It ran past its time limit and was stopped." })) emit(run.id, "state", { state: "timeout" });
      } else if (run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) < at) {
        if (store.finishRun(run.id, { state: "interrupted", reason: "The agents runner stopped answering during this run. It was not tried again." })) emit(run.id, "state", { state: "interrupted" });
      }
    }
  }

  /** Every runner call on a run proves it holds the run's lease; a finished run is told to stop. */
  function heldRun(runId, lease) {
    const run = store.getRun(runId);
    if (!run || !store.holdsLease(runId, lease)) refuse(409, "This runner does not hold that run", "lease_lost");
    if (run.state !== "running") refuse(409, `The run is ${run.state}`, "run_stopped");
    return run;
  }

  function runnerHeartbeat(runId, lease, { usage = null, runnerId = null } = {}) {
    if (runnerId) noteRunner(runnerId, usage);
    const run = store.getRun(runId);
    if (!run || !store.holdsLease(runId, lease)) return { continue: false, reason: "lease_lost", stopModel: false };
    if (run.state !== "running") return { continue: false, reason: run.state, stopModel: run.state === "killed" };
    const spec = store.getVersion(run.agentId, run.version)?.spec;
    if (now().getTime() > Date.parse(run.startedAt) + (spec?.budget?.runSeconds ?? 600) * 1000 + limits.runGraceMs) {
      store.finishRun(run.id, { state: "timeout", reason: "It ran past its time limit and was stopped." });
      emit(run.id, "state", { state: "timeout" });
      return { continue: false, reason: "timeout", stopModel: false };
    }
    store.extendLease(runId, limits.leaseMs);
    return { continue: true };
  }

  /** The runner's own steps: the model's words and timing, and the model starting or stopping. */
  function runnerSteps(runId, lease, steps) {
    const run = heldRun(runId, lease);
    const list = Array.isArray(steps) ? steps.slice(0, 10) : [];
    if (store.countSteps(run.id, "model") + list.length > limits.modelStepsPerRun) refuse(409, "This run has sent as many steps as it may", "too_many_steps");
    const saved = [];
    for (const step of list) {
      if (!step || !["model", "system"].includes(step.kind)) continue;
      const added = store.addStep(run.id, {
        kind: step.kind,
        name: clip(String(step.name ?? step.kind).replace(/[\u0000-\u001f\u007f]/g, " "), 120),
        state: ["done", "failed"].includes(step.state) ? step.state : "done",
        output: step.text === undefined || step.text === null ? null : redact(clip(String(step.text), limits.stepTextChars)),
        input: Array.isArray(step.toolCalls) ? step.toolCalls.slice(0, 8).map((call) => ({ name: clip(String(call?.name ?? ""), 80), arguments: redact(clip(String(call?.arguments ?? ""), 600)) })) : null,
        durationMs: Math.round(finite(step.durationMs, 3_600_000)),
        tokensIn: Math.round(finite(step.tokensIn, 1e7)) || null,
        tokensOut: Math.round(finite(step.tokensOut, 1e7)) || null,
        flags: step.kind === "system" && typeof step.detail === "string" ? { detail: clip(step.detail, 300) } : {},
      });
      if (added) { saved.push(added); emit(run.id, "step", added); }
    }
    return { saved: saved.length };
  }

  // ---- tools ----

  async function runnerTool(runId, lease, name, rawInput) {
    const run = heldRun(runId, lease);
    const spec = store.getVersion(run.agentId, run.version)?.spec;
    const tool = toolById(String(name ?? ""));
    const toolCount = outputKinds.reduce((sum, kind) => sum + store.countSteps(run.id, kind), 0);
    const started = now();
    const given = outputsSoFar(run.id);
    const answer = (stepKind, { state: stepState = "done", text, input = null, flags = {}, title = tool?.title ?? String(name) }) => {
      const cleaned = sanitizeUntrusted(text, { maxChars: limits.toolOutputChars, redact });
      const allFlags = { ...flags, ...(cleaned.flags.injection ? { injection: true, matches: cleaned.flags.matches } : {}), ...(cleaned.flags.truncated ? { truncated: true } : {}) };
      const step = store.addStep(run.id, { kind: stepKind, name: tool?.id ?? clip(String(name), 80), state: stepState, input, output: cleaned.text, flags: allFlags, startedAt: started.toISOString(), durationMs: now().getTime() - started.getTime() });
      if (cleaned.flags.injection) store.mergeRunFlags(run.id, { injection: true });
      if (step) emit(run.id, "step", step);
      const index = stepState === "done" ? given + 1 : null;
      const content = stepState === "done"
        ? wrapToolOutput({ index, tool: tool?.fn ?? String(name), text: cleaned.text, flags: allFlags })
        : `<tool_output tool="${tool?.fn ?? "unknown"}" trust="untrusted">\nThe tool did not run: ${cleaned.text}\n</tool_output>`;
      return { ok: stepState === "done", index, title, content, flags: allFlags };
    };
    if (!tool) return answer("tool", { state: "refused", text: `There is no tool called ${clip(String(name), 60)}.`, flags: { refused: true } });
    if (!toolAllowed(tool, spec?.tools?.[tool.id], { kind: run.kind, readRole: run.readRole })) {
      const why = !roleAtLeast(run.readRole, tool.role) ? `it needs an ${tool.role}, and this run reads as a ${run.readRole}` : spec?.tools?.[tool.id] === "ask" ? "it is only used when a person asks" : "it is off for this agent";
      return answer("tool", { state: "refused", text: `${tool.title} was refused: ${why}.`, flags: { refused: true } });
    }
    if (toolCount >= Math.min(limits.maxToolCallsPerRun, (spec?.budget?.stepsPerRun ?? 6) * limits.toolCallsPerStep)) return answer("tool", { state: "refused", text: "This run has used all its tool calls. Answer with what you have.", flags: { refused: true, limit: true } });
    const { value, problem } = readToolInput(tool, rawInput);
    if (problem) return answer("tool", { state: "refused", text: problem, input: { raw: redact(clip(typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? {}), 400)) }, flags: { refused: true } });
    const context = { readRole: run.readRole, readAs: run.readAs, spec, run };
    try {
      if (tool.id === "notes.read") return answer("tool", { text: readNotes(run, spec, value), input: value });
      if (tool.id === "notes.write") return writeNoteFor(run, spec, value, answer);
      if (tool.id === "plan.propose") return await proposeFor(run, spec, value, answer);
      if (tool.id === "notify.owner") return notifyFor(run, spec, value, answer);
      const result = await Promise.race([
        tools.run(tool.id, value, context),
        new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new ToolError(`${tool.title} did not answer within ${Math.round(limits.toolTimeoutMs / 1000)} seconds`)), limits.toolTimeoutMs); timer.unref?.(); }),
      ]);
      return answer("tool", { text: result, input: value });
    } catch (error) {
      return answer("tool", { state: "failed", text: `${tool.title} failed: ${error?.expose || error instanceof ToolError ? error.message : "it could not be read"}`, input: value, flags: { failed: true } });
    }
  }

  function readNotes(run, spec, { query = null }) {
    if (!spec.memory?.enabled) return "This agent keeps no notes.";
    const words = query ? new Set(query.toLowerCase().split(/\W+/).filter((word) => word.length > 2)) : null;
    const notes = store.listNotes(run.agentId, { limit: 50 }).filter((note) => !words || [...words].some((word) => `${note.title} ${note.body}`.toLowerCase().includes(word))).slice(0, 10);
    if (!notes.length) return query ? `No notes about "${clip(query, 60)}".` : "No notes yet.";
    return notes.map((note) => {
      const stale = note.freshUntil && Date.parse(note.freshUntil) < now().getTime();
      return `## ${note.title}${stale ? " (may be out of date)" : ""}\nWritten ${note.updatedAt.slice(0, 10)}${note.source?.tools?.length ? ` from ${note.source.tools.join(", ")}` : ""}.\n${note.body}`;
    }).join("\n\n");
  }

  function writeNoteFor(run, spec, { title, body, freshDays }, answer) {
    if (!spec.memory?.enabled || !spec.outputs?.notes) return answer("note", { state: "refused", text: "This agent keeps no notes.", flags: { refused: true } });
    if (store.countSteps(run.id, "note") >= limits.noteWritesPerRun) return answer("note", { state: "refused", text: `A run writes at most ${limits.noteWritesPerRun} notes.`, flags: { refused: true } });
    const cleanTitle = sanitizeUntrusted(title, { maxChars: 120, redact }).text.replace(/\n/g, " ");
    const cleanBody = sanitizeUntrusted(body, { maxChars: 2_000, redact });
    const toolsUsed = [...new Set(store.listSteps(run.id).filter((step) => step.kind === "tool" && step.state === "done").map((step) => step.name))];
    const days = freshDays ?? spec.memory.freshDays;
    const note = store.writeNote(run.agentId, {
      title: cleanTitle, body: cleanBody.text,
      source: { runId: run.id, by: "agent", tools: toolsUsed, injection: Boolean(cleanBody.flags.injection || store.getRun(run.id)?.flags?.injection) },
      freshUntil: new Date(now().getTime() + days * 86_400_000).toISOString(), maxNotes: spec.memory.maxNotes,
    });
    return answer("note", { text: `Kept the note "${note.title}", fresh for ${days} days.`, input: { title: cleanTitle } });
  }

  async function proposeFor(run, spec, { title, reason, steps }, answer) {
    if (!spec.outputs?.proposals) return answer("proposal", { state: "refused", text: "This agent does not propose plans.", flags: { refused: true } });
    if (!["owner", "operator"].includes(run.readRole)) return answer("proposal", { state: "refused", text: "Plans are proposed only for someone who could approve them.", flags: { refused: true } });
    if (store.countSteps(run.id, "proposal") >= limits.proposalsPerRun) return answer("proposal", { state: "refused", text: `A run proposes at most ${limits.proposalsPerRun} plans.`, flags: { refused: true } });
    const checked = await validatePlan(steps, { registry, role: run.readRole, secretEnvNamesFor });
    if (!checked.steps.length) return answer("proposal", { state: "refused", text: `None of the steps can be proposed: ${checked.dropped.map((entry) => entry.reason).join("; ") || "there were none"}.`, flags: { refused: true } });
    const flags = store.getRun(run.id)?.flags?.injection ? { afterSuspiciousOutput: true } : {};
    const proposal = store.createProposal({
      agentId: run.agentId, runId: run.id, source: "agent",
      title: sanitizeUntrusted(title, { maxChars: 120, redact }).text.replace(/\n/g, " "),
      reason: sanitizeUntrusted(reason, { maxChars: 600, redact }).text,
      steps: checked.steps, dropped: checked.dropped, flags, forRole: run.readRole, requestedBy: run.requestedBy,
      expiresAt: new Date(now().getTime() + limits.proposalTtlMs).toISOString(),
    });
    audit("agents.proposal.created", { actorId: run.requestedBy, subjectId: proposal.id, details: { agentId: run.agentId, runId: run.id, steps: checked.steps.map((step) => step.operationId), dropped: checked.dropped.length } });
    const tiers = checked.steps.map((step) => `${step.operationId} (${step.risk})`).join(", ");
    return answer("proposal", { text: `Saved as an approval card: ${tiers}.${checked.dropped.length ? ` Left out: ${checked.dropped.map((entry) => `${entry.operationId ?? "a step"} - ${entry.reason}`).join("; ")}.` : ""} Nothing runs until a person approves each step.`, input: { title, steps: checked.steps.map((step) => step.operationId) }, flags: { proposalId: proposal.id, ...flags } });
  }

  function notifyFor(run, spec, { title, message }, answer) {
    if (spec.outputs?.notify !== "important" || moduleSettings().notify === false) return answer("notify", { state: "refused", text: "This agent does not send notifications.", flags: { refused: true } });
    const history = state.getSetting?.("agentsNotified", {}) ?? {};
    const at = now().getTime();
    const recent = Object.values(history).flat().filter((entry) => at - Date.parse(entry) < 86_400_000);
    const mine = (history[run.agentId] ?? []).filter((entry) => at - Date.parse(entry) < limits.notifyCooldownMs);
    if (mine.length || recent.length >= limits.notifyPerDay || store.getRun(run.id)?.flags?.notify) return answer("notify", { state: "refused", text: "The owner was told something recently; put it in your answer instead.", flags: { refused: true } });
    const notice = { title: sanitizeUntrusted(title, { maxChars: 80, redact }).text.replace(/\n/g, " "), message: sanitizeUntrusted(message, { maxChars: 400, redact }).text };
    store.mergeRunFlags(run.id, { notify: notice });
    return answer("notify", { text: "The owner will be told when this run finishes.", input: notice });
  }

  // ---- finishing ----

  async function runnerFinish(runId, lease, result = {}) {
    const run = heldRun(runId, lease);
    const agent = store.getAgent(run.agentId, { includeDeleted: true });
    const spec = store.getVersion(run.agentId, run.version)?.spec ?? agent.spec;
    const outcome = ["completed", "degraded", "failed"].includes(result.outcome) ? result.outcome : "failed";
    const answer = result.answer ? redact(clip(String(result.answer), limits.answerChars)) : null;
    const toolOutputs = outputsSoFar(run.id);
    const citations = checkCitations(answer, toolOutputs);
    const usage = {
      modelMs: Math.round(finite(result.usage?.modelMs, 3_600_000)),
      loadMs: Math.round(finite(result.usage?.loadMs, 3_600_000)),
      promptTokens: Math.round(finite(result.usage?.promptTokens, 1e7)),
      completionTokens: Math.round(finite(result.usage?.completionTokens, 1e7)),
      modelCalls: Math.round(finite(result.usage?.modelCalls, 1000)),
      toolCalls: store.countSteps(run.id, "tool"),
      wallMs: Math.max(0, now().getTime() - Date.parse(run.startedAt)),
    };
    const outputKind = run.kind === "eval" ? "eval" : run.kind === "learn" ? "notes" : run.kind === "schedule" && spec.outputs?.digest ? "digest" : "answer";
    const degradedReason = typeof result.degradedReason === "string" ? result.degradedReason.slice(0, 40) : null;
    const finished = store.finishRun(run.id, {
      state: outcome,
      reason: outcome === "failed" ? clip(redact(String(result.error ?? "The run failed")), 300) : degradedReason ? `degraded: ${degradedReason}` : null,
      answer, outputKind, usage,
      flags: { citations: { cited: citations.cited.length, unknown: citations.unknown }, ...(degradedReason ? { degraded: degradedReason } : {}) },
    });
    if (!finished) refuse(409, "The run has already finished", "run_finished");
    store.markAgentRan(run.agentId, finished.finishedAt);
    emit(run.id, "state", { state: finished.state });
    audit("agents.run.finished", {
      actorId: run.requestedBy, subjectId: run.id,
      details: { agentId: run.agentId, version: run.version, kind: run.kind, outcome: finished.state, readRole: run.readRole, toolCalls: usage.toolCalls, modelMs: usage.modelMs, loadMs: usage.loadMs, tokens: usage.promptTokens + usage.completionTokens, durationMs: usage.wallMs, injectionSuspected: Boolean(finished.flags?.injection), degraded: degradedReason },
    });
    if (finished.flags?.notify && finished.state !== "failed") await deliverNotice(agent, finished);
    if (run.kind === "eval" && run.eval?.evalId) await gradeEvalRun(finished);
    wake();
    return { state: finished.state };
  }

  async function deliverNotice(agent, run) {
    try {
      state.updateSetting?.("agentsNotified", {}, (history) => {
        const at = now().toISOString();
        const kept = Object.fromEntries(Object.entries(history ?? {}).map(([key, list]) => [key, (list ?? []).filter((entry) => now().getTime() - Date.parse(entry) < 86_400_000)]));
        return { value: { ...kept, [agent.id]: [...(kept[agent.id] ?? []), at] }, result: null };
      }, null);
      await healthAlerts?.tell?.({ key: `agent.important:${agent.id}`, title: `${agent.name}: ${run.flags.notify.title}`, message: run.flags.notify.message, priority: "high" });
    } catch { /* an undelivered notice is kept by the ledger or shown on the page; never fatal */ }
  }

  // ---- the module switch, pauses and the kill switch ----

  function saveModule(caller, input) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner turns Agents on or off", "forbidden");
    const current = moduleSettings();
    const next = { ...current };
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") refuse(400, "enabled is true or false", "invalid_setting");
      next.enabled = input.enabled;
      if (input.enabled) { next.killedAt = null; }
    }
    if (input.quietHours !== undefined) {
      try { next.quietHours = normalizeQuietHours(input.quietHours); } catch (error) { refuse(400, error.message, "invalid_setting"); }
    }
    if (input.notify !== undefined) next.notify = input.notify === true;
    state.setSetting(agentsSettingKey, next, { updatedBy: person.id });
    let runtime = runtimeSettings();
    if (input.runtime !== undefined) {
      runtime = normalizeRuntimeSettings(input.runtime, runtime);
      state.setSetting(agentsRuntimeKey, runtime, { updatedBy: person.id });
    }
    if (input.knowledge !== undefined) setKnowledgeSources(person, input.knowledge);
    audit("settings.agents.changed", { actorId: person.id, subjectId: person.id, details: { enabled: next.enabled, quietHours: next.quietHours, notify: next.notify, driver: runtime.driver, endpoint: runtime.endpoint } });
    if (next.enabled && !current.enabled) void ensureRunnerToken().catch(() => null);
    wake();
    return { module: presentModule(), runtime };
  }

  function pauseModule(caller, { until = null } = {}) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot pause agents", "forbidden");
    const resumeAt = until === "tomorrow" ? tomorrowMorning(now()) : until ? new Date(until) : null;
    if (resumeAt && (Number.isNaN(resumeAt.getTime()) || resumeAt <= now() || resumeAt.getTime() - now().getTime() > 30 * 86_400_000)) refuse(400, "Pause until a time within the next thirty days", "invalid_pause");
    state.setSetting(agentsSettingKey, { ...moduleSettings(), paused: true, pausedUntil: resumeAt ? resumeAt.toISOString() : null, pausedBy: person.id }, { updatedBy: person.id });
    audit("agents.module.paused", { actorId: person.id, details: { until: resumeAt?.toISOString() ?? null } });
    return presentModule();
  }

  function resumeModule(caller) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot resume agents", "forbidden");
    const settings = moduleSettings();
    if (settings.killedAt && person.role !== "owner") refuse(403, "After the kill switch only the owner starts agents again", "forbidden");
    state.setSetting(agentsSettingKey, { ...settings, paused: false, pausedUntil: null, pausedBy: null, killedAt: null }, { updatedBy: person.id });
    audit("agents.module.resumed", { actorId: person.id });
    wake();
    return presentModule();
  }

  /** Stop everything now: cancel what waits, stop what runs, tell the runner to stop its model. */
  function killSwitch(caller) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot stop agents", "forbidden");
    const settings = moduleSettings();
    state.setSetting(agentsSettingKey, { ...settings, paused: true, pausedUntil: null, pausedBy: person.id, killedAt: now().toISOString() }, { updatedBy: person.id });
    let cancelled = 0; let stopped = 0;
    for (const run of store.activeRuns()) {
      if (run.state === "queued" && store.finishRun(run.id, { state: "cancelled", reason: "Stopped by the kill switch" })) cancelled += 1;
      if (run.state === "running" && store.finishRun(run.id, { state: "killed", reason: "Stopped by the kill switch" })) { stopped += 1; emit(run.id, "state", { state: "killed" }); }
    }
    stopModelRequested = true;
    audit("agents.module.killed", { actorId: person.id, details: { cancelled, stopped } });
    wake();
    return { module: presentModule(), cancelled, stopped };
  }

  function pauseAgent(caller, agentId, { until = null } = {}) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot pause agents", "forbidden");
    const agent = agentFor(person, agentId);
    const resumeAt = until === "tomorrow" ? tomorrowMorning(now()) : until ? new Date(until) : null;
    if (resumeAt && (Number.isNaN(resumeAt.getTime()) || resumeAt <= now())) refuse(400, "Pause until a time that has not passed", "invalid_pause");
    store.setPaused(agent.id, true, { until: resumeAt?.toISOString() ?? null });
    for (const run of store.activeRuns().filter((entry) => entry.agentId === agent.id && entry.state === "queued")) store.finishRun(run.id, { state: "cancelled", reason: "The agent was paused" });
    audit("agents.paused", { actorId: person.id, subjectId: agent.id, details: { until: resumeAt?.toISOString() ?? null } });
    return presentAgent(person, store.getAgent(agent.id));
  }

  function resumeAgent(caller, agentId) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot resume agents", "forbidden");
    const agent = agentFor(person, agentId);
    store.setPaused(agent.id, false);
    audit("agents.resumed", { actorId: person.id, subjectId: agent.id });
    wake();
    return presentAgent(person, store.getAgent(agent.id));
  }

  // ---- agents: create, edit, versions ----

  function createAgent(caller, { template = null, spec = null } = {}) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Only the owner and operators make agents", "forbidden");
    const base = template ? templateById(template) : null;
    if (template && !base) refuse(400, `There is no template called ${template}`, "invalid_agent");
    if (store.listAgents().length >= 30) refuse(409, "Thirty agents is the most BoxPilot keeps. Delete one first.", "agent_limit");
    const normalized = wrapSpecError(() => normalizeSpec(spec ?? base?.spec ?? {}));
    const agent = store.createAgent({ spec: normalized, template: base?.id ?? null, createdBy: person.id, nextRunAt: nextRunFor(normalized) });
    if (base && templateQuestions[base.id]?.length) store.setQuestions(agent.id, templateQuestions[base.id], { updatedBy: person.id });
    audit("agents.created", { actorId: person.id, subjectId: agent.id, details: { template: base?.id ?? null, name: normalized.name } });
    return presentAgent(person, agent, { detail: true });
  }

  function updateAgent(caller, agentId, { spec, note = null } = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    const normalized = wrapSpecError(() => normalizeSpec(spec));
    if (specText(normalized) === specText(agent.spec)) return { ...presentAgent(person, agent, { detail: true }), unchanged: true };
    const version = store.addVersion(agent.id, { spec: normalized, note: typeof note === "string" ? clip(note.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), 200) || null : null, createdBy: person.id, nextRunAt: nextRunFor(normalized) });
    audit("agents.updated", { actorId: person.id, subjectId: agent.id, details: { version, fields: diffSpecs(agent.spec, normalized).map((change) => change.field) } });
    return presentAgent(person, store.getAgent(agent.id), { detail: true });
  }

  function rollbackAgent(caller, agentId, { version } = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    const target = store.getVersion(agent.id, Number(version));
    if (!target) refuse(404, "That version does not exist", "version_not_found");
    if (target.version === agent.version) refuse(409, "That is already the current version", "version_current");
    const next = store.addVersion(agent.id, { spec: target.spec, note: `Rolled back to version ${target.version}`, createdBy: person.id, nextRunAt: nextRunFor(target.spec) });
    audit("agents.rolled-back", { actorId: person.id, subjectId: agent.id, details: { to: target.version, version: next } });
    return presentAgent(person, store.getAgent(agent.id), { detail: true });
  }

  function deleteAgent(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    for (const run of store.activeRuns().filter((entry) => entry.agentId === agent.id)) store.finishRun(run.id, { state: run.state === "running" ? "killed" : "cancelled", reason: "The agent was deleted" });
    store.deleteAgent(agent.id);
    audit("agents.deleted", { actorId: person.id, subjectId: agent.id, details: { name: agent.name } });
    return { deleted: true };
  }

  function versionDetail(caller, agentId, version) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    if (person.role === "viewer") refuse(403, "Viewers see an agent's answers, not how it is built", "forbidden");
    const target = store.getVersion(agent.id, Number(version));
    if (!target) refuse(404, "That version does not exist", "version_not_found");
    const previous = store.getVersion(agent.id, target.version - 1);
    return { version: { ...target, createdBy: ownActor(person, target.createdBy) }, changes: previous ? diffSpecs(previous.spec, target.spec) : [], againstCurrent: diffSpecs(target.spec, agent.spec) };
  }

  const wrapSpecError = (fn) => { try { return fn(); } catch (error) { if (error instanceof SpecError) throw new AgentError(400, error.message, error.code); throw error; } };
  const nextRunFor = (spec) => nextScheduledRun(spec.triggers?.schedule, now())?.toISOString() ?? null;

  // ---- what the pages read ----

  function presentModule() {
    const settings = moduleSettings();
    return {
      enabled: settings.enabled, paused: modulePaused(settings), pausedUntil: modulePaused(settings) ? settings.pausedUntil : null,
      killedAt: settings.killedAt, quietHours: settings.quietHours, inQuietHours: inQuietHours(now(), settings.quietHours), notify: settings.notify !== false,
    };
  }

  function presentAgent(caller, agent, { detail = false } = {}) {
    const budget = budgetOf(agent);
    const active = store.activeRuns().filter((run) => run.agentId === agent.id);
    const last = store.listRuns({ agentId: agent.id, limit: 10 }).find((run) => finishedStates.has(run.state) && canSeeRun(caller, run, agent));
    const settings = moduleSettings();
    const status = !settings.enabled ? "off" : modulePaused(settings) ? "module-paused" : agentPaused(agent) ? "paused" : active.some((run) => run.state === "running") ? "running" : active.some((run) => run.state === "queued") ? "queued" : "idle";
    const spec = agent.spec;
    const summary = {
      id: agent.id, name: agent.name, template: agent.template, version: agent.version, purpose: spec.purpose,
      paused: agentPaused(agent), pausedUntil: agentPaused(agent) ? agent.pausedUntil : null, status,
      canEdit: canEdit(caller, agent), canAsk: canAsk(caller, agent) && status !== "off", createdAt: agent.createdAt, updatedAt: agent.updatedAt,
      lastRun: last ? { id: last.id, kind: last.kind, state: last.state, finishedAt: last.finishedAt } : null,
      nextRunAt: spec.triggers?.schedule ? agent.nextRunAt : null,
      waitsForQuietHours: Boolean(spec.triggers?.schedule?.quietHours),
      budgetToday: { runsUsed: budget.runsUsed, runsPerDay: spec.budget.runsPerDay, modelSecondsUsed: Math.round(budget.modelMsUsed / 1000), modelSecondsPerDay: spec.budget.modelSecondsPerDay, tokensUsed: budget.tokensUsed },
      toolsOn: Object.values(spec.tools).filter((permission) => permission !== "off").length,
      triggers: { ask: spec.triggers.ask, schedule: spec.triggers.schedule, events: spec.triggers.events },
      audience: spec.audience,
    };
    if (!detail || caller.role === "viewer") return summary;
    return { ...summary, spec, versions: store.listVersions(agent.id).map((version) => ({ ...version, createdBy: ownActor(caller, version.createdBy) })), createdBy: ownActor(caller, agent.createdBy), prompt: systemMessage(spec) };
  }

  function presentRun(caller, run, { steps = null } = {}) {
    const agent = store.getAgent(run.agentId, { includeDeleted: true });
    return {
      id: run.id, agentId: run.agentId, agentName: agent?.name ?? "A deleted agent", version: run.version, kind: run.kind, trigger: run.trigger,
      question: run.question, state: run.state, reason: run.reason, readRole: run.readRole,
      queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
      answer: run.answer, outputKind: run.outputKind, usage: run.usage, flags: run.flags, eval: run.eval,
      requestedBy: caller.role === "owner" || run.requestedBy === caller.id ? run.requestedBy : null,
      proposals: store.listProposalsForRun(run.id).map((proposal) => presentProposal(caller, proposal)),
      ...(steps ? { steps } : {}),
    };
  }

  function presentProposal(caller, proposal) {
    const agent = proposal.agentId ? store.getAgent(proposal.agentId, { includeDeleted: true }) : null;
    return { ...proposal, agentName: agent?.name ?? (proposal.source === "runtime" ? "BoxPilot" : "A deleted agent"), requestedBy: ownActor(caller, proposal.requestedBy), decidedBy: ownActor(caller, proposal.decidedBy) };
  }

  function overview(caller) {
    const person = personOf(caller);
    const agents = store.listAgents().filter((agent) => person.role !== "viewer" || canAsk(person, agent)).map((agent) => presentAgent(person, agent));
    const { queued, running } = queueCounts();
    return {
      module: presentModule(),
      runner: runnerStatus(),
      agents,
      queue: { queued, running, dropped: droppedRuns },
      cardsWaiting: person.role === "viewer" ? 0 : store.listProposals().filter((proposal) => canSeeProposal(person, proposal)).length,
      can: { create: ["owner", "operator"].includes(person.role), configure: person.role === "owner", pause: ["owner", "operator"].includes(person.role) },
    };
  }

  function catalog() {
    return {
      templates: agentTemplates.map(({ id, title, summary, spec }) => ({ id, title, summary, spec, questions: templateQuestions[id] ?? [] })),
      tools: describeTools(),
      events: Object.entries(agentEvents).map(([id, title]) => ({ id, title })),
      limits: { budget: budgetCeilings },
    };
  }

  function getAgent(caller, agentId) {
    const person = personOf(caller);
    return presentAgent(person, agentFor(person, agentId), { detail: true });
  }

  function listRuns(caller, agentId, { limit = 30 } = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    return store.listRuns({ agentId: agent.id, limit: 200 }).filter((run) => canSeeRun(person, run, agent)).slice(0, Math.min(limit, 100)).map((run) => presentRun(person, run));
  }

  function getRun(caller, runId) {
    const person = personOf(caller);
    const run = store.getRun(runId);
    if (!run || !canSeeRun(person, run)) refuse(404, "There is no run with that id", "run_not_found");
    return presentRun(person, run, { steps: store.listSteps(run.id) });
  }

  function listNotes(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    if (!canEdit(person, agent) && person.role !== "owner") refuse(403, "An agent's notes are for the owner and the person who made it", "forbidden");
    return store.listNotes(agent.id).map((note) => ({ ...note, stale: note.freshUntil ? Date.parse(note.freshUntil) < now().getTime() : false }));
  }

  function deleteNote(caller, agentId, noteId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    if (!store.deleteNote(agent.id, noteId)) refuse(404, "There is no such note", "note_not_found");
    audit("agents.note.deleted", { actorId: person.id, subjectId: agent.id });
    return { deleted: true };
  }

  function listProposals(caller) {
    const person = personOf(caller);
    if (person.role === "viewer") return [];
    return store.listProposals().filter((proposal) => canSeeProposal(person, proposal)).map((proposal) => presentProposal(person, proposal));
  }

  function decideProposal(caller, proposalId, { decision, jobIds = [] } = {}) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot act on cards", "forbidden");
    const proposal = store.getProposal(proposalId);
    if (!proposal || !canSeeProposal(person, proposal)) refuse(404, "There is no such card", "proposal_not_found");
    if (!["dismissed", "staged"].includes(decision)) refuse(400, "A card is dismissed, or its steps staged", "invalid_decision");
    const ids = Array.isArray(jobIds) ? jobIds.filter((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 8) : [];
    const decided = store.decideProposal(proposal.id, { state: decision, decidedBy: person.id, jobIds: ids });
    if (!decided) refuse(409, "That card was already decided", "proposal_decided");
    audit("agents.proposal.decided", { actorId: person.id, subjectId: proposal.id, details: { decision, jobs: ids.length } });
    return presentProposal(person, decided);
  }

  function glance(caller) {
    const person = personOf(caller);
    if (person.role === "viewer") refuse(403, "The digest and cards are for the owner and operators", "forbidden");
    const settings = moduleSettings();
    let digest = null;
    for (const agent of store.listAgents()) {
      const run = store.listRuns({ agentId: agent.id, limit: 30 }).find((entry) => entry.outputKind === "digest" && ["completed", "degraded"].includes(entry.state) && canSeeRun(person, entry, agent));
      if (run && (!digest || run.finishedAt > digest.at)) digest = { agentId: agent.id, agentName: agent.name, runId: run.id, at: run.finishedAt, excerpt: clip(run.answer ?? "", 600), state: run.state };
    }
    return { enabled: settings.enabled, paused: modulePaused(settings), runnerOnline: runnerOnline(), digest, cardsWaiting: store.listProposals().filter((proposal) => canSeeProposal(person, proposal)).length };
  }

  function usage(caller) {
    personOf(caller);
    const since = startOfLocalDay(now()).toISOString();
    const perAgent = store.listAgents().map((agent) => {
      const used = store.usageSince(agent.id, since);
      return { agentId: agent.id, name: agent.name, runs: used.runs, runsPerDay: agent.spec.budget.runsPerDay, modelSeconds: Math.round(used.modelMs / 1000), modelSecondsPerDay: agent.spec.budget.modelSecondsPerDay, tokens: used.tokens };
    });
    const { queued, running } = queueCounts();
    return {
      runner: runnerStatus(),
      caps: { ...runnerCaps, unit: runnerUnit },
      today: { runs: perAgent.reduce((sum, entry) => sum + entry.runs, 0), modelSeconds: perAgent.reduce((sum, entry) => sum + entry.modelSeconds, 0), tokens: perAgent.reduce((sum, entry) => sum + entry.tokens, 0), perAgent },
      queue: { queued, running, dropped: droppedRuns },
      module: presentModule(),
    };
  }

  // ---- knowledge ----

  function setKnowledgeSources(person, input) {
    if (person.role !== "owner") refuse(403, "Only the owner turns knowledge sources on or off", "forbidden");
    if (!input || typeof input !== "object" || Array.isArray(input)) refuse(400, "Send each source's on or off", "invalid_setting");
    const current = knowledgeSettings();
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(current, key) || typeof value !== "boolean") refuse(400, `There is no knowledge source called ${key}`, "invalid_setting");
      current[key] = value;
    }
    state.setSetting(agentsKnowledgeKey, current, { updatedBy: person.id });
    return current;
  }

  async function knowledgeState(caller) {
    const person = personOf(caller);
    if (person.role === "viewer") refuse(403, "The learning library is for the owner and operators", "forbidden");
    const toggles = knowledgeSettings();
    const stats = knowledge ? await knowledge.ensure().catch(() => knowledge.stats()) : null;
    const documents = store.listDocuments();
    const notes = store.listAgents().flatMap((agent) => store.listNotes(agent.id).map((note) => ({ ...note, agentName: agent.name })));
    const lastLearn = store.listAgents().map((agent) => ({ agentId: agent.id, name: agent.name, run: store.listRuns({ agentId: agent.id, limit: 50 }).find((run) => run.kind === "learn") ?? null }))
      .map((entry) => ({ agentId: entry.agentId, name: entry.name, state: entry.run?.state ?? null, at: entry.run?.finishedAt ?? entry.run?.queuedAt ?? null }));
    return {
      sources: [
        { id: "docs", title: "BoxPilot's documents", enabled: toggles.docs, items: stats?.documents ?? null, size: stats ? stats.documentChunks : null, unit: "sections", indexedAt: stats?.builtAt ?? null },
        { id: "registry", title: "Registered operations", enabled: toggles.registry, items: stats?.operations ?? null, size: stats?.operations ?? null, unit: "operations", indexedAt: stats?.builtAt ?? null },
        { id: "catalog", title: "The app catalog", enabled: toggles.catalog, items: stats?.apps ?? null, size: stats?.apps ?? null, unit: "apps", indexedAt: stats?.builtAt ?? null },
        { id: "notes", title: "What the agents learned (their notes)", enabled: toggles.notes, items: notes.length, size: notes.reduce((sum, note) => sum + note.body.length, 0), unit: "characters", indexedAt: notes[0]?.updatedAt ?? null },
        { id: "documents", title: "Your documents", enabled: toggles.documents, items: documents.length, size: documents.reduce((sum, document) => sum + document.characters, 0), unit: "characters", indexedAt: documents[0]?.createdAt ?? null },
      ],
      documents: documents.map(({ text: _text, ...document }) => ({ ...document, createdBy: ownActor(person, document.createdBy) })),
      search: { kind: "keyword (BM25)", embeddings: "Not yet: whether Unsloth serves embeddings on this CPU is what the spike measures." },
      learning: { quietHours: moduleSettings().quietHours, agents: lastLearn },
      canChange: person.role === "owner",
    };
  }

  function addDocument(caller, { title, text } = {}) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner adds documents", "forbidden");
    const cleanTitle = typeof title === "string" ? title.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    const cleanText = typeof text === "string" ? text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";
    if (!cleanTitle || cleanTitle.length > 120) refuse(400, "Give the document a title under 120 characters", "invalid_document");
    if (!cleanText || cleanText.length > 64_000) refuse(400, "A document is some text, at most 64,000 characters", "invalid_document");
    if (store.listDocuments().length >= 100) refuse(409, "A hundred documents is the most the library keeps", "document_limit");
    const document = store.addDocument({ title: cleanTitle, text: redact(cleanText), createdBy: person.id });
    audit("agents.document.added", { actorId: person.id, subjectId: document.id, details: { characters: document.characters } });
    const { text: _text, ...rest } = document;
    return rest;
  }

  function removeDocument(caller, documentId) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner removes documents", "forbidden");
    if (!store.deleteDocument(documentId)) refuse(404, "There is no such document", "document_not_found");
    audit("agents.document.removed", { actorId: person.id, subjectId: documentId });
    return { deleted: true };
  }

  function toggleDocument(caller, documentId, enabled) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner changes documents", "forbidden");
    if (typeof enabled !== "boolean" || !store.setDocumentEnabled(documentId, enabled)) refuse(404, "There is no such document", "document_not_found");
    return { enabled };
  }

  /** Queue a quiet-hours learning pass for one agent, or every agent that keeps notes. */
  function relearn(caller, agentId = null) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot start learning", "forbidden");
    const agents = agentId ? [agentFor(person, agentId, { edit: true })] : store.listAgents().filter((agent) => canEdit(person, agent));
    let queued = 0;
    for (const agent of agents.filter((entry) => entry.spec.memory?.enabled && entry.spec.tools["notes.write"] !== "off")) {
      if (enqueueSystem(agent, "learn", { title: "Learn this server", quietHours: true }).run) queued += 1;
    }
    audit("agents.relearn", { actorId: person.id, details: { agents: queued } });
    return { queued, quietHours: moduleSettings().quietHours };
  }

  // ---- evaluation ----

  function normalizeQuestions(list) {
    if (!Array.isArray(list) || list.length > limits.evalQuestions) refuse(400, `At most ${limits.evalQuestions} golden questions`, "invalid_questions");
    const facts = ["hostname", "operatingSystem", "installedApps", "rootDiskPercent", "piholePlacement", "piholeBlocking"];
    return list.map((entry, index) => {
      const question = typeof entry?.question === "string" ? entry.question.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
      if (!question || question.length > 300) refuse(400, `Question ${index + 1} needs words, under 300 characters`, "invalid_questions");
      const expect = entry.expect ?? {};
      if (expect.fact !== undefined) {
        if (!facts.includes(expect.fact)) refuse(400, `Question ${index + 1}: the fact is one of ${facts.join(", ")}`, "invalid_questions");
        return { id: typeof entry.id === "string" && /^[a-z0-9-]{1,40}$/.test(entry.id) ? entry.id : `q${index + 1}`, question, expect: { fact: expect.fact } };
      }
      const includes = Array.isArray(expect.includes) ? expect.includes.filter((text) => typeof text === "string" && text.trim()).map((text) => text.trim().slice(0, 80)).slice(0, 5) : [];
      if (!includes.length) refuse(400, `Question ${index + 1} needs an expected fact or words the answer must contain`, "invalid_questions");
      return { id: typeof entry.id === "string" && /^[a-z0-9-]{1,40}$/.test(entry.id) ? entry.id : `q${index + 1}`, question, expect: { includes } };
    });
  }

  function getEvaluation(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    if (person.role === "viewer") refuse(403, "Evaluations are for the owner and operators", "forbidden");
    return { questions: store.getQuestions(agent.id) ?? templateQuestions[agent.template] ?? [], runs: store.listEvalRuns(agent.id).map((run) => ({ ...run, createdBy: ownActor(person, run.createdBy) })), canEdit: canEdit(person, agent) };
  }

  function setEvaluation(caller, agentId, { questions } = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    const normalized = normalizeQuestions(questions);
    store.setQuestions(agent.id, normalized, { updatedBy: person.id });
    audit("agents.evaluation.changed", { actorId: person.id, subjectId: agent.id, details: { questions: normalized.length } });
    return getEvaluation(person, agent.id);
  }

  /** What a golden question's fact is on this server right now. */
  async function resolveFacts({ role }) {
    const [snapshot, apps, pihole] = await Promise.all([
      inventory?.inspect().catch(() => null),
      tools.readApps().catch(() => null),
      // An operator read (ADR-003); an evaluation is started by the owner or an operator anyway.
      helper && ["owner", "operator"].includes(role) ? helper.request("app.pihole.inspect", {}, { timeoutMs: 30_000 }).catch(() => null) : null,
    ]);
    return {
      hostname: snapshot?.host?.hostname ?? null,
      operatingSystem: snapshot?.host?.operatingSystem ?? null,
      installedApps: Array.isArray(apps?.applications) ? apps.applications.filter((entry) => entry?.installed).length : null,
      rootDiskPercent: Number.isFinite(snapshot?.storage?.root?.usedPercent) ? snapshot.storage.root.usedPercent : null,
      piholePlacement: pihole?.placement ?? null,
      piholeBlocking: pihole?.available ? (pihole.blocking === true ? "on" : pihole.blocking === false ? "off" : null) : null,
    };
  }

  async function runEvaluation(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    const settings = moduleSettings();
    if (!settings.enabled) refuse(409, "Agents are off. Turn them on to run an evaluation.", "agents_off");
    if (modulePaused(settings) || agentPaused(agent)) refuse(409, "Resume the agent to run an evaluation", "agent_paused");
    const recent = store.listEvalRuns(agent.id, 1)[0];
    if (recent && (recent.state === "running" || now().getTime() - Date.parse(recent.createdAt) < limits.evalEveryMs)) refuse(429, "An evaluation ran in the last hour. Try again later.", "evaluation_recent");
    const questions = store.getQuestions(agent.id) ?? templateQuestions[agent.template] ?? [];
    if (!questions.length) refuse(400, "Give this agent some golden questions first", "no_questions");
    if (queueCounts().queued + questions.length > limits.queueMax) refuse(503, "Agents have too much waiting right now. Try again later.", "agents_backlog");
    const facts = await resolveFacts(person);
    const results = questions.map((question) => ({ questionId: question.id, question: question.question, expected: question.expect.fact ? { fact: question.expect.fact, value: facts[question.expect.fact] } : { includes: question.expect.includes }, runId: null, passed: null, found: null }));
    const evaluation = store.createEvalRun({ agentId: agent.id, version: agent.version, results, createdBy: person.id });
    for (const result of results) {
      const run = store.enqueueRun({ agentId: agent.id, version: agent.version, kind: "eval", question: result.question, requestedBy: person.id, readRole: person.role, readAs: person.id, evalInfo: { evalId: evaluation.id, questionId: result.questionId, expected: result.expected } });
      result.runId = run.id;
    }
    store.setEvalResults(evaluation.id, results);
    audit("agents.evaluation.started", { actorId: person.id, subjectId: agent.id, details: { questions: results.length } });
    wake();
    return store.getEvalRun(evaluation.id);
  }

  async function gradeEvalRun(run) {
    const expected = run.eval.expected ?? {};
    const answer = String(run.answer ?? "");
    let passed = false; let found = null;
    if (run.state !== "completed") { passed = false; found = `The run ended ${run.state}`; }
    else if (expected.includes) {
      const missing = expected.includes.filter((text) => !answer.toLowerCase().includes(text.toLowerCase()));
      passed = missing.length === 0; found = passed ? "Every expected word is there" : `Missing: ${missing.join(", ")}`;
    } else if (expected.fact) {
      ({ passed, found } = gradeFact(expected.fact, expected.value, answer));
    }
    store.gradeEval(run.eval.evalId, run.eval.questionId, { passed, found });
  }

  return {
    // people
    overview, catalog, getAgent, createAgent, updateAgent, rollbackAgent, deleteAgent, versionDetail,
    pauseAgent, resumeAgent, pauseModule, resumeModule, killSwitch, saveModule,
    startRun, cancelRun, listRuns, getRun, subscribeRun,
    listNotes, deleteNote, listProposals, decideProposal, glance, usage,
    knowledgeState, addDocument, removeDocument, toggleDocument, relearn,
    getEvaluation, setEvaluation, runEvaluation,
    runtimeState: (caller) => runtimeState(caller), checkForNewerModel: () => checkForNewerModel(),
    useModel: (result, options) => useModel(result, options),
    currentModel: () => { const runtime = runtimeSettings(); return `${runtime.repo}/${runtime.file}`; },
    // the runner
    runnerHello, runnerNext, runnerHeartbeat, runnerSteps, runnerTool, runnerFinish,
    runnerUsage: (runnerId, value) => { noteRunner(runnerId, value?.usage ?? null, value?.hostBusy); return runnerAdvice(); },
    runnerAdvice: () => runnerAdvice(),
    verifyRunnerToken: (token) => verifyRunnerToken(token), ensureRunnerToken: () => ensureRunnerToken(),
    // background
    start, tick, recoverAtStartup, onJob, onHealthRound, moduleSettings, runtimeSettings,
    get limits() { return limits; },
  };

  /**
   * What the runner should do with its model while nothing is claimed: stop it now after the kill
   * switch, and whenever Agents are off or paused, rather than waiting for it to idle out.
   */
  function runnerAdvice() {
    const settings = moduleSettings();
    const stopModel = stopModelRequested || !settings.enabled || modulePaused(settings);
    stopModelRequested = false;
    return { stopModel, enabled: settings.enabled, paused: modulePaused(settings) };
  }

  // ---- the runtime: what runs the model ----

  async function runtimeState(caller) {
    const person = personOf(caller);
    const runtime = runtimeSettings();
    // agents.runtime.inspect is an operator read (ADR-003): not run for a viewer on this route's behalf.
    const inspected = helper && ["owner", "operator"].includes(person.role) ? await helper.request("agents.runtime.inspect", {}, { timeoutMs: 45_000 }).catch(() => null) : null;
    const check = state.getSetting?.(runtimeCheckKey, null);
    return {
      settings: person.role === "owner" ? runtime : { driver: runtime.driver, repo: runtime.repo, file: runtime.file },
      library: modelLibrary.map((model) => ({ ...model, preview: downloadPreview(model), downloaded: Boolean(inspected?.models?.some((entry) => entry.repo === model.repo && entry.file === model.file && entry.complete)), current: model.repo === runtime.repo && model.file === runtime.file })),
      installed: inspected ? { runtime: inspected.runtime ?? null, service: inspected.service ?? null, models: inspected.models ?? [], diskFreeBytes: inspected.diskFreeBytes ?? null } : null,
      newer: check?.newer ?? null,
      checkedAt: check?.checkedAt ?? null,
      runner: runnerStatus(),
      caps: { ...runnerCaps, unit: runnerUnit },
    };
  }

  /** agents.model.switch finished: the helper found the model downloaded whole, so the next run uses it. */
  function useModel(result, { actorId = null } = {}) {
    if (!result?.repo || !result?.file) return null;
    const next = { ...runtimeSettings(), repo: result.repo, file: result.file, projector: result.projector ?? null, quant: result.quant };
    state.setSetting(agentsRuntimeKey, next, { updatedBy: actorId });
    audit("agents.model.switched", { actorId, details: { repo: result.repo, file: result.file } });
    // The model server running the old one stops at its next idle check, or when the next run asks.
    return next;
  }

  /** Daily: is there a newer small Qwen? If so, a card - never a switch. */
  async function checkForNewerModel() {
    const settings = moduleSettings();
    const runtime = runtimeSettings();
    if (!settings.enabled || runtime.driver !== "unsloth" || !fetchJson) return null;
    const newer = await findNewerQwen({ current: { repo: runtime.repo }, fetchJson }).catch(() => null);
    state.setSetting?.(runtimeCheckKey, { checkedAt: now().toISOString(), newer }, { updatedBy: null });
    if (!newer) return null;
    const title = `Switch agents to ${newer.repo.replace(/^unsloth\//, "")}`;
    if (store.findOpenProposal("runtime", title)) return newer;
    const parameters = { repo: newer.repo, file: newer.file, projector: newer.projector ?? null };
    const checked = await validatePlan([
      { operationId: "agents.model.download", parameters, why: "Download the newer model and check every byte." },
      { operationId: "agents.model.switch", parameters, why: "Use it for the next run; the model in use now stays on disk to switch back to." },
    ], { registry, role: "owner", secretEnvNamesFor });
    if (checked.steps.length) {
      store.createProposal({ source: "runtime", title, reason: `Unsloth published Qwen ${newer.version} at ${newer.parameters}B, newer than the model agents use now. Nothing changes until you approve both steps.`, steps: checked.steps, dropped: checked.dropped, forRole: "owner", expiresAt: new Date(now().getTime() + 30 * 86_400_000).toISOString() });
    }
    return newer;
  }

  // ---- the runner's key ----

  function tokenFile() {
    return tokenPath ?? path.join(path.dirname(state.databasePath ?? path.join(os.tmpdir(), "boxpilot", "x")), "agents", "runner.token");
  }

  /** The runner's key: a random value in a root-readable file (systemd's LoadCredential hands it over); only its digest is kept. */
  async function ensureRunnerToken({ rotate = false } = {}) {
    const saved = state.getSetting?.(runnerTokenKey, null);
    if (saved?.hash && !rotate) return { issued: false, path: tokenFile() };
    const token = randomBytes(32).toString("base64url");
    const file = tokenFile();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${token}\n`, { mode: 0o600 });
    state.setSetting(runnerTokenKey, { hash: digestToken(token), issuedAt: now().toISOString() }, { updatedBy: null });
    audit("agents.runner.key-issued", { details: { rotated: Boolean(saved?.hash) } });
    return { issued: true, path: file };
  }

  function verifyRunnerToken(token) {
    const saved = state.getSetting?.(runnerTokenKey, null);
    if (!saved?.hash || typeof token !== "string" || token.length < 20 || token.length > 200) return false;
    const given = Buffer.from(digestToken(token));
    const expected = Buffer.from(saved.hash);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  // ---- background ----

  /** At startup: a run that was going when BoxPilot stopped is marked, not retried. */
  function recoverAtStartup() {
    let count = 0;
    for (const run of store.activeRuns().filter((entry) => entry.state === "running")) {
      if (store.finishRun(run.id, { state: "interrupted", reason: "BoxPilot restarted while this run was going. It was not tried again." })) count += 1;
    }
    return count;
  }

  async function tick() {
    const at = now();
    const settings = moduleSettings();
    if (settings.paused && settings.pausedUntil && Date.parse(settings.pausedUntil) <= at.getTime()) {
      state.setSetting(agentsSettingKey, { ...settings, paused: false, pausedUntil: null, pausedBy: null }, { updatedBy: null });
      audit("agents.module.resumed", { details: { scheduled: true } });
    }
    for (const agent of store.listAgents()) {
      if (agent.paused && agent.pausedUntil && Date.parse(agent.pausedUntil) <= at.getTime()) store.setPaused(agent.id, false);
      const schedule = agent.spec.triggers?.schedule;
      if (!schedule) continue;
      if (!agent.nextRunAt) { store.setNextRun(agent.id, nextScheduledRun(schedule, at)?.toISOString() ?? null); continue; }
      if (Date.parse(agent.nextRunAt) > at.getTime()) continue;
      store.setNextRun(agent.id, nextScheduledRun(schedule, at)?.toISOString() ?? null);
      enqueueSystem(store.getAgent(agent.id), "schedule", { title: "Its schedule", quietHours: schedule.quietHours });
    }
    expireLeases();
    store.expireProposals(at);
    if (at.getTime() - lastPrune > 86_400_000) { lastPrune = at.getTime(); try { store.prune({ at }); } catch { /* next day */ } }
    if (settings.enabled && at.getTime() - lastModelCheck > 86_400_000) { lastModelCheck = at.getTime(); await checkForNewerModel().catch(() => null); }
    wake();
  }

  function onEvent(family, trigger) {
    const at = now();
    for (const agent of store.listAgents()) {
      if (!agent.spec.triggers?.events?.includes(family)) continue;
      const last = agent.events?.[family];
      if (last && at.getTime() - Date.parse(last) < limits.eventCooldownMs) continue;
      const queued = enqueueSystem(agent, "event", { event: family, title: clip(trigger.title, 200) });
      if (queued.run || queued.refused) store.noteEvent(agent.id, family, at.toISOString());
    }
  }

  function onJob(job) {
    if (job?.state !== "failed") return;
    onEvent("job.failed", { title: `A job failed: ${job.title ?? job.type ?? "a job"}` });
  }

  function onHealthRound({ active = [] } = {}) {
    const now_ = new Set(active);
    if (previousAlerts === null) { previousAlerts = now_; return; }
    const ledger = state.getSetting?.("healthAlertsState", {}) ?? {};
    for (const key of now_) {
      if (previousAlerts.has(key)) continue;
      const family = key.split(":")[0];
      const title = ledger[key]?.title ?? family;
      if (family === "storage.mount.detached" || family === "storage.mount.readonly") onEvent("drive.dropped", { title });
      else onEvent("health.alert", { title });
    }
    previousAlerts = now_;
  }

  function start({ subscribeJobs = null, afterRound = null } = {}) {
    recoverAtStartup();
    const timer = setInterval(() => { void tick().catch(() => {}); }, limits.tickMs);
    timer.unref?.();
    const unsubscribeJobs = subscribeJobs ? subscribeJobs(onJob) : null;
    const unsubscribeRounds = afterRound ? afterRound(onHealthRound) : null;
    if (moduleSettings().enabled) void ensureRunnerToken().catch(() => null);
    return () => { clearInterval(timer); unsubscribeJobs?.(); unsubscribeRounds?.(); wake(); };
  }
}

/** Whether an answer states a fact's value, allowing the ways a model writes it. */
export function gradeFact(fact, value, answer) {
  const text = String(answer ?? "").toLowerCase();
  if (value === null || value === undefined) return { passed: false, found: "The fact could not be read on this server, so the answer cannot be checked" };
  if (fact === "installedApps" || fact === "rootDiskPercent") {
    const numbers = [...text.matchAll(/\b(\d{1,4})(?:\.\d+)?\b/g)].map((match) => Number(match[1]));
    const words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    words.forEach((word, index) => { if (new RegExp(`\\b${word}\\b`).test(text)) numbers.push(index); });
    const tolerance = fact === "rootDiskPercent" ? 2 : 0;
    const passed = numbers.some((number) => Math.abs(number - value) <= tolerance);
    return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
  }
  if (fact === "operatingSystem") {
    const [name, version] = String(value).toLowerCase().match(/^(\S+)\s+([\d.]+)/)?.slice(1) ?? [String(value).toLowerCase(), ""];
    const short = version.split(".").slice(0, 2).join(".");
    const passed = text.includes(name) && (!short || text.includes(short));
    return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
  }
  if (fact === "piholePlacement") {
    const words = { "boxpilot-app": ["boxpilot app", "boxpilot's app", "bp-pi-hole", "installed by boxpilot", "boxpilot container"], container: ["docker container", "a container", "another container"], host: ["natively", "on the host", "systemd", "pihole-ftl.service", "host service"], absent: ["not installed", "isn't installed", "is not running here", "no pi-hole"] }[value] ?? [];
    const passed = words.some((word) => text.includes(word));
    return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
  }
  if (fact === "piholeBlocking") {
    const passed = value === "on" ? /\b(on|enabled|active|is blocking)\b/.test(text) && !/\b(off|disabled|not blocking)\b/.test(text) : /\b(off|disabled|not blocking)\b/.test(text);
    return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
  }
  const passed = text.includes(String(value).toLowerCase());
  return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
}
