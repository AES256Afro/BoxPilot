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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validatePlan } from "../assistant/plan.mjs";
import { finalRedaction } from "../assistant/prompt.mjs";
import { normalizeEndpoint, isLocalAddress, isLoopbackAddress } from "../assistant/local-endpoint.mjs";
import { createRedactor, loadRedactionPolicy } from "../redaction.mjs";
import { budgetState, createRateLimit, defaultQuietHours, inQuietHours, nextScheduledRun, normalizeQuietHours, startOfLocalDay, tomorrowMorning } from "./budget.mjs";
import { runnerCaps, runnerUnit } from "./caps.mjs";
import { ConnectorError, boundSync, cleanDocumentText, connectors, readFolderSetting, scanFolder, textOfUpload } from "./connectors.mjs";
import { sanitizeUntrusted, wrapNote, wrapToolOutput } from "./guard.mjs";
import { readUnderstanding, understandingSummary } from "./intent.mjs";
import { decodeVector, encodeVector, episodeOf, foldThread, hybridSearch, memoryTiers, readVector } from "./memory.mjs";
import { defaultModelId, downloadPreview, findNewerQwen, modelById, modelLibrary, testedUnslothVersion, unslothModelSpec } from "./models.mjs";
import { chainOf, checkHandoff, findSpecialist, specialistsFor, treeOf } from "./orchestrator.mjs";
import { exportDefinition, readDefinition } from "./portable.mjs";
import { checkCitations, readStructuredAnswer, systemMessage, taskMessage } from "./prompt.mjs";
import { SpecError, agentEvents, budgetCeilings, diffSpecs, normalizeSpec, outputFormats, scopeWarnings, specText } from "./spec.mjs";
import { digestToken, finishedStates } from "./store.mjs";
import { agentTemplates, templateById, templateQuestions } from "./templates.mjs";
import { describeTools, readToolInput, roleAtLeast, toModelTool, toolAllowed, toolById, toolCatalog, toolCategories } from "./tool-catalog.mjs";
import { ToolError, createToolRunner } from "./tools.mjs";

export const agentsSettingKey = "agents";
export const agentsRuntimeKey = "agentsRuntime";
export const agentsKnowledgeKey = "agentsKnowledge";
export const runnerTokenKey = "agentsRunnerToken";
export const runtimeCheckKey = "agentsRuntimeCheck";
export const runtimeInstallKey = "agentsRuntimeInstall";

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
  memoryInPrompt: 4,
  indexBatch: 48,
  docChunkChars: 1_200,
  webhookFiresPerMinute: 6,
  lowConfidence: 0.5,
  tickMs: 60_000,
  notesInPrompt: 8,
  toolTimeoutMs: 35_000,
  evalQuestions: 10,
  evalEveryMs: 3600_000,
});

/**
 * What serves the model: Unsloth (the owner's choice, the default); llama.cpp's own llama-server from
 * the same install with no Studio layer (ADR-005 leaves that choice to the owner); a model server the
 * owner already runs on this machine; or the fake model, for tests and the demo only.
 */
export const runtimeDrivers = Object.freeze(["unsloth", "llama-server", "external", "fake"]);

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
// One queue for every agent: a person's live question first, orchestrated follow-ups with it, then
// evaluations, events and webhooks, schedules, and background work (learning, indexing) last.
const kindRank = { ask: 0, manual: 0, continue: 0, handoff: 1, eval: 1, event: 2, webhook: 2, schedule: 3, learn: 4, index: 5 };
/** Whether a person is waiting on this run: their own question, or a hand-off made for one. */
const personWaiting = (run) => personKinds.has(run.kind) || (["handoff", "continue"].includes(run.kind) && Boolean(run.requestedBy));
/** The id of the index runs, which belong to no agent: the memory's own. */
export const memoryIndexAgentId = "boxpilot-memory-index";
const clip = (text, max) => { const value = String(text ?? ""); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const finite = (value, max) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(Number(value), max) : 0);

export const defaultModuleSettings = Object.freeze({
  enabled: false, paused: false, pausedUntil: null, pausedBy: null, killedAt: null, quietHours: defaultQuietHours, notify: true,
  // One budget across every agent, on top of each agent's own.
  budget: Object.freeze({ runsPerDay: 300, modelSecondsPerDay: 10_800 }),
  // Meaning search for memory: embeddings from the model server's /v1/embeddings, indexed in quiet hours.
  embeddings: true,
  // Opt-in, and off: web search through the owner's own SearXNG, a folder to learn from, and
  // read-only Notion and Slack through named credentials.
  webSearch: Object.freeze({ enabled: false, endpoint: null }),
  folder: Object.freeze({ enabled: false, path: null }),
  connectors: Object.freeze({ notion: Object.freeze({ enabled: false, credential: null }), slack: Object.freeze({ enabled: false, credential: null, channels: [] }) }),
});
export const moduleBudgetCeilings = Object.freeze({ runsPerDay: { min: 10, max: 2_000 }, modelSecondsPerDay: { min: 60, max: 86_400 } });

export function defaultRuntimeSettings() {
  const model = modelById(defaultModelId);
  return { driver: "unsloth", repo: model.repo, file: model.file, projector: model.projector, quant: model.quant, endpoint: null, contextTokens: model.contextTokens, idleStopMinutes: 60, maxTokens: 1_024, temperature: 0.2 };
}

/** The owner's runtime choices as stored; the model itself changes only through agents.model.switch. */
export function normalizeRuntimeSettings(input, current = defaultRuntimeSettings()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgentError(400, "Send the runtime's settings", "invalid_setting");
  const driver = input.driver ?? current.driver;
  if (!runtimeDrivers.includes(driver) || (driver === "fake" && process.env.BOXPILOT_AGENTS_ALLOW_FAKE !== "1")) throw new AgentError(400, "The runtime is Unsloth, llama.cpp's llama-server, or a model server already running on this machine", "invalid_setting");
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
    // Unsloth unloads the model itself after 15 quiet minutes (UNSLOTH_MODEL_IDLE_TTL); this stops the
    // whole server, its Python backend too, so idle is then no process at all.
    idleStopMinutes: integer(input.idleStopMinutes, current.idleStopMinutes, 5, 720, "Minutes before an idle model server stops"),
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
  fetcher = null,
  productVersion = null,
} = {}) {
  const limits = { ...serviceLimits, ...overrides };
  const tools = createToolRunner({ state, store, registry, helper, inventory, knowledge, secretEnvNamesFor, now, webSearch: () => moduleSettings().webSearch, ...(fetcher ? { fetcher } : {}) });
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
  let issuing = null;   // the runner's key being issued, so two callers never make two keys
  // Step kinds whose output the model is given, numbered T1, T2 ... in the order they happened.
  const outputKinds = ["tool", "memory", "proposal", "note", "notify", "handoff"];
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
    const own = budgetState(agent.spec.budget, usedToday(agent.id));
    const all = moduleBudget();
    // One budget across all agents: whichever runs out first stops the run.
    return { ...own, modelMsLeft: Math.min(own.modelMsLeft, all.modelMsLeft), refusal: own.refusal ?? all.refusal };
  }
  /** Every agent's use today against the module's own budget. */
  function moduleBudget() {
    const used = store.usageSince(null, startOfLocalDay(now()).toISOString());
    const { runsPerDay, modelSecondsPerDay } = moduleSettings().budget ?? defaultModuleSettings.budget;
    const modelMsLeft = Math.max(0, modelSecondsPerDay * 1000 - used.modelMs);
    const refusal = used.runs >= runsPerDay ? `All agents together have used their ${runsPerDay} runs for today`
      : modelMsLeft <= 0 ? `All agents together have used their ${modelSecondsPerDay} seconds of model time for today` : null;
    return { runsUsed: used.runs, runsPerDay, modelMsUsed: used.modelMs, modelSecondsPerDay, modelMsLeft, refusal };
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
      if (run.kind !== "index") {
        const agent = store.getAgent(run.agentId);
        if (!agent) { store.finishRun(run.id, { state: "cancelled", reason: "The agent was deleted" }); continue; }
        if (agentPaused(agent)) continue;
      }
      const ttl = personWaiting(run) ? limits.askTtlMs : limits.systemTtlMs;
      if (at.getTime() - Date.parse(run.queuedAt) > ttl) { store.finishRun(run.id, { state: "cancelled", reason: "It waited too long to start" }); continue; }
      if (run.trigger?.quietHours && !quiet) continue;
      // The server is busy: people's questions still go, everything else waits.
      if ((hostBusy || hostLoad() > 0.85) && !personWaiting(run)) continue;
      eligible.push(run);
    }
    eligible.sort((a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9) || a.queuedAt.localeCompare(b.queuedAt));
    return eligible[0] ?? null;
  }

  /** The tools a run is offered: the agent's permissions, the run's role, and what is switched on. */
  function offeredTools(run, spec, agent) {
    const settings = moduleSettings();
    const specialists = specialistsFor(spec, store.listAgents(), agent.id);
    return toolCatalog.filter((tool) => {
      if (!toolAllowed(tool, spec.tools?.[tool.id], { kind: run.kind, readRole: run.readRole })) return false;
      if (tool.id === "docs.search") return Object.values(spec.knowledge ?? {}).some(Boolean);
      if (tool.id === "web.search") return settings.webSearch?.enabled === true && Boolean(settings.webSearch?.endpoint);
      if (tool.id === "memory.search") return spec.memory?.enabled === true;
      // A follow-up run writes the answer; it hands nothing further.
      if (tool.id === "agents.handoff") return specialists.length > 0 && run.kind !== "continue" && (run.depth ?? 0) < (spec.orchestration?.maxDepth ?? 2);
      return true;
    });
  }

  /** What the runtime is, for the runner: the model, the name to ask for, thinking, embeddings. */
  function runtimeClaim(spec) {
    const runtime = runtimeSettings();
    const thinking = spec?.model?.thinking === true;
    return {
      driver: runtime.driver,
      // Unsloth loads "repo:quant"; every request names the repo, since once Unsloth has unloaded
      // the model its /v1/models lists every GGUF in the cache, not only this one (the spike).
      model: runtime.driver === "unsloth" ? unslothModelSpec({ repo: runtime.repo, quant: runtime.quant }) : null,
      requestModel: ["unsloth", "llama-server"].includes(runtime.driver) ? runtime.repo : null,
      repo: runtime.repo, file: runtime.file, projector: runtime.projector,
      endpoint: runtime.driver === "external" ? runtime.endpoint : null,
      contextTokens: runtime.contextTokens, threads: runnerCaps.modelThreads, idleStopMs: runtime.idleStopMinutes * 60_000,
      maxTokens: runtime.maxTokens, temperature: runtime.temperature,
      // Qwen's thinking is off unless the agent asks for it: on a CPU the spike's 4B spent 1,500
      // tokens thinking without answering. An agent may turn it on for hard tasks, within budget.
      extra: runtime.driver === "unsloth" || runtime.driver === "fake" ? { enable_thinking: thinking }
        : runtime.driver === "llama-server" ? { chat_template_kwargs: { enable_thinking: thinking } } : {},
      // Meaning search: Unsloth answers /v1/embeddings beside the chat model (its RAG embedder).
      // llama.cpp's server alone does not, so memory search falls back to words there.
      embeddings: moduleSettings().embeddings !== false && runtime.driver !== "llama-server",
    };
  }

  const stale = (item) => Boolean(item.freshUntil && Date.parse(item.freshUntil) < now().getTime());

  /**
   * What an agent may remember in a run reading as `readRole`: its own facts, other agents' shared
   * facts learned by runs that read no more than this one may, its episodes, and pinned knowledge.
   */
  function memoryItems(agent, spec, readRole) {
    const items = [];
    const agentNames = new Map(store.listAgents().map((entry) => [entry.id, entry.name]));
    if (spec.memory?.enabled) {
      for (const note of store.listNotes(agent.id, { limit: 200 })) items.push({ key: `note:${note.id}`, tier: note.pinned ? "pinned" : "fact", title: note.title, text: note.body, from: agent.name, at: note.updatedAt, freshUntil: note.freshUntil, weight: note.pinned ? 1.3 : 1 });
      for (const note of store.listSharedNotes({ exceptAgentId: agent.id })) {
        if (roleAtLeast(readRole, note.readRole)) items.push({ key: `note:${note.id}`, tier: note.pinned ? "pinned" : "fact", title: note.title, text: note.body, from: agentNames.get(note.agentId) ?? "another agent", at: note.updatedAt, freshUntil: note.freshUntil, weight: 0.9 });
      }
      for (const episode of store.listEpisodes(agent.id, { limit: 100 })) {
        if (roleAtLeast(readRole, episode.readRole)) items.push({ key: `episode:${episode.id}`, tier: "episode", title: `A run on ${episode.createdAt.slice(0, 10)}`, text: episode.text, from: agent.name, at: episode.createdAt, freshUntil: null, weight: 0.8 });
      }
    }
    if (spec.knowledge?.documents !== false && knowledgeSettings().documents !== false) {
      for (const document of store.listDocuments().filter((entry) => entry.enabled && entry.pinned)) {
        chunksOf(document).forEach((text, index) => items.push({ key: `doc:${document.id}#${index}`, tier: "pinned", title: document.title, text, from: "the owner", at: document.createdAt, freshUntil: null, weight: 1.2 }));
      }
    }
    return items;
  }

  /** A document in the pieces it is embedded as: at most 1,200 characters, twenty pieces. */
  function chunksOf(document) {
    const pieces = [];
    for (let at = 0; at < document.text.length && pieces.length < 20; at += limits.docChunkChars) pieces.push(document.text.slice(at, at + limits.docChunkChars));
    return pieces;
  }

  /** The memory items with their vectors, for one embedding model. */
  function withVectors(items, model) {
    const kinds = [...new Set(items.map((item) => item.key.split(":")[0]))];
    const vectors = kinds.length ? store.vectorsOf(kinds) : new Map();
    return items.map((item) => {
      const stored = vectors.get(item.key);
      return stored && stored.model === model ? { ...item, vector: decodeVector(stored.vector) } : item;
    });
  }

  const embedModelName = () => { const runtime = runtimeSettings(); return runtime.driver === "unsloth" || runtime.driver === "llama-server" ? runtime.repo : runtime.driver; };

  function memoryLine(item) {
    return `<memory kind="${item.tier}" from="${String(item.from).replace(/"/g, "'")}" written="${String(item.at ?? "").slice(0, 10)}"${stale(item) ? " stale=\"true\"" : ""} trust="untrusted">\n${item.title}: ${sanitizeUntrusted(item.text, { maxChars: 600, redact }).text}\n</memory>`;
  }

  /** The claim for an index run: the texts whose embeddings are missing or out of date. */
  function indexPayload(run, lease) {
    const items = pendingEmbeddings().slice(0, limits.indexBatch);
    return {
      run: { id: run.id, kind: "index", question: null, trigger: run.trigger, readRole: run.readRole, startedAt: run.startedAt, deadlineAt: new Date(Date.parse(run.startedAt) + 600_000).toISOString() },
      lease, agent: { id: memoryIndexAgentId, name: "Memory index", version: 0, outputs: {} },
      index: { model: embedModelName(), items: items.map((item) => ({ key: item.key, text: item.text.slice(0, 2_000) })) },
      messages: [], tools: [], runtime: runtimeClaim(null),
      limits: { steps: 0, tokens: 0, runSeconds: 600, remainingModelMs: moduleBudget().modelMsLeft, toolCallsPerStep: 0, maxToolCalls: 0, heartbeatMs: limits.heartbeatMs },
    };
  }

  function claimPayload(run, lease) {
    if (run.kind === "index") return indexPayload(run, lease);
    const agent = store.getAgent(run.agentId, { includeDeleted: true });
    const version = store.getVersion(run.agentId, run.version) ?? { spec: agent.spec };
    const spec = version.spec;
    const offered = offeredTools(run, spec, agent);
    const notes = spec.memory?.enabled && spec.knowledge?.notes !== false && knowledgeSettings().notes !== false
      ? store.listNotes(agent.id, { limit: limits.notesInPrompt }).map((note) => wrapNote({ ...note, stale: stale(note) }, { redact }))
      : [];
    // What it remembers that bears on this request, by words (the query's vector comes later, from
    // the runner, when the model searches memory itself). Recorded in the trace as a memory read.
    const query = [run.question, run.trigger?.title, spec.job].filter(Boolean).join(" ");
    const noteKeys = new Set(store.listNotes(agent.id, { limit: limits.notesInPrompt }).map((note) => `note:${note.id}`));
    const recalled = spec.memory?.enabled ? hybridSearch(memoryItems(agent, spec, run.readRole).filter((item) => !noteKeys.has(item.key)), { query, limit: limits.memoryInPrompt }) : [];
    if (recalled.length) {
      const step = store.addStep(run.id, { kind: "recall", name: "recall", input: { query: clip(query, 200) }, output: recalled.map((item) => `${item.tier}: ${item.title} (${item.from}, ${String(item.at ?? "").slice(0, 10)}${stale(item) ? ", may be out of date" : ""})`).join("\n"), flags: { read: recalled.length } });
      if (step) emit(run.id, "step", step);
    }
    // The conversation with this person, when the agent keeps one.
    const thread = spec.memory?.threads && run.requestedBy && ["ask", "manual"].includes(run.kind) ? store.getThread(agent.id, run.requestedBy) : null;
    const context = thread ? foldThread(thread, { keep: spec.memory.turns ?? 6 }) : null;
    // A supervisor's follow-up: what each specialist answered, as tool output it can cite.
    if (run.kind === "continue") {
      for (const child of store.listChildren(run.parentRunId).filter((entry) => entry.kind === "handoff")) {
        const name = store.getAgent(child.agentId, { includeDeleted: true })?.name ?? "A specialist";
        const text = child.answer ? `${name} was asked: ${child.question}\n${name} answered: ${child.answer}` : `${name} was asked: ${child.question}\nIt did not answer (${child.state}).`;
        const cleaned = sanitizeUntrusted(text, { maxChars: limits.toolOutputChars, redact });
        store.addStep(run.id, { kind: "tool", name: "agents.handoff", input: { agent: name, runId: child.id }, output: cleaned.text, flags: cleaned.flags.injection ? { injection: true } : {} });
      }
    }
    const handoffOutputs = run.kind === "continue" ? store.listSteps(run.id).filter((step) => step.kind === "tool" && step.name === "agents.handoff").map((step, index) => wrapToolOutput({ index: index + 1, tool: "agents_handoff", text: step.output ?? "", flags: step.flags })) : [];
    const budget = budgetOf({ ...agent, spec });
    const deadlineAt = new Date(Date.parse(run.startedAt) + spec.budget.runSeconds * 1000).toISOString();
    const understand = !["eval", "continue"].includes(run.kind);
    return {
      run: { id: run.id, kind: run.kind, question: run.question, trigger: run.trigger, readRole: run.readRole, startedAt: run.startedAt, deadlineAt },
      lease,
      agent: { id: agent.id, name: spec.name, version: run.version, outputs: spec.outputs },
      messages: [
        { role: "system", content: systemMessage(spec, { specialists: offered.some((tool) => tool.id === "agents.handoff") ? specialistsFor(spec, store.listAgents(), agent.id) : [] }) },
        { role: "user", content: [taskMessage({ kind: run.kind, question: run.question, trigger: run.trigger, notes, memories: recalled.map(memoryLine), thread: context, now: now() }), ...handoffOutputs].join("\n\n") },
      ],
      tools: offered.map((tool) => ({ id: tool.id, ...toModelTool(tool) })),
      // Intent, then plan, then act: the runner asks for the structured understanding first.
      understand: understand ? { tools: offered.map((tool) => ({ fn: tool.fn, title: tool.title })) } : null,
      output: spec.prompt?.output ?? { format: "text", fields: [] },
      runtime: runtimeClaim(spec),
      limits: {
        steps: spec.budget.stepsPerRun,
        tokens: spec.budget.tokensPerRun,
        runSeconds: spec.budget.runSeconds,
        remainingModelMs: run.kind === "eval" ? Math.min(spec.budget.modelSecondsPerDay * 1000, moduleBudget().modelMsLeft || spec.budget.modelSecondsPerDay * 1000) : budget.modelMsLeft,
        toolCallsPerStep: limits.toolCallsPerStep,
        maxToolCalls: Math.min(limits.maxToolCallsPerRun, spec.budget.stepsPerRun * limits.toolCallsPerStep),
        heartbeatMs: limits.heartbeatMs,
      },
    };
  }

  // ---- embeddings: what the index runs fill in ----

  const textHash = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 32);

  /** Everything memory search may compare by meaning, whose vector is missing or out of date. */
  function pendingEmbeddings() {
    const model = embedModelName();
    const items = [];
    for (const agent of store.listAgents()) {
      for (const note of store.listNotes(agent.id, { limit: 200 })) items.push({ key: `note:${note.id}`, text: `${note.title}\n${note.body}` });
      for (const episode of store.listEpisodes(agent.id, { limit: 200 })) items.push({ key: `episode:${episode.id}`, text: episode.text });
    }
    for (const document of store.listDocuments().filter((entry) => entry.enabled)) chunksOf(document).forEach((text, index) => items.push({ key: `doc:${document.id}#${index}`, text: `${document.title}\n${text}` }));
    const kinds = ["note", "episode", "doc"];
    const vectors = store.vectorsOf(kinds);
    return items.filter((item) => { const stored = vectors.get(item.key); return !stored || stored.model !== model || stored.textHash !== textHash(item.text); });
  }

  /** The runner's embeddings for an index run: each checked, stored against the text it was made from. */
  function runnerVectors(runId, lease, entries) {
    const run = heldRun(runId, lease);
    if (run.kind !== "index") refuse(409, "Only an index run sends embeddings", "not_index");
    const pending = new Map(pendingEmbeddings().map((item) => [item.key, item]));
    const model = embedModelName();
    let saved = 0;
    for (const entry of (Array.isArray(entries) ? entries : []).slice(0, limits.indexBatch)) {
      const item = pending.get(entry?.key);
      const vector = readVector(entry?.vector);
      if (!item || !vector) continue;
      const [kind, itemId] = [item.key.slice(0, item.key.indexOf(":")), item.key.slice(item.key.indexOf(":") + 1)];
      store.setVector(kind, itemId, { model, vector: encodeVector(vector), textHash: textHash(item.text) });
      saved += 1;
    }
    return { saved };
  }

  /** In quiet hours, when something waits to be embedded and nothing is indexing: one index run. */
  function queueIndexing({ force = false } = {}) {
    const settings = moduleSettings();
    if (!settings.enabled || modulePaused(settings) || settings.embeddings === false || runtimeSettings().driver === "llama-server") return null;
    if (store.activeRuns().some((run) => run.kind === "index")) return null;
    if (!pendingEmbeddings().length) return null;
    const owner = state.listOwners?.().find((entry) => entry.role === "owner") ?? null;
    const run = store.enqueueRun({ agentId: memoryIndexAgentId, version: 0, kind: "index", trigger: { title: "Index memory for meaning search", quietHours: !force }, readRole: "owner", readAs: owner?.id ?? null });
    wake();
    return run;
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
      if (step?.kind === "intent") { saved.push(...intentSteps(run, step)); continue; }
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

  /**
   * The intent and the plan the model returned before acting: checked (known fields, bounded text,
   * only tools this run was offered), kept as two steps the trace shows, and the confidence kept on
   * the run for escalation. A reply that did not parse is a failed intent step; the run goes on.
   */
  function intentSteps(run, step) {
    const agent = store.getAgent(run.agentId, { includeDeleted: true });
    const spec = store.getVersion(run.agentId, run.version)?.spec ?? agent?.spec;
    const offered = spec && agent ? offeredTools(run, spec, agent).map((tool) => tool.fn) : [];
    const timing = { durationMs: Math.round(finite(step.durationMs, 3_600_000)), tokensIn: Math.round(finite(step.tokensIn, 1e7)) || null, tokensOut: Math.round(finite(step.tokensOut, 1e7)) || null };
    const read = readUnderstanding(step.understanding ?? step.text ?? null, { offered });
    const added = [];
    if (read.problem) {
      const failed = store.addStep(run.id, { kind: "intent", name: "understood", state: "failed", output: read.problem, ...timing });
      if (failed) added.push(failed);
    } else {
      const { understanding } = read;
      // What the model wrote back is its own words about untrusted input: redacted before it is kept.
      const clean = (text) => sanitizeUntrusted(text, { maxChars: 400, redact }).text;
      const intent = { goal: clean(understanding.goal), subject: clean(understanding.subject), constraints: understanding.constraints.map(clean), tools: understanding.tools, confidence: understanding.confidence, clarify: understanding.clarify ? clean(understanding.clarify) : null };
      const plan = understanding.plan.map((entry) => ({ step: clean(entry.step), tool: entry.tool }));
      const first = store.addStep(run.id, { kind: "intent", name: "understood", input: intent, output: understandingSummary(intent), flags: { confidence: intent.confidence, ...(read.dropped.length ? { dropped: read.dropped } : {}) }, ...timing });
      const second = store.addStep(run.id, { kind: "plan", name: "plan", input: plan, output: plan.map((entry, index) => `${index + 1}. ${entry.step}${entry.tool ? ` (${entry.tool})` : ""}`).join("\n") || "No steps: answer from what it can read." });
      store.mergeRunFlags(run.id, { confidence: intent.confidence });
      for (const entry of [first, second]) if (entry) added.push(entry);
    }
    for (const entry of added) emit(run.id, "step", entry);
    return added;
  }

  // ---- tools ----

  async function runnerTool(runId, lease, name, rawInput, extras = {}) {
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
    if (tool.id === "web.search" && !(moduleSettings().webSearch?.enabled && moduleSettings().webSearch?.endpoint)) return answer("tool", { state: "refused", text: "Web search is off on this server.", flags: { refused: true } });
    try {
      if (tool.id === "memory.search") return answer("memory", { text: searchMemory(run, spec, value, extras.vector), input: { query: value.query, tier: value.tier ?? "any", byMeaning: Boolean(readVector(extras.vector)) } });
      if (tool.id === "agents.handoff") return handoffFor(run, spec, value, answer);
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

  /**
   * Memory search: hybrid retrieval over what this agent may remember. `vector` is the query's
   * embedding, made by the runner with the model server's /v1/embeddings; without it (or with no
   * stored vectors from the same model) the search is by words alone.
   */
  function searchMemory(run, spec, { query, tier = "any", limit = 5 }, vector) {
    const agent = store.getAgent(run.agentId, { includeDeleted: true });
    let items = memoryItems(agent, spec, run.readRole);
    if (tier !== "any") items = items.filter((item) => item.tier === tier);
    if (!items.length) return "Nothing is remembered yet.";
    const queryVector = readVector(vector);
    const found = hybridSearch(queryVector ? withVectors(items, embedModelName()) : items, { query, queryVector, limit });
    if (!found.length) return `Nothing remembered about "${clip(query, 80)}".`;
    return found.map((item) => `## ${item.title} (${memoryTiers[item.tier]?.toLowerCase() ?? item.tier}; from ${item.from}; ${String(item.at ?? "").slice(0, 10)}${stale(item) ? "; may be out of date" : ""}; matched by ${item.via.join(" and ")})\n${item.text}`).join("\n\n");
  }

  /**
   * A supervisor hands a subtask to a specialist: the specialist's run is queued as the same person,
   * one level deeper under this run; its answer comes back in the supervisor's follow-up run.
   */
  function handoffFor(run, spec, { agent: name, task }, answer) {
    const agent = store.getAgent(run.agentId, { includeDeleted: true });
    const target = findSpecialist(store.listAgents(), name);
    const handed = store.listChildren(run.id).filter((entry) => entry.kind === "handoff").length;
    const check = checkHandoff({ agent, spec, run, target, chain: chainOf(run, (id) => store.getRun(id)), handedSoFar: handed });
    if (check.problem) return answer("handoff", { state: "refused", text: `${check.problem}.`, input: { agent: clip(name, 60) }, flags: { refused: true } });
    const targetBudget = budgetOf(target);
    if (targetBudget.refusal) return answer("handoff", { state: "refused", text: `${target.name} cannot run again today: ${targetBudget.refusal.toLowerCase()}.`, input: { agent: target.name }, flags: { refused: true } });
    const cleanTask = sanitizeUntrusted(task, { maxChars: 1_000, redact }).text;
    const child = store.enqueueRun({
      agentId: target.id, version: target.version, kind: "handoff", question: cleanTask, trigger: { title: `Handed over by ${agent.name}` },
      requestedBy: run.requestedBy, readRole: run.readRole, readAs: run.readAs, parentRunId: run.id, rootRunId: run.rootRunId ?? run.id, depth: check.depth,
    });
    audit("agents.handoff", { actorId: run.requestedBy, subjectId: child.id, details: { from: agent.id, to: target.id, parentRunId: run.id, depth: check.depth } });
    wake();
    return answer("handoff", { text: `Handed to ${target.name}. It runs after this run, and its answer comes back to you in a follow-up; finish this run with what you have.`, input: { agent: target.name, task: cleanTask }, flags: { childRunId: child.id } });
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
      freshUntil: new Date(now().getTime() + days * 86_400_000).toISOString(), maxNotes: spec.memory.maxNotes, readRole: run.readRole, shared: spec.memory.share === true,
    });
    return answer("note", { text: `Kept the note "${note.title}", fresh for ${days} days.`, input: { title: cleanTitle } });
  }

  async function proposeFor(run, spec, { title, reason, steps }, answer) {
    if (!spec.outputs?.proposals) return answer("proposal", { state: "refused", text: "This agent does not propose plans.", flags: { refused: true } });
    if (!["owner", "operator"].includes(run.readRole)) return answer("proposal", { state: "refused", text: "Plans are proposed only for someone who could approve them.", flags: { refused: true } });
    if (store.countSteps(run.id, "proposal") >= limits.proposalsPerRun) return answer("proposal", { state: "refused", text: `A run proposes at most ${limits.proposalsPerRun} plans.`, flags: { refused: true } });
    // The agent's allowlist first: a step for an operation it may not propose never reaches a card.
    const allowed = spec.allow?.operations ?? "*";
    const outside = allowed === "*" ? [] : (Array.isArray(steps) ? steps : []).map((step, index) => ({ index, operationId: step?.operationId ?? null })).filter((entry) => !allowed.includes(entry.operationId));
    const inside = allowed === "*" ? steps : (Array.isArray(steps) ? steps : []).filter((step) => allowed.includes(step?.operationId));
    const checked = await validatePlan(inside, { registry, role: run.readRole, secretEnvNamesFor });
    checked.dropped.push(...outside.map((entry) => ({ index: entry.index, operationId: entry.operationId, reason: "not on this agent's list of operations it may propose" })));
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
    if (run.kind === "index") return finishIndex(run, result);
    const agent = store.getAgent(run.agentId, { includeDeleted: true });
    const spec = store.getVersion(run.agentId, run.version)?.spec ?? agent.spec;
    const outcome = ["completed", "degraded", "failed"].includes(result.outcome) ? result.outcome : "failed";
    // The agent asked before guessing: its question is the answer, and a card for the person.
    const clarify = outcome === "completed" && typeof result.clarify === "string" && result.clarify.trim() ? sanitizeUntrusted(result.clarify, { maxChars: 300, redact }).text : null;
    let answer = clarify ?? (result.answer ? redact(clip(String(result.answer), limits.answerChars)) : null);
    // A structured answer is checked against the fields the owner named, and kept as their JSON.
    const format = spec.prompt?.output?.format ?? "text";
    let structured = null;
    if (!clarify && answer && format === "json" && outcomeIsAnswer(outcome)) {
      const read = readStructuredAnswer(answer, spec.prompt.output.fields ?? []);
      structured = read.value ? { ok: true } : { ok: false, problem: read.problem };
      if (read.value) answer = JSON.stringify(read.value, null, 1);
    }
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
    const outputKind = clarify ? "question" : run.kind === "eval" ? "eval" : run.kind === "learn" ? "notes" : run.kind === "schedule" && spec.outputs?.digest ? "digest" : "answer";
    const degradedReason = typeof result.degradedReason === "string" ? result.degradedReason.slice(0, 40) : null;
    const limitReached = Boolean(degradedReason === "budget" || degradedReason === "timeout" || result.limitReached);
    const finished = store.finishRun(run.id, {
      state: outcome,
      reason: outcome === "failed" ? clip(redact(String(result.error ?? "The run failed")), 300) : degradedReason ? `degraded: ${degradedReason}` : null,
      answer, outputKind, usage,
      flags: {
        citations: { cited: citations.cited.length, unknown: citations.unknown }, ...(degradedReason ? { degraded: degradedReason } : {}),
        ...(clarify ? { clarify: true } : {}), ...(structured ? { structured } : {}), ...(limitReached ? { limitReached: true } : {}),
        model: embedModelName(),
      },
    });
    if (!finished) refuse(409, "The run has already finished", "run_finished");
    store.markAgentRan(run.agentId, finished.finishedAt);
    emit(run.id, "state", { state: finished.state });
    audit("agents.run.finished", {
      actorId: run.requestedBy, subjectId: run.id,
      details: { agentId: run.agentId, version: run.version, kind: run.kind, outcome: finished.state, readRole: run.readRole, toolCalls: usage.toolCalls, modelMs: usage.modelMs, loadMs: usage.loadMs, tokens: usage.promptTokens + usage.completionTokens, durationMs: usage.wallMs, injectionSuspected: Boolean(finished.flags?.injection), degraded: degradedReason, parentRunId: run.parentRunId, clarify: Boolean(clarify) },
    });
    if (finished.flags?.notify && finished.state !== "failed") await deliverNotice(agent, finished);
    if (run.kind === "eval" && run.eval?.evalId) await gradeEvalRun(finished);
    rememberRun(agent, spec, finished);
    await escalate(agent, spec, finished, { clarify });
    continueTree(finished);
    wake();
    return { state: finished.state };
  }

  const outcomeIsAnswer = (outcome) => outcome === "completed";

  /** An index run's end: its usage counts toward the day's budget like any run's. */
  function finishIndex(run, result) {
    const usage = { modelMs: Math.round(finite(result.usage?.modelMs, 3_600_000)), loadMs: Math.round(finite(result.usage?.loadMs, 3_600_000)), wallMs: Math.max(0, now().getTime() - Date.parse(run.startedAt)) };
    const outcome = ["completed", "degraded", "failed"].includes(result.outcome) ? result.outcome : "failed";
    const finished = store.finishRun(run.id, { state: outcome, reason: outcome === "failed" ? clip(String(result.error ?? "Indexing failed"), 300) : null, usage, outputKind: "index", answer: `Indexed ${Math.round(finite(result.indexed, 10_000))} pieces of memory for meaning search.` });
    if (!finished) refuse(409, "The run has already finished", "run_finished");
    emit(run.id, "state", { state: finished.state });
    audit("agents.memory.indexed", { details: { runId: run.id, outcome: finished.state, indexed: Math.round(finite(result.indexed, 10_000)), modelMs: usage.modelMs } });
    wake();
    return { state: finished.state };
  }

  /**
   * What a finished run leaves in memory: an episode (what it found, for later runs to recall) and,
   * for a person's question, the conversation with that person, folded to fit the model.
   */
  function rememberRun(agent, spec, run) {
    try {
      if (spec.memory?.enabled && outcomeIsAnswer(run.state) && !["eval", "handoff"].includes(run.kind)) {
        const text = episodeOf(run);
        if (text) store.addEpisode({ agentId: agent.id, runId: run.id, text, readRole: run.readRole });
      }
      // The person's conversation: their question and the final answer. A supervisor's answer to a
      // hand-off comes in its follow-up run, so that is the turn kept, against the root's question.
      const root = run.kind === "continue" ? store.getRun(run.rootRunId ?? run.parentRunId) : run;
      if (spec.memory?.threads && run.requestedBy && ["ask", "manual", "continue"].includes(run.kind) && root?.question && run.answer) {
        const thread = store.getThread(agent.id, run.requestedBy) ?? { summary: "", turns: [] };
        const turns = [...thread.turns, { role: "user", text: root.question, at: root.queuedAt }, { role: "agent", text: clip(run.answer, 2_000), at: run.finishedAt, runId: run.id }];
        const folded = foldThread({ summary: thread.summary, turns }, { keep: (spec.memory.turns ?? 6) * 2 });
        store.saveThread(agent.id, run.requestedBy, { summary: folded.summary, turns: folded.turns });
      }
    } catch { /* memory is a help, never a reason for a run to fail */ }
  }

  /**
   * Escalation: the agent hands a matter to a person rather than acting or guessing. A clarifying
   * question, low confidence, a limit reached, or tool output that looked like an instruction
   * becomes a card; the risky ones also tell the owner. Never an action.
   */
  async function escalate(agent, spec, run, { clarify }) {
    const rules = spec.escalation ?? {};
    const forRole = ["owner", "operator"].includes(run.readRole) ? run.readRole : "owner";
    const card = (kind, title, reason, extra = {}) => store.createProposal({
      agentId: agent.id, runId: run.id, source: "agent", kind, title, reason, forRole, requestedBy: run.requestedBy,
      expiresAt: new Date(now().getTime() + limits.proposalTtlMs).toISOString(), ...extra,
    });
    try {
      if (clarify) { card("question", `${agent.name} has a question`, "It asked rather than guess what was meant. Answer it in the console.", { question: clarify }); return; }
      const reasons = [];
      const confidence = run.flags?.confidence;
      if (rules.lowConfidence && typeof confidence === "number" && confidence < limits.lowConfidence && ["ask", "manual", "event", "schedule", "webhook"].includes(run.kind)) reasons.push(`It was only ${Math.round(confidence * 100)}% sure it understood the request.`);
      if (rules.limits && run.flags?.limitReached) reasons.push(run.flags.degraded === "budget" ? "It ran out of its model time for today before it finished." : run.flags.degraded === "timeout" ? "It ran out of time before it finished." : "It reached a limit before it finished.");
      const risky = rules.risk && run.flags?.injection;
      if (risky) reasons.push("Something it read looked like an instruction to it. It treated it as data; check what it read.");
      if (!reasons.length) return;
      card("escalation", `${agent.name} needs you to look`, reasons.join(" "));
      audit("agents.escalated", { actorId: run.requestedBy, subjectId: run.id, details: { agentId: agent.id, lowConfidence: reasons.length && typeof confidence === "number" && confidence < limits.lowConfidence, limit: Boolean(run.flags?.limitReached), risk: Boolean(risky) } });
      if (risky && moduleSettings().notify !== false) await healthAlerts?.tell?.({ key: `agent.important:${agent.id}:risk`, title: `${agent.name}: check what it read`, message: "An agent read something that looked like an instruction. It did not act on it; the run's trace shows where.", priority: "high" });
    } catch { /* a card that could not be made is not worth failing the run over */ }
  }

  /**
   * The orchestrator's join: when every specialist a supervisor handed work to has finished, the
   * supervisor gets one follow-up run with their answers, as the same person.
   */
  function continueTree(run) {
    if (run.kind !== "handoff" || !run.parentRunId) return;
    const parent = store.getRun(run.parentRunId);
    if (!parent || parent.flags?.continued) return;
    const children = store.listChildren(parent.id).filter((entry) => entry.kind === "handoff");
    if (children.some((entry) => !finishedStates.has(entry.state))) return;
    if (!["completed", "degraded"].includes(parent.state)) return;
    const agent = store.getAgent(parent.agentId);
    if (!agent) return;
    store.mergeRunFlags(parent.id, { continued: true });
    store.enqueueRun({
      agentId: agent.id, version: agent.version, kind: "continue", question: parent.question, trigger: { title: "The specialists answered" },
      requestedBy: parent.requestedBy, readRole: parent.readRole, readAs: parent.readAs, parentRunId: parent.id, rootRunId: parent.rootRunId ?? parent.id, depth: parent.depth ?? 0,
    });
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
    if (input.embeddings !== undefined) next.embeddings = input.embeddings === true;
    if (input.budget !== undefined) {
      const raw = input.budget ?? {};
      const whole = (value, fallback, { min, max }, what) => {
        if (value === undefined) return fallback;
        if (!Number.isInteger(value) || value < min || value > max) refuse(400, `${what} must be ${min} to ${max}`, "invalid_setting");
        return value;
      };
      const current_ = current.budget ?? defaultModuleSettings.budget;
      next.budget = { runsPerDay: whole(raw.runsPerDay, current_.runsPerDay, moduleBudgetCeilings.runsPerDay, "Runs a day for all agents"), modelSecondsPerDay: whole(raw.modelSecondsPerDay, current_.modelSecondsPerDay, moduleBudgetCeilings.modelSecondsPerDay, "Model seconds a day for all agents") };
    }
    if (input.webSearch !== undefined) {
      const enabled = input.webSearch?.enabled === true;
      let endpoint = input.webSearch?.endpoint ?? current.webSearch?.endpoint ?? null;
      if (endpoint) {
        const onThisNetwork = "Web search goes through a SearXNG on this network: give its address here, like http://192.168.1.20:8089";
        try { endpoint = normalizeEndpoint(endpoint); } catch { refuse(400, onThisNetwork, "invalid_setting"); }
        const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
        if (/^[\d.:a-f]+$/i.test(host) && !isLocalAddress(host)) refuse(400, onThisNetwork, "invalid_setting");
      }
      if (enabled && !endpoint) refuse(400, "Give the address of your SearXNG to turn web search on", "invalid_setting");
      next.webSearch = { enabled, endpoint };
    }
    if (input.folder !== undefined) {
      let folder;
      try { folder = readFolderSetting(input.folder?.path ?? null); } catch (error) { refuse(400, error.message, "invalid_setting"); }
      if (input.folder?.enabled === true && !folder) refuse(400, "Name the folder to learn from", "invalid_setting");
      next.folder = { enabled: input.folder?.enabled === true, path: folder };
    }
    if (input.connectors !== undefined) {
      const raw = input.connectors ?? {};
      const credentialName = (value) => {
        if (value === null || value === undefined || value === "") return null;
        if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) refuse(400, "A connector's token is the name of a saved credential, like notion-token", "invalid_setting");
        return value;
      };
      const channels = Array.isArray(raw.slack?.channels) ? raw.slack.channels : current.connectors?.slack?.channels ?? [];
      if (channels.length > 10 || channels.some((channel) => typeof channel !== "string" || !/^[CG][A-Z0-9]{6,20}$/.test(channel))) refuse(400, "Slack channels are up to ten channel ids, like C0123456789", "invalid_setting");
      next.connectors = {
        notion: { enabled: raw.notion?.enabled === true, credential: credentialName(raw.notion?.credential ?? current.connectors?.notion?.credential) },
        slack: { enabled: raw.slack?.enabled === true, credential: credentialName(raw.slack?.credential ?? current.connectors?.slack?.credential), channels },
      };
      for (const id of ["notion", "slack"]) if (next.connectors[id].enabled && !next.connectors[id].credential) refuse(400, `Name the saved credential ${connectors[id].title} reads with`, "invalid_setting");
    }
    state.setSetting(agentsSettingKey, next, { updatedBy: person.id });
    let runtime = runtimeSettings();
    if (input.runtime !== undefined) {
      runtime = normalizeRuntimeSettings(input.runtime, runtime);
      state.setSetting(agentsRuntimeKey, runtime, { updatedBy: person.id });
    }
    if (input.knowledge !== undefined) setKnowledgeSources(person, input.knowledge);
    audit("settings.agents.changed", { actorId: person.id, subjectId: person.id, details: { enabled: next.enabled, quietHours: next.quietHours, notify: next.notify, driver: runtime.driver, endpoint: runtime.endpoint, budget: next.budget, embeddings: next.embeddings, webSearch: next.webSearch?.enabled ?? false, folder: next.folder?.enabled ?? false, notion: next.connectors?.notion?.enabled ?? false, slack: next.connectors?.slack?.enabled ?? false } });
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
      budget: moduleBudget(), embeddings: settings.embeddings !== false,
      webSearch: { enabled: settings.webSearch?.enabled === true, endpoint: settings.webSearch?.endpoint ?? null },
      folder: { enabled: settings.folder?.enabled === true, path: settings.folder?.path ?? null },
      connectors: {
        notion: { enabled: settings.connectors?.notion?.enabled === true, credential: settings.connectors?.notion?.credential ?? null },
        slack: { enabled: settings.connectors?.slack?.enabled === true, credential: settings.connectors?.slack?.credential ?? null, channels: settings.connectors?.slack?.channels ?? [] },
      },
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
    return {
      ...summary, spec, versions: store.listVersions(agent.id).map((version) => ({ ...version, createdBy: ownActor(caller, version.createdBy) })), createdBy: ownActor(caller, agent.createdBy),
      prompt: systemMessage(spec, { specialists: specialistsFor(spec, store.listAgents(), agent.id) }),
      warnings: scopeWarnings(spec),
      webhook: { enabled: Boolean(spec.triggers?.webhook), minted: Boolean(agent.webhookHash) },
      specialists: specialistsFor(spec, store.listAgents(), agent.id).map(({ id, name }) => ({ id, name })),
    };
  }

  const agentNameOf = (agentId) => (agentId === memoryIndexAgentId ? "Memory index" : store.getAgent(agentId, { includeDeleted: true })?.name ?? "A deleted agent");

  function presentRun(caller, run, { steps = null, tree = false } = {}) {
    const feedback = store.getFeedback(run.id);
    const root = run.rootRunId ?? run.id;
    return {
      id: run.id, agentId: run.agentId, agentName: agentNameOf(run.agentId), version: run.version, kind: run.kind, trigger: run.trigger,
      question: run.question, state: run.state, reason: run.reason, readRole: run.readRole,
      queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
      answer: run.answer, outputKind: run.outputKind, usage: run.usage, flags: run.flags, eval: run.eval,
      requestedBy: caller.role === "owner" || run.requestedBy === caller.id ? run.requestedBy : null,
      parentRunId: run.parentRunId, rootRunId: root, depth: run.depth ?? 0,
      feedback: feedback ? { verdict: feedback.verdict, note: feedback.note, mine: feedback.givenBy === caller.id } : null,
      proposals: store.listProposalsForRun(run.id).map((proposal) => presentProposal(caller, proposal)),
      ...(steps ? { steps } : {}),
      // An orchestrated request is one tree: every run under the same root, as the person may see them.
      ...(tree ? { tree: treeOf(store.listTree(root).filter((entry) => canSeeRun(caller, entry)), agentNameOf) } : {}),
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
      limits: { budget: budgetCeilings, module: moduleBudgetCeilings },
      categories: toolCategories,
      outputFormats,
      memoryTiers,
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
    return presentRun(person, run, { steps: store.listSteps(run.id), tree: true });
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

  // ---- memory, as the owner sees and edits it ----

  /**
   * What an agent remembers, by tier: the facts it learned (pinned first), what other agents share
   * with it, what its past runs found, and the conversation with the person asking. For the owner
   * and the person who made the agent.
   */
  function memoryOf(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    if (!canEdit(person, agent)) refuse(403, "An agent's memory is for the owner and the person who made it", "forbidden");
    const agentNames = new Map(store.listAgents().map((entry) => [entry.id, entry.name]));
    const vectors = store.vectorsOf(["note", "episode"]);
    const model = embedModelName();
    const indexed = (key) => vectors.get(key)?.model === model;
    const thread = store.getThread(agent.id, person.id);
    return {
      facts: store.listNotes(agent.id, { limit: 200 }).map((note) => ({ ...note, stale: stale(note), indexed: indexed(`note:${note.id}`) })),
      shared: store.listSharedNotes({ exceptAgentId: agent.id }).filter((note) => roleAtLeast(person.role, note.readRole)).map((note) => ({ id: note.id, title: note.title, body: note.body, from: agentNames.get(note.agentId) ?? "another agent", updatedAt: note.updatedAt, stale: stale(note) })),
      episodes: store.listEpisodes(agent.id, { limit: 100 }).filter((episode) => roleAtLeast(person.role, episode.readRole)).map((episode) => ({ ...episode, indexed: indexed(`episode:${episode.id}`) })),
      thread: thread ? { summary: thread.summary, turns: thread.turns, updatedAt: thread.updatedAt } : null,
      settings: { enabled: agent.spec.memory.enabled, share: agent.spec.memory.share, threads: agent.spec.memory.threads, turns: agent.spec.memory.turns, freshDays: agent.spec.memory.freshDays, maxNotes: agent.spec.memory.maxNotes },
      search: { byMeaning: moduleSettings().embeddings !== false && runtimeSettings().driver !== "llama-server", model, pending: pendingEmbeddings().length, vectors: store.countVectors() },
    };
  }

  /** The owner's change to a remembered fact: its words, how long it stays fresh, pinned, shared. */
  function editMemory(caller, agentId, noteId, patch = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    const title = patch.title === undefined ? undefined : sanitizeUntrusted(String(patch.title), { maxChars: 120, redact }).text.replace(/\n/g, " ");
    const body = patch.body === undefined ? undefined : sanitizeUntrusted(String(patch.body), { maxChars: 2_000, redact }).text;
    if (title !== undefined && !title) refuse(400, "A note needs a title", "invalid_note");
    if (body !== undefined && !body) refuse(400, "A note needs some words; forget it instead", "invalid_note");
    let freshUntil;
    if (patch.freshDays !== undefined) {
      if (patch.freshDays !== null && (!Number.isInteger(patch.freshDays) || patch.freshDays < 1 || patch.freshDays > 365)) refuse(400, "A note stays fresh 1 to 365 days, or always", "invalid_note");
      freshUntil = patch.freshDays === null ? null : new Date(now().getTime() + patch.freshDays * 86_400_000).toISOString();
    }
    const note = store.updateNote(agent.id, noteId, { title, body, freshUntil, pinned: typeof patch.pinned === "boolean" ? patch.pinned : undefined, shared: typeof patch.shared === "boolean" ? patch.shared : undefined });
    if (!note) refuse(404, "There is no such note", "note_not_found");
    audit("agents.memory.edited", { actorId: person.id, subjectId: agent.id, details: { note: note.id, pinned: note.pinned, shared: note.shared } });
    return { ...note, stale: stale(note) };
  }

  /** Forget: a fact, a past run's episode, or the whole conversation. Really deleted, embedding and all. */
  function forgetMemory(caller, agentId, { kind, id = null } = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    const forgotten = kind === "thread"
      ? store.deleteThread(agent.id, person.id)
      : (() => {
        if (!canEdit(person, agent)) refuse(403, "Only the owner and the person who made it change what it remembers", "forbidden");
        if (kind === "note") return store.deleteNote(agent.id, String(id ?? ""));
        if (kind === "episode") return store.deleteEpisode(agent.id, String(id ?? ""));
        return refuse(400, "Forget a note, an episode or the conversation", "invalid_memory");
      })();
    if (!forgotten) refuse(404, "There is nothing like that to forget", "memory_not_found");
    audit("agents.memory.forgotten", { actorId: person.id, subjectId: agent.id, details: { kind } });
    return { forgotten: true };
  }

  // ---- feedback on a run ----

  /** "Was this right?": thumbs up or down on a run, by whoever may see it; it feeds the evaluation. */
  function giveFeedback(caller, runId, { verdict, note = null } = {}) {
    const person = personOf(caller);
    const run = store.getRun(runId);
    if (!run || run.kind === "index" || !canSeeRun(person, run)) refuse(404, "There is no run with that id", "run_not_found");
    if (!finishedStates.has(run.state)) refuse(409, "Say whether it was right once it has answered", "run_running");
    if (!["up", "down"].includes(verdict)) refuse(400, "Feedback is up or down", "invalid_feedback");
    const cleanNote = typeof note === "string" && note.trim() ? redact(clip(note.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), 300)) : null;
    const given = store.setFeedback(run.id, { agentId: run.agentId, version: run.version, model: run.flags?.model ?? null, verdict, note: cleanNote, givenBy: person.id });
    audit("agents.feedback", { actorId: person.id, subjectId: run.id, details: { agentId: run.agentId, version: run.version, verdict } });
    return { verdict: given.verdict, note: given.note, mine: true };
  }

  // ---- export and import ----

  function exportAgent(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    audit("agents.exported", { actorId: person.id, subjectId: agent.id });
    return exportDefinition(agent, { questions: store.getQuestions(agent.id) ?? templateQuestions[agent.template] ?? [], productVersion, now: now() });
  }

  function importAgent(caller, { definition } = {}) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Only the owner and operators make agents", "forbidden");
    let read;
    try { read = readDefinition(definition); } catch (error) { refuse(error.status ?? 400, error.message, error.code ?? "invalid_definition"); }
    if (store.listAgents().length >= 30) refuse(409, "Thirty agents is the most BoxPilot keeps. Delete one first.", "agent_limit");
    const agent = store.createAgent({ spec: read.spec, template: read.template, createdBy: person.id, nextRunAt: nextRunFor(read.spec) });
    let questions = [];
    try { questions = normalizeQuestions(read.questions); } catch { questions = []; }
    if (questions.length) store.setQuestions(agent.id, questions, { updatedBy: person.id });
    audit("agents.imported", { actorId: person.id, subjectId: agent.id, details: { name: read.spec.name, template: read.template, questions: questions.length } });
    return presentAgent(person, store.getAgent(agent.id), { detail: true });
  }

  // ---- webhooks: another system (n8n, for one) starts an agent ----

  const webhookFires = new Map();

  /** A webhook token, shown once; only its digest is kept. The caller chooses only when, never what. */
  function mintAgentWebhook(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    if (!agent.spec.triggers?.webhook) refuse(409, `Turn on "a webhook" among ${agent.name}'s triggers first`, "webhook_off");
    const token = randomBytes(32).toString("base64url");
    store.setWebhook(agent.id, digestToken(token));
    audit("agents.webhook.minted", { actorId: person.id, subjectId: agent.id });
    return { token, path: `/api/v1/hooks/agents/${agent.id}/${token}` };
  }

  function clearAgentWebhook(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    store.setWebhook(agent.id, null);
    audit("agents.webhook.cleared", { actorId: person.id, subjectId: agent.id });
    return { removed: true };
  }

  /**
   * A webhook call: "accepted" | "not-found" | "rate-limited". A wrong token, a missing agent and a
   * paused or webhook-less agent answer alike, so the URL cannot be probed. Nothing in the request
   * reaches the run: the agent does its job, under its maker's authority, as a schedule would.
   */
  function fireAgentWebhook(agentId, token, { source = null } = {}) {
    const agent = store.getAgent(agentId);
    if (!agent || !agent.webhookHash || !agent.spec.triggers?.webhook || typeof token !== "string" || !token.length || token.length > 200) return "not-found";
    const presented = Buffer.from(digestToken(token));
    const stored = Buffer.from(agent.webhookHash);
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return "not-found";
    const recent = (webhookFires.get(agent.id) ?? []).filter((at) => now().getTime() - at < 60_000);
    if (recent.length >= limits.webhookFiresPerMinute) { webhookFires.set(agent.id, recent); return "rate-limited"; }
    webhookFires.set(agent.id, [...recent, now().getTime()]);
    const queued = enqueueSystem(agent, "webhook", { title: `A webhook${source ? ` from ${clip(String(source).replace(/[^\w .:-]/g, ""), 40)}` : ""}` });
    audit("agents.webhook.fired", { actorId: agent.createdBy, subjectId: agent.id, details: { queued: Boolean(queued.run), skipped: queued.skipped ?? null } });
    return "accepted";
  }

  // ---- documents from outside: uploads, a folder, connectors ----

  /** An uploaded PDF, Markdown or text file becomes a document in the library. Owner only. */
  function uploadDocument(caller, { name, buffer, title = null } = {}) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner adds documents", "forbidden");
    if (!Buffer.isBuffer(buffer) || !buffer.length) refuse(400, "Send the file", "invalid_document");
    let read;
    try { read = textOfUpload(buffer, name); } catch (error) { refuse(400, error.message, "invalid_document"); }
    if (!read.text) refuse(400, "The file has no text", "invalid_document");
    if (store.listDocuments().length >= 300) refuse(409, "Three hundred documents is the most the library keeps", "document_limit");
    const cleanTitle = clip(String(title ?? name ?? "Uploaded document").replace(/\.(pdf|md|markdown|txt)$/i, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "Uploaded document", 120);
    const document = store.addDocument({ title: cleanTitle, text: redact(read.text), createdBy: person.id, source: /\.pdf$/i.test(name ?? "") || buffer.subarray(0, 5).toString("latin1") === "%PDF-" ? "pdf" : "upload" });
    audit("agents.document.added", { actorId: person.id, subjectId: document.id, details: { characters: document.characters, source: document.source } });
    const { text: _text, ...rest } = document;
    return { ...rest, detail: read.detail };
  }

  /** Bring a connector's documents in: new ones added, changed ones replaced, each redacted. */
  function ingestDocuments(source, documents, { actorId = null, removeMissing = false } = {}) {
    let changed = 0; let removed = 0;
    const seen = new Set();
    for (const entry of documents) {
      if (!entry?.externalId || !entry?.text) continue;
      const externalId = String(entry.externalId).slice(0, 300);
      seen.add(externalId);
      const result = store.upsertDocument({ source, externalId, title: clip(String(entry.title ?? externalId), 120), text: redact(cleanDocumentText(entry.text)), createdBy: actorId });
      if (result.changed) changed += 1;
    }
    if (removeMissing) {
      for (const document of store.listDocuments().filter((entry) => entry.source === source && entry.externalId && !seen.has(entry.externalId))) { store.deleteDocument(document.id); removed += 1; }
    }
    return { changed, removed };
  }

  /** The folder the owner named, read now: at most once an hour unless the owner asks. */
  let lastFolderScan = 0;
  async function syncFolder({ force = false, actorId = null } = {}) {
    const folder = moduleSettings().folder;
    if (!folder?.enabled || !folder.path) return { skipped: "off" };
    if (!force && now().getTime() - lastFolderScan < 3600_000) return { skipped: "recent" };
    lastFolderScan = now().getTime();
    try {
      const { documents, skipped } = await scanFolder(folder.path);
      const result = ingestDocuments("folder", documents, { actorId, removeMissing: true });
      audit("agents.folder.synced", { actorId, details: { files: documents.length, changed: result.changed, removed: result.removed, skipped: skipped.length } });
      return { files: documents.length, ...result, skipped };
    } catch (error) {
      return { error: error instanceof ConnectorError ? error.message : "The folder could not be read" };
    }
  }

  function syncFolderNow(caller) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner syncs the folder", "forbidden");
    return syncFolder({ force: true, actorId: person.id });
  }

  /** agents.connector.sync finished in its root task: its documents come into the library. */
  function ingestConnector(result, { actorId = null } = {}) {
    if (!result || !Object.hasOwn(connectors, result.connector) || !Array.isArray(result.documents)) return null;
    const bounded = boundSync(result.documents.filter((entry) => typeof entry?.text === "string"));
    const outcome = ingestDocuments(result.connector, bounded.documents, { actorId, removeMissing: !bounded.truncated });
    audit("agents.connector.synced", { actorId, details: { connector: result.connector, documents: bounded.documents.length, changed: outcome.changed, removed: outcome.removed } });
    return outcome;
  }

  function reindexMemory(caller) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner starts indexing", "forbidden");
    const run = queueIndexing({ force: true });
    return { queued: Boolean(run), pending: pendingEmbeddings().length };
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
      search: {
        kind: "words (BM25) and meaning (embeddings), fused",
        embeddings: moduleSettings().embeddings === false ? "Off: search is by words only." : runtimeSettings().driver === "llama-server" ? "Not with llama.cpp's server alone: search is by words only." : `${store.countVectors()} pieces indexed by the model server's embedder; ${pendingEmbeddings().length} wait for the next quiet hours.`,
        pending: pendingEmbeddings().length, vectors: store.countVectors(), enabled: moduleSettings().embeddings !== false,
      },
      connectors: presentModule().connectors, folder: presentModule().folder, webSearch: presentModule().webSearch,
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

  /** Pinned knowledge: a document every agent that reads documents recalls first. Owner only. */
  function pinDocument(caller, documentId, pinned) {
    const person = personOf(caller);
    if (person.role !== "owner") refuse(403, "Only the owner pins documents", "forbidden");
    if (typeof pinned !== "boolean" || !store.setDocumentPinned(documentId, pinned)) refuse(404, "There is no such document", "document_not_found");
    audit("agents.document.pinned", { actorId: person.id, subjectId: documentId, details: { pinned } });
    return { pinned };
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
    const runs = store.listEvalRuns(agent.id, 20);
    return {
      questions: store.getQuestions(agent.id) ?? templateQuestions[agent.template] ?? [],
      runs: runs.map((run) => ({ ...run, createdBy: ownActor(person, run.createdBy) })),
      canEdit: canEdit(person, agent),
      successCriteria: agent.spec.successCriteria ?? [],
      accuracy: accuracyOf(agent, runs),
    };
  }

  /**
   * Accuracy over time, per agent version and model: the golden questions' scores and the people's
   * thumbs, side by side, so an improvement or a regression shows against what changed.
   */
  function accuracyOf(agent, runs) {
    const groups = new Map();
    const group = (version, model) => {
      const key = `${version}|${model ?? ""}`;
      if (!groups.has(key)) groups.set(key, { version, model: model ?? null, evaluations: 0, score: null, up: 0, down: 0, since: null });
      return groups.get(key);
    };
    for (const run of [...runs].reverse().filter((entry) => entry.state === "done" && entry.score !== null)) {
      const entry = group(run.version, run.model);
      entry.score = entry.score === null ? run.score : Math.round(((entry.score * entry.evaluations + run.score) / (entry.evaluations + 1)) * 100) / 100;
      entry.evaluations += 1;
      entry.since ??= run.createdAt;
    }
    for (const feedback of store.listFeedback(agent.id)) {
      const entry = group(feedback.version, feedback.model);
      entry[feedback.verdict === "up" ? "up" : "down"] += 1;
      if (!entry.since || feedback.givenAt < entry.since) entry.since = feedback.givenAt;
    }
    return [...groups.values()].sort((a, b) => a.version - b.version || String(a.since).localeCompare(String(b.since)));
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
    const evaluation = store.createEvalRun({ agentId: agent.id, version: agent.version, results, createdBy: person.id, model: embedModelName() });
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
    memoryOf, editMemory, forgetMemory, giveFeedback, exportAgent, importAgent,
    mintAgentWebhook, clearAgentWebhook, fireAgentWebhook,
    knowledgeState, addDocument, uploadDocument, removeDocument, toggleDocument, pinDocument, relearn, reindexMemory, syncFolderNow,
    ingestConnector: (result, options) => ingestConnector(result, options),
    getEvaluation, setEvaluation, runEvaluation,
    runtimeState: (caller) => runtimeState(caller), checkForNewerModel: () => checkForNewerModel(),
    useModel: (result, options) => useModel(result, options),
    noteRuntimeInstalled: (result, options) => noteRuntimeInstalled(result, options),
    currentModel: () => { const runtime = runtimeSettings(); return `${runtime.repo}/${runtime.file}`; },
    // the runner
    runnerHello, runnerNext, runnerHeartbeat, runnerSteps, runnerTool, runnerFinish, runnerVectors,
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
      library: modelLibrary.map((model) => ({ ...model, preview: downloadPreview(model), fitsCap: model.memoryBytes <= runnerCaps.memoryMaxBytes, downloaded: Boolean(inspected?.models?.some((entry) => entry.repo === model.repo && entry.file === model.file && entry.complete)), current: model.repo === runtime.repo && model.file === runtime.file })),
      installed: inspected ? { runtime: inspected.runtime ?? null, service: inspected.service ?? null, models: inspected.models ?? [], diskFreeBytes: inspected.diskFreeBytes ?? null } : null,
      newer: check?.newer ?? null,
      checkedAt: check?.checkedAt ?? null,
      unsloth: { ...(state.getSetting?.(runtimeInstallKey, null) ?? { version: null, installerSha256: null, installedAt: null }), testedVersion: testedUnslothVersion },
      runner: runnerStatus(),
      caps: { ...runnerCaps, unit: runnerUnit },
    };
  }

  /**
   * agents.runtime.install finished: which Unsloth it installed, kept so the Agents section can say
   * when that is not the release the spike measured (the installer always takes the newest).
   */
  function noteRuntimeInstalled(result, { actorId = null } = {}) {
    if (!result?.installed) return null;
    const installed = {
      version: typeof result.version === "string" ? result.version.replace(/[^A-Za-z0-9.+ -]/g, "").trim().slice(0, 60) || null : null,
      installerSha256: /^[a-f0-9]{64}$/.test(result.installerSha256 ?? "") ? result.installerSha256 : null,
      installedAt: now().toISOString(),
    };
    state.setSetting(runtimeInstallKey, installed, { updatedBy: actorId });
    audit("agents.runtime.installed", { actorId, details: { version: installed.version, tested: installed.version?.includes(testedUnslothVersion) ?? false } });
    return installed;
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

  /**
   * The runner's key: a random value in a root-readable file (systemd's LoadCredential hands it over);
   * only its digest is kept. One issue at a time: turning Agents on starts one in the background, and
   * a second caller racing it would otherwise leave the file holding one key and the digest another.
   */
  function ensureRunnerToken({ rotate = false } = {}) {
    const next = (issuing ?? Promise.resolve()).then(() => issueRunnerToken({ rotate }));
    const settled = next.catch(() => null).then(() => { if (issuing === settled) issuing = null; });
    issuing = settled;
    return next;
  }

  async function issueRunnerToken({ rotate }) {
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
    // Background work in quiet hours: the folder the owner named, then meaning search's index.
    if (settings.enabled && !modulePaused(settings) && inQuietHours(at, settings.quietHours)) {
      await syncFolder().catch(() => null);
      queueIndexing();
    }
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
