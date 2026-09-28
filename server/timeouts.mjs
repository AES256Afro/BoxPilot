/**
 * Timeouts as a result, not a sentence (M30.3).
 *
 * A job that ran out of time used to be told apart from one that failed only by the words in its
 * error: "timed out after 900000 ms" at the front of a command's stderr, or "Helper request timed
 * out" from the socket. Here a timeout is a small object that travels on the error, across the
 * helper protocol (the helper's reply carries it next to `error`), and lands on the job record,
 * which is where the dialog and Activity read it from.
 *
 * On an error: `error.timeout = { scope, budgetMs, step? }`
 *   scope    "operation" - the whole operation's budget ran out (the web side's deadline)
 *            "step"      - one step inside it hit its own limit (a pull, a root task)
 *   budgetMs the limit that ran out
 *   step     what was running, in the operation's words ("Downloading the images")
 *   phase    "queued" when the budget ran out before the helper started it
 */

export const timeoutScopes = Object.freeze(["operation", "step"]);

const text = (value, limit) => (typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null);
const whole = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/** The timeout an error carries, cleaned to the fields and sizes above; null when it carries none. */
export function timeoutOf(error) {
  const raw = error?.timeout;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const budgetMs = whole(raw.budgetMs);
  if (budgetMs === null || budgetMs === 0) return null;
  return {
    scope: timeoutScopes.includes(raw.scope) ? raw.scope : "step",
    budgetMs,
    ...(text(raw.step, 200) ? { step: text(raw.step, 200) } : {}),
    ...(raw.phase === "queued" ? { phase: "queued" } : {}),
  };
}

/** An error that says it ran out of time. */
export function timedOut(message, { budgetMs, step = null, scope = "step", phase = null } = {}) {
  return Object.assign(new Error(message), { code: "timeout", timeout: { scope, budgetMs, ...(step ? { step } : {}), ...(phase ? { phase } : {}) } });
}

/** Carry a cause's timeout onto the error that wraps it ("the update failed and was rolled back. ..."). */
export function keepTimeout(cause, error) {
  const timeout = timeoutOf(cause);
  return timeout ? Object.assign(error, { code: "timeout", timeout }) : error;
}

/** "25 minutes", "2 hours 30 minutes", "40 seconds": how the budget is said to a person. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

/** The last line the operation wrote to its log: the furthest point it is known to have reached. */
export function lastOutputLine(log) {
  const lines = String(log ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return text(lines.at(-1) ?? "", 300);
}

/**
 * The timeout as the job record keeps it.
 *
 *   scope       "operation" or "step" (above)
 *   budgetMs    the limit that ran out
 *   elapsedMs   how long the job had been running when it stopped, by the job service's clock
 *   phase       "queued" (it never left the helper's queue) or "running"
 *   step        what the operation said was running, when it said
 *   lastOutput  the last line of its log: how far it got
 *   moreTimeMs  the budget "Try again with more time" would give it, or null when it is not offered
 */
export function jobTimeoutRecord(timeout, { elapsedMs, log = "", moreTimeMs = null } = {}) {
  return {
    scope: timeout.scope,
    budgetMs: timeout.budgetMs,
    elapsedMs: Math.max(0, Math.round(elapsedMs ?? 0)),
    phase: timeout.phase === "queued" ? "queued" : "running",
    step: timeout.step ?? null,
    lastOutput: lastOutputLine(log),
    moreTimeMs: Number.isInteger(moreTimeMs) && moreTimeMs > 0 ? moreTimeMs : null,
  };
}

/** The job's error sentence for a timeout: what ran out, and what may still be happening. */
export function timeoutMessage(title, timeout) {
  if (timeout.phase === "queued") return `${title} waited ${formatDuration(timeout.budgetMs)} behind other work on the server and did not start.`;
  if (timeout.scope === "operation") return `${title} did not finish within ${formatDuration(timeout.budgetMs)}. It may still be running on the server; Activity shows how far it got.`;
  return `${title} stopped: ${timeout.step ? `${timeout.step} did not finish` : "one step did not finish"} within ${formatDuration(timeout.budgetMs)}.`;
}
