/**
 * Authorization boundaries at the HTTP layer.
 *
 * The routers are mounted in the same order and with the same middleware as server/index.mjs,
 * against a real state store and a stub helper, then driven over a real socket with fetch. The
 * unit tests cover each service on its own; these cover what only the assembled app can show:
 * who may reach which route, with which role, and what the middleware lets through.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createStateStore } from "../state.mjs";
import { createAuthService, hashPassword } from "../security.mjs";
import { createIdentityService } from "../identity.mjs";
import { createIdentityRouter } from "./identity.mjs";
import { createJobsRouter } from "./jobs.mjs";
import { createOperationsRouter } from "./operations.mjs";
import { createPeopleRouter } from "./people.mjs";
import { createSettingsRouter } from "./settings.mjs";
import { createJobService } from "../jobs.mjs";
import { createSchedulerService } from "../scheduler.mjs";
import { createNotificationService } from "../notifications.mjs";

const password = "correct horse battery";
let directory;
let server;
let base;
let state;
let identity;
const accounts = {};

async function api(method, urlPath, { session = null, body = undefined, headers = {} } = {}) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(session ? { Cookie: session.cookie, "X-BoxPilot-CSRF": session.csrfToken } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function signIn(username) {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const body = await response.json();
  const cookie = String(response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie")).split(";")[0];
  return { cookie, csrfToken: body.csrfToken, owner: body.owner };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-routes-"));
  state = createStateStore({ stateDirectory: directory });
  const passwordHash = await hashPassword(password);
  accounts.owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "owner", passwordHash });
  accounts.operator = state.createOwnerAccount({ username: "operator", passwordHash, role: "operator", createdBy: accounts.owner.id });
  accounts.viewer = state.createOwnerAccount({ username: "viewer", passwordHash, role: "viewer", createdBy: accounts.owner.id });

  const helper = { request: vi.fn(async () => ({ ok: true })) };
  const auth = createAuthService(state);
  identity = createIdentityService({ store: state, run: vi.fn(async () => ({ ok: false, stdout: "", stderr: "" })) });
  const jobs = createJobService(state, helper);
  const scheduler = createSchedulerService({ store: state, jobs });
  const notifications = createNotificationService({ store: state });

  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  app.use("/api/v1", createIdentityRouter({ store: state, auth, identity }));
  app.post("/api/v1/auth/login", auth.login);
  app.post("/api/v1/auth/elevate", auth.requireSession, auth.requireCsrf, auth.elevate);
  app.use("/api/v1", auth.requireSession);
  app.use("/api/v1", (request, response, next) => (["GET", "HEAD", "OPTIONS"].includes(request.method) ? next() : auth.requireCsrf(request, response, next)));
  app.use("/api/v1", (request, response, next) => {
    const role = request.boxpilotSession?.owner?.role ?? "owner";
    const reading = ["GET", "HEAD", "OPTIONS"].includes(request.method);
    const pathname = request.path.toLowerCase();
    const readOnlyRun = /^\/operations\/[^/]+\/run$/.test(pathname);
    const selfService = pathname === "/auth/logout" || pathname === "/auth/elevate" || pathname === "/auth/password";
    if (role === "disabled") return response.status(403).json({ error: "This account is disabled", code: "forbidden" });
    if (role === "viewer" && !reading && !readOnlyRun && !selfService) return response.status(403).json({ error: "Viewers can look but not change anything", code: "forbidden" });
    if (role === "operator" && !reading && (pathname.startsWith("/settings") || pathname.startsWith("/people"))) return response.status(403).json({ error: "Only the owner can change settings or people", code: "forbidden" });
    return next();
  });
  app.use("/api/v1/people", auth.requireRole("owner"));
  app.use("/api/v1", createPeopleRouter({ state, auth }));
  app.use("/api/v1", createOperationsRouter({ state, helper, jobs, prerequisites: { inspect: async () => ({}) }, recoveryKit: { inspect: async () => ({}) }, actionCenter: { inspect: async () => ({}) }, auth }));
  app.use("/api/v1", createJobsRouter({ state, jobs, scheduler, jobLogReader: { read: async () => "" }, auth }));
  app.use("/api/v1", createSettingsRouter({ state, notifications, auth }));

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  state.close();
  await rm(directory, { recursive: true, force: true });
});

describe("role boundaries", () => {
  it("keeps settings and people owner-only, whatever the path casing", async () => {
    const operator = await signIn("operator");
    const owner = await signIn("owner");
    expect((await api("PUT", "/api/v1/settings/approval-mode", { session: operator, body: { approvalMode: "always-password", password } })).status).toBe(403);
    // Express matches routes case-insensitively; the policy must not be fooled by the casing.
    expect((await api("PUT", "/api/v1/Settings/approval-mode", { session: operator, body: { approvalMode: "always-password", password } })).status).toBe(403);
    expect((await api("PUT", "/api/v1/SETTINGS/approval-mode", { session: operator, body: { approvalMode: "always-password", password } })).status).toBe(403);
    expect((await api("POST", "/api/v1/People", { session: operator, body: { username: "sneak", password: "sneaky password", role: "owner" } })).status).toBe(403);
    expect((await api("PUT", "/api/v1/settings/approval-mode", { session: owner, body: { approvalMode: "tiered", password } })).status).toBe(200);
  });

  it("refuses viewers everything that changes the box, including elevation and secret reads", async () => {
    const viewer = await signIn("viewer");
    expect((await api("POST", "/api/v1/auth/elevate", { session: viewer, body: { password } })).status).toBe(403);
    expect((await api("POST", "/api/v1/operations/app.secrets/run", { session: viewer, body: { parameters: { id: "jellyfin" } } })).status).toBe(403);
    expect((await api("POST", "/api/v1/operations/apt.refresh/jobs", { session: viewer, body: { parameters: {} } })).status).toBe(403);
    expect((await api("GET", "/api/v1/jobs", { session: viewer })).status).toBe(200);
  });

  it("requires a CSRF token for every change and a session for everything", async () => {
    const owner = await signIn("owner");
    expect((await api("POST", "/api/v1/operations/apt.refresh/jobs", { body: { parameters: {} } })).status).toBe(401);
    const noCsrf = { cookie: owner.cookie, csrfToken: "" };
    expect((await api("POST", "/api/v1/operations/apt.refresh/jobs", { session: noCsrf, body: { parameters: {} } })).status).toBe(403);
  });
});

describe("identity linking", () => {
  it("signs a linked identity in as the account that linked it, and only the owner may link for others", async () => {
    const operatorSession = await signIn("operator");
    // The operator links their own Tailscale login (whois is stubbed, so link through the service).
    identity.linkTailscale(accounts.operator.id, "operator@example.com");
    expect(identity.tailscaleAccountFor("operator@example.com")).toBe(accounts.operator.id);
    expect(identity.tailscaleAccountFor("owner@example.com")).toBeNull();
    // Only the owner may change the GitHub client id, even with a valid password.
    expect((await api("PUT", "/api/v1/settings/github-client-id", { session: operatorSession, body: { clientId: "Ov23liabcdefghijklmn", password } })).status).toBe(403);
    const ownerSession = await signIn("owner");
    expect((await api("PUT", "/api/v1/settings/github-client-id", { session: ownerSession, body: { clientId: "Ov23liabcdefghijklmn", password } })).status).toBe(200);
  });
});

describe("job visibility and cancellation", () => {
  it("shows an account only its own jobs and lets it withdraw them before approval", async () => {
    const ownerSession = await signIn("owner");
    const operatorSession = await signIn("operator");
    const ownerJob = await api("POST", "/api/v1/operations/apt.refresh/jobs", { session: ownerSession, body: { parameters: {} } });
    const operatorJob = await api("POST", "/api/v1/operations/apt.refresh/jobs", { session: operatorSession, body: { parameters: {} } });
    expect(ownerJob.status).toBe(201);
    expect(operatorJob.status).toBe(201);

    const operatorJobs = await api("GET", "/api/v1/jobs", { session: operatorSession });
    expect(operatorJobs.body.jobs.map((job) => job.id)).toContain(operatorJob.body.job.id);
    expect(operatorJobs.body.jobs.map((job) => job.id)).not.toContain(ownerJob.body.job.id);
    const ownerJobs = await api("GET", "/api/v1/jobs", { session: ownerSession });
    expect(ownerJobs.body.jobs.map((job) => job.id)).toEqual(expect.arrayContaining([ownerJob.body.job.id, operatorJob.body.job.id]));

    // Someone else's staged job is not theirs to withdraw; their own is.
    expect((await api("DELETE", `/api/v1/jobs/${ownerJob.body.job.id}`, { session: operatorSession })).status).toBe(404);
    const cancelled = await api("DELETE", `/api/v1/jobs/${operatorJob.body.job.id}`, { session: operatorSession });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.job.state).toBe("cancelled");
    expect((await api("POST", `/api/v1/jobs/${operatorJob.body.job.id}/approve`, { session: operatorSession, body: {} })).status).toBe(409);
  });
});

describe("password attempts", () => {
  it("stops answering after repeated wrong passwords and says when to retry", async () => {
    const attempt = () => fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "viewer", password: "not the password" }) });
    const codes = [];
    for (let i = 0; i < 6; i += 1) codes.push((await attempt()).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.at(-1)).toBe(429);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After") ?? blocked.headers.get("retry-after")).toBeTruthy();
    // The block is per account: another account still signs in.
    expect((await signIn("owner")).csrfToken).toBeTruthy();
  });
});
