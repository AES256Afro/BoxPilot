/**
 * The example book (M46), in the web process: the work a person approved - a card staged, a thumbs
 * up, an answer kept as a finding, an evaluation question answered right - kept as the request and
 * the plan the model made for it. The runner chooses the planner's demonstrations from it; the
 * Memory tab shows and prunes it; the owner exports it as training data (examples-export.mjs,
 * acting-export.mjs). Part of the agents service (service.mjs), which hands it what it uses.
 */
import { detectInjection } from "../../packages/harness/src/index.mjs";
import { actingRecords } from "./acting-export.mjs";
import { preferencePairs, toJsonl, trainingRecords } from "./examples-export.mjs";
import { decodeVector, hybridSearch } from "./memory.mjs";
import { seedExamples } from "./templates.mjs";
import { roleAtLeast, toolById } from "./tool-catalog.mjs";

/**
 * @param {{
 *   store: any, limits: Record<string, number>, now: () => Date,
 *   audit: (type: string, entry: object) => void, redact: (text: string) => string,
 *   clip: (text: unknown, max: number) => string,
 *   refuse: (status: number, message: string, code?: string) => never,
 *   personOf: (caller: any) => { id: string, role: string },
 *   agentFor: (caller: any, id: string, options?: { edit?: boolean }) => any,
 *   canEdit: (caller: any, agent: any) => boolean, embedModelName: () => string, houseNamesAll: () => any,
 * }} deps
 */
export function createAgentExamples({ store, limits, now, audit, redact, clip, refuse, personOf, agentFor, canEdit, embedModelName, houseNamesAll }) {
  /**
   * Keep a run as an example once a person approved what it did: the request and the plan the
   * model made for it (the tools it read), with the answer. `signal` says what the approval was: a
   * card staged, a thumbs up, an answer kept as a finding, an evaluation question answered right. A
   * run that read something like an instruction, asked back, or made no plan leaves none. The
   * request is redacted, and one that itself reads like an instruction is not kept: these lines go
   * back into prompts.
   */
  function rememberExample(run, signal) {
    try {
      if (!run || !["ask", "manual", "eval", "schedule"].includes(run.kind) || run.state !== "completed") return null;
      if (run.flags?.injection || run.flags?.clarify) return null;
      const steps = store.listSteps(run.id);
      const plan = steps.find((step) => step.kind === "plan")?.input;
      const tools = [...new Set((Array.isArray(plan) ? plan : []).map((entry) => entry?.tool).filter((tool) => typeof tool === "string"))];
      if (!tools.length) return null;
      // What the planner understood, for an export to carry the model's own answer (M46.3).
      const understood = steps.find((step) => step.kind === "intent" && step.state === "done")?.input ?? null;
      const intent = understood ? { goal: clip(String(understood.goal ?? ""), 300), subject: clip(String(understood.subject ?? ""), 120), constraints: (Array.isArray(understood.constraints) ? understood.constraints : []).slice(0, 5).map((entry) => clip(String(entry), 200)), confidence: typeof understood.confidence === "number" ? understood.confidence : null } : null;
      const spec = store.getVersion(run.agentId, run.version)?.spec ?? store.getAgent(run.agentId, { includeDeleted: true })?.spec;
      const request = clip(redact(String(run.question ?? run.trigger?.title ?? spec?.job ?? "").replace(/\s+/g, " ").trim()), 300);
      if (!request || detectInjection(request).suspected) return null;
      const kept = store.addExample({
        agentId: run.agentId, source: run.id, signal, request, intent,
        // Eight, as a plan holds (M47.2): six cut a seven-read survey short and made a false preference pair (M48.4).
        plan: plan.slice(0, 8).map((entry) => ({ step: clip(String(entry?.step ?? ""), 200), tool: typeof entry?.tool === "string" ? entry.tool : null })),
        answer: run.answer ? clip(redact(String(run.answer)), 600) : null,
        route: run.usage?.route ? "claude" : "local", model: run.usage?.model ?? run.flags?.model ?? null, readRole: run.readRole,
      });
      if (kept?.added) audit("agents.example.kept", { actorId: run.requestedBy, subjectId: run.agentId, details: { runId: run.id, signal, tools } });
      return kept;
    } catch { return null; /* an example is a help, never a reason for a run to fail */ }
  }

  /** A staged card's run, kept as an example. */
  const rememberProposal = (proposal) => { if (proposal?.state === "staged" && proposal.runId) rememberExample(store.getRun(proposal.runId), "card-staged"); };

  /** The examples an agent's template ships with (M46), each with every tool the agent may use when a person asks. */
  function seedAgentExamples(agent) {
    try {
      let added = 0;
      for (const seed of seedExamples(agent.template, agent.spec)) {
        const kept = store.addExample({ agentId: agent.id, source: `seed:${seed.id}`, signal: "seed", request: seed.request, plan: seed.tools.map((tool) => ({ step: `Read ${toolById(tool)?.title ?? tool}`, tool })), readRole: "viewer" });
        if (kept?.added) added += 1;
      }
      return added;
    } catch { return 0; }
  }

  /**
   * The examples the runner chooses the planner's demonstrations from (M46): this agent's, at the
   * run's role, whose every tool the run was offered, each with its vector when the memory index has
   * made one. All of them while there are few; past that, the ones nearest by words and every seed.
   */
  function exampleCandidates(agent, run, offered) {
    const allowed = new Set(offered.map((tool) => tool.id));
    const examples = store.listExamples(agent.id, { limit: 400 }).filter((example) => roleAtLeast(run.readRole, example.readRole) && example.plan.some((entry) => entry.tool) && example.plan.every((entry) => !entry.tool || allowed.has(entry.tool)));
    if (!examples.length) return [];
    const vectors = store.vectorsOf(["example"]);
    const model = embedModelName();
    const candidate = (example) => {
      const stored = vectors.get(`example:${example.id}`);
      const vector = stored && stored.model === model ? decodeVector(stored.vector) : null;
      const tools = [...new Set(example.plan.map((entry) => entry.tool).filter(Boolean))];
      return { key: example.id, text: example.request, tools, label: tools[0] ?? null, ...(vector ? { vector: Array.from(vector, (value) => Math.round(value * 1e4) / 1e4) } : {}) };
    };
    if (examples.length <= limits.examplePool) return examples.map(candidate);
    const query = [run.question, run.trigger?.title].filter(Boolean).join(" ");
    const chosen = new Set(hybridSearch(examples.map((example) => ({ key: example.id, title: "", text: example.request, weight: example.seed ? 1.1 : 1 })), { query, limit: limits.examplePool }).map((item) => item.key));
    for (const example of examples) if (example.seed) chosen.add(example.id);
    return examples.filter((example) => chosen.has(example.id)).slice(0, limits.examplePool * 2).map(candidate);
  }

  /** An example a person may read: one kept from a run that read no more than they may (M48.3, as the planner's pool and memoryOf). */
  const mayReadExample = (person, example) => roleAtLeast(person.role, example.readRole ?? "owner");

  /**
   * The example book as the Memory tab shows it: the owner's and the maker's to read and prune. A
   * maker who is an operator sees only the examples kept from runs that read as an operator or a
   * viewer: an example kept from the owner's own question holds the owner's answer (M48.3; sweep 2's
   * rule for runs, canSeeRun). The run behind an example is the owner's to open.
   */
  function examplesOf(caller, agentId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    if (!canEdit(person, agent)) refuse(403, "An agent's examples are for the owner and the person who made it", "forbidden");
    const vectors = store.vectorKeys(["example"]);
    const counts = store.countExamples(agent.id);
    const visible = store.listExamples(agent.id).filter((example) => mayReadExample(person, example));
    return {
      examples: visible.map((example) => ({
        id: example.id, request: example.request, tools: [...new Set(example.plan.map((entry) => entry.tool).filter(Boolean))], plan: example.plan, answer: example.answer,
        signal: example.signal, seed: example.seed, runId: example.seed || person.role !== "owner" ? null : example.source, route: example.route, readRole: example.readRole, createdAt: example.createdAt, embedded: vectors.has(`example:${example.id}`),
      })),
      // M46.6: how many thumbs down have an approved neighbour with another plan: the pairs an export would carry.
      // M46.7: how many approved runs rebuild as a whole conversation the answer can be learned from.
      counts: person.role === "owner"
        ? { total: Number(counts?.count ?? 0), seeds: Number(counts?.seeds ?? 0), ...trainingCountsOf(agent) }
        : { total: visible.length, seeds: visible.filter((example) => example.seed).length, pairs: 0, acting: 0 },
    };
  }

  /**
   * The book as training data (M46.3): the owner's alone, since it leaves the box. Chat-shaped JSON
   * Lines with this house's names as stand-ins (`examples-export.mjs`); `cover` picks a covering
   * subset of that many, `seeds: false` leaves the template's own examples out.
   */
  /** The book with each example's vector, when the index made one with the model in use. */
  function examplesWithVectors(agentId) {
    const vectors = store.vectorsOf(["example"]);
    const model = embedModelName();
    return store.listExamples(agentId, { limit: 1_000 }).map((example) => {
      const stored = vectors.get(`example:${example.id}`);
      return { ...example, vector: stored && stored.model === model ? decodeVector(stored.vector) : null };
    });
  }

  /**
   * The runs someone gave a thumbs down, as a preference pair's rejected side (M46.6): the request,
   * what the planner understood, the note. Only runs that still exist and were planned.
   */
  function rejectedRuns(agentId) {
    const rejected = [];
    for (const given of store.listFeedback(agentId, { limit: 500 })) {
      if (given.verdict !== "down") continue;
      const run = store.getRun(given.runId);
      if (!run || !["ask", "manual", "eval", "schedule"].includes(run.kind)) continue;
      // The understanding is the intent step's input; the plan it carried is the plan step's (as rememberExample reads them).
      const steps = store.listSteps(run.id);
      const intent = steps.find((step) => step.kind === "intent" && step.state === "done")?.input ?? null;
      const plan = steps.find((step) => step.kind === "plan")?.input;
      const request = clip(redact(String(run.question ?? run.trigger?.title ?? "").replace(/\s+/g, " ").trim()), 300);
      if (!request || !intent || !Array.isArray(plan)) continue;
      rejected.push({ id: run.id, request, understanding: { ...intent, plan }, note: given.note ?? null, vector: null });
    }
    return rejected;
  }

  const pairsFor = (agent) => preferencePairs({ agent: { name: agent.name, spec: agent.spec }, examples: examplesWithVectors(agent.id), rejected: rejectedRuns(agent.id), names: houseNamesAll() });

  /**
   * The approved runs behind the book's examples (M46.7), each with its steps and the spec it ran as,
   * for the acting conversation's records. Seeds have no run.
   */
  function approvedRuns(agentId) {
    const runs = [];
    for (const example of store.listExamples(agentId, { limit: 1_000 })) {
      if (example.seed) continue;
      const run = store.getRun(example.source);
      if (!run) continue;
      runs.push({ run, steps: store.listSteps(run.id), spec: store.getVersion(run.agentId, run.version)?.spec ?? null, signal: example.signal });
    }
    return runs;
  }
  const actingFor = (agent) => actingRecords({ agent: { name: agent.name, spec: agent.spec }, runs: approvedRuns(agent.id), names: houseNamesAll() });
  /**
   * How many preference pairs and acting records an export would carry (M48.5): built in full only
   * when the book or the thumbs changed since last asked, since each build reads every approved run's
   * trace and the Memory tab asks on every open and after every change.
   */
  const trainingCounts = new Map();
  function trainingCountsOf(agent) {
    const stamp = store.trainingStamp(agent.id);
    const cached = trainingCounts.get(agent.id);
    if (cached && cached.stamp === stamp) return cached.counts;
    const counts = { pairs: pairsFor(agent).length, acting: actingFor(agent).length };
    trainingCounts.set(agent.id, { stamp, counts });
    return counts;
  }

  /**
   * @param {any} caller
   * @param {string} agentId
   * @param {{ cover?: unknown, seeds?: boolean | string, pairs?: boolean | string, acting?: boolean | string }} [options] booleans, or the query string's text
   */
  function exportExamples(caller, agentId, { cover = null, seeds = true, pairs = false, acting = false } = {}) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    if (person.role !== "owner") refuse(403, "Only the owner exports examples: they leave this server", "forbidden");
    const slug = String(agent.name).replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "agent";
    const date = now().toISOString().slice(0, 10);
    // M46.7: the acting conversations instead, when asked: each approved run's tool outputs and answer.
    if (acting === true || acting === "true" || acting === "1") {
      const records = actingFor(agent);
      audit("agents.examples.exported", { actorId: person.id, subjectId: agent.id, details: { acting: records.length } });
      return { filename: `boxpilot-acting-${slug}-${date}.jsonl`, records: records.length, jsonl: toJsonl(records) };
    }
    // M46.6: the preference pairs instead, when asked: each thumbs down beside the approved plan it should have had.
    if (pairs === true || pairs === "true" || pairs === "1") {
      const records = pairsFor(agent);
      audit("agents.examples.exported", { actorId: person.id, subjectId: agent.id, details: { pairs: records.length } });
      return { filename: `boxpilot-pairs-${slug}-${date}.jsonl`, records: records.length, jsonl: toJsonl(records) };
    }
    const examples = examplesWithVectors(agent.id);
    const size = Number.isInteger(Number(cover)) && Number(cover) > 0 ? Math.min(Number(cover), 1_000) : null;
    const records = trainingRecords({ agent: { name: agent.name, spec: agent.spec }, examples, names: houseNamesAll(), cover: size, seeds: seeds !== false && seeds !== "false" && seeds !== "0" });
    audit("agents.examples.exported", { actorId: person.id, subjectId: agent.id, details: { records: records.length, cover: size, seeds: records.some((record) => record.meta.seed) } });
    return { filename: `boxpilot-examples-${slug}-${date}.jsonl`, records: records.length, jsonl: toJsonl(records) };
  }

  function forgetExample(caller, agentId, exampleId) {
    const person = personOf(caller);
    const agent = agentFor(person, agentId);
    if (!canEdit(person, agent)) refuse(403, "An agent's examples are for the owner and the person who made it", "forbidden");
    const example = store.getExample(agent.id, exampleId);
    if (!example || !mayReadExample(person, example)) refuse(404, "There is no such example", "example_not_found");
    store.deleteExample(agent.id, example.id);
    audit("agents.example.forgotten", { actorId: person.id, subjectId: agent.id, details: { exampleId: example.id, signal: example.signal } });
    return { deleted: true };
  }

  return { rememberExample, rememberProposal, seedAgentExamples, exampleCandidates, examplesOf, exportExamples, forgetExample };
}
