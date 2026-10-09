/**
 * Which model a run uses, and when that changes (M45.4). A host has two models: a local one, on
 * the machine, and a remote one it pays for. An agent says which it runs on: "local", "remote", or
 * "auto". Each rule here is a plain function of what the host already knows, so the host decides
 * when to ask and records the answer; nothing here calls a model.
 *
 * - startRoute      where a run starts, and whether it may move later
 * - moveAfterPlan   whether an auto run moves to the remote model after the local model planned
 * - secondOpinion   whether a finished local answer is worth asking the remote model again
 * - fallsBack       whether a remote call's failure means going on with the local model
 *
 * Every answer that changes the model carries a reason a person can read: the host shows it.
 */

export const routes = Object.freeze(["local", "remote", "auto"]);

/** An auto run's plan below this confidence moves; a conversation past this share of the local context moves. */
export const routerDefaults = Object.freeze({ unsureBelow: 0.5, contextShare: 0.8 });

/**
 * Where a run starts. `remote` says whether the remote model may take this run now: connected,
 * within its spending, and allowed for whoever asked (`{ ok, reason }`). A second opinion starts on
 * the remote model whatever the agent's route.
 *
 * @param {{ route?: string, remote?: { ok: boolean, reason?: string | null }, secondOpinion?: boolean }} input
 * @returns {{ start: "local" | "remote", mayMove: boolean, reason: string | null }}
 */
export function startRoute({ route = "local", remote = { ok: false, reason: null }, secondOpinion = false } = {}) {
  const wants = secondOpinion ? "remote" : routes.includes(route) ? route : "local";
  if (wants === "local") return { start: "local", mayMove: false, reason: null };
  if (!remote?.ok) return { start: "local", mayMove: false, reason: remote?.reason ?? "The remote model cannot take this run" };
  return wants === "remote" ? { start: "remote", mayMove: false, reason: null } : { start: "local", mayMove: true, reason: null };
}

const localProblems = Object.freeze({
  "model-unavailable": "The local model could not start",
  "model-error": "The local model stopped while it planned",
});

/**
 * Whether an auto run moves to the remote model once the local model has planned, and why. The
 * first reason that holds wins, in this order: the local model could not plan, the work is too
 * long for its context, its plan could not be read, it was unsure of its plan, or its plan
 * changes something.
 *
 * @param {{
 *   plan?: { read: boolean, confidence?: number | null, changes?: boolean } | null,
 *   localProblem?: string | null,
 *   promptTokens?: number,
 *   contextTokens?: number | null,
 *   unsureBelow?: number,
 *   contextShare?: number,
 * }} input `plan` is null when the run had no planning step; `changes` is true when the plan uses
 *   a tool that changes something or proposes a change
 * @returns {{ move: boolean, why: string | null, reason: string | null }}
 */
export function moveAfterPlan({ plan = null, localProblem = null, promptTokens = 0, contextTokens = null, unsureBelow = routerDefaults.unsureBelow, contextShare = routerDefaults.contextShare } = {}) {
  const move = (why, reason) => ({ move: true, why, reason });
  if (localProblem && localProblems[localProblem]) return move("local-failed", localProblems[localProblem]);
  if (contextTokens > 0 && promptTokens > contextTokens * contextShare) {
    return move("context", `The work is about ${Math.round(promptTokens)} tokens, more than the local model's ${Math.round(contextTokens)}-token context holds well`);
  }
  if (plan && !plan.read) return move("plan-unread", "The local model's plan could not be read");
  if (plan && Number.isFinite(plan.confidence) && plan.confidence < unsureBelow) return move("unsure", `The local model was unsure of its plan (confidence ${plan.confidence})`);
  if (plan?.changes) return move("changes", "The plan proposes a change, so the stronger model carries it out");
  return { move: false, why: null, reason: null };
}

/**
 * Whether a finished answer from the local model is worth asking the remote model again, and why.
 * A failed run, a question back to the person, and a run that was itself a second opinion are not.
 *
 * @param {{ outcome: string, degradedReason?: string | null, check?: { unsure?: boolean, mismatches?: number } | null, clarify?: boolean, secondOpinion?: boolean }} input
 * @returns {{ ask: boolean, reason: string | null }}
 */
export function secondOpinion({ outcome, degradedReason = null, check = null, clarify = false, secondOpinion: already = false } = {}) {
  if (already || clarify || outcome === "failed") return { ask: false, reason: null };
  if (outcome === "degraded") return { ask: true, reason: `The local model's answer was cut short (${degradedReason ?? "it did not finish"})` };
  if (check?.unsure || Number(check?.mismatches) > 0) return { ask: true, reason: "Part of the local model's answer did not match what its tools returned" };
  return { ask: false, reason: null };
}

/**
 * The remote failures a run goes on from with the local model: the remote model is not there, not
 * reachable, busy, out of money, or refuses the key. A request the remote model found malformed,
 * and a call that ran out of time, are not: the local model would fare no better.
 */
export const fallbackCodes = Object.freeze(["gateway-down", "not-connected", "budget", "unreachable", "overloaded", "rate-limited", "auth", "forbidden", "not-found", "api"]);

/** Whether a remote call that failed with `code` means going on with the local model. */
export const fallsBack = (code) => fallbackCodes.includes(String(code ?? ""));
