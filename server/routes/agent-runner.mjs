/**
 * The agents runner's routes (M37), at /api/v1/agent-runner, mounted before the session wall with a
 * key of their own (access.mjs, agentRunnerAuth): the runner is not a person and has no session,
 * and this key opens nothing else. What it can do here:
 *
 * - hello      say it started; runs another runner held are marked interrupted, never retried
 * - next       wait (a long poll, at most half a minute) for the next run; one at a time server-wide
 * - heartbeat  keep a run's lease; the answer says when to stop (cancelled, paused, killed, late)
 * - steps      the model's words and timing, and the model starting or stopping
 * - tools      one read-only tool by name, run here as the run's person
 * - finish     the answer, the outcome and the usage
 * - usage      how hard it is working while idle
 *
 * Every run-scoped call proves the run's lease. Nothing here stages, approves or runs an operation.
 */
import { Router } from "express";
import { agentRunnerAuth } from "./access.mjs";

function refuse(response, error) {
  if (error?.expose) return response.status(error.status).json({ error: error.message, code: error.code });
  throw error;
}

const handle = (fn) => async (request, response) => {
  try {
    const result = await fn(request, response);
    if (!response.headersSent) response.json(result ?? { ok: true });
  } catch (error) {
    if (!response.headersSent) refuse(response, error);
  }
};

export function createAgentRunnerRouter({ agents, limit = null }) {
  const router = Router();
  const auth = agentRunnerAuth({ verify: (token) => agents.verifyRunnerToken(token), limit });
  const lease = (request) => (typeof request.body?.lease === "string" ? request.body.lease : "");

  router.post("/agent-runner/hello", auth, handle((request) => agents.runnerHello(request.agentRunner.runnerId, { version: request.body?.version ?? null, usage: request.body?.usage ?? null })));

  router.post("/agent-runner/next", auth, handle(async (request, response) => {
    // A runner that hangs up stops waiting for it.
    const hangUp = new AbortController();
    response.on("close", () => { if (!response.writableFinished) hangUp.abort(); });
    const claim = await agents.runnerNext(request.agentRunner.runnerId, { usage: request.body?.usage ?? null, hostBusy: request.body?.hostBusy === true, waitMs: request.body?.waitMs, signal: hangUp.signal });
    return { claim, ...agents.runnerAdvice() };
  }));

  router.post("/agent-runner/runs/:runId/heartbeat", auth, handle((request) => agents.runnerHeartbeat(request.params.runId, lease(request), { usage: request.body?.usage ?? null, runnerId: request.agentRunner.runnerId })));
  router.post("/agent-runner/runs/:runId/steps", auth, handle((request) => agents.runnerSteps(request.params.runId, lease(request), request.body?.steps)));
  router.post("/agent-runner/runs/:runId/tools", auth, handle((request) => agents.runnerTool(request.params.runId, lease(request), request.body?.name, request.body?.input ?? "{}")));
  router.post("/agent-runner/runs/:runId/finish", auth, handle((request) => agents.runnerFinish(request.params.runId, lease(request), request.body ?? {})));
  router.post("/agent-runner/usage", auth, handle((request) => agents.runnerUsage(request.agentRunner.runnerId, { usage: request.body?.usage ?? null, hostBusy: request.body?.hostBusy === true })));

  return router;
}
