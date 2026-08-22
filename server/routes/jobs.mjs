/**
 * Job routes: list/read jobs, live output and SSE streams, risk-tiered approval, the
 * Activity-drawer event stream, and operation schedules. Mounted at /api/v1 behind the session.
 */
import { Router } from "express";

export function createJobsRouter({ state, jobs, scheduler, jobLogReader, auth }) {
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
        if (final !== null && final.length > offset) send("output", { text: final.slice(offset) });
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

  // Scheduled operations: low/medium registered ops on an hourly/daily/weekly cadence,
  // approved automatically as the schedule's creator. High-risk ops cannot be scheduled.
  router.get("/schedules", (_request, response) => {
    response.json({ schedules: scheduler.list() });
  });

  router.post("/schedules", auth.requireCsrf, async (request, response) => {
    try {
      const { operationId, parameters, frequency, minute, hour, weekday } = request.body ?? {};
      const schedule = await scheduler.create({ operationId, parameters: parameters ?? {}, frequency, minute, hour: hour ?? null, weekday: weekday ?? null, createdBy: request.boxpilotSession.owner.id });
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
