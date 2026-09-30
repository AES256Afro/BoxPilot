/**
 * Job routes: list/read jobs, live output and SSE streams, risk-tiered approval, the
 * Activity-drawer event stream, and operation schedules. Mounted at /api/v1 behind the session.
 */
import { Router } from "express";
import { createEventStream, createStreamBudget } from "../event-stream.mjs";
import { suggestFlows, suggestionFacts } from "../flow-suggestions.mjs";
import { callerId, readsThroughHelper, seesEveryAccount } from "./access.mjs";

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

export function createJobsRouter({ state, jobs, scheduler, flows = null, autoReconnect = null, helper = null, jobLogReader, auth, streamBudget = createStreamBudget() }) {
  const router = Router();
  function openStream(request, response) {
    const release = streamBudget.acquire(request.boxpilotSession?.owner?.id ?? "anonymous");
    if (!release) {
      response.setHeader("Retry-After", "10");
      response.status(429).json({ error: "Too many live streams are open. Close an unused tab and try again.", code: "stream_limit" });
      return null;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const stream = createEventStream(response);
    stream.onClose(release);
    return stream;
  }


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
    const stream = openStream(request, response);
    if (!stream) return;
    const scope = scopeFor(request);
    stream.send("snapshot", { jobs: state.listJobs(30, scope) });
    const unsubscribe = state.subscribeJobs((job) => { if (!scope.createdBy || job.createdBy === scope.createdBy) stream.send("job", { job }); });
    stream.onClose(unsubscribe);
    const heartbeat = setInterval(() => stream.write(": ping\n\n"), 25_000);
    heartbeat.unref?.();
    stream.onClose(() => clearInterval(heartbeat));
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
    const stream = openStream(request, response);
    if (!stream) return;
    stream.write(": connected\n\n");
    let offset = 0;
    const persisted = state.getJobOutput(initial.id);
    if (persisted !== null) { await stream.output(persisted); stream.send("state", { state: initial.state, error: initial.error }); stream.end(); return; }
    const started = Date.now();
    while (!stream.closed && Date.now() - started < 3 * 60 * 60 * 1000) {
      if (!await stream.ready()) break;
      const chunk = await jobLogReader.read(initial.id, offset).catch(() => ({ text: "", offset, exists: false }));
      if (chunk.text) { if (!await stream.output(chunk.text)) break; offset = chunk.offset; }
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
        if (tail) await stream.output(tail);
        stream.send("state", { state: current?.state ?? "unknown", error: current?.error ?? null });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    stream.end();
    return undefined;
  });

  router.get("/jobs/:id", (request, response) => {
    const job = state.getJob(request.params.id);
    if (!job || !mayRead(request, job)) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
    return response.json({ job });
  });

  // What a finished job showed once (its operation's oneTimeFields): to the person who ran it, the
  // first time they ask, within a quarter of an hour. Never stored, so never shown again.
  router.post("/jobs/:id/once", auth.requireCsrf, (request, response) => {
    const job = state.getJob(request.params.id);
    if (!job || !mayRead(request, job)) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
    const value = typeof jobs.takeOneTime === "function" ? jobs.takeOneTime(job.id, request.boxpilotSession?.owner?.id ?? null) : null;
    if (!value) return response.status(410).json({ error: "This was shown once already, or it was for someone else. Run the action again for a new one.", code: "shown_once" });
    return response.json({ jobId: job.id, value });
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

  // "Try again with more time" (M30.3): stages the same operation with a larger budget and answers
  // like staging does, with the new job and what approving it needs. Nothing runs until it is approved.
  router.post("/jobs/:id/more-time", auth.requireCsrf, async (request, response) => {
    try {
      const owner = request.boxpilotSession.owner;
      const job = await jobs.retryWithMoreTime(request.params.id, owner.id, { role: owner.role ?? "owner" });
      response.status(201).json({ job, approval: jobs.describeApproval(job.id, request.boxpilotSession) });
    } catch (error) {
      const status = error.message === "Job not found" ? 404 : /^(Only the owner|Viewers cannot)/.test(error.message) ? 403 : 409;
      response.status(status).json({ error: error.message, code: error.code === "more_time_refused" ? "more_time_refused" : "job_retry_failed" });
    }
  });

  // "I have seen this failure" (M36): it stays in Activity and stops asking for attention on Home and
  // Ops. Its creator or the owner; the role policy keeps viewers out, as for every other change.
  router.post("/jobs/:id/dismiss", auth.requireCsrf, (request, response) => {
    try {
      const owner = request.boxpilotSession.owner;
      response.json({ job: jobs.dismissFailure(request.params.id, owner.id, { role: owner.role ?? "owner" }) });
    } catch (error) {
      response.status(error.message === "Job not found" ? 404 : 409).json({ error: error.message, code: "job_dismiss_failed" });
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
  router.get("/flows", async (request, response) => {
    if (!flows) return response.status(503).json({ error: "Flows are not available", code: "flows_unavailable" });
    const listed = await flows.list();
    response.json({ flows: seesEveryAccount(request) ? listed : listed.map((flow) => flowForCaller(request, flow)), palette: flows.stepPalette(), shelf: flows.shelf() });
  });

  /**
   * A flow is shared - every role reads it, and an operator may run anyone's - but each run's steps
   * are jobs of whoever ran it (M29.4). For anyone but the owner, a last run that was not entirely
   * theirs keeps its outcome and the step it reached, and loses its job ids and the error text those
   * jobs recorded; the flow's creator is named only to the creator.
   */
  function flowForCaller(request, flow) {
    const self = callerId(request);
    const jobIds = Array.isArray(flow.lastJobIds) ? flow.lastJobIds : [];
    const theirs = jobIds.every((jobId) => jobId === null || (self !== null && state.getJob(jobId)?.createdBy === self));
    const visible = { ...flow, createdBy: flow.createdBy === self ? flow.createdBy : null };
    if (theirs) return visible;
    return { ...visible, lastJobIds: [], lastResult: typeof flow.lastResult === "string" ? flow.lastResult.split(": ")[0] : flow.lastResult, lastRunElsewhere: true };
  }

  // Which automation this server in particular should have, and why (M24.1). Nothing is created:
  // this is the argument for pressing a button that was already on the shelf.
  router.get("/flows/suggestions", async (request, response) => {
    if (!flows) return response.status(503).json({ error: "Flows are not available", code: "flows_unavailable" });
    // Three of the four facts are database reads and free. The other two ask the helper, and a
    // fact that cannot be read simply means that argument is not made today rather than an error:
    // a suggestion nobody can justify should not be offered at all. housekeeping.inspect needs an
    // operator (ADR-003), so it is not run for a viewer, who cannot add a flow either (M29.4).
    const [housekeeping, updates] = await Promise.all([
      helper && readsThroughHelper(request) ? helper.request("housekeeping.inspect", {}, { timeoutMs: 20_000 }).catch(() => null) : null,
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
    response.json({ suggestions: suggestFlows({ shelf: flows.shelf(), flows: await flows.list(), facts }) });
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

  // 202: the run has started, not finished. It used to await the whole flow, and a proxy that gave
  // up on a long request made the page report a refusal while the flow was still running. The
  // flow list is the source of truth for progress; every refusal still comes back with its status.
  router.post("/flows/:id/run", auth.requireCsrf, async (request, response) => {
    try {
      const started = await flows.launch(request.params.id, request.boxpilotSession.owner.id, { role: request.boxpilotSession.owner.role });
      response.status(202).json({ started });
    } catch (error) {
      const status = error.message.includes("not found") ? 404 : /Viewers|always ask/.test(error.message) ? 403 : 409;
      response.status(status).json({ error: error.message, code: "flow_run_failed" });
    }
  });

  // Reconnecting a drive automatically (M26.5). Arming is creating the drive's flow as the person
  // asking, disarming removes it; reading says what is armed and what is waiting for a person.
  router.get("/drives/auto-reconnect", (_request, response) => {
    if (!autoReconnect) return response.status(503).json({ error: "Automations are not available", code: "flows_unavailable" });
    return response.json(autoReconnect.status());
  });

  router.post("/drives/:name/auto-reconnect", auth.requireCsrf, async (request, response) => {
    if (!autoReconnect) return response.status(503).json({ error: "Automations are not available", code: "flows_unavailable" });
    try {
      const flow = await autoReconnect.arm(request.params.name, request.boxpilotSession.owner.id, { role: request.boxpilotSession.owner.role });
      return response.status(201).json({ flow });
    } catch (error) {
      return response.status(error.code === "forbidden" ? 403 : 400).json({ error: error.message, code: "auto_reconnect_rejected" });
    }
  });

  router.delete("/drives/:name/auto-reconnect", auth.requireCsrf, (request, response) => {
    if (!autoReconnect) return response.status(503).json({ error: "Automations are not available", code: "flows_unavailable" });
    try {
      autoReconnect.disarm(request.params.name, request.boxpilotSession.owner.id, { role: request.boxpilotSession.owner.role });
      return response.status(204).end();
    } catch (error) {
      return response.status(error.code === "not_found" ? 404 : 403).json({ error: error.message, code: "auto_reconnect_rejected" });
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
