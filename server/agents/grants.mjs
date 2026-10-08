/**
 * What an agent may do itself (M45.5, ADR-013): per operation on its list, the owner grants one of
 *
 * - propose  a card, as before: a person approves each step at its tier (the default)
 * - ask      the agent stages the job and a person approves it at its tier; low and medium only
 * - run      the job runs under the maker's delegated consent, as schedules and flows do; low only
 *
 * and fences no grant opens: high risk is always a card; an operation BoxPilot runs itself, one that
 * only reads, one that reveals secrets or carries one, and one that changes how agents run are never
 * granted; one that asks for typed confirmation is at most Ask; "always ask for the password" makes
 * every grant at most Ask. The service holds the rest (a viewer's run, a tainted run, the limits,
 * the maker's role).
 */

export const grantLevels = Object.freeze(["propose", "ask", "run"]);

/** At most 3 operations a run and 20 a day per agent; an approval not given within an hour drops the job. */
export const actLimits = Object.freeze({ perRun: 3, perDay: 20, approvalWaitMs: 60 * 60_000, perAgentGrants: 20 });

const rank = { propose: 0, ask: 1, run: 2 };
const lower = (a, b) => (rank[a] <= rank[b] ? a : b);

/** The fields of an operation that hold a secret or a value used once: an agent never holds either. */
const holdsSecret = (operation) => Object.values(operation?.parameters?.fields ?? {}).some((field) => field?.secret === true) || (operation?.oneTimeFields?.length ?? 0) > 0;

/**
 * Why this operation may not have this grant, or null when it may. `operation` is the registry's
 * entry (or undefined when there is none). Propose is always allowed: it is a card.
 */
export function grantProblem(operation, level) {
  if (!grantLevels.includes(level)) return `A grant is one of ${grantLevels.join(", ")}`;
  if (level === "propose") return null;
  if (!operation) return "BoxPilot has no such operation";
  if (operation.internal) return `${operation.title} is BoxPilot's own plumbing; BoxPilot runs it itself`;
  // How agents run - their model, Claude, their chat, their connectors - is never an agent's to change.
  if (String(operation.id ?? "").startsWith("agents.")) return `${operation.title} changes how agents run, which is the owner's to do`;
  if (operation.readOnly) return `${operation.title} only reads; an agent reads with its tools`;
  if (operation.elevatedOnly) return `${operation.title} reveals secrets, so no agent runs it`;
  if (holdsSecret(operation)) return `${operation.title} takes a secret, which an agent never holds`;
  if (operation.risk === "high") return `${operation.title} is high risk: it is always a card, with a person and a password`;
  if (level === "run" && operation.risk !== "low") return `${operation.title} is ${operation.risk} risk: only low risk runs without a person, so the most it can have is Ask`;
  if (level === "run" && (operation.confirm || operation.confirmWhen)) return `${operation.title} asks for typed confirmation, so a person approves it: the most it can have is Ask`;
  return null;
}

/**
 * The grant as it stands for one job: what the agent was granted, lowered by the tier the job was
 * staged at (what it acts on can raise it: installing an app whose manifest calls it high risk), by
 * a typed confirmation this job asks for, and by the approval mode.
 */
export function grantNow(level, { risk, mode = "tiered", confirms = false } = {}) {
  let now = grantLevels.includes(level) ? level : "propose";
  if (risk === "high") return "propose";
  if (risk !== "low") now = lower(now, "ask");
  if (confirms) now = lower(now, "ask");
  if (mode === "always-password") now = lower(now, "ask");
  return now;
}

/** An agent's grants as stored: `{ operationId: "ask" | "run" }`; Propose is the default and not stored. */
export const grantsOf = (spec) => (spec?.allow?.grants && typeof spec.allow.grants === "object" ? spec.allow.grants : {});
