/**
 * The example book as training data (M46.3, ADR-014). Each example - a request a person approved
 * the plan for - becomes one record in the chat shape a fine-tune reads: the planner's system
 * message as the agent's runs send it, the request as the planner is asked it, and the model's own
 * answer, the understanding JSON the planner returned (its goal, subject, constraints, confidence
 * and plan). A template's seed carries the plan it was written with and a goal in the stand-in
 * model's words, and says so (`meta.seed`), so a recipe can leave the seeds out.
 *
 * Nothing that names the house leaves with it: every text goes through the same stand-ins a run on
 * Claude uses (`createStandIns`: host names, accounts, the domain, private addresses and MAC
 * addresses replaced with values no real house has). Secrets were redacted when the example was
 * kept. `coverExamples` picks a subset that covers the book when a smaller set is wanted.
 *
 * Preference pairs (M46.6): a run someone gave a thumbs down, beside the approved example nearest
 * its request (the same words, or by meaning when both have vectors, else most words shared), when
 * the two plans differ: the example's understanding is the chosen answer, the run's the rejected
 * one, in the shape a preference trainer (DPO, ORPO) reads. A thumbs down whose plan was the same
 * as the approved one makes no pair: the answer was wrong, not the plan, and the planner is what is
 * trained. Nothing is made up for the chosen side: a thumbs down with no approved neighbour waits.
 *
 * The script `scripts/boxpilot-agents-examples.mjs` writes the same records from the database
 * directly, for a server where the API is not at hand; `docs/TRAINING.md` is the recipe.
 */
import { cosineOf, coverExamples, createStandIns, wordOverlap } from "../../packages/harness/src/index.mjs";
import { plannerSystem } from "./intent.mjs";
import { toolById, toolCatalog } from "./tool-catalog.mjs";

/** The tools an agent's spec lets it use when a person asks, as the planner lists them: { fn, title, use }. */
export function plannerToolsOf(spec) {
  return toolCatalog.filter((tool) => ["auto", "ask"].includes(spec?.tools?.[tool.id])).map((tool) => ({ fn: tool.fn, title: tool.title, ...(tool.use ? { use: tool.use } : {}) }));
}

/** The planner's request message, as `plannerMessages` words it, without hints (they are the words' own pointer, not the model's). */
export const plannerUserMessage = (request) => `${String(request ?? "").trim()}\n\nWork out what is asked and plan it. Answer only with the JSON.`;

const fnOf = (tool) => toolById(tool)?.fn ?? String(tool).replace(/\./g, "_");

/** The understanding the model is to learn for an example: its own when a run kept it, else a seed's plain one. */
export function understandingOf(example) {
  const plan = (example.plan ?? []).map((entry) => ({ step: entry.step, tool: entry.tool ? fnOf(entry.tool) : null }));
  if (example.intent) {
    return { goal: example.intent.goal, subject: example.intent.subject ?? "", constraints: example.intent.constraints ?? [], confidence: example.intent.confidence ?? 0.9, clarify: null, plan };
  }
  return { goal: `Answer “${String(example.request).slice(0, 160)}”`, subject: "", constraints: [], confidence: 0.9, clarify: null, plan };
}

/**
 * Training records for one agent's examples. `agent` is { name, spec }, `examples` the book (with
 * vectors where the index made them, as `vector`), `names` the house's names for the stand-ins
 * ({ hosts, domains, users }), `cover` the size of a covering subset, or null for all.
 */
export function trainingRecords({ agent, examples, names = {}, cover = null, seeds = true }) {
  const standIns = createStandIns(names);
  const hide = (text) => standIns.hide(String(text ?? ""));
  const spec = agent.spec ?? {};
  const system = plannerSystemFor(agent, hide);
  let chosen = examples.filter((example) => seeds || !example.seed);
  if (cover && cover > 0 && cover < chosen.length) {
    const picked = new Set(coverExamples({ candidates: chosen.map((example) => ({ key: example.id, text: example.request, vector: example.vector ?? null })), limit: cover }).map((candidate) => candidate.key));
    chosen = chosen.filter((example) => picked.has(example.id));
  }
  return chosen.map((example) => {
    const understanding = understandingOf(example);
    const hidden = { ...understanding, goal: hide(understanding.goal), subject: hide(understanding.subject), constraints: understanding.constraints.map(hide), plan: understanding.plan.map((entry) => ({ ...entry, step: hide(entry.step) })) };
    return {
      messages: [
        { role: "system", content: system },
        { role: "user", content: plannerUserMessage(hide(example.request)) },
        { role: "assistant", content: JSON.stringify(hidden) },
      ],
      meta: {
        agent: hide(spec.name ?? agent.name), signal: example.signal, seed: Boolean(example.seed), tools: understanding.plan.map((entry) => entry.tool).filter(Boolean),
        route: example.route ?? null, model: example.model ?? null, createdAt: example.createdAt ?? null, ...(example.answer ? { answer: hide(example.answer) } : {}),
      },
    };
  });
}

/** The planner's system message for an agent, as its runs send it, with the house's names hidden. */
function plannerSystemFor(agent, hide) {
  const spec = agent.spec ?? {};
  return hide(plannerSystem({ name: spec.name ?? agent.name, purpose: spec.purpose ?? "", job: spec.job ?? "", steps: spec.prompt?.steps ?? [], useFindings: spec.sharing?.useFindings !== false }, plannerToolsOf(spec)));
}

const plainWords = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const toolsOf = (understanding) => understanding.plan.map((entry) => entry.tool).filter(Boolean);

/** The approved example nearest a rejected run's request, and how it was matched, or null. */
export function nearestExample(run, examples, { minOverlap = 0.6, minCosine = 0.85 } = {}) {
  let best = null;
  for (const example of examples) {
    let score = null;
    let by = null;
    if (plainWords(example.request) === plainWords(run.request)) { score = 2; by = "same words"; }
    else {
      const cosine = run.vector && example.vector ? cosineOf(run.vector, example.vector) : null;
      if (cosine !== null && cosine >= minCosine) { score = 1 + cosine; by = `meaning ${cosine.toFixed(2)}`; }
      else {
        const overlap = wordOverlap(run.request, example.request);
        if (cosine === null && overlap >= minOverlap) { score = overlap; by = `words ${overlap.toFixed(2)}`; }
      }
    }
    if (score !== null && (!best || score > best.score)) best = { example, score, by };
  }
  return best;
}

/**
 * Preference pairs for one agent: `rejected` are its thumbed-down runs as { id, request, understanding,
 * note, vector }, `examples` the book (as for trainingRecords). TRL's conversational preference shape:
 * prompt, chosen, rejected, each a list of messages.
 */
export function preferencePairs({ agent, examples, rejected, names = {}, minOverlap = 0.6, minCosine = 0.85 }) {
  const standIns = createStandIns(names);
  const hide = (text) => standIns.hide(String(text ?? ""));
  const system = plannerSystemFor(agent, hide);
  const hidden = (understanding) => ({ ...understanding, goal: hide(understanding.goal), subject: hide(understanding.subject), constraints: understanding.constraints.map(hide), plan: understanding.plan.map((entry) => ({ ...entry, step: hide(entry.step) })) });
  const pairs = [];
  for (const run of rejected) {
    if (!run?.request || !run.understanding || !Array.isArray(run.understanding.plan)) continue;
    const match = nearestExample(run, examples, { minOverlap, minCosine });
    if (!match) continue;
    const chosen = understandingOf(match.example);
    const bad = understandingOf({ request: run.request, plan: run.understanding.plan, intent: run.understanding });
    if (toolsOf(chosen).join(" ") === toolsOf(bad).join(" ")) continue;
    pairs.push({
      prompt: [{ role: "system", content: system }, { role: "user", content: plannerUserMessage(hide(run.request)) }],
      chosen: [{ role: "assistant", content: JSON.stringify(hidden(chosen)) }],
      rejected: [{ role: "assistant", content: JSON.stringify(hidden(bad)) }],
      meta: { agent: hide(agent.spec?.name ?? agent.name), runId: run.id, exampleId: match.example.id, matchedBy: match.by, chosenTools: toolsOf(chosen), rejectedTools: toolsOf(bad), ...(run.note ? { note: hide(run.note) } : {}) },
    });
  }
  return pairs;
}

/** Records as JSON Lines, one a line, ending with a newline. */
export const toJsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
