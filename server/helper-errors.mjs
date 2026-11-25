/**
 * When BoxPilot's admin service (the root helper) does not answer (M89).
 *
 * The socket client used to throw Node's own words ("Helper unavailable: connect ENOENT
 * /run/boxpilot/helper.sock", "Helper request timed out (overall deadline reached)"), and the routes
 * and jobs passed them to the owner unchanged. Now each of the three ways it can fail carries a code
 * and a plain message, and the transport's own text rides along as `detail` (and the Node error as
 * `cause`) for the logs and the support bundle. Nothing here sends `detail` to the browser.
 *
 *   helper_unavailable  nothing to connect to: nothing was sent, so nothing ran
 *   helper_timeout      sent, and no answer within the deadline
 *   helper_closed       sent, and the connection dropped before the answer
 */

const said = Object.freeze({
  helper_unavailable: "BoxPilot's admin service is not answering",
  helper_timeout: "BoxPilot's admin service did not answer in time",
  helper_closed: "BoxPilot's admin service stopped answering partway",
});

/** The code of an error that came from the admin service not answering; null for anything else. */
export function helperErrorCode(error) {
  const code = error?.code;
  return typeof code === "string" && Object.hasOwn(said, code) ? code : null;
}

/**
 * The error the client throws for each way the admin service can fail to answer.
 * @param {"helper_unavailable" | "helper_timeout" | "helper_closed"} code
 * @param {string} detail the transport's own words, for logs only
 * @param {{ cause?: unknown, timeout?: object }} [extra]
 */
export function helperError(code, detail, { cause, timeout } = {}) {
  const error = new Error(`${said[code]}.`, cause === undefined ? undefined : { cause });
  return Object.assign(error, { code, detail: String(detail ?? "") }, timeout ? { timeout } : {});
}

const readNext = {
  helper_unavailable: "so this could not be read. Repair says how to start it again.",
  helper_timeout: "so this could not be read. Try again in a moment; if it keeps happening, Repair says how to restart it.",
  helper_closed: "so this could not be read. Try again in a moment; if it keeps happening, Repair says how to restart it.",
};

const runNext = {
  helper_unavailable: "so this did not start and nothing was changed. Repair says how to start it again.",
  helper_timeout: "so whether this finished is not known. Check what it changed before running it again.",
  helper_closed: "so whether this finished is not known. Check what it changed before running it again.",
};

/**
 * What to tell the owner when a read or a job failed because the admin service did not answer:
 * `{ error, code }` in plain words, or null when the error is something else.
 * @param {unknown} error
 * @param {{ doing?: "read" | "run" }} [options]
 */
export function helperFailure(error, { doing = "read" } = {}) {
  const code = helperErrorCode(error);
  if (!code) return null;
  return { error: `${said[code]}, ${(doing === "run" ? runNext : readNext)[code]}`, code };
}

/**
 * Answer a route with the plain words when the admin service did not answer. True when it did.
 * @param {{ status: (code: number) => { json: (body: unknown) => unknown } }} response
 * @param {unknown} error
 */
export function sendHelperFailure(response, error) {
  const failure = helperFailure(error);
  if (!failure) return false;
  response.status(503).json(failure);
  return true;
}
