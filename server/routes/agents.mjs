/**
 * The Agents section's routes (M37), mounted at /api/v1 behind the session and the role policy.
 * Who may do what is the service's to decide (server/agents/service.mjs), per agent and per run;
 * the route matrix holds each route to its role:
 *
 * - Everyone signed in reads the module's state, the usage and the catalog, and asks an agent that
 *   takes their questions (the role policy lets a viewer POST /agents/:id/ask, as it lets them ask
 *   the assistant: it only reads, as the asker).
 * - The owner and operators make, change, run, pause and stop agents, and read runs, notes, cards
 *   and the learning library; an operator changes only the agents they made and sees only their own
 *   runs and those of their agents (another account's work is the owner's to see).
 * - The owner turns Agents on and chooses the runtime (PUT /settings/agents, with the password, like
 *   the assistant's model address: it is where the server's facts go) and adds documents.
 *
 * Nothing here stages or runs an operation. A card's steps carry the request that stages each one
 * through the ordinary job path, where it is approved at its own tier.
 */
import express, { Router } from "express";
import { createEventStream } from "../event-stream.mjs";

const callerOf = (request) => ({ id: request.boxpilotSession?.owner?.id ?? null, role: request.boxpilotSession?.owner?.role ?? "owner" });

function refuse(response, error) {
  if (error?.expose) return response.status(error.status).json({ error: error.message, code: error.code });
  throw error;
}

/** A handler whose AgentErrors become their status and sentence; anything else is a 500. */
const handle = (fn) => async (request, response) => {
  try {
    const result = await fn(request, response);
    if (result !== undefined && !response.headersSent) response.json(result);
  } catch (error) {
    if (!response.headersSent) refuse(response, error);
  }
};

/** Claude when no gateway is wired in (tests that do not ask about it): not connected. */
const noCloud = { state: async () => ({ connected: false, model: null, models: [], capUsd: null, connectedAt: null, gateway: "off", month: null, spentUsd: null, calls: null, problem: null }) };

export function createAgentsRouter({ agents, state, auth, cloud = noCloud }) {
  const router = Router();

  // ---- the module ----
  router.get("/agents", handle((request) => agents.overview(callerOf(request))));
  router.get("/agents/catalog", handle(() => agents.catalog()));
  router.get("/agents/usage", handle((request) => agents.usage(callerOf(request))));
  router.get("/agents/runtime", handle((request) => agents.runtimeState(callerOf(request))));
  router.get("/agents/glance", handle((request) => agents.glance(callerOf(request))));
  router.get("/agents/proposals", handle((request) => ({ proposals: agents.listProposals(callerOf(request)) })));
  router.get("/agents/knowledge", handle((request) => agents.knowledgeState(callerOf(request))));
  // M38: the team chat's panel, and "Check #agent-files now".
  router.get("/agents/zulip", handle((request) => agents.zulipState(callerOf(request))));
  // M45.3: Claude - connected or not, the cap, the month so far. Never the key, which only the gateway holds.
  router.get("/agents/cloud", handle(() => cloud.state()));
  router.post("/agents/zulip/poll", auth.requireCsrf, handle((request) => agents.zulipPollNow(callerOf(request))));
  router.post("/agents/module/pause", auth.requireCsrf, handle((request) => agents.pauseModule(callerOf(request), { until: request.body?.until ?? null })));
  router.post("/agents/module/resume", auth.requireCsrf, handle((request) => agents.resumeModule(callerOf(request))));
  router.post("/agents/module/kill", auth.requireCsrf, handle((request) => agents.killSwitch(callerOf(request))));

  // ---- the learning library ----
  router.post("/agents/knowledge/documents", auth.requireCsrf, handle((request) => agents.addDocument(callerOf(request), request.body ?? {})));
  router.put("/agents/knowledge/documents/:documentId", auth.requireCsrf, handle((request) => agents.toggleDocument(callerOf(request), request.params.documentId, request.body?.enabled)));
  router.delete("/agents/knowledge/documents/:documentId", auth.requireCsrf, handle((request) => agents.removeDocument(callerOf(request), request.params.documentId)));
  router.post("/agents/knowledge/relearn", auth.requireCsrf, handle((request) => agents.relearn(callerOf(request), request.body?.agentId ?? null)));
  router.put("/agents/knowledge/documents/:documentId/pin", auth.requireCsrf, handle((request) => agents.pinDocument(callerOf(request), request.params.documentId, request.body?.pinned)));
  // A PDF, Markdown or text file, sent as the request's body (up to 10 MB); its name in ?name=.
  router.post("/agents/knowledge/upload", auth.requireCsrf, express.raw({ type: () => true, limit: "11mb" }), handle((request) => agents.uploadDocument(callerOf(request), {
    name: typeof request.query.name === "string" ? request.query.name.slice(0, 200) : "upload", title: typeof request.query.title === "string" ? request.query.title.slice(0, 120) : null,
    buffer: Buffer.isBuffer(request.body) ? request.body : null,
  })));
  router.post("/agents/knowledge/folder/sync", auth.requireCsrf, handle((request) => agents.syncFolderNow(callerOf(request))));
  router.post("/agents/knowledge/reindex", auth.requireCsrf, handle((request) => agents.reindexMemory(callerOf(request))));
  // Import an agent from its JSON definition (export is per agent, below).
  router.post("/agents/import", auth.requireCsrf, handle((request, response) => { response.status(201); return agents.importAgent(callerOf(request), request.body ?? {}); }));

  // ---- cards ----
  router.get("/agents/proposals/:proposalId", handle((request) => agents.getProposal(callerOf(request), request.params.proposalId)));
  router.post("/agents/proposals/:proposalId/decide", auth.requireCsrf, handle((request) => agents.decideProposal(callerOf(request), request.params.proposalId, request.body ?? {})));
  // Which job a step was staged as: kept on the card, which is decided once every step's job is approved.
  router.post("/agents/proposals/:proposalId/steps/:step/job", auth.requireCsrf, handle((request) => agents.stageProposalStep(callerOf(request), request.params.proposalId, request.params.step, request.body ?? {})));

  // ---- runs ----
  router.get("/agents/runs/:runId", handle((request) => agents.getRun(callerOf(request), request.params.runId)));
  router.post("/agents/runs/:runId/cancel", auth.requireCsrf, handle((request) => agents.cancelRun(callerOf(request), request.params.runId)));
  // "Was this right?": anyone who may see the run says so, and it feeds the evaluation.
  router.post("/agents/runs/:runId/feedback", auth.requireCsrf, handle((request) => agents.giveFeedback(callerOf(request), request.params.runId, request.body ?? {})));
  // A run's trace as it happens: each step, then its end. A page closed mid-run just unsubscribes.
  router.get("/agents/runs/:runId/stream", async (request, response) => {
    let first;
    try {
      first = agents.getRun(callerOf(request), request.params.runId);
    } catch (error) {
      return refuse(response, error);
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const stream = createEventStream(response);
    stream.send("snapshot", first);
    const done = new Set(["completed", "degraded", "failed", "cancelled", "killed", "interrupted", "refused", "timeout"]);
    if (done.has(first.state)) { stream.end(); return undefined; }
    const unsubscribe = agents.subscribeRun(callerOf(request), request.params.runId, (event, data) => {
      stream.send(event, data);
      if (event === "state" && done.has(data.state)) {
        try { stream.send("snapshot", agents.getRun(callerOf(request), request.params.runId)); } catch { /* gone */ }
        stream.end();
      }
    });
    const heartbeat = setInterval(() => stream.write(": ping\n\n"), 15_000);
    heartbeat.unref?.();
    stream.onClose(() => { clearInterval(heartbeat); unsubscribe(); });
    return undefined;
  });

  // ---- one agent ----
  router.post("/agents", auth.requireCsrf, handle((request, response) => { response.status(201); return agents.createAgent(callerOf(request), request.body ?? {}); }));
  router.get("/agents/:id", handle((request) => agents.getAgent(callerOf(request), request.params.id)));
  router.put("/agents/:id", auth.requireCsrf, handle((request) => agents.updateAgent(callerOf(request), request.params.id, request.body ?? {})));
  router.delete("/agents/:id", auth.requireCsrf, handle((request) => agents.deleteAgent(callerOf(request), request.params.id)));
  router.get("/agents/:id/versions/:version", handle((request) => agents.versionDetail(callerOf(request), request.params.id, request.params.version)));
  router.post("/agents/:id/rollback", auth.requireCsrf, handle((request) => agents.rollbackAgent(callerOf(request), request.params.id, request.body ?? {})));
  router.post("/agents/:id/pause", auth.requireCsrf, handle((request) => agents.pauseAgent(callerOf(request), request.params.id, { until: request.body?.until ?? null })));
  router.post("/agents/:id/resume", auth.requireCsrf, handle((request) => agents.resumeAgent(callerOf(request), request.params.id)));
  router.get("/agents/:id/runs", handle((request) => ({ runs: agents.listRuns(callerOf(request), request.params.id, { limit: Number(request.query.limit) || 30 }) })));
  // The test console: run once now, as the person pressing the button.
  router.post("/agents/:id/runs", auth.requireCsrf, handle((request, response) => { response.status(202); return agents.startRun(callerOf(request), request.params.id, { kind: "manual", question: request.body?.question ?? null }); }));
  // A question, from anyone the agent takes them from.
  router.post("/agents/:id/ask", auth.requireCsrf, handle((request, response) => { response.status(202); return agents.startRun(callerOf(request), request.params.id, { kind: "ask", question: request.body?.question ?? null }); }));
  router.get("/agents/:id/notes", handle((request) => ({ notes: agents.listNotes(callerOf(request), request.params.id) })));
  // What it remembers, by tier; the owner edits a fact or makes it forget one, an episode or the conversation.
  router.get("/agents/:id/memory", handle((request) => agents.memoryOf(callerOf(request), request.params.id)));
  router.put("/agents/:id/memory/notes/:noteId", auth.requireCsrf, handle((request) => agents.editMemory(callerOf(request), request.params.id, request.params.noteId, request.body ?? {})));
  router.delete("/agents/:id/memory/notes/:noteId", auth.requireCsrf, handle((request) => agents.forgetMemory(callerOf(request), request.params.id, { kind: "note", id: request.params.noteId })));
  router.delete("/agents/:id/memory/episodes/:episodeId", auth.requireCsrf, handle((request) => agents.forgetMemory(callerOf(request), request.params.id, { kind: "episode", id: request.params.episodeId })));
  // The conversation with the person asking: anyone who may ask the agent can make it forget theirs.
  router.delete("/agents/:id/memory/thread", auth.requireCsrf, handle((request) => agents.forgetMemory(callerOf(request), request.params.id, { kind: "thread" })));
  router.get("/agents/:id/export", handle((request, response) => {
    const definition = agents.exportAgent(callerOf(request), request.params.id);
    response.setHeader("Content-Disposition", `attachment; filename="${definition.spec.name.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "agent"}.boxpilot-agent.json"`);
    return definition;
  }));
  // A webhook that starts the agent: minted (the token is shown once) or taken away.
  router.post("/agents/:id/webhook", auth.requireCsrf, handle((request) => agents.mintAgentWebhook(callerOf(request), request.params.id)));
  router.delete("/agents/:id/webhook", auth.requireCsrf, handle((request) => agents.clearAgentWebhook(callerOf(request), request.params.id)));
  router.delete("/agents/:id/notes/:noteId", auth.requireCsrf, handle((request) => agents.deleteNote(callerOf(request), request.params.id, request.params.noteId)));
  router.get("/agents/:id/evaluation", handle((request) => agents.getEvaluation(callerOf(request), request.params.id)));
  router.put("/agents/:id/evaluation", auth.requireCsrf, handle((request) => agents.setEvaluation(callerOf(request), request.params.id, request.body ?? {})));
  router.post("/agents/:id/evaluation/run", auth.requireCsrf, handle((request, response) => { response.status(202); return agents.runEvaluation(callerOf(request), request.params.id); }));

  // ---- the owner's settings: on or off, quiet hours, the runtime ----
  // Owner only, whatever the casing: the role policy refuses /settings changes to anyone else, and
  // this says so again, as the settings router does.
  router.put("/settings/agents", auth.requireCsrf, auth.requireRole("owner"), async (request, response) => {
    const owner = state.findOwnerById(request.boxpilotSession.owner.id);
    const verdict = await auth.checkPassword(request, owner, request.body?.password);
    if (verdict.blocked) return auth.rejectThrottled(response, verdict);
    if (!verdict.ok) return response.status(401).json({ error: "Owner password required to change how agents run", code: "reauthentication_required" });
    try {
      const { password: _password, ...input } = request.body ?? {};
      return response.json(agents.saveModule(callerOf(request), input));
    } catch (error) {
      return refuse(response, error);
    }
  });

  // M40.5: who in Zulip may ask the agents, as which BoxPilot account. It lets a chat account ask as
  // a BoxPilot one, so it takes the owner's password like the settings above.
  router.put("/agents/zulip/people", auth.requireCsrf, auth.requireRole("owner"), async (request, response) => {
    const owner = state.findOwnerById(request.boxpilotSession.owner.id);
    const verdict = await auth.checkPassword(request, owner, request.body?.password);
    if (verdict.blocked) return auth.rejectThrottled(response, verdict);
    if (!verdict.ok) return response.status(401).json({ error: "Owner password required to say who may ask in Zulip", code: "reauthentication_required" });
    try {
      const { people, defaultAgentId = null, twoWay = true } = request.body ?? {};
      return response.json(await agents.setZulipPeople(callerOf(request), { people, defaultAgentId, twoWay }));
    } catch (error) {
      return refuse(response, error);
    }
  });

  return router;
}
