import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createJobsRouter } from "./jobs.mjs";

/*
 * Who may see and act on a job, and what the job routes pass on to the services that decide the
 * rest. The services are fakes that record what they were given; the session is named by the
 * x-test-session header and the CSRF token is "csrf".
 */

const accounts = {
  alex: { id: "alex", username: "alex", role: "owner" },
  olly: { id: "olly", username: "olly", role: "operator" },
  otto: { id: "otto", username: "otto", role: "operator" },
};
const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } });

async function serve({ approveError = null, oneTime = null } = {}) {
  const calls = { listJobs: [], approved: [], oneTime: [], moreTime: [], dismissed: [], cancelled: [], schedules: [], scheduleList: [], flows: [], webhooks: [] };
  const storedJobs = { "job-olly": { id: "job-olly", createdBy: "olly", state: "awaiting_approval" } };
  const state = {
    listJobs: (limit, scope) => { calls.listJobs.push(scope); return []; },
    getJob: (id) => storedJobs[id] ?? null,
    findOwnerById: (id) => accounts[id] ?? null,
    getJobOutput: () => null,
    subscribeJobs: () => () => {},
  };
  const fail = (message) => { const error = new Error(message); throw error; };
  const jobs = {
    approveAndStart: async (id, ownerId, approval) => { if (approveError) fail(approveError); calls.approved.push({ id, ownerId, password: approval.password, passwordVerified: approval.passwordVerified, confirmText: approval.confirmText }); return { id, state: "running" }; },
    takeOneTime: (id, ownerId) => { calls.oneTime.push([id, ownerId]); return oneTime; },
    describeApproval: (id) => (storedJobs[id] ? { tier: "medium" } : null),
    retryWithMoreTime: async (id, ownerId, { role }) => { calls.moreTime.push([id, ownerId, role]); if (!storedJobs[id]) fail("Job not found"); if (role !== "owner" && storedJobs[id].createdBy !== ownerId) fail("Only the owner can retry another account's job"); return { id: "job-2" }; },
    dismissFailure: (id, ownerId, { role }) => { calls.dismissed.push([id, ownerId, role]); return { id }; },
    cancelJob: (id, ownerId, { role }) => { calls.cancelled.push([id, ownerId, role]); if (!storedJobs[id]) fail("Job not found"); return { id, state: "cancelled" }; },
  };
  const scheduler = {
    list: (scope) => { calls.scheduleList.push(scope); return []; },
    create: async (spec) => { calls.schedules.push(spec); return { id: "s1" }; },
  };
  const flows = {
    create: async (spec) => { calls.flows.push(spec); return { id: "f1" }; },
    mintWebhook: (id, ownerId, { role }) => { calls.webhooks.push([id, ownerId, role]); if (role !== "owner") throw new Error("Only the owner can give an automation a webhook"); return { token: "t".repeat(43) }; },
  };
  const auth = {
    requireCsrf: (request, response, next) => (request.get("x-boxpilot-csrf") === "csrf" ? next() : response.status(403).json({ code: "csrf_required" })),
    checkPassword: async (_request, account, password) => ({ ok: Boolean(account) && password === "right password", blocked: password === "throttled" }),
    rejectThrottled: (response) => response.status(429).json({ code: "too_many_attempts" }),
    requestSession: async () => ({ elevatedUntil: "2026-10-18T12:00:00.000Z" }),
  };
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => { const owner = accounts[request.get("x-test-session") ?? ""]; if (!owner) return response.status(401).end(); request.boxpilotSession = { owner }; return next(); });
  app.use(createJobsRouter({ state, jobs, scheduler, flows, auth, jobLogReader: { read: async () => ({ text: "", offset: 0 }) } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { as, body, csrf = true } = {}) => {
    const response = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", "x-test-session": as, ...(csrf ? { "x-boxpilot-csrf": "csrf" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { call, calls };
}

describe("seeing jobs", () => {
  it("lists only the caller's own jobs and schedules, and the whole box for the owner", async () => {
    const { call, calls } = await serve();
    await call("GET", "/jobs", { as: "olly" });
    await call("GET", "/jobs", { as: "alex" });
    await call("GET", "/schedules", { as: "olly" });
    await call("GET", "/schedules", { as: "alex" });
    expect(calls.listJobs).toEqual([{ createdBy: "olly" }, {}]);
    expect(calls.scheduleList).toEqual([{ createdBy: "olly" }, {}]);
  });

  it("answers another operator's job exactly as a missing one, and shows it to its creator and the owner", async () => {
    const { call } = await serve();
    for (const url of ["/jobs/job-olly", "/jobs/job-olly/approval"]) {
      const theirs = await call("GET", url, { as: "otto" });
      expect(theirs).toEqual(await call("GET", url.replace("job-olly", "job-none"), { as: "otto" }));
      expect(theirs.status).toBe(404);
      expect((await call("GET", url, { as: "olly" })).status).toBe(200);
      expect((await call("GET", url, { as: "alex" })).status).toBe(200);
    }
  });

  it("hands a one-time value only to a reader of the job, asking for it as the caller", async () => {
    const { call, calls } = await serve({ oneTime: "secret" });
    expect((await call("POST", "/jobs/job-olly/once", { as: "otto" })).status).toBe(404);
    expect((await call("POST", "/jobs/job-olly/once", { as: "olly", csrf: false })).status).toBe(403);
    expect(calls.oneTime).toEqual([]);
    expect(await call("POST", "/jobs/job-olly/once", { as: "olly" })).toEqual({ status: 200, body: { jobId: "job-olly", value: "secret" } });
    // The owner can read the job, but asks as the owner: the service gives the value only to whoever ran it.
    await call("POST", "/jobs/job-olly/once", { as: "alex" });
    expect(calls.oneTime).toEqual([["job-olly", "olly"], ["job-olly", "alex"]]);
    expect((await (await serve()).call("POST", "/jobs/job-olly/once", { as: "olly" })).status).toBe(410);
  });
});

describe("approving a job", () => {
  it("checks a password here, and passes on only whether it was right", async () => {
    const { call, calls } = await serve();
    expect(await call("POST", "/jobs/job-olly/approve", { as: "olly", body: { password: "wrong password" } })).toMatchObject({ status: 409, body: { error: "Wrong password" } });
    expect((await call("POST", "/jobs/job-olly/approve", { as: "olly", body: { password: "throttled" } })).status).toBe(429);
    expect((await call("POST", "/jobs/job-olly/approve", { as: "olly", csrf: false, body: { password: "right password" } })).status).toBe(403);
    expect(calls.approved).toEqual([]);
    expect(await call("POST", "/jobs/job-olly/approve", { as: "olly", body: { password: "right password", confirmText: "olly-box" } })).toMatchObject({ status: 202, body: { elevatedUntil: "2026-10-18T12:00:00.000Z" } });
    expect(await call("POST", "/jobs/job-olly/approve", { as: "olly", body: { password: 42 } })).toMatchObject({ status: 202 });
    expect(calls.approved).toEqual([
      { id: "job-olly", ownerId: "olly", password: "right password", passwordVerified: true, confirmText: "olly-box" },
      { id: "job-olly", ownerId: "olly", password: null, passwordVerified: false, confirmText: null },
    ]);
  });

  it("turns the service's refusals into the right status", async () => {
    const cases = [["Job not found", 404], ["Password reauthentication required", 401], ["Only the owner can approve this", 403], ["Viewers cannot approve jobs", 403], ["This job is not waiting for approval", 409]];
    for (const [message, status] of cases) {
      expect(await (await serve({ approveError: message })).call("POST", "/jobs/job-olly/approve", { as: "olly", body: {} })).toEqual({ status, body: { error: message, code: "job_approval_failed" } });
    }
  });
});

describe("acting on jobs, schedules and automations", () => {
  it("passes the caller and their role from the session, never from the request", async () => {
    const { call, calls } = await serve();
    expect((await call("POST", "/jobs/job-olly/more-time", { as: "otto", body: { role: "owner" } })).status).toBe(403);
    expect((await call("POST", "/jobs/job-olly/more-time", { as: "olly" })).status).toBe(201);
    await call("POST", "/jobs/job-olly/dismiss", { as: "olly", body: { role: "owner" } });
    expect((await call("DELETE", "/jobs/job-none", { as: "olly" })).status).toBe(404);
    await call("POST", "/schedules", { as: "olly", body: { operationId: "apt.update", frequency: "daily", createdBy: "alex" } });
    await call("POST", "/flows", { as: "olly", body: { name: "Nightly", steps: [], createdBy: "alex", role: "owner" } });
    expect(calls.moreTime).toEqual([["job-olly", "otto", "operator"], ["job-olly", "olly", "operator"]]);
    expect(calls.dismissed).toEqual([["job-olly", "olly", "operator"]]);
    expect(calls.cancelled).toEqual([["job-none", "olly", "operator"]]);
    expect(calls.schedules[0]).toMatchObject({ operationId: "apt.update", createdBy: "olly" });
    expect(calls.flows[0]).toMatchObject({ createdBy: "olly", role: "operator" });
  });

  it("needs the CSRF token for every change", async () => {
    const { call, calls } = await serve();
    for (const [method, url] of [["POST", "/jobs/job-olly/more-time"], ["POST", "/jobs/job-olly/dismiss"], ["DELETE", "/jobs/job-olly"], ["POST", "/schedules"], ["POST", "/flows"], ["POST", "/flows/f1/webhook"]]) {
      expect((await call(method, url, { as: "alex", csrf: false, body: {} })).status).toBe(403);
    }
    expect(Object.values(calls).every((list) => list.length === 0)).toBe(true);
  });

  it("returns a webhook token once, with the path it opens, and says when it is refused", async () => {
    const { call } = await serve();
    expect(await call("POST", "/flows/f1/webhook", { as: "alex" })).toEqual({ status: 200, body: { token: "t".repeat(43), path: `/api/v1/hooks/flows/f1/${"t".repeat(43)}` } });
    expect((await call("POST", "/flows/f1/webhook", { as: "olly" })).status).toBe(403);
  });
});
