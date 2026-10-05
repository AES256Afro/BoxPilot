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
  // The helper answers as the real one would where a later step reads the result: syncing Homepage
  // records the host its links point at, which is whatever the step was given.
  const jobs = createJobService(state, { request: async (operation, parameters) => (operation === "homepage.sync" ? { synced: true, services: 2, groupsKept: 0, host: parameters.host } : { ok: true }) });
  const flows = createFlowService({ store: state, jobs, library: [], pollMs: 5 });
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
    steps.push({ operationId: "apt.refresh", parameters: {}, retry: 2 });
    const saved = await call("PUT", `/api/v1/flows/${flowId}`, sessions.operator, { steps });
    expect(saved.status).toBe(200);
    const stored = state.getFlow(flowId).steps;
    expect(stored).toHaveLength(3);
    expect(stored[0]).toEqual({ operationId: "apt.refresh", parameters: {}, name: "refresh" });
    expect(stored[1]).toEqual({ operationId: "http.request", parameters: request });
    expect(stored[2]).toMatchObject({ operationId: "apt.refresh", retry: 2 });
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

  it("is kept by the owner, that step alone (Keep this step)", async () => {
    // Put there before steps were checked: it does not run until the owner keeps it.
    expect(await shown("owner")).toMatchObject({ ownerToKeep: [{ step: 2, title: "Send an HTTP request", reads: ["refresh"] }] });
    const refused = await call("POST", `/api/v1/flows/${flowId}/run`, sessions.owner);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/step 2 \(Send an HTTP request\) is one only the owner may run.*"Keep this step"/);
    // The operator cannot keep it: what they send back is the step as stored, which keeps no mark,
    // and asking to keep it is refused.
    expect((await call("PUT", `/api/v1/flows/${flowId}`, sessions.operator, { steps: (await shown("operator")).steps })).status).toBe(200);
    expect(state.getFlow(flowId).steps[1].ownerAdded).toBeUndefined();
    expect((await call("PUT", `/api/v1/flows/${flowId}`, sessions.operator, { keepStep: 2 })).status).toBe(403);
    // Nor does the owner sending the steps back as shown keep it (sweep 4): that kept every one.
    expect((await call("PUT", `/api/v1/flows/${flowId}`, sessions.owner, { steps: (await shown("owner")).steps })).status).toBe(200);
    expect(state.getFlow(flowId).steps[1].ownerAdded).toBeUndefined();
    // The owner's button names the step it keeps.
    const kept = await call("PUT", `/api/v1/flows/${flowId}`, sessions.owner, { keepStep: 2 });
    expect(kept.status).toBe(200);
    expect(state.getFlow(flowId).steps).toEqual([{ operationId: "apt.refresh", parameters: {}, name: "refresh" }, { operationId: "http.request", parameters: request, ownerAdded: true }]);
    expect((await shown("owner")).ownerToKeep).toEqual([]);
  });

  it("is not kept by an owner's edit elsewhere that moves it to another place (sweep 5)", async () => {
    // The step was matched by position: an owner removing the step before it shifted it to a place
    // where nothing was stored, and it was marked as the owner's own and ran.
    const plain = { operationId: "http.request", parameters: { url: "https://ntfy.example/topic", method: "POST" } };
    state.deleteFlow(flowId, { actorId: owner.id });
    flowId = state.createFlow({ name: "Tidy", steps: [{ operationId: "apt.refresh", parameters: {} }, { operationId: "apt.refresh", parameters: {}, retry: 1 }, plain], createdBy: operator.id }).id;
    expect((await shown("owner")).ownerToKeep).toEqual([{ step: 3, title: "Send an HTTP request", reads: [] }]);
    const removed = await call("PUT", `/api/v1/flows/${flowId}`, sessions.owner, { steps: (await shown("owner")).steps.slice(1) });
    expect(removed.status).toBe(200);
    expect(state.getFlow(flowId).steps).toEqual([{ operationId: "apt.refresh", parameters: {}, retry: 1 }, plain]);
    expect((await shown("owner")).ownerToKeep).toEqual([{ step: 2, title: "Send an HTTP request", reads: [] }]);
    expect((await call("POST", `/api/v1/flows/${flowId}/run`, sessions.owner)).status).toBe(409);
    // Nor by one that puts a step in front of it.
    const inserted = await call("PUT", `/api/v1/flows/${flowId}`, sessions.owner, { steps: [{ operationId: "apt.refresh", parameters: {} }, ...(await shown("owner")).steps] });
    expect(inserted.status).toBe(200);
    expect(state.getFlow(flowId).steps[2]).toEqual(plain);
    expect((await shown("owner")).ownerToKeep).toEqual([{ step: 3, title: "Send an HTTP request", reads: [] }]);
    // Kept, it stays kept wherever the owner's edits move it.
    expect((await call("PUT", `/api/v1/flows/${flowId}`, sessions.owner, { keepStep: 3 })).status).toBe(200);
    expect((await call("PUT", `/api/v1/flows/${flowId}`, sessions.owner, { steps: (await shown("owner")).steps.slice(1) })).status).toBe(200);
    expect(state.getFlow(flowId).steps[1]).toEqual({ ...plain, ownerAdded: true });
    expect((await shown("owner")).ownerToKeep).toEqual([]);
    // Changed by the owner, it is the owner's own.
    state.updateFlow(flowId, { steps: [{ operationId: "apt.refresh", parameters: {} }, plain] }, { actorId: owner.id });
    const changed = await call("PUT", `/api/v1/flows/${flowId}`, sessions.owner, { steps: [{ operationId: "apt.refresh", parameters: {} }, { ...plain, parameters: { ...plain.parameters, url: "https://ntfy.example/other" } }] });
    expect(changed.status).toBe(200);
    expect(state.getFlow(flowId).steps[1].ownerAdded).toBe(true);
  });
});

describe("a step an owner-only step reads (sweep 3)", () => {
  // The owner's request goes to the host the step before it records, and a credential rides along.
  // Syncing Homepage records the host it was given, so whoever edits that step chooses the address.
  const pinged = { operationId: "http.request", parameters: { url: "https://{{ steps.dash.host }}/hook", method: "POST", body: "synced {{ steps.dash.services }} apps", credentialName: "ntfy-token" }, ownerAdded: true };
  const stored = [
    { operationId: "apt.refresh", parameters: {}, name: "refresh" },
    { operationId: "homepage.sync", parameters: { host: "box.example" }, name: "dash" },
    pinged,
  ];
  let id;
  beforeEach(() => { id = state.createFlow({ name: "Ping", steps: stored, createdBy: operator.id }).id; });
  const steps = async () => (await call("GET", "/api/v1/flows", sessions.operator)).body.flows.find((flow) => flow.id === id).steps;

  /** Run the flow as the owner, as Run now does, and return the owner's request as it was staged. */
  async function ownersRequest() {
    expect((await call("POST", `/api/v1/flows/${id}/run`, sessions.owner)).status).toBe(202);
    for (let wait = 0; wait < 500 && String(state.getFlow(id).lastResult ?? "running").startsWith("running"); wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.getFlow(id).lastResult).toBe("completed");
    return state.getFlow(id).lastJobIds.map((jobId) => state.getJob(jobId)).find((job) => job.type === "op:http.request");
  }

  it("cannot be changed, swapped, made conditional or moved by the operator", async () => {
    const shown = await steps();
    const attempts = {
      "a new host": [shown[0], { ...shown[1], parameters: { host: "other-host.example" } }, shown[2]],
      "another operation under its name": [shown[0], { operationId: "apt.refresh", parameters: {}, name: "dash" }, shown[2]],
      "a condition": [shown[0], { ...shown[1], when: { value: "{{ steps.refresh.ok }}" } }, shown[2]],
      "a new failure rule": [shown[0], { ...shown[1], onFailure: "continue" }, shown[2]],
      "moved": [{ ...shown[1] }, { ...shown[0] }, shown[2]],
    };
    for (const [what, attempt] of Object.entries(attempts)) {
      const refused = await call("PUT", `/api/v1/flows/${id}`, sessions.operator, { steps: attempt });
      expect(refused.status, what).toBe(403);
      expect(refused.body, what).toMatchObject({ code: "flow_step_owner_only" });
      expect(refused.body.error, what).toMatch(/step 3 \(Send an HTTP request\), which only the owner may run, reads/);
      expect(state.getFlow(id).steps, what).toEqual(stored);
    }
    expect((await call("PUT", `/api/v1/flows/${id}`, sessions.operator, { steps: attempts["a new host"] })).body.error).toBe("Only the owner can change, move or remove step 2 (Sync Homepage with installed apps): step 3 (Send an HTTP request), which only the owner may run, reads its result. Leave it where it is, as it is, to save your other changes.");
    // Removing it moves the owner's step, which was already refused.
    expect((await call("PUT", `/api/v1/flows/${id}`, sessions.operator, { steps: [shown[0], shown[2]] })).status).toBe(403);
    // The owner's request goes where the owner meant.
    expect((await ownersRequest()).parameters).toMatchObject({ url: "https://box.example/hook", body: "synced 2 apps", credentialName: "ntfy-token" });
  });

  it("leaves the operator every step it does not read", async () => {
    const shown = await steps();
    const saved = await call("PUT", `/api/v1/flows/${id}`, sessions.operator, { name: "Ping it", steps: [{ ...shown[0], retry: 1 }, shown[1], shown[2], { operationId: "apt.refresh", parameters: {} }] });
    expect(saved.status).toBe(200);
    expect(state.getFlow(id).steps.map((step) => step.retry ?? 0)).toEqual([1, 0, 0, 0]);
    expect(state.getFlow(id).steps[2]).toEqual(pinged);
  });

  it("covers a step it reads through another, and a step its condition reads", async () => {
    const through = state.createFlow({ name: "Chain", steps: [
      { operationId: "homepage.sync", parameters: { host: "box.example" }, name: "pick" },
      { operationId: "homepage.sync", parameters: { host: "{{ steps.pick.host }}" }, name: "dash" },
      pinged,
    ], createdBy: operator.id }).id;
    const chain = (await call("GET", "/api/v1/flows", sessions.operator)).body.flows.find((flow) => flow.id === through).steps;
    const steered = await call("PUT", `/api/v1/flows/${through}`, sessions.operator, { steps: [{ ...chain[0], parameters: { host: "other-host.example" } }, chain[1], chain[2]] });
    expect(steered.status).toBe(403);
    expect(steered.body.error).toMatch(/^Only the owner can change, move or remove step 1 \(Sync Homepage with installed apps\): step 3/);

    const gated = state.createFlow({ name: "Gated", steps: [
      { operationId: "homepage.sync", parameters: { host: "box.example" }, name: "check" },
      { operationId: "http.request", parameters: { url: "https://hooks.example/hook" }, when: { value: "{{ steps.check.synced }}" }, ownerAdded: true },
    ], createdBy: operator.id }).id;
    const shown = (await call("GET", "/api/v1/flows", sessions.operator)).body.flows.find((flow) => flow.id === gated).steps;
    const swapped = await call("PUT", `/api/v1/flows/${gated}`, sessions.operator, { steps: [{ operationId: "apt.refresh", parameters: {}, name: "check" }, shown[1]] });
    expect(swapped.status).toBe(403);
    expect(swapped.body.error).toMatch(/^Only the owner can change, move or remove step 1 \(Sync Homepage with installed apps\): step 2 \(Send an HTTP request\)/);
  });

  it("stays the owner's to change", async () => {
    const shown = (await call("GET", "/api/v1/flows", sessions.owner)).body.flows.find((flow) => flow.id === id).steps;
    expect((await call("PUT", `/api/v1/flows/${id}`, sessions.owner, { steps: [shown[0], { ...shown[1], parameters: { host: "dash.example" } }, shown[2]] })).status).toBe(200);
    expect((await ownersRequest()).parameters.url).toBe("https://dash.example/hook");
  });
});
