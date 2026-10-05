// @vitest-environment node
/**
 * A flow's owner-only steps, edited by someone else (sweep 1, S3-3).
 *
 * GET /flows shows anyone but the owner an owner-only step redacted: an HTTP request keeps only
 * where it goes, everything else is left out. An operator may still edit a flow they made, and what
 * they send back for that step is the redaction. Saved as sent, it would overwrite the owner's real
 * settings. Driven over a real socket with the real flow service and the routes index.mjs mounts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStateStore } from "../state.mjs";
import { createAuthService, hashPassword } from "../security.mjs";
import { createJobService } from "../jobs.mjs";
import { createFlowService } from "../flows.mjs";
import { createJobsRouter } from "./jobs.mjs";

vi.setConfig({ testTimeout: 30_000 });

const password = "correct horse battery";
const request = { url: "https://ntfy.example/secret-topic", method: "POST", body: "{{ steps.refresh.status }}", credentialName: "ntfy-token" };
let directory; let state; let server; let base; let owner; let operator; let flowId;
const sessions = {};

async function signIn(username) {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const body = await response.json();
  return { cookie: String(response.headers.getSetCookie()[0]).split(";")[0], csrfToken: body.csrfToken };
}

async function call(method, urlPath, session, body) {
  const response = await fetch(`${base}${urlPath}`, { method, headers: { Cookie: session.cookie, "X-BoxPilot-CSRF": session.csrfToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** The flow as `role` is shown it. */
async function shown(role) {
  return (await call("GET", "/api/v1/flows", sessions[role])).body.flows.find((flow) => flow.id === flowId);
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-flow-hidden-"));
  state = createStateStore({ stateDirectory: directory });
  const passwordHash = await hashPassword(password);
  owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "owner", passwordHash });
  operator = state.createOwnerAccount({ username: "operator", passwordHash, role: "operator", createdBy: owner.id });
  const auth = createAuthService(state);
  const jobs = createJobService(state, { request: async () => ({ ok: true }) });
  const flows = createFlowService({ store: state, jobs, library: [] });
  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  app.post("/api/v1/auth/login", auth.login);
  app.use("/api/v1", auth.requireSession);
  app.use("/api/v1", (req, res, next) => (["GET", "HEAD", "OPTIONS"].includes(req.method) ? next() : auth.requireCsrf(req, res, next)));
  app.use("/api/v1", createJobsRouter({ state, jobs, scheduler: {}, flows, auth, jobLogReader: null }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  sessions.owner = await signIn("owner");
  sessions.operator = await signIn("operator");
});

// The operator's flow, with a step the owner added that only the owner may run.
beforeEach(() => {
  if (flowId) state.deleteFlow(flowId, { actorId: owner.id });
  flowId = state.createFlow({ name: "Tidy", steps: [{ operationId: "apt.refresh", parameters: {}, name: "refresh" }, { operationId: "http.request", parameters: request }], createdBy: operator.id }).id;
});

afterAll(async () => {
  server?.closeAllConnections?.(); server?.close();
  state?.close?.();
  await rm(directory, { recursive: true, force: true });
});

describe("an owner-only step in a flow an operator edits", () => {
  it("is shown to the operator redacted", async () => {
    const [, step] = (await shown("operator")).steps;
    expect(step).toMatchObject({ operationId: "http.request", parameters: { url: "https://ntfy.example", method: "POST" }, parametersHidden: true });
  });

  it("keeps its real settings when the operator saves changes to the other steps", async () => {
    const steps = (await shown("operator")).steps;
    steps[0] = { ...steps[0], retry: 2 };
    steps.push({ operationId: "apt.refresh", parameters: {} });
    const saved = await call("PUT", `/api/v1/flows/${flowId}`, sessions.operator, { steps });
    expect(saved.status).toBe(200);
    const stored = state.getFlow(flowId).steps;
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({ operationId: "apt.refresh", retry: 2 });
    expect(stored[1]).toEqual({ operationId: "http.request", parameters: request });
    // A rename that leaves the steps alone is as it was.
    expect((await call("PUT", `/api/v1/flows/${flowId}`, sessions.operator, { name: "Tidy up" })).status).toBe(200);
    expect(state.getFlow(flowId).steps[1].parameters).toEqual(request);
  });

  it("cannot be changed, moved, removed or swapped for another operation by the operator", async () => {
    const steps = (await shown("operator")).steps;
    const attempts = {
      "a new address": [steps[0], { ...steps[1], parameters: { ...steps[1].parameters, url: "https://collector.example/x" } }],
      "a new setting": [steps[0], { ...steps[1], parameters: { ...steps[1].parameters, credentialName: "other-token" } }],
      "a new failure rule": [steps[0], { ...steps[1], onFailure: "continue" }],
      "removed": [steps[0]],
      "moved": [steps[1], steps[0]],
      "a step put in front of it": [steps[0], { operationId: "apt.refresh", parameters: {} }, steps[1]],
      "another operation": [steps[0], { operationId: "apt.refresh", parameters: {} }],
    };
    for (const [what, attempt] of Object.entries(attempts)) {
      const refused = await call("PUT", `/api/v1/flows/${flowId}`, sessions.operator, { steps: attempt });
      expect(refused.status, what).toBe(403);
      expect(refused.body, what).toMatchObject({ code: "flow_step_owner_only" });
      expect(refused.body.error, what).toMatch(/^Only the owner can change, move or remove step 2 \(Send an HTTP request\)/);
      expect(state.getFlow(flowId).steps, what).toEqual([{ operationId: "apt.refresh", parameters: {}, name: "refresh" }, { operationId: "http.request", parameters: request }]);
    }
  });

  it("cannot be put in a flow by the operator at all (sweep 2)", async () => {
    const sendTo = { operationId: "http.request", parameters: { url: "https://collector.example/x", method: "POST", credentialName: "github-token" } };
    const created = await call("POST", "/api/v1/flows", sessions.operator, { name: "Mine", steps: [{ operationId: "apt.refresh", parameters: {} }, sendTo] });
    expect(created.status).toBe(403);
    expect(created.body).toMatchObject({ code: "flow_step_owner_only", error: expect.stringMatching(/^Only the owner can put step 2 \(Send an HTTP request\) in a flow/) });
    // Nor added to a flow of theirs, after the step the owner put there.
    const steps = (await shown("operator")).steps;
    const added = await call("PUT", `/api/v1/flows/${flowId}`, sessions.operator, { steps: [...steps, sendTo] });
    expect(added.status).toBe(403);
    expect(added.body).toMatchObject({ code: "flow_step_owner_only", error: expect.stringMatching(/^Only the owner can put step 3 \(Send an HTTP request\) in a flow/) });
    expect(state.getFlow(flowId).steps).toHaveLength(2);
    // The owner can.
    expect((await call("POST", "/api/v1/flows", sessions.owner, { name: "Owner's", steps: [sendTo] })).status).toBe(201);
  });

  it("stays the owner's to change in full", async () => {
    const steps = (await shown("owner")).steps;
    expect(steps[1].parameters).toEqual(request);
    const changed = await call("PUT", `/api/v1/flows/${flowId}`, sessions.owner, { steps: [steps[0], { ...steps[1], parameters: { ...request, url: "https://ntfy.example/new-topic" } }] });
    expect(changed.status).toBe(200);
    expect(state.getFlow(flowId).steps[1].parameters.url).toBe("https://ntfy.example/new-topic");
    expect((await call("PUT", `/api/v1/flows/${flowId}`, sessions.owner, { steps: [steps[0]] })).status).toBe(200);
    expect(state.getFlow(flowId).steps).toHaveLength(1);
  });

  it("is kept by the owner with the steps sent back as shown (Keep this step)", async () => {
    // Put there before steps were checked: it does not run until the owner keeps it.
    expect(await shown("owner")).toMatchObject({ ownerToKeep: { step: 2, title: "Send an HTTP request" } });
    const refused = await call("POST", `/api/v1/flows/${flowId}/run`, sessions.owner);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/step 2 \(Send an HTTP request\) is one only the owner may run.*"Keep this step"/);
    // The operator cannot keep it: what they send back is the step as stored, which keeps no mark.
    expect((await call("PUT", `/api/v1/flows/${flowId}`, sessions.operator, { steps: (await shown("operator")).steps })).status).toBe(200);
    expect(state.getFlow(flowId).steps[1].ownerAdded).toBeUndefined();
    // The owner's button sends the steps back unchanged.
    const kept = await call("PUT", `/api/v1/flows/${flowId}`, sessions.owner, { steps: (await shown("owner")).steps });
    expect(kept.status).toBe(200);
    expect(state.getFlow(flowId).steps).toEqual([{ operationId: "apt.refresh", parameters: {}, name: "refresh" }, { operationId: "http.request", parameters: request, ownerAdded: true }]);
    expect((await shown("owner")).ownerToKeep).toBeNull();
  });
});
