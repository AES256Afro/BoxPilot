/**
 * The brain's first step (M37): intent, then plan, then act. Before any tool is called, a request -
 * a person's words, a schedule, an event, a webhook - is turned into a structured intent and a short
 * plan, as JSON the model must return against a schema (Unsloth answers `json_schema` correctly;
 * the spike checked it). The intent and the plan are shown in the trace, so the owner can see how a
 * messy request was understood; the plan is then handed to the model as its steps, and the tools it
 * names are the ones the calls that act carry.
 *
 * The planner is a small conversation of its own: a system message that is the same for every run
 * of an agent (its job, how it works, the JSON's shape and the tools it may name), then the request.
 * Everything long and unchanging comes first, so the model server reads it once and reuses it.
 *
 * When the request is ambiguous the agent does not guess: it returns a clarifying question, which
 * becomes a card for the person, and the run ends there.
 *
 * Everything the model returns is checked here: only known fields, bounded text, tool names from
 * the tools this run was offered, read as the registry's ids however the model spelled them. A
 * step whose words are only punctuation or a number (a small model under a grammar writes "}," or
 * "2" when it is unsure what a field is for) is named after its tool, or dropped when it has none.
 * A reply that does not parse is not fatal - the run goes on without a plan, and the trace says so.
 */
import { boxLine, sanitizeUntrusted } from "../../packages/harness/src/index.mjs";
import { toolById, toolIdOf } from "./tool-catalog.mjs";

const stepText = { type: "string", minLength: 3, maxLength: 80, description: "What to do, in a few words." };

export const understandingSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["goal", "subject", "constraints", "confidence", "clarify", "plan"],
  properties: {
    goal: { type: "string", minLength: 3, maxLength: 160, description: "What the person or the trigger wants done, in one sentence." },
    subject: { type: "string", maxLength: 60, description: "What it is about: an app, a service, a drive, the server." },
    constraints: { type: "array", maxItems: 3, items: { type: "string", maxLength: 100 }, description: "Limits or conditions stated or implied." },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are that you understood: 0 to 1." },
    clarify: { type: ["string", "null"], maxLength: 200, description: "A question to ask back when the request is ambiguous; otherwise null." },
    plan: {
      type: "array", maxItems: 5,
      items: { type: "object", additionalProperties: false, required: ["step", "tool"], properties: { step: stepText, tool: { type: ["string", "null"] } } },
      description: "The steps, in order; each with the tool it uses, or null for writing the answer.",
    },
  },
});

/** The JSON the model is held to as `response_format`. With `fns`, a step can only name one of them, or null. */
export function understandingFormatFor(fns = []) {
  const schema = fns.length
    ? { ...understandingSchema, properties: { ...understandingSchema.properties, plan: { ...understandingSchema.properties.plan, items: { ...understandingSchema.properties.plan.items, properties: { step: stepText, tool: { enum: [...fns, null] } } } } } }
    : understandingSchema;
  return { type: "json_schema", json_schema: { name: "understanding", strict: true, schema } };
}
export const understandingFormat = Object.freeze(understandingFormatFor());

/**
 * The planner's system message: the same bytes for every run of this agent with these tools, so a
 * model server that keeps its prompt cache reads it once. `agent` is { name, purpose, job, steps };
 * `tools` are { fn, title } as the run was offered them.
 */
export function plannerSystem(agent = {}, tools = []) {
  const example = tools.find((tool) => /^(alerts|server|storage|services)_/.test(tool.fn))?.fn ?? tools[0]?.fn ?? null;
  // Its maker's words, never a chat template's token (2026-10 sweep 4, as systemMessage).
  const own = (text) => sanitizeUntrusted(String(text ?? ""), { maxChars: 20_000 }).text;
  const name = agent.name ? boxLine(agent.name, 80) : "";
  const lines = [
    `You work out what a request to ${name || "an agent"} asks for, before anything is done, and plan it.`,
  ];
  if (agent.purpose) lines.push(`${name || "The agent"}: ${own(agent.purpose)}`);
  if (agent.job) lines.push(`Its job: ${own(agent.job)}`);
  if (agent.steps?.length) lines.push("How it works:", ...agent.steps.map((step, index) => `${index + 1}. ${own(step)}`));
  lines.push(
    "",
    "Answer only with JSON like this:",
    JSON.stringify({ goal: "What is wanted, in one sentence", subject: "What it is about", constraints: [], confidence: 0.8, clarify: null, plan: [...(example ? [{ step: "Read what the answer needs", tool: example }] : []), { step: "Answer with citations", tool: null }] }),
    "goal: what the person or the trigger wants. subject: an app, a service, a drive, the server. constraints: limits stated or implied. confidence: 0 to 1. clarify: one question to ask back if the request is too unclear to act on, else null.",
    "plan: at most five steps in order, each a few words naming the one tool it uses from the list below, or null for writing the answer. Name only the tools the request needs.",
    // M44: what other agents found may already answer it. The same words for every run of the agent.
    ...(agent.useFindings ? ["Plan no tool for what another agent's finding (F1, F2) answers, unless asked for a fresh check or a fix."] : []),
    "",
    "Tools:",
    ...(tools.length ? tools.map((tool) => `- ${tool.fn}: ${tool.title}${tool.use ? `. For: ${tool.use}` : ""}`) : ["- none"]),
  );
  return lines.join("\n");
}

/**
 * The request as the planner reads it: the run's task message, then what to do with it. `hints`
 * are the tools the request's own words point at (toolsForQuestion), as { fn, title }: said after
 * the request, so the system message above stays the same bytes for every run.
 */
export function plannerMessages(agent, tools, task, { hints = [], examples = [] } = {}) {
  const hint = hints.length ? `\n\nTools made for requests worded like this: ${hints.map((tool) => `${tool.fn} (${tool.title})`).join(", ")}.` : "";
  const shown = demonstrationLines(examples, tools);
  return [
    { role: "system", content: plannerSystem(agent, tools) },
    { role: "user", content: `${String(task ?? "").trim()}${hint}${shown ? `\n\n${shown}` : ""}\n\nWork out what is asked and plan it. Answer only with the JSON.` },
  ];
}

/** The heading the demonstrations go under: the stand-in model and the tests read it too. */
export const demonstrationsHeading = "Plans that worked for requests like this one:";

/**
 * Demonstrations for the planner (M46): a few requests a person approved the plan for, each with the
 * tools that plan read, as the model is told them. `examples` are { text, tools } (tools as ids or
 * fns, kept to the ones this run was offered); each request is one line, so nothing in it can
 * pass for an instruction. Nothing when there are none.
 */
export function demonstrationLines(examples = [], tools = []) {
  const offered = new Map(tools.map((tool) => [toolIdOf(tool.fn) ?? tool.fn, tool.fn]));
  const lines = [];
  for (const example of (Array.isArray(examples) ? examples : []).slice(0, 5)) {
    const fns = [...new Set((example?.tools ?? []).map((tool) => offered.get(toolIdOf(String(tool)) ?? tool)).filter(Boolean))];
    const text = boxLine(String(example?.text ?? "").replace(/["“”]/g, "'"), 140);
    if (!text || !fns.length) continue;
    lines.push(`- "${text}" -> ${fns.join(", ")}`);
  }
  return lines.length ? [demonstrationsHeading, ...lines].join("\n") : "";
}

const clip = (value, max) => {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Words a person could read: at least two letters, not a number or punctuation alone. */
const readable = (text) => (text.match(/\p{L}/gu) ?? []).length >= 2;

/**
 * The model's understanding, checked, or `{ problem }`. `offered` are the tools the run was given
 * (ids or fns); a tool outside them is dropped from the intent and the plan, and said to have been.
 * Tools come back as the registry's ids.
 */
export function readUnderstanding(raw, { offered = [] } = {}) {
  let value = raw;
  if (typeof raw === "string") {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    if (text.length > 16 * 1024) return { problem: "The understanding was too long" };
    try { value = JSON.parse(text); } catch { return { problem: "The model's understanding was not JSON" }; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "The model's understanding was not an object" };
  const known = new Set(offered.map(toolIdOf).filter(Boolean));
  const dropped = [];
  const toolName = (name) => {
    if (name === null || name === undefined || name === "" || name === "null") return null;
    const id = toolIdOf(String(name));
    if (!id || !known.has(id)) { dropped.push(clip(name, 40)); return null; }
    return id;
  };
  const goal = clip(value.goal, 300);
  if (!readable(goal)) return { problem: "The understanding had no goal" };
  const confidence = Number(value.confidence);
  const plan = [];
  for (const entry of (Array.isArray(value.plan) ? value.plan : []).slice(0, 6)) {
    const tool = toolName(entry?.tool);
    const words = clip(entry?.step, 200);
    if (readable(words)) plan.push({ step: words, tool });
    else if (tool) plan.push({ step: `Use ${toolById(tool).title}`, tool });
  }
  const tools = [...new Set([...(Array.isArray(value.tools) ? value.tools : []).slice(0, 8).map(toolName), ...plan.map((entry) => entry.tool)].filter(Boolean))];
  const understanding = {
    goal,
    subject: clip(value.subject, 120),
    constraints: (Array.isArray(value.constraints) ? value.constraints : []).slice(0, 5).map((entry) => clip(entry, 200)).filter(readable),
    tools,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, Math.round(confidence * 100) / 100)) : null,
    clarify: typeof value.clarify === "string" && readable(value.clarify) ? clip(value.clarify, 300) : null,
    plan,
  };
  return { understanding, dropped: [...new Set(dropped)] };
}

/**
 * The plan as the model is then told it: its own steps, numbered, each tool as the model calls it.
 * `hinted` are tools the request's words point at that the plan left out (toolsForQuestion): named
 * after it, so the model has them in mind when it acts.
 */
export function planMessage(understanding, { hinted = [] } = {}) {
  const fn = (id) => toolById(id)?.fn ?? id;
  const steps = understanding.plan.map((entry, index) => `${index + 1}. ${entry.step}${entry.tool ? ` (${fn(entry.tool)})` : ""}`);
  const missing = hinted.filter((id) => !understanding.plan.some((entry) => entry.tool === id));
  return [
    "Your plan:", ...(steps.length ? steps : ["1. Answer from what you can read."]),
    ...(missing.length ? ["", `The request's words fit ${missing.map((id) => `${fn(id)} (${toolById(id)?.title ?? id})`).join(" and ")} too: use ${missing.length === 1 ? "it" : "them"} if the plan's tools do not answer it directly.`] : []),
    "", "Carry it out with the tools, then answer. Change the plan if a tool's output says you should.",
  ].join("\n");
}

/** A line for the trace and the audit: what was understood, without the person's words. */
export function understandingSummary(understanding) {
  return `${understanding.goal}${understanding.subject ? ` (about ${understanding.subject})` : ""}${understanding.confidence !== null ? `, confidence ${understanding.confidence}` : ""}`;
}
