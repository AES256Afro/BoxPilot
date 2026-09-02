/**
 * Job routes: list/read jobs, live output and SSE streams, risk-tiered approval, the
 * Activity-drawer event stream, and operation schedules. Mounted at /api/v1 behind the session.
 */
import { Router } from "express";
import { suggestFlows, suggestionFacts } from "../flow-suggestions.mjs";

/**
 * The part of a job's persisted output the stream has not sent yet, given how many BYTES of the
 * live log were already sent. Null when there is nothing to add - including when the persisted
 * copy is shorter than what was streamed, which means it was truncated to its last 2 MiB and is a
 * suffix whose offsets no longer line up with the file's.
 */
export function outputTailFrom(final, sentBytes) {
  const bytes = Buffer.from(final, "utf8");
  if (bytes.length <= sentBytes) return null;
  return bytes.subarray(sentBytes).toString("utf8");
}

export function createJobsRouter({ state, jobs, scheduler, flows = null, helper = null, jobLogReader, auth }) {
  const router = Router();

  /** Everyone sees their own jobs; the owner sees the whole box. */
  const scopeFor = (request) => (request.boxpilotSession?.owner?.role === "owner" ? {} : { createdBy: request.boxpilotSession.owner.id });
  /** The owner is shown every job, so the owner may open every job; everyone else only their own. */
  const mayRead = (request, job) => request.boxpilotSession?.owner?.role === "owner" || job.createdBy === request.boxpilotSession.owner.id;

  router.get("/jobs", (request, response) => {
    response.json({ jobs: state.listJobs(request.query.limit, scopeFor(request)) });
  });

  // Server-sent events for the Activity drawer: recent jobs on connect, then a snapshot of each
  // job as it is created, approved, stepped, or finished. Output text stays on /jobs/:id/stream.
  router.get("/events", (request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const scope = scopeFor(request);
    send("snapshot", { jobs: state.listJobs(30, scope) });
    const unsubscribe = state.subscribeJobs((job) => { if (!scope.createdBy || job.createdBy === scope.createdBy) send("job", { job }); });
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 25_000);
    request.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  // Job output: persisted once the job is finished, otherwise the live file being written by the helper/runner.
  router.get("/jobs/:id/output", async (request, response) => {
    const job = state.getJob(request.params.id);
    if (!job || !mayRead(request, job)) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
    const persisted = state.getJobOutput(job.id);
    if (persisted !== null) return response.json({ jobId: job.id, state: job.state, output: persisted, live: false });
    const live = await jobLogReader.read(job.id, 0).catch(() => ({ text: "", exists: false }));
    return response.json({ jobId: job.id, state: job.state, output: live.text, live: true });
  });

  // Server-sent events: streams new output as it is written, then a final `state` event when the job finishes.
  router.get("/jobs/:id/stream", async (request, response) => {
    const initial = state.getJob(request.params.id);
    if (!initial || !mayRead(request, initial)) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.write(": connected\n\n");
    let offset = 0; let closed = false;
    request.on("close", () => { closed = true; });
    const send = (event, data) => { if (!closed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const persisted = state.getJobOutput(initial.id);
    if (persisted !== null) { send("output", { text: persisted }); send("state", { state: initial.state, error: initial.error }); response.end(); return; }
    const started = Date.now();
    while (!closed && Date.now() - started < 3 * 60 * 60 * 1000) {
      const chunk = await jobLogReader.read(initial.id, offset).catch(() => ({ text: "", offset, exists: false }));
      if (chunk.text) { send("output", { text: chunk.text }); offset = chunk.offset; }
      const current = state.getJob(initial.id);
      if (!current || ["completed", "failed", "cancelled"].includes(current.state)) {
        const final = state.getJobOutput(initial.id);
        // `offset` counts bytes read from the log file; `final` is a string. Slicing a string by a
        // byte count drops the tail whenever the log holds anything outside ASCII - compose's "✔"
        // is three bytes and one character. Compare and cut in bytes. And the persisted copy keeps
        // only the last 2 MiB, so if it is shorter than what has already been streamed it is a
        // suffix, not the whole, and offsets from the start no longer mean anything: send nothing
        // rather than a slice from the wrong place.
        const tail = final === null ? null : outputTailFrom(final, offset);
        if (tail) send("output", { text: tail });
        send("state", { state: current?.state ?? "unknown", error: current?.error ?? null });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (!closed) response.end();
    return undefined;
  });

  router.get("/jobs/:id", (request, response) => {
    const job = state.getJob(request.params.id);
    if (!job || !mayRead(request, job)) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
    return response.json({ job });
  });

  router.post("/jobs/:id/approve", auth.requireCsrf, async (request, response) => {
    try {
      const approval = { password: typeof request.body?.password === "string" ? request.body.password : null, confirmText: typeof request.body?.confirmText === "string" ? request.body.confirmText : null, session: request.boxpilotSession };
      // Every op: job runs in the background; approval returns as soon as execution starts.
      const job = await jobs.approveAndStart(request.params.id, request.boxpilotSession.owner.id, approval);
      const session = auth.requestSession(request);
      response.status(202).json({ job, elevatedUntil: session?.elevatedUntil ?? null });
    } catch (error) {
      const status = error.message === "Job not found" ? 404 : error.message.includes("reauthentication") ? 401 : /^(Only the owner|Viewers cannot)/.test(error.message) ? 403 : 409;
      response.status(status).json({ error: error.message, code: "job_approval_failed" });
    }
  });

  router.delete("/jobs/:id", auth.requireCsrf, (request, response) => {
    try {
      response.json({ job: jobs.cancelJob(request.params.id, request.boxpilotSession.owner.id, { role: request.boxpilotSession.owner.role ?? "owner" }) });
    } catch (error) {
      response.status(error.message === "Job not found" ? 404 : 409).json({ error: error.message, code: "job_cancel_failed" });
    }
  });

  router.get("/jobs/:id/approval", (request, response) => {
    const subject = state.getJob(request.params.id);
    if (!subject || !mayRead(request, subject)) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
    const policy = jobs.describeApproval(request.params.id, request.boxpilotSession);
    if (!policy) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
    return response.json({ jobId: request.params.id, ...policy });
  });

  // Flows (ADR-002): ordered lists of registered operations, each step an ordinary job. The
  // routes mirror schedules: reading needs a session, changing needs CSRF, and running is barred
  // to viewers by the service itself.
  router.get("/flows", (_request, response) => {
    if (!flows) return response.status(503).json({ error: "Flows are not available", code: "flows_unavailable" });
    response.json({ flows: flows.list(), palette: flows.stepPalette(), shelf: flows.shelf() });
  });

  // Which automation this server in particular should have, and why (M24.1). Nothing is created:
  // this is the argument for pressing a button that was already on the shelf.
  router.get("/flows/suggestions", async (_request, response) => {
    if (!flows) return response.status(503).json({ error: "Flows are not available", code: "flows_unavailable" });
    // Three of the four facts are database reads and free. The other two ask the helper, and a
    // fact that cannot be read simply means that argument is not made today rather than an error:
    // a suggestion nobody can justify should not be offered at all.
    const [housekeeping, updates] = await Promise.all([
      helper ? helper.request("housekeeping.inspect", {}, { timeoutMs: 20_000 }).catch(() => null) : null,
      helper ? helper.request("apt.upgradable.inspect", {}, { timeoutMs: 20_000 }).catch(() => null) : null,
    ]);
    const packages = Array.isArray(updates?.packages) ? updates.packages : [];
    const facts = suggestionFacts({
      backups: state.listBackups(50),
      offBoxDestination: state.getSetting("backupDestination", null),
      offBoxLastSyncAt: state.getSetting("backupDestinationLastSync", null)?.completedAt ?? null,
      housekeeping,
      updates: { total: packages.length, security: packages.filter((entry) => entry?.security).length },
    });
    response.json({ suggestions: suggestFlows({ shelf: flows.shelf(), flows: flows.list(), facts }) });
  });

  router.post("/flows", auth.requireCsrf, async (request, response) => {
    try {
      const flow = await flows.create({ name: request.body?.name, steps: request.body?.steps, cadence: request.body?.cadence ?? null, triggerFlowId: typeof request.body?.triggerFlowId === "string" ? request.body.triggerFlowId : null, createdBy: request.boxpilotSession.owner.id });
      response.status(201).json({ flow });
    } catch (error) {
      response.status(400).json({ error: error.message, code: "flow_rejected" });
    }
  });

  router.put("/flows/:id", auth.requireCsrf, async (request, response) => {
    try {
      const flow = await flows.update(request.params.id, { name: request.body?.name, steps: request.body?.steps, cadence: request.body?.cadence, enabled: request.body?.enabled, triggerFlowId: request.body?.triggerFlowId === undefined ? undefined : (typeof request.body.triggerFlowId === "string" ? request.body.triggerFlowId : null) }, request.boxpilotSession.owner.id, { role: request.boxpilotSession.owner.role });
      response.json({ flow });
    } catch (error) {
      response.status(error.message.includes("not found") ? 404 : 400).json({ error: error.message, code: "flow_update_failed" });
    }
  });

  router.delete("/flows/:id", auth.requireCsrf, (request, response) => {
    try {
      flows.remove(request.params.id, request.boxpilotSession.owner.id, { role: request.boxpilotSession.owner.role });
      response.status(204).end();
    } catch (error) {
      response.status(error.message.includes("not found") ? 404 : 400).json({ error: error.message, code: "flow_delete_failed" });
    }
  });

  router.post("/flows/:id/webhook", auth.requireCsrf, (request, response) => {
    if (!flows) return response.status(503).json({ error: "Automations are not available", code: "flows_unavailable" });
    try {
      const { token } = flows.mintWebhook(request.params.id, request.boxpilotSession.owner.id, { role: request.boxpilotSession.owner.role });
      // The token appears exactly once, here; from now on the server knows only its hash.
      return response.json({ token, path: `/api/v1/hooks/flows/${request.params.id}/${token}` });
    } catch (error) {
      return response.status(error.message === "Flow not found" ? 404 : 403).json({ error: error.message });
    }
  });

  router.delete("/flows/:id/webhook", auth.requireCsrf, (request, response) => {
    if (!flows) return response.status(503).json({ error: "Automations are not available", code: "flows_unavailable" });
    try {
      flows.clearWebhook(request.params.id, request.boxpilotSession.owner.id, { role: request.boxpilotSession.owner.role });
      return response.status(204).end();
    } catch (error) {
      return response.status(error.message === "Flow not found" ? 404 : 403).json({ error: error.message });
    }
  });

  router.post("/flows/:id/run", auth.requireCsrf, async (request, response) => {
    try {
      const result = await flows.run(request.params.id, request.boxpilotSession.owner.id, { role: request.boxpilotSession.owner.role });
      response.json({ run: result });
    } catch (error) {
      const status = error.message.includes("not found") ? 404 : /Viewers|always ask/.test(error.message) ? 403 : 409;
      response.status(status).json({ error: error.message, code: "flow_run_failed" });
    }
  });

  // Scheduled operations: low/medium registered ops on an hourly/daily/weekly cadence,
  // approved automatically as the schedule's creator. High-risk ops cannot be scheduled.
  router.get("/schedules", (request, response) => {
    response.json({ schedules: scheduler.list(scopeFor(request)) });
  });

  router.post("/schedules", auth.requireCsrf, async (request, response) => {
    try {
      const { operationId, parameters, frequency, minute, hour, weekday, spread } = request.body ?? {};
      const schedule = await scheduler.create({ operationId, parameters: parameters ?? {}, frequency, minute, hour: hour ?? null, weekday: weekday ?? null, spread: spread === true, createdBy: request.boxpilotSession.owner.id });
      response.status(201).json({ schedule });
    } catch (error) {
      response.status(400).json({ error: error.message, code: "schedule_rejected" });
    }
  });

  router.put("/schedules/:id", auth.requireCsrf, (request, response) => {
    try {
      response.json({ schedule: scheduler.setEnabled(request.params.id, Boolean(request.body?.enabled), request.boxpilotSession.owner.id) });
    } catch (error) {
      response.status(error.message.includes("not found") ? 404 : 400).json({ error: error.message, code: "schedule_update_failed" });
    }
  });

  router.delete("/schedules/:id", auth.requireCsrf, (request, response) => {
    try {
      scheduler.remove(request.params.id, request.boxpilotSession.owner.id);
      response.json({ ok: true });
    } catch (error) {
      response.status(error.message.includes("not found") ? 404 : 400).json({ error: error.message, code: "schedule_delete_failed" });
    }
  });

  return router;
}
