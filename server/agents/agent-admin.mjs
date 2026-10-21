/**
 * Agents as the people who make them see them, in the web process: made, edited, rolled back and
 * deleted, with the grants each version holds; feedback on a run; export and import; and the
 * webhook another system (n8n, for one) starts an agent with. Part of the agents service
 * (service.mjs), which hands it what it uses.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { nextScheduledRun } from "./budget.mjs";
import { grantProblem, grantsOf } from "./grants.mjs";
import { nameKey, reservedNameProblem } from "./orchestrator.mjs";
import { exportDefinition, readDefinition } from "./portable.mjs";
import { SpecError, diffSpecs, normalizeSpec, specText } from "./spec.mjs";
import { digestToken, finishedStates } from "./store.mjs";
import { templateById, templateQuestions } from "./templates.mjs";

/**
 * @param {{
 *   store: any, registry: any, cloud: any, limits: Record<string, number>, now: () => Date,
 *   audit: (type: string, entry: object) => void, redact: (text: string) => string,
 *   clip: (text: unknown, max: number) => string,
 *   refuse: (status: number, message: string, code?: string) => never,
 *   productVersion: string | null, AgentError: typeof import("./service.mjs").AgentError,
 *   personOf: (caller: any) => { id: string, role: string },
 *   agentFor: (caller: any, id: string, options?: { edit?: boolean }) => any,
 *   canEdit: (caller: any, agent: any) => boolean,
 *   canSeeRun: (caller: any, run: any, agent?: any) => boolean,
 *   ownActor: (caller: any, id: string | null) => string | null,
 *   presentAgent: (caller: any, agent: any, options?: { detail?: boolean, module?: any }) => any,
 *   runEnded: (run: any, options?: { tree?: boolean }) => void,
 *   enqueueSystem: (agent: any, kind: string, trigger?: object) => any,
 *   sharingFor: (agent: any, spec?: any) => any, seedAgentExamples: (agent: any) => void,
 *   normalizeQuestions: (input: any) => any[], rememberExample: (run: any, signal: string) => any,
 * }} deps
 */
export function createAgentAdmin({ store, registry, cloud, limits, now, audit, redact, clip, refuse, productVersion, AgentError, personOf, agentFor, canEdit, canSeeRun, ownActor, presentAgent, runEnded, enqueueSystem, sharingFor, seedAgentExamples, normalizeQuestions, rememberExample }) {
  function createAgent(caller, { template = null, spec = null } = {}) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Only the owner and operators make agents", "forbidden");
    const base = template ? templateById(template) : null;
    if (template && !base) refuse(400, `There is no template called ${template}`, "invalid_agent");
    if (store.listAgents().length >= 30) refuse(409, "Thirty agents is the most BoxPilot keeps. Delete one first.", "agent_limit");
    // A new agent moves to Claude when a run needs it, once Claude is connected (M45.4): one made from
    // a template, or from a definition that names no model. The templates name none of their own.
    const given = spec ?? base?.spec ?? {};
    const routed = !spec?.model?.route && cloud?.settings().connected ? { ...given, model: { ...(given.model ?? {}), route: "auto" } } : given;
    const normalized = wrapSpecError(() => normalizeSpec(routed));
    checkGrants(person, normalized, null);
    refuseReservedName(normalized.name);
    const agent = store.createAgent({ spec: normalized, template: base?.id ?? null, createdBy: person.id, nextRunAt: nextRunFor(normalized) });
    if (base && templateQuestions[base.id]?.length) store.setQuestions(agent.id, templateQuestions[base.id], { updatedBy: person.id });
    if (base) seedAgentExamples(agent);
    audit("agents.created", { actorId: person.id, subjectId: agent.id, details: { template: base?.id ?? null, name: normalized.name } });
    return presentAgent(person, agent, { detail: true });
  }

  /**
   * @param {any} caller
   * @param {string} agentId
   * @param {{ spec?: any, note?: string | null }} [body]
   */
  function updateAgent(caller, agentId, { spec, note = null } = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    const normalized = wrapSpecError(() => normalizeSpec(spec));
    if (specText(normalized) === specText(agent.spec)) return { ...presentAgent(person, agent, { detail: true }), unchanged: true };
    checkGrants(person, normalized, agent.spec);
    refuseReservedName(normalized.name, agent.spec.name);
    const version = store.addVersion(agent.id, { spec: normalized, note: typeof note === "string" ? clip(note.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), 200) || null : null, createdBy: person.id, nextRunAt: nextRunFor(normalized) });
    audit("agents.updated", { actorId: person.id, subjectId: agent.id, details: { version, fields: diffSpecs(agent.spec, normalized).map((change) => change.field) } });
    forgetFindingsIfUnshared(agent, normalized);
    return presentAgent(person, store.getAgent(agent.id), { detail: true });
  }

  /**
   * Grants (M45.5): each held to the registry's rules, and raised only by the owner. A grant lets the
   * agent change the server in its maker's name without them, so it is the owner's to give; anyone
   * who may edit the agent may take one away or lower it.
   */
  function checkGrants(person, next, previous) {
    const grants = grantsOf(next);
    for (const [operationId, level] of Object.entries(grants)) {
      const problem = grantProblem(registry.get(operationId), level);
      if (problem) refuse(400, `${operationId}: ${problem}`, "invalid_agent");
    }
    const before = grantsOf(previous);
    const rank = { propose: 0, ask: 1, run: 2 };
    const raised = Object.entries(grants).some(([operationId, level]) => rank[level] > rank[before[operationId] ?? "propose"]);
    if (raised && person.role !== "owner") refuse(403, "Only the owner gives an agent leave to carry out operations", "forbidden");
  }

  /** Sharing turned off (M44): what it shared is forgotten, so nobody reads it after the owner said no. */
  function forgetFindingsIfUnshared(agent, spec) {
    if (sharingFor(agent).shareFindings && !sharingFor(agent, spec).shareFindings) store.deleteFindings(agent.id);
  }

  /**
   * @param {any} caller
   * @param {string} agentId
   * @param {{ version?: number | string }} [body]
   */
  function rollbackAgent(caller, agentId, { version } = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    const target = store.getVersion(agent.id, Number(version));
    if (!target) refuse(404, "That version does not exist", "version_not_found");
    if (target.version === agent.version) refuse(409, "That is already the current version", "version_current");
    checkGrants(person, target.spec, agent.spec);
    refuseReservedName(target.spec.name, agent.spec.name);
    const next = store.addVersion(agent.id, { spec: target.spec, note: `Rolled back to version ${target.version}`, createdBy: person.id, nextRunAt: nextRunFor(target.spec) });
    audit("agents.rolled-back", { actorId: person.id, subjectId: agent.id, details: { to: target.version, version: next } });
    forgetFindingsIfUnshared(agent, target.spec);
    return presentAgent(person, store.getAgent(agent.id), { detail: true });
  }

  function deleteAgent(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    for (const run of store.activeRuns().filter((entry) => entry.agentId === agent.id)) runEnded(store.finishRun(run.id, { state: run.state === "running" ? "killed" : "cancelled", reason: "The agent was deleted" }));
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
  /** A greeting or BoxPilot's own name, given as an agent's new name: refused (sweep 5). One it already had is kept. */
  const refuseReservedName = (name, before = null) => {
    const problem = before !== null && nameKey(name) === nameKey(before) ? null : reservedNameProblem(name);
    if (problem) refuse(400, problem, "reserved_name");
  };
  const nextRunFor = (spec) => nextScheduledRun(spec.triggers?.schedule, now())?.toISOString() ?? null;

  // ---- feedback on a run ----

  /** "Was this right?": thumbs up or down on a run, by whoever may see it; it feeds the evaluation. */
  /**
   * "Was this right?" A verdict counts toward the agent's accuracy by version and model. A "wrong"
   * with `expect` - words the right answer contains - also makes the question one of the agent's
   * own golden questions (M40), for whoever may change the agent: every evaluation asks it again.
   */
  /**
   * @param {any} caller
   * @param {string} runId
   * @param {{ verdict?: string, note?: string | null, expect?: any }} [body]
   */
  function giveFeedback(caller, runId, { verdict, note = null, expect = null } = {}) {
    const person = personOf(caller);
    const run = store.getRun(runId);
    if (!run || ["index", "describe"].includes(run.kind) || !canSeeRun(person, run)) refuse(404, "There is no run with that id", "run_not_found");
    if (!finishedStates.has(run.state)) refuse(409, "Say whether it was right once it has answered", "run_running");
    if (!["up", "down"].includes(verdict)) refuse(400, "Feedback is up or down", "invalid_feedback");
    const cleanNote = typeof note === "string" && note.trim() ? redact(clip(note.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), 300)) : null;
    const words = Array.isArray(expect) ? expect.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => redact(entry.replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, 80)).slice(0, 5) : [];
    let added = null;
    if (words.length) {
      if (verdict !== "down") refuse(400, "Only a wrong answer becomes a golden question", "invalid_feedback");
      const agent = store.getAgent(run.agentId);
      if (!agent || !canEdit(person, agent)) refuse(403, "Only whoever may change this agent adds to its evaluation", "forbidden");
      const question = String(run.question ?? "").trim();
      if (!question || run.kind === "eval") refuse(400, "Only a question someone asked becomes a golden question", "invalid_feedback");
      const current = store.getQuestions(agent.id) ?? templateQuestions[agent.template] ?? [];
      const same = current.find((entry) => entry.question.toLowerCase() === question.slice(0, 300).toLowerCase());
      const kept = same ? current.map((entry) => (entry === same ? { ...entry, expect: { includes: words } } : entry)) : [...current, { id: `q${Date.now().toString(36)}`, question: question.slice(0, 300), expect: { includes: words } }];
      const normalized = normalizeQuestions(kept);
      store.setQuestions(agent.id, normalized, { updatedBy: person.id });
      added = { questionId: normalized.find((entry) => entry.question.toLowerCase() === question.slice(0, 300).toLowerCase())?.id ?? null };
      audit("agents.evaluation.changed", { actorId: person.id, subjectId: agent.id, details: { questions: normalized.length, fromFeedback: run.id } });
    }
    const given = store.setFeedback(run.id, { agentId: run.agentId, version: run.version, model: run.flags?.model ?? null, verdict, note: cleanNote, givenBy: person.id });
    audit("agents.feedback", { actorId: person.id, subjectId: run.id, details: { agentId: run.agentId, version: run.version, verdict } });
    // A thumbs up keeps the run as an example (M46); a thumbs down takes one back.
    if (verdict === "up") rememberExample(run, "thumbs-up");
    else store.deleteExampleOfRun(run.agentId, run.id);
    return { verdict: given.verdict, note: given.note, mine: true, ...(added ? { addedToEvaluation: added } : {}) };
  }

  // ---- export and import ----

  function exportAgent(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId, { edit: true });
    audit("agents.exported", { actorId: person.id, subjectId: agent.id });
    return exportDefinition(agent, { questions: store.getQuestions(agent.id) ?? templateQuestions[agent.template] ?? [], productVersion, now: now() });
  }

  /**
   * @param {any} caller
   * @param {{ definition?: any }} [body]
   */
  function importAgent(caller, { definition } = {}) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Only the owner and operators make agents", "forbidden");
    let read;
    try { read = readDefinition(definition); } catch (error) { refuse(error.status ?? 400, error.message, error.code ?? "invalid_definition"); }
    if (store.listAgents().length >= 30) refuse(409, "Thirty agents is the most BoxPilot keeps. Delete one first.", "agent_limit");
    refuseReservedName(read.spec.name);
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

  return { createAgent, updateAgent, rollbackAgent, deleteAgent, versionDetail, nextRunFor, giveFeedback, exportAgent, importAgent, mintAgentWebhook, clearAgentWebhook, fireAgentWebhook };
}
