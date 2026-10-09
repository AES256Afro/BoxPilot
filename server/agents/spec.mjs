/**
 * What an agent is (M37): a spec, stored as a version. Every edit that changes anything makes a
 * new version, so an agent's history can be read, compared and rolled back.
 *
 *   name, purpose        what it is called and what it is for
 *   job                  its one job, in a sentence, and how the owner will know it did it; the
 *   successCriteria      Builder asks for both and warns when the scope reads like "everything"
 *   prompt               the structured system prompt: rules, operational steps, the output format
 *                        (text, or JSON with named fields) and what to escalate
 *   instructions         anything else the owner wants to say, below BoxPilot's own rules (prompt.mjs)
 *   audience             who may ask it: owner, operator, viewer (the IT helper can be borrowed)
 *   knowledge            which sources its search reads: docs, registry, catalog, notes, documents
 *   tools                a permission per catalog tool: auto, ask (only when a person asked) or off
 *   triggers             asked, a schedule, events (a health alert, a failed job, a dropped drive),
 *                        a webhook
 *   budget               runs a day, model seconds a day, steps and tokens a run, seconds a run
 *   outputs              notes, a daily digest, notifications (important only), approval cards, and
 *                        its team chat (M38): findings, logs and knowledge, each to a Zulip channel
 *   memory               notes kept, how long they stay fresh and how many, whether other agents
 *                        may read them, and a conversation per person
 *   sharing              findings (M44): whether what its routine runs and checked answers found
 *                        is kept for the other agents, and whether it reads theirs before it works
 *   escalation           when it hands the matter to the owner as a card: low confidence, a limit
 *                        reached, an action needed, something that looks risky
 *   allow                the apps its tools may look at and the operations it may propose
 *   model                thinking on or off (off by default: on a CPU it costs minutes); which model
 *                        runs it, local or Claude (M45.3), and what may leave the box when Claude does
 *   orchestration        a supervisor that hands subtasks to other agents, and how deep
 *
 * normalizeSpec() is the one gate: anything else is refused with a sentence, never repaired.
 */
import { actLimits, grantLevels } from "./grants.mjs";
import { toolById, toolCatalog, toolPermissions } from "./tool-catalog.mjs";
import { normalizeChatOutputs } from "./zulip.mjs";

export const agentEvents = Object.freeze({
  "health.alert": "A health alert is raised",
  "job.failed": "A BoxPilot job fails",
  "drive.dropped": "A drive drops out or goes read-only",
});

export const scheduleCadences = Object.freeze(["hourly", "every-6-hours", "daily", "weekly"]);
export const knowledgeSources = Object.freeze(["docs", "registry", "catalog", "notes", "documents"]);
export const audiences = Object.freeze(["owner", "operator", "viewer"]);
export const outputFormats = Object.freeze(["text", "json"]);
/** Which model runs an agent: the local one, Claude through the model gateway (M45.3), or the local one moving to Claude when the run needs it (M45.4). */
export const modelRoutes = Object.freeze(["local", "claude", "auto"]);
/** What may leave the box when Claude runs it: names replaced with stand-ins, or the text as it is. Secrets never. */
export const dataPolicies = Object.freeze(["redacted", "as-is"]);
const appIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const operationIdPattern = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const agentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fieldNamePattern = /^[a-z][A-Za-z0-9_]{0,31}$/;

/**
 * Ceilings no agent may raise itself past, whatever its spec says. A run may take 15 minutes by
 * default (the owner's choice after the first real run timed out), and a day's model time defaults
 * to two such runs, so the default day never cuts the default run short.
 */
export const budgetCeilings = Object.freeze({
  runsPerDay: { min: 1, max: 200, default: 12 },
  modelSecondsPerDay: { min: 10, max: 7_200, default: 1_800 },
  stepsPerRun: { min: 1, max: 12, default: 6 },
  tokensPerRun: { min: 500, max: 32_000, default: 12_000 },
  runSeconds: { min: 30, max: 1_800, default: 900 },
});

/** The longest run's default before 15 minutes: an agent saved with it is moved to the new one. */
export const previousRunSecondsDefault = 600;

export class SpecError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = "invalid_agent";
    this.expose = true;
  }
}

const plain = (value, max, what, { required = false, multiline = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (required) throw new SpecError(`Give the agent ${what}`);
    return "";
  }
  if (typeof value !== "string") throw new SpecError(`${what[0].toUpperCase()}${what.slice(1)} must be text`);
  const cleaned = value.replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, multiline ? "" : " ").trim();
  if (required && !cleaned) throw new SpecError(`Give the agent ${what}`);
  if (cleaned.length > max) throw new SpecError(`Keep ${what} under ${max} characters`);
  return cleaned;
};

const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

function integer(value, { min, max, default: fallback }, what) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) throw new SpecError(`${what} must be a whole number from ${min} to ${max}`);
  return number;
}

/** A list of short lines: rules, steps, criteria. Empty lines are dropped; too many are refused. */
function lines(value, { max, chars, what, required = false }) {
  let list = value ?? [];
  if (typeof list === "string") list = list.split("\n");
  if (!Array.isArray(list)) throw new SpecError(`${what[0].toUpperCase()}${what.slice(1)} must be a list`);
  const cleaned = list.map((entry) => plain(entry, chars, `each of its ${what}`)).filter(Boolean);
  if (cleaned.length > max) throw new SpecError(`At most ${max} ${what}`);
  if (required && !cleaned.length) throw new SpecError(`Give the agent at least one of its ${what}`);
  return cleaned;
}

/** "*" (anything a run may otherwise touch) or a list of ids of one shape. */
function allowList(value, pattern, what) {
  if (value === undefined || value === null || value === "*") return "*";
  if (!Array.isArray(value) || value.length > 50 || value.some((entry) => typeof entry !== "string" || !pattern.test(entry))) throw new SpecError(`${what} is "*" or a list of ids`);
  return [...new Set(value)].sort();
}

const section = (value, what) => {
  const raw = value ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new SpecError(what);
  return raw;
};

function normalizeSchedule(raw) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new SpecError("The schedule must say how often and when");
  if (!scheduleCadences.includes(raw.every)) throw new SpecError(`The schedule runs ${scheduleCadences.join(", ")}`);
  const minute = integer(raw.minute, { min: 0, max: 59, default: 0 }, "The schedule's minute");
  const hour = raw.every === "daily" || raw.every === "weekly" ? integer(raw.hour, { min: 0, max: 23, default: 5 }, "The schedule's hour") : null;
  const weekday = raw.every === "weekly" ? integer(raw.weekday, { min: 0, max: 6, default: 1 }, "The schedule's weekday") : null;
  // Heavy work (a digest, learning) waits for quiet hours unless the owner says otherwise.
  return { every: raw.every, minute, hour, weekday, quietHours: bool(raw.quietHours, true) };
}

function normalizePrompt(input) {
  const raw = section(input, "The prompt must be its parts: rules, steps, output and what to escalate");
  const rawOutput = section(raw.output, "The output format must say text or JSON");
  const format = rawOutput.format ?? "text";
  if (!outputFormats.includes(format)) throw new SpecError("The output is text or JSON");
  const rawFields = rawOutput.fields ?? [];
  if (!Array.isArray(rawFields) || rawFields.length > 8) throw new SpecError("A JSON answer has at most 8 fields");
  const fields = rawFields.map((field) => {
    if (!field || typeof field !== "object" || !fieldNamePattern.test(field.name ?? "")) throw new SpecError("Each field needs a name of letters and digits, starting with a small letter");
    return { name: field.name, description: plain(field.description, 200, "a field's description") };
  });
  if (new Set(fields.map((field) => field.name)).size !== fields.length) throw new SpecError("Each field needs its own name");
  if (format === "json" && !fields.length) throw new SpecError("A JSON answer needs at least one field");
  return {
    rules: lines(raw.rules, { max: 12, chars: 300, what: "rules" }),
    steps: lines(raw.steps, { max: 12, chars: 300, what: "steps" }),
    output: { format, fields: format === "json" ? fields : [], style: plain(rawOutput.style, 300, "the output's style") },
    escalate: lines(raw.escalate, { max: 8, chars: 300, what: "things to escalate" }),
  };
}

/**
 * The spec as it is stored, from what the Builder sent. Tools missing from the input are off;
 * unknown tools, events, audiences and sources are refused, so a typo is never a silent default.
 */
export function normalizeSpec(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SpecError("Send the agent as an object");
  const name = plain(input.name, 60, "a name", { required: true });
  const purpose = plain(input.purpose, 300, "a purpose");
  const job = plain(input.job, 200, "one job, in a sentence", { required: true });
  const successCriteria = lines(input.successCriteria, { max: 6, chars: 200, what: "success criteria", required: true });
  const prompt = normalizePrompt(input.prompt);
  const instructions = plain(input.instructions, 8_000, "instructions", { multiline: true });

  const audience = input.audience === undefined ? ["owner", "operator"] : input.audience;
  if (!Array.isArray(audience) || !audience.length || audience.some((role) => !audiences.includes(role))) throw new SpecError(`Who may ask it: some of ${audiences.join(", ")}`);
  if (!audience.includes("owner")) throw new SpecError("The owner can always ask an agent");

  const rawKnowledge = section(input.knowledge, "Knowledge must name its sources");
  for (const key of Object.keys(rawKnowledge)) if (!knowledgeSources.includes(key)) throw new SpecError(`There is no knowledge source called ${key}`);
  const knowledge = Object.fromEntries(knowledgeSources.map((source) => [source, bool(rawKnowledge[source], true)]));

  const rawTools = section(input.tools, "Tools must be a permission for each tool");
  for (const [id, permission] of Object.entries(rawTools)) {
    if (!toolById(id)) throw new SpecError(`There is no tool called ${id}`);
    if (!toolPermissions.includes(permission)) throw new SpecError(`A tool's permission is one of ${toolPermissions.join(", ")}`);
  }
  const tools = Object.fromEntries(toolCatalog.map((tool) => [tool.id, rawTools[tool.id] ?? rawTools[tool.fn] ?? "off"]));

  const rawTriggers = section(input.triggers, "Triggers must say when it runs");
  const events = rawTriggers.events ?? [];
  if (!Array.isArray(events) || events.some((event) => !Object.hasOwn(agentEvents, event))) throw new SpecError(`Events are some of ${Object.keys(agentEvents).join(", ")}`);
  const triggers = { ask: bool(rawTriggers.ask, true), schedule: normalizeSchedule(rawTriggers.schedule), events: [...new Set(events)], webhook: bool(rawTriggers.webhook, false) };

  const rawBudget = section(input.budget, "The budget must be a set of limits");
  const budget = {
    runsPerDay: integer(rawBudget.runsPerDay, budgetCeilings.runsPerDay, "Runs a day"),
    modelSecondsPerDay: integer(rawBudget.modelSecondsPerDay, budgetCeilings.modelSecondsPerDay, "Model seconds a day"),
    stepsPerRun: integer(rawBudget.stepsPerRun, budgetCeilings.stepsPerRun, "Steps a run"),
    tokensPerRun: integer(rawBudget.tokensPerRun, budgetCeilings.tokensPerRun, "Tokens a run"),
    runSeconds: integer(rawBudget.runSeconds, budgetCeilings.runSeconds, "Seconds a run"),
  };

  const rawOutputs = section(input.outputs, "Outputs must say what it may produce");
  const notify = rawOutputs.notify ?? "important";
  if (!["important", "never"].includes(notify)) throw new SpecError("Notifications are important or never");
  // Its team chat (M38): findings, logs and knowledge each on by default, to the connection's channel
  // and a topic named after the agent unless the owner names others. Nothing is posted until Zulip is
  // connected, and then by BoxPilot from the run's outcome, never by the model.
  const chat = normalizeChatOutputs(rawOutputs.chat, (message) => { throw new SpecError(message); });
  const outputs = { notes: bool(rawOutputs.notes, true), digest: bool(rawOutputs.digest, false), notify, proposals: bool(rawOutputs.proposals, true), chat };

  const rawMemory = section(input.memory, "Memory must be a set of choices");
  const memory = {
    enabled: bool(rawMemory.enabled, true),
    freshDays: integer(rawMemory.freshDays, { min: 1, max: 90, default: 14 }, "Days a note stays fresh"),
    maxNotes: integer(rawMemory.maxNotes, { min: 1, max: 200, default: 50 }, "The most notes it keeps"),
    // Other agents read its facts, each only as far as its own runs may read (the writer's role).
    share: bool(rawMemory.share, false),
    // A conversation per person: the last turns word for word, older ones as a running summary.
    threads: bool(rawMemory.threads, true),
    turns: integer(rawMemory.turns, { min: 1, max: 20, default: 6 }, "Turns kept word for word"),
  };

  // Findings (M44): a permission each way, on unless the owner turns it off. Sharing keeps what its
  // routine runs and checked answers found for the other agents; using reads theirs before it works.
  const rawSharing = section(input.sharing, "Sharing must be a set of choices");
  const sharing = { shareFindings: bool(rawSharing.shareFindings, true), useFindings: bool(rawSharing.useFindings, true) };

  const rawEscalation = section(input.escalation, "Escalation must be a set of choices");
  const escalation = {
    lowConfidence: bool(rawEscalation.lowConfidence, true),
    limits: bool(rawEscalation.limits, true),
    actions: bool(rawEscalation.actions, true),
    risk: bool(rawEscalation.risk, true),
  };

  const rawAllow = section(input.allow, "What it may touch must be lists");
  const allow = { apps: allowList(rawAllow.apps, appIdPattern, "The apps it may look at"), operations: allowList(rawAllow.operations, operationIdPattern, "The operations it may propose or carry out") };
  // What it may do itself (M45.5): Ask or Run per operation on its list; Propose, the default, is not kept.
  // The registry's rules for each (grants.mjs) are checked where the agent is saved, which knows the registry.
  const rawGrants = section(rawAllow.grants, "What it may do itself must be a choice for each operation");
  const grants = {};
  for (const [operationId, level] of Object.entries(rawGrants)) {
    if (!operationIdPattern.test(operationId)) throw new SpecError(`${operationId} is not an operation id`);
    if (!grantLevels.includes(level)) throw new SpecError(`What it may do with ${operationId} is one of ${grantLevels.join(", ")}`);
    if (level === "propose") continue;
    if (allow.operations !== "*" && !allow.operations.includes(operationId)) throw new SpecError(`${operationId} is not on its list of operations, so it cannot carry it out`);
    grants[operationId] = level;
  }
  if (Object.keys(grants).length > actLimits.perAgentGrants) throw new SpecError(`At most ${actLimits.perAgentGrants} operations it carries out itself`);
  // Kept only when there are some, so an agent saved before M45.5 reads as it was saved.
  if (Object.keys(grants).length) allow.grants = Object.fromEntries(Object.entries(grants).sort(([a], [b]) => a.localeCompare(b)));
  // The acting tool follows the grants: off with none; with some, on, or only when a person asked if
  // the owner set it so. Taking the grants away is how acting stops.
  for (const id of ["operations.run", "operations.plan"]) tools[id] = !Object.keys(grants).length ? "off" : (rawTools[id] ?? rawTools[id.replace(".", "_")]) === "ask" ? "ask" : "auto";

  const rawModel = section(input.model, "The model's settings must be choices");
  const route = rawModel.route ?? "local";
  if (!modelRoutes.includes(route)) throw new SpecError(`The model is one of ${modelRoutes.join(", ")}`);
  const dataPolicy = rawModel.dataPolicy ?? "redacted";
  if (!dataPolicies.includes(dataPolicy)) throw new SpecError(`What may leave the box is one of ${dataPolicies.join(", ")}`);
  // Claude for a viewer's question only when the owner says so: their words go to Anthropic.
  // The owner's documents (the library, connector imports, Zulip files) go to Claude only when named here.
  const model = { thinking: bool(rawModel.thinking, false), route, dataPolicy, claudeForViewers: bool(rawModel.claudeForViewers, false), claudeReadsDocuments: bool(rawModel.claudeReadsDocuments, false) };

  const rawOrchestration = section(input.orchestration, "Orchestration must be a set of choices");
  const orchestration = {
    supervisor: bool(rawOrchestration.supervisor, false),
    delegates: allowList(rawOrchestration.delegates, agentIdPattern, "The agents it may hand work to"),
    maxDepth: integer(rawOrchestration.maxDepth, { min: 1, max: 3, default: 2 }, "How deep hand-offs may go"),
  };

  // Outputs and tools agree: an agent that may not write notes has notes.write off, and so on.
  if (!outputs.notes || !memory.enabled) tools["notes.write"] = "off";
  if (!memory.enabled) tools["memory.search"] = "off";
  if (!outputs.proposals) tools["plan.propose"] = "off";
  if (outputs.notify === "never") tools["notify.owner"] = "off";
  if (!orchestration.supervisor) tools["agents.handoff"] = "off";
  if (!triggers.ask && !triggers.schedule && !triggers.events.length && !triggers.webhook) throw new SpecError("An agent needs at least one way to start: asked, a schedule, an event or a webhook");
  return { name, purpose, job, successCriteria, prompt, instructions, audience: audiences.filter((role) => audience.includes(role)), knowledge, tools, triggers, budget, outputs, memory, sharing, escalation, allow, model, orchestration };
}

/**
 * What the Builder warns about ("define the scope"): an agent with one specific job does it better
 * on a small model than one asked to do everything. Warnings, never refusals.
 */
export function scopeWarnings(spec) {
  const warnings = [];
  const job = String(spec?.job ?? "");
  if (/\b(everything|anything|whatever|all (?:tasks|things|of it)|any task)\b/i.test(job)) warnings.push("The job reads like \"do everything\". Give it one specific job, and make another agent for the next one.");
  if ((job.match(/\b(and|also|plus)\b/gi) ?? []).length >= 3) warnings.push("The job lists several things. One agent for each keeps a small model on track.");
  const on = Object.values(spec?.tools ?? {}).filter((permission) => permission !== "off").length;
  if (on > 10 && !spec?.orchestration?.supervisor) warnings.push(`It has ${on} tools on. An agent with one job needs a few; each extra tool is one more for a small model to choose between.`);
  if (!(spec?.successCriteria ?? []).length) warnings.push("Say how you will know it did its job: its success criteria are what its evaluation checks.");
  if (spec?.prompt?.output?.format === "json" && spec?.outputs?.digest) warnings.push("A digest is read on Home and Ops; as JSON it will show as fields rather than sentences.");
  return warnings;
}

/** A stable text of a spec, so two versions compare equal when they say the same thing. */
export function specText(spec) {
  const sort = (value) => (Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value);
  return JSON.stringify(sort(spec));
}

/** Lines of two texts marked kept, removed and added: a longest-common-subsequence diff. */
export function lineDiff(before, after, { maxLines = 400 } = {}) {
  const split = (text) => (String(text ?? "") === "" ? [] : String(text).split("\n").slice(0, maxLines));
  const a = split(before);
  const b = split(after);
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: "keep", text: a[i] }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ op: "remove", text: a[i] }); i += 1; }
    else { out.push({ op: "add", text: b[j] }); j += 1; }
  }
  while (i < a.length) out.push({ op: "remove", text: a[i++] });
  while (j < b.length) out.push({ op: "add", text: b[j++] });
  return out;
}

const textList = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * What changed between two versions: one entry per field that differs; the instructions and every
 * list of lines (rules, steps, criteria) as a line diff, everything else as before and after.
 */
export function diffSpecs(before, after) {
  const changes = [];
  const walk = (a, b, path) => {
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) walk(a[key], b[key], [...path, key]);
      return;
    }
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const field = path.join(".");
    if (field === "instructions" || textList(a) || textList(b)) {
      const text = (value) => (textList(value) ? value.join("\n") : value ?? "");
      changes.push({ field, lines: lineDiff(text(a), text(b)) });
    } else {
      changes.push({ field, before: a ?? null, after: b ?? null });
    }
  };
  walk(before ?? {}, after ?? {}, []);
  return changes;
}
