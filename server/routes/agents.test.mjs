// @vitest-environment node
/**
 * The Agents routes over HTTP (M37): the real runner talking to the web service the way
 * runner-main does - its key, loopback, long poll, tools, finish - while a page follows the run's
 * trace as server-sent events; and the owner's settings behind the password. Roles and casing for
 * every route are in route-matrix.test.mjs.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { createRunner, createRunnerApi } from "../agents/runner.mjs";
import { createAgentRunnerRouter } from "./agent-runner.mjs";
import { createAgentsRouter } from "./agents.mjs";

let h;
let server;
let base;
let token;

const auth = {
  requireCsrf: (_request, _response, next) => next(),
  requireRole: (role) => (request, response, next) => (request.boxpilotSession.owner.role === role ? next() : response.status(403).json({ error: "forbidden" })),
  checkPassword: async (_request, _owner, password) => ({ ok: password === "right", blocked: false }),
  rejectThrottled: (response) => response.status(429).json({ error: "throttled" }),
};

beforeAll(async () => {
  h = await createAgentsHarness({ start: new Date() });
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createAgentRunnerRouter({ agents: h.service }));
  app.use((request, _response, next) => {
    const role = request.headers["x-test-role"] ?? "owner";
    request.boxpilotSession = { owner: { id: h.accounts[role]?.id ?? h.accounts.owner.id, role } };
    next();
  });
  app.use("/api/v1", createAgentsRouter({ agents: h.service, state: h.state, auth }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await h.close();
});

const request = async (method, pathname, { role = "owner", body } = {}) => {
  const response = await fetch(`${base}${pathname}`, { method, headers: { "Content-Type": "application/json", "x-test-role": role }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
};

describe("turning Agents on", () => {
  it("is the owner's, with the password, and issues the runner's key", async () => {
    expect((await request("PUT", "/api/v1/settings/agents", { role: "operator", body: { enabled: true, password: "right" } })).status).toBe(403);
    expect((await request("PUT", "/api/v1/settings/agents", { body: { enabled: true, password: "wrong" } })).status).toBe(401);
    expect(await request("PUT", "/api/v1/settings/agents", { body: { runtime: { driver: "external", endpoint: "http://192.168.1.20:8080" }, password: "right" } })).toMatchObject({ status: 400, body: { code: "invalid_setting" } });
    const saved = await request("PUT", "/api/v1/settings/agents", { body: { enabled: true, quietHours: { start: "01:00", end: "05:00" }, runtime: { driver: "external", endpoint: h.fake.url }, password: "right" } });
    expect(saved).toMatchObject({ status: 200, body: { module: { enabled: true, quietHours: { start: "01:00", end: "05:00" } }, runtime: { driver: "external", endpoint: h.fake.url } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    token = (await readFile(path.join(h.directory, "agents", "runner.token"), "utf8")).trim();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(h.state.listAudit(20))).not.toContain("right");
  });
});

describe("a run, from the question to the answer, over HTTP", () => {
  it("is taken by the runner with its key, streamed to the page step by step, and answered", async () => {
    const created = await request("POST", "/api/v1/agents", { body: { template: "it-support" } });
    expect(created.status).toBe(201);
    const asked = await request("POST", `/api/v1/agents/${created.body.id}/ask`, { role: "viewer", body: { question: "What is this server called?" } });
    expect(asked).toMatchObject({ status: 202, body: { state: "queued" } });

    // The page follows the run...
    const events = [];
    const stream = fetch(`${base}/api/v1/agents/runs/${asked.body.id}/stream`, { headers: { "x-test-role": "viewer" } }).then(async (response) => {
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const text = await response.text();
      for (const match of text.matchAll(/event: (\w+)\ndata: ([^\n]*)\n\n/g)) events.push([match[1], JSON.parse(match[2])]);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // ...while the runner, as runner-main starts it, takes the run over HTTP and carries it out.
    const api = createRunnerApi({ base, token, runnerId: h.runnerId });
    const runner = createRunner({ api, runtime: h.runtime, client: h.client });
    const response = await api.next({ waitMs: 0 });
    expect(response.claim.run.id).toBe(asked.body.id);
    await runner.execute(response.claim);
    await stream;

    expect(events[0][0]).toBe("snapshot");
    expect(events.filter(([event]) => event === "step").map(([, step]) => step.kind)).toEqual(expect.arrayContaining(["model", "tool"]));
    const [, final] = events.at(-1);
    expect(final).toMatchObject({ id: asked.body.id, state: "completed" });
    expect(final.answer).toContain("testbox");
    const run = await request("GET", `/api/v1/agents/runs/${asked.body.id}`, { role: "viewer" });
    expect(run.body.steps.length).toBeGreaterThan(2);
  });

  it("refuses the runner without its key, and a stale lease", async () => {
    const wrong = createRunnerApi({ base, token: "x".repeat(43), runnerId: h.runnerId });
    await expect(wrong.next({ waitMs: 0 })).rejects.toMatchObject({ status: 401 });
    const api = createRunnerApi({ base, token, runnerId: h.runnerId });
    await expect(api.tool("11111111-2222-4333-8444-555555555555", "not-a-lease", "server_facts", "{}")).rejects.toMatchObject({ status: 409 });
  });
});

describe("the module's switches, over HTTP", () => {
  it("pauses until tomorrow, resumes, and stops everything with the kill switch", async () => {
    expect((await request("POST", "/api/v1/agents/module/pause", { role: "operator", body: { until: "tomorrow" } })).body).toMatchObject({ paused: true });
    expect((await request("POST", "/api/v1/agents/module/resume", { role: "operator" })).body).toMatchObject({ paused: false });
    expect((await request("POST", "/api/v1/agents/module/kill", { role: "operator" })).body).toMatchObject({ module: { paused: true } });
    expect((await request("POST", "/api/v1/agents/module/resume", { role: "operator" })).status).toBe(403);
    expect((await request("POST", "/api/v1/agents/module/resume")).status).toBe(200);
  });
});
