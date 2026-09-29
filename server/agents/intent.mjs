/**
 * The brain's first step (M37): intent, then plan, then act. Before any tool is called, a request -
 * a person's words, a schedule, an event, a webhook - is turned into a structured intent and a short
 * plan, as JSON the model must return against a schema (Unsloth answers `json_schema` correctly;
 * the spike checked it). The intent and the plan are shown in the trace, so the owner can see how a
 * messy request was understood; the plan is then handed to the model as its steps.
 *
 * When the request is ambiguous the agent does not guess: it returns a clarifying question, which
 * becomes a card for the person, and the run ends there.
 *
 * Everything the model returns is checked here: only known fields, bounded text, tool names from
 * the tools this run was offered. A reply that does not parse is not fatal - the run goes on
 * without a plan, and the trace says so.
 */

export const understandingSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["goal", "subject", "constraints", "tools", "confidence", "clarify", "plan"],
  properties: {
    goal: { type: "string", description: "What the person or the trigger wants done, in one sentence." },
    subject: { type: "string", description: "What it is about: an app, a service, a drive, the server." },
    constraints: { type: "array", maxItems: 5, items: { type: "string" }, description: "Limits or conditions stated or implied." },
    tools: { type: "array", maxItems: 6, items: { type: "string" }, description: "The tool names needed, from the list given." },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are that you understood: 0 to 1." },
    clarify: { type: ["string", "null"], description: "A question to ask back when the request is ambiguous; otherwise null." },
    plan: {
      type: "array", maxItems: 6,
      items: { type: "object", additionalProperties: false, required: ["step", "tool"], properties: { step: { type: "string" }, tool: { type: ["string", "null"] } } },
      description: "The steps, in order; each with the tool it uses, or null for writing the answer.",
    },
  },
});

/** What the model is sent as `response_format`: its answer must be the schema's JSON. */
export const understandingFormat = Object.freeze({ type: "json_schema", json_schema: { name: "understanding", strict: true, schema: understandingSchema } });

/** The request to understand, with the tools this run may use, named as the model calls them. */
export function understandingMessage(tools) {
  const list = tools.map((tool) => `- ${tool.fn}: ${tool.title}`).join("\n");
  return [
    "Before you do anything, work out what is being asked. Answer only with JSON:",
    "goal, subject, constraints, the tools you will need (from the list below), your confidence from 0 to 1,",
    "a clarifying question in clarify if the request is too ambiguous to act on (otherwise null),",
    "and a plan of at most six steps, each naming its tool or null.",
    "",
    "Tools you may use:",
    list || "- none",
  ].join("\n");
}

const clip = (value, max) => {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * The model's understanding, checked, or `{ problem }`. `offered` are the fns (or ids) the run was
 * given; a tool outside them is dropped from the intent and the plan, and said to have been.
 */
export function readUnderstanding(raw, { offered = [] } = {}) {
  let value = raw;
  if (typeof raw === "string") {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    if (text.length > 16 * 1024) return { problem: "The understanding was too long" };
    try { value = JSON.parse(text); } catch { return { problem: "The model's understanding was not JSON" }; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "The model's understanding was not an object" };
  const known = new Map(offered.flatMap((name) => [[name, name], [name.replace(/\./g, "_"), name.replace(/\./g, "_")], [name.replace(/_/g, "."), name.replace(/\./g, "_")]]));
  const dropped = [];
  const toolName = (name) => {
    if (name === null || name === undefined || name === "") return null;
    const found = known.get(String(name));
    if (!found) { dropped.push(clip(name, 40)); return null; }
    return found;
  };
  const goal = clip(value.goal, 300);
  if (!goal) return { problem: "The understanding had no goal" };
  const confidence = Number(value.confidence);
  const understanding = {
    goal,
    subject: clip(value.subject, 120),
    constraints: (Array.isArray(value.constraints) ? value.constraints : []).slice(0, 5).map((entry) => clip(entry, 200)).filter(Boolean),
    tools: [...new Set((Array.isArray(value.tools) ? value.tools : []).slice(0, 8).map(toolName).filter(Boolean))],
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, Math.round(confidence * 100) / 100)) : null,
    clarify: typeof value.clarify === "string" && value.clarify.trim() ? clip(value.clarify, 300) : null,
    plan: (Array.isArray(value.plan) ? value.plan : []).slice(0, 6).map((entry) => ({ step: clip(entry?.step, 200), tool: toolName(entry?.tool) })).filter((entry) => entry.step),
  };
  return { understanding, dropped: [...new Set(dropped)] };
}

/** The plan as the model is then told it: its own steps, numbered. */
export function planMessage(understanding) {
  const steps = understanding.plan.map((entry, index) => `${index + 1}. ${entry.step}${entry.tool ? ` (${entry.tool})` : ""}`);
  return ["Your plan:", ...(steps.length ? steps : ["1. Answer from what you can read."]), "", "Carry it out with the tools, then answer. Change the plan if a tool's output says you should."].join("\n");
}

/** A line for the trace and the audit: what was understood, without the person's words. */
export function understandingSummary(understanding) {
  return `${understanding.goal}${understanding.subject ? ` (about ${understanding.subject})` : ""}${understanding.confidence !== null ? `, confidence ${understanding.confidence}` : ""}`;
}
