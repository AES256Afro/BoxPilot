/**
 * The local assistant's routes (M34.2), mounted at /api/v1 behind the session:
 *
 * - GET  /assistant/status   whether a model answers, which one, and how big the index is.
 * - POST /assistant/ask      a question, answered as the person asking may read. Streams as
 *                            server-sent events when asked for text/event-stream (sources, then
 *                            the answer as it is written, then the finished result); plain JSON
 *                            otherwise. It only reads, so viewers may ask too (access.mjs).
 * - PUT  /settings/assistant the model server's address and the model names; the owner's, with
 *                            the password, like the notification target: it is where the
 *                            server's facts are sent.
 *
 * Nothing here stages or runs an operation. A plan's steps carry the request the page sends to
 * stage one through the ordinary job path.
 */
import { Router } from "express";
import { createEventStream } from "../event-stream.mjs";

const callerOf = (request) => ({ id: request.boxpilotSession?.owner?.id ?? null, role: request.boxpilotSession?.owner?.role ?? "owner" });

function refuse(response, error) {
  if (error?.expose) return response.status(error.status).json({ error: error.message, code: error.code });
  throw error;
}

export function createAssistantRouter({ assistant, state, auth }) {
  const router = Router();

  router.get("/assistant/status", async (request, response) => {
    response.json(await assistant.status(callerOf(request)));
  });

  router.post("/assistant/ask", auth.requireCsrf, async (request, response) => {
    let pending;
    try {
      pending = assistant.begin(callerOf(request), request.body ?? {});
    } catch (error) {
      return refuse(response, error);
    }
    // A person who closes the page stops the model writing an answer nobody will read.
    const hangUp = new AbortController();
    const streaming = /\btext\/event-stream\b/.test(request.get("accept") ?? "");
    if (!streaming) {
      response.on("close", () => { if (!response.writableFinished) hangUp.abort(); });
      try {
        const { outcome, ...result } = await pending.run({ signal: hangUp.signal });
        if (outcome === "cancelled" || response.destroyed) return undefined;
        return response.json(result);
      } catch (error) {
        return refuse(response, error);
      }
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const stream = createEventStream(response);
    stream.onClose(() => hangUp.abort());
    stream.write(": connected\n\n");
    // A model loading from disk can take a while to say its first word; keep the connection warm.
    const heartbeat = setInterval(() => stream.write(": ping\n\n"), 15_000);
    heartbeat.unref?.();
    try {
      const { outcome, ...result } = await pending.run({ signal: hangUp.signal, onEvent: (event, data) => stream.send(event, data) });
      if (outcome !== "cancelled") stream.send("done", result);
    } catch (error) {
      stream.send("error", { error: error?.expose ? error.message : "The assistant could not answer. The Logs page has the details.", code: error?.code ?? "assistant_failed" });
      if (!error?.expose) console.error(`[boxpilot] assistant: ${error?.stack ?? error}`);
    } finally {
      clearInterval(heartbeat);
      stream.end();
    }
    return undefined;
  });

  // Owner only, whatever the casing: the role policy refuses /settings changes to anyone else, and
  // this says so again, as the settings router does.
  router.put("/settings/assistant", auth.requireCsrf, auth.requireRole("owner"), async (request, response) => {
    const owner = state.findOwnerById(request.boxpilotSession.owner.id);
    const verdict = await auth.checkPassword(request, owner, request.body?.password);
    if (verdict.blocked) return auth.rejectThrottled(response, verdict);
    if (!verdict.ok) return response.status(401).json({ error: "Owner password required to change where the assistant's model runs", code: "reauthentication_required" });
    try {
      return response.json({ settings: assistant.saveSettings(request.body ?? {}, { actorId: owner.id }), status: await assistant.status(callerOf(request)) });
    } catch (error) {
      return refuse(response, error);
    }
  });

  return router;
}
