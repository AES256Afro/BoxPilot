/**
 * A suggested fix, as the assistant may offer it (M34.2): a list of registered operations, each
 * checked here against the registry and against the person asking. Nothing is staged or run. A
 * step that survives carries the request that would stage it (or run it, for a read) through the
 * ordinary job path, where it is approved at its own tier like any other.
 */
import { secretPaths, validateParameters } from "../ops/registry.mjs";

export const maxPlanSteps = 8;

const approvalByTier = {
  low: "One click",
  medium: "One confirmation, with a preview",
  high: "The owner's password and a typed confirmation",
};

export const planFence = /```[ \t]*plan(?![a-z])[ \t]*\n?/i;
const jsonFence = /```[ \t]*json[ \t]*\n([\s\S]*?)(?:```|$)/gi;

/**
 * The answer with any plan block taken out, and the block's steps as written. The block is the
 * last thing the model writes, so a block the model was cut off in the middle of is kept as far as
 * it goes and reported as unreadable rather than guessed at.
 */
export function extractPlan(text) {
  const source = String(text ?? "");
  const start = source.search(planFence);
  if (start >= 0) {
    const after = source.slice(start).replace(planFence, "");
    const end = after.indexOf("```");
    const raw = (end >= 0 ? after.slice(0, end) : after).trim();
    const rest = end >= 0 ? after.slice(end + 3) : "";
    return { answer: `${source.slice(0, start)}${rest}`.trim(), ...parseSteps(raw, end < 0) };
  }
  // Small models sometimes label the block json instead of plan; accept it only when it is plainly a plan.
  for (const match of source.matchAll(jsonFence)) {
    const parsed = parseSteps(match[1].trim(), false);
    if (parsed.steps?.some((step) => step && typeof step === "object" && "operationId" in step)) {
      return { answer: `${source.slice(0, match.index)}${source.slice(match.index + match[0].length)}`.trim(), ...parsed };
    }
  }
  return { answer: source.trim(), steps: null, problem: null };
}

function parseSteps(raw, cutOff) {
  if (!raw) return { steps: [], problem: null };
  try {
    const parsed = JSON.parse(raw);
    const steps = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.steps) ? parsed.steps : null;
    return steps ? { steps, problem: null } : { steps: [], problem: "The plan was not a list of steps" };
  } catch {
    return { steps: [], problem: cutOff ? "The plan was cut off before it ended" : "The plan could not be read" };
  }
}

/** Why this role may not take this step, or null when it may. Mirrors jobs.mjs and the operations router. */
export function refusalFor(operation, role) {
  if (!["owner", "operator"].includes(role)) return "Viewers can look but not change anything";
  if (operation.elevatedOnly) return "It reveals secrets, so it is not suggested";
  if (operation.readOnly) {
    if (operation.minimumRole === "owner" && role !== "owner") return "Only the owner can run this read";
    return null;
  }
  if (operation.risk === "high" && role !== "owner") return "Only the owner can approve high-risk operations";
  if (operation.minimumRole === "owner" && role !== "owner") return "Only the owner can approve this operation";
  return null;
}

const plainText = (value, max) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

/**
 * Check each step as written: the operation exists, its parameters pass the registry's own check,
 * the person asking could approve it, and it carries no secret (the assistant never handles one).
 * Steps that pass keep their order; the rest are dropped, each with the reason.
 */
export async function validatePlan(rawSteps, { registry, role, secretEnvNamesFor = null } = {}) {
  const steps = [];
  const dropped = [];
  const seen = new Map();
  const list = Array.isArray(rawSteps) ? rawSteps : [];
  for (const [index, raw] of list.entries()) {
    const operationId = typeof raw?.operationId === "string" ? raw.operationId.slice(0, 120) : null;
    const drop = (reason) => dropped.push({ index, operationId, reason });
    if (index >= maxPlanSteps) { drop(`A plan has at most ${maxPlanSteps} steps`); continue; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { drop("This step is not an operation"); continue; }
    if (!operationId) { drop("This step names no operation"); continue; }
    const operation = registry.get(operationId);
    if (!operation) { drop(`BoxPilot has no operation called ${operationId}`); continue; }
    if (operation.internal) { drop(`${operation.title} is BoxPilot's own plumbing: BoxPilot runs it itself, and it is never proposed`); continue; }
    const parameters = raw.parameters === undefined || raw.parameters === null ? {} : raw.parameters;
    if (typeof parameters !== "object" || Array.isArray(parameters)) { drop("Its parameters are not a set of named values"); continue; }
    const refusal = refusalFor(operation, role);
    if (refusal) { drop(refusal); continue; }
    const problem = validateParameters(operation.parameters, parameters, operation.title);
    if (problem) { drop(problem); continue; }
    if ((await secretPaths(operation, parameters, { secretEnvNamesFor })).length) { drop("It carries a secret, which the assistant never handles; start it from its own page"); continue; }
    const key = `${operationId}\u0000${JSON.stringify(parameters)}`;
    if (seen.has(key)) { drop(`It repeats step ${seen.get(key) + 1}`); continue; }
    seen.set(key, steps.length);
    const risk = operation.readOnly ? "low" : operation.risk;
    steps.push({
      operationId,
      title: operation.title,
      risk,
      readOnly: operation.readOnly,
      approval: operation.readOnly ? "Runs at once; it only reads" : approvalByTier[risk],
      typedConfirmation: typeof operation.confirm === "function",
      parameters,
      why: plainText(raw.why, 300),
      // What the page sends to take this step: a read runs directly, anything else is staged as a
      // job and waits for approval at its tier. The assistant itself sends neither.
      request: { method: "POST", path: `/api/v1/operations/${encodeURIComponent(operationId)}/${operation.readOnly ? "run" : "jobs"}`, body: { parameters } },
    });
  }
  return { steps, dropped };
}
