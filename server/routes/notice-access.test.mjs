// @vitest-environment node
/**
 * What the notification centre and the watch list tell someone who is not the owner (sweep 3).
 *
 * An automation's failure carries its step's job error, so its words go to the owner and to whoever
 * ran that run: decided by who ran the run the entry describes, recorded when it was raised, not by
 * whoever ran the flow last. And a kind of news nobody decided about is the owner's: the weekly
 * report names every account's failed jobs, which only the owner may preview. Driven over a real
 * socket with the real session, role policy, flow, job, alert and notification-history services and
 * the routes index.mjs mounts; only the root helper and the notification target are stand-ins.
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
import { createHealthAlerts, healthConditions, noticeKinds } from "../health-alerts.mjs";
import { createNotificationHistory } from "../notification-history.mjs";
import { apiRolePolicy } from "./access.mjs";
import { createJobsRouter } from "./jobs.mjs";
import { createSettingsRouter } from "./settings.mjs";

vi.setConfig({ testTimeout: 30_000 });

const password = "correct horse battery";
const secret = "OWNER-SECRET-7f3a";
let directory; let state; let server; let base; let owner; let operator; let alerts; let history;
const sessions = {};
// What the root helper answers. The owner's HTTP request fails with words only the owner should read.
const failing = new Set(["http.request"]);
const helper = {
  request: async (operation) => {
    if (failing.has(operation)) throw new Error(`${operation} failed: 401 from https://hooks.example/${secret}`);
    return { ok: true };
  },
};
let targetSet = true;
const notifications = { getTarget: () => (targetSet ? { kind: "ntfy" } : null), send: async () => {}, describe: () => ({ configured: targetSet }) };

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

async function until(check, what) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Run a flow as `who` and wait for its run, and the alert it raised, to settle. */
async function runAs(who, flowId) {
  const before = history.list().length;
  const started = await call("POST", `/api/v1/flows/${flowId}/run`, sessions[who]);
  expect(started.status).toBe(202);
  await until(() => !String(state.getFlow(flowId).lastResult ?? "running").startsWith("running"), "the run to finish");
  // The alert goes through the ledger's queue after the run's record is written.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return history.list().length > before;
}

const entryFor = async (who, key) => (await call("GET", "/api/v1/notifications", sessions[who])).body.entries.find((entry) => entry.family === key.split(":")[0] && (entry.key === key || entry.key === key.split(":")[0]));

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-notice-access-"));
  state = createStateStore({ stateDirectory: directory });
  const passwordHash = await hashPassword(password);
  owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "owner", passwordHash });
  operator = state.createOwnerAccount({ username: "operator", passwordHash, role: "operator", createdBy: owner.id });
  state.createOwnerAccount({ username: "other", passwordHash, role: "operator", createdBy: owner.id });
  state.createOwnerAccount({ username: "viewer", passwordHash, role: "viewer", createdBy: owner.id });
  const auth = createAuthService(state);
  history = createNotificationHistory({ store: state });
  alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications, store: state, history });
  const jobs = createJobService(state, helper, { alerts });
  const flows = createFlowService({ store: state, jobs, alerts, pollMs: 5, retryDelayMs: 0, library: [] });
  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  app.post("/api/v1/auth/login", auth.login);
  app.use("/api/v1", auth.requireSession);
  app.use("/api/v1", (req, res, next) => (["GET", "HEAD", "OPTIONS"].includes(req.method) ? next() : auth.requireCsrf(req, res, next)));
  app.use("/api/v1", apiRolePolicy());
  app.use("/api/v1", createJobsRouter({ state, jobs, scheduler: {}, flows, auth, jobLogReader: null }));
  app.use("/api/v1", createSettingsRouter({ state, notifications, notificationHistory: history, auth }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["owner", "operator", "other", "viewer"]) sessions[name] = await signIn(name);
});

beforeEach(() => {
  targetSet = true;
  failing.clear();
  failing.add("http.request");
  state.setSetting("healthAlertsState", {}, { updatedBy: null });
  state.setSetting("notificationHistory", [], { updatedBy: null });
});

afterAll(async () => {
  server?.closeAllConnections?.(); server?.close();
  state?.close?.();
  await rm(directory, { recursive: true, force: true });
});

describe("an automation's failure in the notification centre (R3S1-1)", () => {
  it("stays the owner's when the owner's run failed, after the operator runs the flow again", async () => {
    // The operator's flow, with a step the owner added that only the owner may run.
    const flowId = state.createFlow({ name: "Tidy", steps: [{ operationId: "apt.refresh", parameters: {} }, { operationId: "http.request", parameters: { url: "https://hooks.example/topic", method: "POST" }, ownerAdded: true }], createdBy: operator.id }).id;
    // The owner presses Run now: the owner's step fails, with words only the owner should read.
    expect(await runAs("owner", flowId)).toBe(true);
    expect(state.getFlow(flowId).lastResult).toMatch(/^stopped at step 2/);
    expect((await entryFor("owner", `flow.failed:${flowId}`)).message).toContain(secret);
    expect(await entryFor("operator", `flow.failed:${flowId}`)).toMatchObject({ key: "flow.failed", message: null });

    // The operator runs it: the owner's step is refused before a job exists, so the last run's jobs
    // are all the operator's. The entry still describes the owner's run.
    await runAs("operator", flowId);
    expect(state.getFlow(flowId).lastResult).toMatch(/^failed at step 2/);
    const lastJobs = state.getFlow(flowId).lastJobIds;
    expect(lastJobs).toHaveLength(2);
    expect(lastJobs[1]).toBeNull();
    expect(state.getJob(lastJobs[0]).createdBy).toBe(operator.id);

    const listed = await call("GET", "/api/v1/notifications", sessions.operator);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(await entryFor("operator", `flow.failed:${flowId}`)).toMatchObject({ key: "flow.failed", title: "An automation stopped or did not run", message: null });
    expect((await call("GET", "/api/v1/settings/watch", sessions.operator)).body.conditions.find((condition) => condition.key === "flow.failed").details[0].title).toBe("An automation stopped or did not run");
    expect((await entryFor("owner", `flow.failed:${flowId}`)).message).toContain(secret);
  });

  it("is in full for whoever ran the run it describes, and only the kind for anyone else", async () => {
    failing.add("apt.refresh");
    const flowId = state.createFlow({ name: "Refresh", steps: [{ operationId: "apt.refresh", parameters: {} }], createdBy: operator.id }).id;
    expect(await runAs("operator", flowId)).toBe(true);
    const full = { key: `flow.failed:${flowId}`, title: "Automation stopped: Refresh", message: expect.stringContaining("apt.refresh failed") };
    const label = { key: "flow.failed", title: "An automation stopped or did not run", message: null };
    expect(await entryFor("operator", `flow.failed:${flowId}`)).toMatchObject(full);
    expect(await entryFor("owner", `flow.failed:${flowId}`)).toMatchObject(full);
    expect(await entryFor("other", `flow.failed:${flowId}`)).toMatchObject(label);
    expect(await entryFor("viewer", `flow.failed:${flowId}`)).toMatchObject(label);
  });

  it("takes the words of the newest run when the first was never delivered, and with them its runner", async () => {
    // No target: the owner's failure is kept as not announced, and the operator's run replaces it.
    targetSet = false;
    const flowId = state.createFlow({ name: "Mirror", steps: [{ operationId: "apt.refresh", parameters: {} }, { operationId: "http.request", parameters: { url: "https://hooks.example/topic" }, ownerAdded: true }], createdBy: operator.id }).id;
    await runAs("owner", flowId);
    expect(await entryFor("operator", `flow.failed:${flowId}`)).toMatchObject({ key: "flow.failed", message: null });
    await runAs("operator", flowId);
    const own = await entryFor("operator", `flow.failed:${flowId}`);
    expect(own).toMatchObject({ key: `flow.failed:${flowId}`, message: expect.stringContaining("Only the owner can stage this operation") });
    expect(JSON.stringify(own)).not.toContain(secret);
  });

  it("is the kind only, for anyone but the owner, when it was recorded before the runner was", async () => {
    history.record({ key: "flow.failed:legacy", kind: "alert", title: "Automation stopped: Old", message: `Old stopped at step 1: ${secret}`, delivered: true });
    expect(await entryFor("operator", "flow.failed:legacy")).toMatchObject({ key: "flow.failed", message: null });
    expect((await entryFor("owner", "flow.failed:legacy")).message).toContain(secret);
  });
});

describe("news nobody but the owner decided about (R3S1-2)", () => {
  it("keeps the weekly report's words to the owner, on the notification centre and the watch list", async () => {
    targetSet = true;
    await alerts.tell({ key: "report.weekly", title: "Weekly report: 2 jobs failed", message: `Back up application data (${secret}) failed for owner.` });
    for (const who of ["operator", "viewer"]) {
      const listed = await call("GET", "/api/v1/notifications", sessions[who]);
      expect(JSON.stringify(listed.body), who).not.toContain(secret);
      expect(listed.body.entries.find((entry) => entry.family === "report.weekly"), who).toMatchObject({ key: "report.weekly", title: "The weekly report", message: null });
    }
    expect((await entryFor("owner", "report.weekly")).message).toContain(secret);
    // Kept because nothing could send it, it is a notice on the watch list.
    targetSet = false;
    await alerts.tell({ key: "report.weekly", title: `Weekly report: ${secret}`, message: secret });
    const watch = (await call("GET", "/api/v1/settings/watch", sessions.viewer)).body;
    expect(JSON.stringify(watch)).not.toContain(secret);
    expect(watch.notices.find((notice) => notice.key === "report.weekly").title).toBe("The weekly report");
  });

  it("gives a kind it does not know only as its kind to anyone but the owner", async () => {
    targetSet = true;
    await alerts.tell({ key: "something.new:x", title: `Something new: ${secret}`, message: secret });
    const entry = (await call("GET", "/api/v1/notifications", sessions.viewer)).body.entries.find((item) => item.family === "something.new");
    expect(entry).toMatchObject({ key: "something.new", message: null });
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("still gives every role the server's own conditions and news in full", async () => {
    targetSet = true;
    // Every kind BoxPilot says, and what a viewer reads of it with nobody's account behind it.
    const everyone = ["storage.root.full", "storage.mount.full", "storage.smart", "storage.mount.detached", "storage.mount.readonly", "power.ups", "system.services", "system.reboot", "docker.unhealthy", "docker.restarting", "storage.forecast", "smart.errors", "smart.wear", "joblog.unreadable", "release.available", "drive.reconnected", "boxpilot.restart"];
    const ownersOrTheirs = ["schedule.overdue", "schedule.failed", "flow.failed", "record.failed", "job.interrupted", "signin.new", "report.weekly", "approval.lapsed", "agent.important"];
    expect([...everyone, ...ownersOrTheirs].sort()).toEqual([...Object.keys(healthConditions), ...Object.keys(noticeKinds)].sort());
    for (const family of [...everyone, ...ownersOrTheirs]) {
      history.record({ key: `${family}:subject`, kind: Object.hasOwn(noticeKinds, family) ? "notice" : "alert", title: `The words of ${family}`, message: `More about ${family}`, delivered: true });
    }
    const entries = (await call("GET", "/api/v1/notifications", sessions.viewer)).body.entries;
    for (const family of everyone) expect(entries.find((entry) => entry.family === family), family).toMatchObject({ key: `${family}:subject`, title: `The words of ${family}`, message: `More about ${family}` });
    for (const family of ownersOrTheirs) expect(entries.find((entry) => entry.family === family), family).toMatchObject({ key: family, message: null });
  });
});
