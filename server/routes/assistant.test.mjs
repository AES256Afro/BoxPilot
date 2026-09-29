// @vitest-environment node
/**
 * The assistant's routes (M34.2): JSON and server-sent events, the errors a page can act on, a
 * person hanging up part-way, and the owner-only settings. Roles and casing are in route-matrix.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeOllama } from "../../test/fake-ollama.mjs";
import { createAssistantService } from "../assistant/index.mjs";
import { createKnowledgeIndex } from "../assistant/knowledge.mjs";
import { registry } from "../ops/index.mjs";
import { createRedactor } from "../redaction.mjs";
import { createStateStore } from "../state.mjs";
import { createAssistantRouter } from "./assistant.mjs";

let directory;
let state;
let fake;
let server;
let base;
let assistant;
const accounts = {};

// A role-aware stub: the caller is named by x-test-role; the owner's password is "right".
const auth = {
  requireCsrf: (_request, _response, next) => next(),
  requireRole: (role) => (request, response, next) => (request.boxpilotSession.owner.role === role ? next() : response.status(403).json({ error: "forbidden" })),
  checkPassword: async (_request, _owner, password) => ({ ok: password === "right", blocked: false }),
  rejectThrottled: (response) => response.status(429).json({ error: "throttled" }),
};

async function post(pathname, role, body, headers = {}) {
  const response = await fetch(`${base}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-role": role, ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-assistant-routes-"));
  state = createStateStore({ stateDirectory: directory });
  accounts.owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "owner", passwordHash: "x" });
  accounts.operator = state.createOwnerAccount({ username: "operator", passwordHash: "x", role: "operator", createdBy: accounts.owner.id });
  fake = await startFakeOllama({ models: ["hermes3:8b"], answer: "Open the app's card and pick a backup [S1]." });
  state.setSetting("assistant", { endpoint: fake.url, model: null, embedModel: null });
  const knowledge = createKnowledgeIndex({
    registry,
    catalog: null,
    root: "/repo",
    readDirectory: async () => ["BACKUPS.md"],
    readText: async (file) => (file.replaceAll("\\", "/").endsWith("docs/BACKUPS.md") ? "# Backups\n\n## Restore\n\nOpen the app's card and pick a backup to restore.\n" : "# Agents\n\nRead this first.\n"),
  });
  assistant = createAssistantService({ state, registry, knowledge, redactor: createRedactor() });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const role = request.headers["x-test-role"] ?? "owner";
    request.boxpilotSession = { owner: { id: accounts[role]?.id ?? accounts.owner.id, role } };
    next();
  });
  app.use("/api/v1", createAssistantRouter({ assistant, state, auth }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await fake?.close();
  state?.close();
  await rm(directory, { recursive: true, force: true });
});

afterEach(() => {
  Object.assign(fake.state, { chat: "answer", answer: "Open the app's card and pick a backup [S1].", delayMs: 0 });
  fake.reset();
});

describe("POST /assistant/ask", () => {
  it("answers in JSON when the page does not ask for a stream", async () => {
    const { status, body } = await post("/api/v1/assistant/ask", "owner", { question: "How do I restore a backup?" });
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["answer", "citations", "degraded", "model", "notes", "plan", "sources"]);
    expect(body).toMatchObject({ answer: "Open the app's card and pick a backup [S1].", model: "hermes3:8b", degraded: null, plan: { steps: [], dropped: [] } });
    expect(body.sources[0]).toMatchObject({ id: "S1", kind: "doc", ref: { path: "docs/BACKUPS.md", heading: "Restore" }, cited: true });
  });

  it("answers the page's mistakes with a status and a sentence", async () => {
    expect(await post("/api/v1/assistant/ask", "owner", { question: "" })).toMatchObject({ status: 400, body: { code: "invalid_question" } });
    expect(await post("/api/v1/assistant/ask", "owner", { question: "What happened?", context: { jobId: "00000000-0000-4000-8000-000000000000" } })).toMatchObject({ status: 404, body: { code: "job_not_found" } });
    const held = assistant.begin({ id: accounts.owner.id, role: "owner" }, { question: "held" });
    try {
      expect(await post("/api/v1/assistant/ask", "owner", { question: "Another?" })).toMatchObject({ status: 429, body: { code: "assistant_busy" } });
    } finally {
      held.cancel();
    }
  });

  it("stops writing an answer when the person hangs up, and gives their slot back", async () => {
    Object.assign(fake.state, { answer: "A long answer that takes its time. ".repeat(20), chunkSize: 4, delayMs: 50 });
    const hangUp = new AbortController();
    const response = await fetch(`${base}/api/v1/assistant/ask`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", "x-test-role": "operator" }, body: JSON.stringify({ question: "How do I restore a backup?" }), signal: hangUp.signal });
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes("event: delta")) text += Buffer.from((await reader.read()).value).toString("utf8");
    hangUp.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(() => assistant.begin({ id: accounts.operator.id, role: "operator" }, { question: "again" }).cancel(), { timeout: 3_000, interval: 50 });
    await vi.waitFor(() => expect(state.listAudit(20).find((event) => event.type === "assistant.asked" && event.actorId === accounts.operator.id)?.details.outcome).toBe("cancelled"), { timeout: 3_000, interval: 50 });
  });
});

describe("PUT /settings/assistant", () => {
  it("is the owner's, with the password, and keeps the model on this network", async () => {
    const put = async (role, body) => {
      const response = await fetch(`${base}/api/v1/settings/assistant`, { method: "PUT", headers: { "Content-Type": "application/json", "x-test-role": role }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    expect((await put("operator", { endpoint: fake.url, password: "right" })).status).toBe(403);
    expect((await put("owner", { endpoint: fake.url, password: "wrong" })).status).toBe(401);
    expect(await put("owner", { endpoint: "https://api.example.com", password: "right" })).toMatchObject({ status: 400, body: { code: "invalid_setting" } });
    // The stand-in speaks Ollama's own API, the legacy provider (M37 made the OpenAI one the default).
    const saved = await put("owner", { provider: "ollama", endpoint: `${fake.url}/`, model: "hermes3:8b", password: "right" });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toEqual({ provider: "ollama", endpoint: fake.url, model: "hermes3:8b", embedModel: null });
    expect(saved.body.status).toMatchObject({ ready: true, source: "setting" });
    expect(JSON.stringify(state.listAudit(20))).not.toContain("right");
  });
});

describe("GET /assistant/status", () => {
  it("says whether the model answers and how big the index is", async () => {
    const body = await (await fetch(`${base}/api/v1/assistant/status`, { headers: { "x-test-role": "owner" } })).json();
    expect(body).toMatchObject({ ready: true, reachable: true, chatModel: "hermes3:8b", embeddings: false, index: { documents: 2, operations: registry.list().length, apps: 0 } });
  });
});
