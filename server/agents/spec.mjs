/**
 * What an agent is (M37): a spec, stored as a version. Every edit that changes anything makes a
 * new version, so an agent's history can be read, compared and rolled back.
 *
 *   name, purpose        what it is called and what it is for
 *   instructions         the owner's words to it, below BoxPilot's own rules (prompt.mjs)
 *   audience             who may ask it: owner, operator, viewer (the IT helper can be borrowed)
 *   knowledge            which sources its search reads: docs, registry, catalog, notes, documents
 *   tools                a permission per catalog tool: auto, ask (only when a person asked) or off
 *   triggers             on ask, on a schedule, on events (a health alert, a failed job, a dropped drive)
 *   budget               runs a day, model seconds a day, steps and tokens a run, seconds a run
 *   outputs              notes, a daily digest, notifications (important only), approval cards
 *   memory               whether it keeps notes, how long they stay fresh, how many
 *
 * normalizeSpec() is the one gate: anything else is refused with a sentence, never repaired.
 */
import { toolById, toolCatalog, toolPermissions } from "./tool-catalog.mjs";

export const agentEvents = Object.freeze({
  "health.alert": "A health alert is raised",
  "job.failed": "A BoxPilot job fails",
  "drive.dropped": "A drive drops out or goes read-only",
});

export const scheduleCadences = Object.freeze(["hourly", "every-6-hours", "daily", "weekly"]);
export const knowledgeSources = Object.freeze(["docs", "registry", "catalog", "notes", "documents"]);
export const audiences = Object.freeze(["owner", "operator", "viewer"]);

/** Ceilings no agent may raise itself past, whatever its spec says. */
export const budgetCeilings = Object.freeze({
  runsPerDay: { min: 1, max: 200, default: 12 },
  modelSecondsPerDay: { min: 10, max: 7_200, default: 900 },
  stepsPerRun: { min: 1, max: 12, default: 6 },
  tokensPerRun: { min: 500, max: 32_000, default: 12_000 },
  runSeconds: { min: 30, max: 1_800, default: 600 },
});

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

/**
 * The spec as it is stored, from what the Builder sent. Tools missing from the input are off;
 * unknown tools, events, audiences and sources are refused, so a typo is never a silent default.
 */
export function normalizeSpec(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SpecError("Send the agent as an object");
  const name = plain(input.name, 60, "a name", { required: true });
  const purpose = plain(input.purpose, 300, "a purpose");
  const instructions = plain(input.instructions, 8_000, "instructions", { multiline: true });

  const audience = input.audience === undefined ? ["owner", "operator"] : input.audience;
  if (!Array.isArray(audience) || !audience.length || audience.some((role) => !audiences.includes(role))) throw new SpecError(`Who may ask it: some of ${audiences.join(", ")}`);
  if (!audience.includes("owner")) throw new SpecError("The owner can always ask an agent");

  const rawKnowledge = input.knowledge ?? {};
  if (typeof rawKnowledge !== "object" || Array.isArray(rawKnowledge)) throw new SpecError("Knowledge must name its sources");
  for (const key of Object.keys(rawKnowledge)) if (!knowledgeSources.includes(key)) throw new SpecError(`There is no knowledge source called ${key}`);
  const knowledge = Object.fromEntries(knowledgeSources.map((source) => [source, bool(rawKnowledge[source], true)]));

  const rawTools = input.tools ?? {};
  if (typeof rawTools !== "object" || Array.isArray(rawTools)) throw new SpecError("Tools must be a permission for each tool");
  for (const [id, permission] of Object.entries(rawTools)) {
    if (!toolById(id)) throw new SpecError(`There is no tool called ${id}`);
    if (!toolPermissions.includes(permission)) throw new SpecError(`A tool's permission is one of ${toolPermissions.join(", ")}`);
  }
  const tools = Object.fromEntries(toolCatalog.map((tool) => [tool.id, rawTools[tool.id] ?? rawTools[tool.fn] ?? "off"]));

  const rawTriggers = input.triggers ?? {};
  if (typeof rawTriggers !== "object" || Array.isArray(rawTriggers)) throw new SpecError("Triggers must say when it runs");
  const events = rawTriggers.events ?? [];
  if (!Array.isArray(events) || events.some((event) => !Object.hasOwn(agentEvents, event))) throw new SpecError(`Events are some of ${Object.keys(agentEvents).join(", ")}`);
  const triggers = { ask: bool(rawTriggers.ask, true), schedule: normalizeSchedule(rawTriggers.schedule), events: [...new Set(events)] };

  const rawBudget = input.budget ?? {};
  if (typeof rawBudget !== "object" || Array.isArray(rawBudget)) throw new SpecError("The budget must be a set of limits");
  const budget = {
    runsPerDay: integer(rawBudget.runsPerDay, budgetCeilings.runsPerDay, "Runs a day"),
    modelSecondsPerDay: integer(rawBudget.modelSecondsPerDay, budgetCeilings.modelSecondsPerDay, "Model seconds a day"),
    stepsPerRun: integer(rawBudget.stepsPerRun, budgetCeilings.stepsPerRun, "Steps a run"),
    tokensPerRun: integer(rawBudget.tokensPerRun, budgetCeilings.tokensPerRun, "Tokens a run"),
    runSeconds: integer(rawBudget.runSeconds, budgetCeilings.runSeconds, "Seconds a run"),
  };

  const rawOutputs = input.outputs ?? {};
  if (typeof rawOutputs !== "object" || Array.isArray(rawOutputs)) throw new SpecError("Outputs must say what it may produce");
  const notify = rawOutputs.notify ?? "important";
  if (!["important", "never"].includes(notify)) throw new SpecError("Notifications are important or never");
  const outputs = { notes: bool(rawOutputs.notes, true), digest: bool(rawOutputs.digest, false), notify, proposals: bool(rawOutputs.proposals, true) };

  const rawMemory = input.memory ?? {};
  if (typeof rawMemory !== "object" || Array.isArray(rawMemory)) throw new SpecError("Memory must be a set of choices");
  const memory = {
    enabled: bool(rawMemory.enabled, true),
    freshDays: integer(rawMemory.freshDays, { min: 1, max: 90, default: 14 }, "Days a note stays fresh"),
    maxNotes: integer(rawMemory.maxNotes, { min: 1, max: 200, default: 50 }, "The most notes it keeps"),
  };

  // Outputs and tools agree: an agent that may not write notes has notes.write off, and so on.
  if (!outputs.notes || !memory.enabled) tools["notes.write"] = "off";
  if (!outputs.proposals) tools["plan.propose"] = "off";
  if (outputs.notify === "never") tools["notify.owner"] = "off";
  if (!triggers.ask && !triggers.schedule && !triggers.events.length) throw new SpecError("An agent needs at least one way to start: asked, a schedule, or an event");
  return { name, purpose, instructions, audience: audiences.filter((role) => audience.includes(role)), knowledge, tools, triggers, budget, outputs, memory };
}

/** A stable text of a spec, so two versions compare equal when they say the same thing. */
export function specText(spec) {
  const sort = (value) => (Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value);
  return JSON.stringify(sort(spec));
}

/** Lines of two texts marked kept, removed and added: a longest-common-subsequence diff. */
export function lineDiff(before, after, { maxLines = 400 } = {}) {
  const a = String(before ?? "").split("\n").slice(0, maxLines);
  const b = String(after ?? "").split("\n").slice(0, maxLines);
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

/**
 * What changed between two versions: one entry per field that differs, the instructions as a line
 * diff, everything else as its value before and after.
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
    changes.push(field === "instructions" ? { field, lines: lineDiff(a, b) } : { field, before: a ?? null, after: b ?? null });
  };
  walk(before ?? {}, after ?? {}, []);
  return changes;
}
