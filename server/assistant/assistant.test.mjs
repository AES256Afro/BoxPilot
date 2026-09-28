// @vitest-environment node
/**
 * The assistant as a whole (M34.1, M34.2): a real state store with three accounts' work on record,
 * the real operation registry, a stub helper, and a stand-in model server on a loopback port. Each
 * test reads what the model was actually sent.
 */
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeOllama } from "../../test/fake-ollama.mjs";
import { registry } from "../ops/index.mjs";
import { createRedactor } from "../redaction.mjs";
import { createStateStore } from "../state.mjs";
import { AssistantError, createAssistantService, normalizeAssistantSettings } from "./index.mjs";
import { createKnowledgeIndex } from "./knowledge.mjs";

let directory;
let state;
let fake;
const accounts = {};
const jobs = {};
const helperCalls = [];

const documents = {
  "AGENTS.md": "# Working on BoxPilot\n\n## Copy\n\nSay what the action does.\n",
  "docs/BACKUPS.md": "# Backups\n\n## Restore\n\nTo restore an app, open its card, pick a backup archive and approve the restore.\n",
  "docs/LAB.md": "# Lab\n\n## The lab router\n\nThe lab router password: SENTINEL-DOC-9 and the lab address is SENTINEL-LITERAL-10.\n",
};
const catalogManifests = [
  { id: "jellyfin", name: "Jellyfin", category: "Media", description: "Streams films and music.", ports: [{ id: "web", label: "Web", host: 8096 }], sha256: "j" },
  { id: "ollama", name: "Ollama", category: "AI", description: "Runs language models.", ports: [{ id: "api", label: "API", container: 11434, host: 11434 }], modelRunner: { kind: "ollama", service: "ollama" }, sha256: "o" },
];
const catalog = { all: async () => ({ manifests: catalogManifests }), get: async (id) => catalogManifests.find((manifest) => manifest.id === id) ?? null };

let applications = [];
const helper = {
  request: async (operation, parameters) => {
    helperCalls.push({ operation, parameters });
    if (operation === "app.inspect") return { applications };
    if (operation === "app.logs") return { id: parameters.id, lines: ["2026-09-28T10:00:00Z starting", "token=SENTINEL-APPLOG-8", "2026-09-28T10:00:05Z crashed: database locked"] };
    return {};
  },
};
const inventory = { inspect: async () => ({ storage: { root: { usedPercent: 93, freeBytes: 14e9, totalBytes: 200e9 }, filesystems: { available: true, mounts: [{ target: "/srv", usedPercent: 81, capacityState: "warning", readOnly: false }] }, smart: { available: true, status: "warning", summary: { healthy: 1, warning: 1, critical: 0, unavailable: 0 }, disks: [{ device: "/dev/sdb", health: "warning", reason: "reallocated-sectors" }] } } }) };

const answerWithPlan = [
  "The package refresh failed because a mirror did not answer [S1].",
  "",
  "```plan",
  '[{"operationId": "apt.refresh", "parameters": {}, "why": "Try the refresh again."},',
  ' {"operationId": "app.purge", "parameters": {"id": "jellyfin"}, "why": "Start over."},',
  ' {"operationId": "no.such.operation", "parameters": {}, "why": "Made up."}]',
  "```",
].join("\n");

const services = [];
function service(overrides = {}) {
  const knowledge = createKnowledgeIndex({
    registry,
    catalog,
    root: "/repo",
    readDirectory: async () => Object.keys(documents).filter((name) => name.startsWith("docs/")).map((name) => name.slice(5)),
    readText: async (file) => {
      const relative = path.relative("/repo", file).replaceAll("\\", "/");
      if (!(relative in documents)) throw new Error("missing");
      return documents[relative];
    },
  });
  const created = createAssistantService({
    state, registry, catalog, helper, inventory, knowledge,
    secretEnvNamesFor: async (appId) => (appId === "jellyfin" ? ["ADMIN_PASSWORD"] : null),
    redactor: createRedactor({ additionalLiterals: ["SENTINEL-LITERAL-10"] }),
    ...overrides,
  });
  services.push(created);
  return created;
}
const caller = (role) => ({ id: accounts[role].id, role });
const thrown = (fn) => { try { fn(); } catch (error) { return error; } return null; };
const promptText = () => JSON.stringify(fake.prompts()).toLowerCase();
const failJob = (job, error, output) => {
  state.transitionJob(job.id, "awaiting_approval", "failed", { error });
  if (output) state.saveJobOutput(job.id, output);
  return state.getJob(job.id);
};

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-assistant-"));
  state = createStateStore({ stateDirectory: directory });
  accounts.owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "owner", passwordHash: "x" });
  accounts.operator = state.createOwnerAccount({ username: "operator", passwordHash: "x", role: "operator", createdBy: accounts.owner.id });
  accounts.viewer = state.createOwnerAccount({ username: "viewer", passwordHash: "x", role: "viewer", createdBy: accounts.owner.id });
  const { owner, operator } = accounts;

  // The owner's work, and secrets that must never reach the model: in a secret parameter whose name
  // the redactor would not recognise, in a whole Compose file, in an app's env, and in errors.
  jobs.ownerCredential = failJob(state.createJob({ type: "op:credentials.set", title: "Save a credential", parameters: { name: "ntfy", value: "SENTINEL-VALUE-1" }, createdBy: owner.id }), "Authorization: Bearer SENTINEL-BEARER-4 was refused");
  jobs.ownerCompose = failJob(state.createJob({ type: "op:app.compose.edit", title: "Edit application compose file", parameters: { id: "jellyfin", compose: "services:\n  app:\n    environment:\n      - KEY=SENTINEL-COMPOSE-2" }, createdBy: owner.id }), "compose did not validate");
  jobs.ownerInstall = failJob(state.createJob({ type: "op:app.install", title: "Install application", parameters: { id: "jellyfin", values: { env: { ADMIN_PASSWORD: "SENTINEL-ENV-3", TZ: "Europe/Paris" } } }, createdBy: owner.id }), "port 8096 is taken");
  jobs.ownerUnknown = failJob(state.createJob({ type: "legacy.thing", title: "An old job", parameters: { apiSecret: "SENTINEL-LEGACY-11" }, createdBy: owner.id }), "old failure");
  // The most recent: the owner's refresh, then the operator's.
  jobs.ownerRefresh = failJob(state.createJob({ type: "op:apt.refresh", title: "Refresh package lists", parameters: {}, createdBy: owner.id }), "OWNERMARK mirror unreachable", "Hit:1 archive\nErr:2 mirror OWNERMARK-log\nexport RESTIC_PASSWORD=SENTINEL-LOG-5\n");
  jobs.operatorRefresh = failJob(state.createJob({ type: "op:apt.refresh", title: "Refresh package lists", parameters: {}, createdBy: operator.id }), "OPERMARK lock held by another process", "Could not get lock OPERMARK-log\n");

  const ownerSchedule = state.createSchedule({ operationId: "apt.refresh", parameters: {}, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id, nextDueAt: "2026-09-29T03:00:00.000Z" });
  state.setSetting("healthAlertsState", {
    "storage.root.full": { title: "Root disk is 93% full", since: "2026-09-27T00:00:00Z", notified: true },
    [`schedule.failed:${ownerSchedule.id}`]: { title: "Scheduled task failed: OWNERMARK-schedule", since: "2026-09-27T00:00:00Z", notified: false },
    [`signin.new:${operator.id}:192.0.2.11`]: { title: "New sign-in from 192.0.2.11 (OPERMARK-signin)", since: "2026-09-27T00:00:00Z", notified: false },
    "job.interrupted:apt.refresh:OWNERMARK-interrupted": { title: "Refresh package lists (OWNERMARK-interrupted) was interrupted", since: "2026-09-27T00:00:00Z", notified: false },
    "system.services": { title: "Webhook https://user:SENTINEL-URL-6@hooks.example.test failed", since: "2026-09-27T00:00:00Z", notified: true },
  });
  state.recordBackup({ id: "b1", applicationId: "jellyfin", destination: "local-managed", artifactPath: "/var/lib/boxpilot-managed/backups/jellyfin/b1.tar.gz", checksumSha256: "a".repeat(64), sizeBytes: 2e9, downtimeMs: 0, restoreDrill: { passed: true }, createdBy: owner.id });
  applications = [{ id: "jellyfin", installed: true, container: { running: true, status: "running", health: "unhealthy", restarts: 4 }, state: { values: { env: { API_KEY: "SENTINEL-APPENV-7" } } }, urls: [{ id: "web", label: "Web", host: 8096 }] }];

  fake = await startFakeOllama({ answer: answerWithPlan });
  state.setSetting("assistant", { endpoint: fake.url, model: null, embedModel: null });
});

afterAll(async () => {
  await fake?.close();
  state?.close();
  await rm(directory, { recursive: true, force: true });
});

afterEach(async () => {
  // Background embedding from one test must not reach the next one's record of requests.
  await Promise.all(services.splice(0).map((created) => created.whenIdle()));
  fake.reset();
  helperCalls.length = 0;
  Object.assign(fake.state, { models: ["hermes3:8b", "nomic-embed-text:latest"], answer: answerWithPlan, chat: "answer", chunkSize: 16, delayMs: 0 });
  state.setSetting("assistant", { endpoint: fake.url, model: null, embedModel: null });
});

describe("what goes into the model's context, per role", () => {
  it("gives the owner every account's failed jobs, their logs and every alert in full", async () => {
    await service().ask(caller("owner"), { question: "Why did the package refresh fail?" });
    const prompt = promptText();
    for (const expected of ["ownermark mirror unreachable", "ownermark-log", "opermark lock held", "ownermark-schedule", "opermark-signin", "root disk is 93% full"]) expect(prompt, expected).toContain(expected);
  });

  it("gives an operator their own jobs only, and cuts other accounts' alerts back to their kind", async () => {
    await service().ask(caller("operator"), { question: "Why did the package refresh fail?" });
    const prompt = promptText();
    expect(prompt).toContain("opermark lock held");
    expect(prompt).toContain("opermark-log");
    expect(prompt).toContain("opermark-signin");
    for (const foreign of ["ownermark", accounts.owner.id, jobs.ownerRefresh.id, jobs.ownerInstall.id]) expect(prompt, foreign).not.toContain(String(foreign).toLowerCase());
    expect(prompt).toContain("a scheduled task failed or did not run");
    expect(prompt).toContain("a job was cut off by a restart");
  });

  it("gives a viewer no one else's jobs, alerts or ids, and no operator read", async () => {
    const result = await service().ask(caller("viewer"), { question: "Why did the package refresh fail?", context: { appId: "jellyfin" } });
    const prompt = promptText();
    for (const foreign of ["ownermark", "opermark", accounts.owner.id, accounts.operator.id, ...Object.values(jobs).map((job) => job.id)]) expect(prompt, foreign).not.toContain(String(foreign).toLowerCase());
    expect(prompt).toContain("a sign-in from a new address");
    expect(prompt).toContain("root disk is 93% full");
    expect(prompt).toContain("jellyfin: running, health unhealthy, 4 restarts");
    expect(helperCalls.map((entry) => entry.operation)).not.toContain("app.logs");
    expect(result.notes).toContain("Application logs need an operator, so they were not read for you.");
    expect(JSON.stringify(result).toLowerCase()).not.toContain("ownermark");
  });

  it("reads an app's container log for an operator asking about that app", async () => {
    const result = await service().ask(caller("operator"), { question: "Why does Jellyfin keep restarting?", context: { appId: "jellyfin" } });
    expect(helperCalls.map((entry) => entry.operation)).toContain("app.logs");
    expect(promptText()).toContain("crashed: database locked");
    expect(result.sources.find((source) => source.kind === "log" && source.ref.appId === "jellyfin")).toBeTruthy();
  });

  it("answers about a job only for someone who may read it, and puts that job first", async () => {
    const assistant = service();
    for (const role of ["viewer", "operator"]) {
      expect(thrown(() => assistant.begin(caller(role), { question: "What happened?", context: { jobId: jobs.ownerRefresh.id } })), role).toMatchObject({ status: 404, code: "job_not_found" });
    }
    const result = await assistant.ask(caller("operator"), { question: "What happened?", context: { jobId: jobs.operatorRefresh.id } });
    expect(result.sources[0]).toMatchObject({ id: "S1", kind: "job", ref: { jobId: jobs.operatorRefresh.id } });
    expect(result.sources[1]).toMatchObject({ kind: "log", ref: { jobId: jobs.operatorRefresh.id } });
  });
});

describe("secrets", () => {
  it("never lets a planted secret reach the prompt or the answer", async () => {
    const result = await service({ limits: { failedJobs: 10 } }).ask(caller("owner"), { question: "Tell me about the lab router and why my jobs failed", context: { appId: "jellyfin" } });
    const prompt = promptText();
    // Every place a secret was planted was read: the jobs, the app, its log and the document.
    for (const job of Object.values(jobs).filter((entry) => entry.createdBy === accounts.owner.id)) expect(prompt).toContain(job.id);
    expect(prompt).toContain("the lab router password");
    expect(prompt).toContain("database locked");
    expect(prompt).toContain("europe/paris");
    for (let number = 1; number <= 11; number += 1) {
      const pattern = new RegExp(`sentinel-[a-z]+-${number}(?![0-9])`);
      expect(prompt, `sentinel ${number} in the prompt`).not.toMatch(pattern);
      expect(JSON.stringify(result).toLowerCase(), `sentinel ${number} in the answer`).not.toMatch(pattern);
    }
    expect(prompt).toContain("[secret]");
  });
});

describe("plans", () => {
  it("validates each step against the registry and the asker, and shows each step's tier", async () => {
    const owner = await service().ask(caller("owner"), { question: "Why did the package refresh fail?" });
    expect(owner.plan.steps.map((step) => [step.operationId, step.risk])).toEqual([["apt.refresh", "low"], ["app.purge", "high"]]);
    expect(owner.plan.steps[0].request).toEqual({ method: "POST", path: "/api/v1/operations/apt.refresh/jobs", body: { parameters: {} } });
    expect(owner.plan.dropped).toEqual([{ index: 2, operationId: "no.such.operation", reason: "BoxPilot has no operation called no.such.operation" }]);
    expect(owner.answer).not.toContain("```");

    const operator = await service().ask(caller("operator"), { question: "Why did the package refresh fail?" });
    expect(operator.plan.steps.map((step) => step.operationId)).toEqual(["apt.refresh"]);
    expect(operator.plan.dropped.map((entry) => entry.reason)).toContain("Only the owner can approve high-risk operations");

    const viewer = await service().ask(caller("viewer"), { question: "Why did the package refresh fail?" });
    expect(viewer.plan).toBeNull();
    expect(fake.prompts().at(-1).messages[1].content).toContain("do not include a plan block");
  });

  it("stages nothing and runs nothing", async () => {
    const before = state.listJobs(200).length;
    await service().ask(caller("owner"), { question: "Why did the package refresh fail?" });
    expect(state.listJobs(200).length).toBe(before);
    expect(helperCalls.map((entry) => entry.operation).filter((operation) => !["app.inspect", "app.logs"].includes(operation))).toEqual([]);
  });
});

describe("citations", () => {
  it("marks what was cited, names ids the model made up, and lists claims with no source", async () => {
    fake.state.answer = "The refresh failed because a mirror did not answer [S1]. The restore steps are in the backup notes [S42].\nThe server will need more memory next month for certain.";
    const result = await service().ask(caller("owner"), { question: "Why did the package refresh fail?" });
    expect(result.sources[0].cited).toBe(true);
    expect(result.sources.slice(1).every((source) => !source.cited)).toBe(true);
    expect(result.citations.unknown).toEqual(["S42"]);
    expect(result.citations.uncited).toEqual(["The server will need more memory next month for certain."]);
    expect(result.sources.every((source) => /^S\d+$/.test(source.id) && source.title && source.ref)).toBe(true);
  });
});

describe("without a model", () => {
  it("answers with what it found when no model is set up, and says so", async () => {
    state.setSetting("assistant", { endpoint: null, model: null, embedModel: null });
    const assistant = service();
    const status = await assistant.status(caller("owner"));
    expect(status).toMatchObject({ ready: false, source: "none", problem: { reason: "no-model" } });
    const result = await assistant.ask(caller("owner"), { question: "How do I restore a backup?" });
    expect(result.degraded).toMatchObject({ reason: "no-model" });
    expect(result.model).toBeNull();
    expect(result.answer).toContain("No local model is set up");
    expect(result.answer).toMatch(/\[S1\]/);
    expect(result.sources.some((source) => source.ref.path === "docs/BACKUPS.md")).toBe(true);
    expect(result.plan).toEqual({ steps: [], dropped: [] });
    expect(fake.prompts()).toEqual([]);
  });

  it("says the model server did not answer when nothing listens at its address", async () => {
    const closed = http.createServer();
    closed.listen(0, "127.0.0.1");
    await new Promise((resolve) => closed.once("listening", resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    state.setSetting("assistant", { endpoint: `http://127.0.0.1:${port}`, model: null, embedModel: null });
    const result = await service().ask(caller("viewer"), { question: "How do I restore a backup?" });
    expect(result.degraded).toMatchObject({ reason: "unreachable" });
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it("says the chosen model is missing rather than using another", async () => {
    state.setSetting("assistant", { endpoint: fake.url, model: "llama9:70b", embedModel: null });
    const result = await service().ask(caller("owner"), { question: "How do I restore a backup?" });
    expect(result.degraded).toMatchObject({ reason: "model-missing" });
    expect(fake.prompts()).toEqual([]);
  });

  it("finds the catalog's Ollama when it is installed and nothing else is set", async () => {
    state.setSetting("assistant", { endpoint: null, model: null, embedModel: null });
    const saved = applications;
    applications = [...saved, { id: "ollama", installed: true, container: { running: true }, state: { values: { ports: { api: fake.port } } }, urls: [] }];
    try {
      const status = await service().status(caller("owner"));
      expect(status).toMatchObject({ ready: true, source: "catalog", endpoint: `http://127.0.0.1:${fake.port}`, chatModel: "hermes3:8b", embeddings: true });
    } finally {
      applications = saved;
    }
  });
});

describe("bounds", () => {
  it("stops at the deadline and still answers with the sources", async () => {
    fake.state.chat = "hang";
    const result = await service({ limits: { timeoutMs: 300 } }).ask(caller("owner"), { question: "How do I restore a backup?" });
    expect(result.degraded).toMatchObject({ reason: "timeout" });
    expect(result.answer).toContain("The local model took too long");
    expect(result.sources.length).toBeGreaterThan(0);
    const [event] = state.listAudit(10).filter((entry) => entry.type === "assistant.asked");
    expect(event.details.outcome).toBe("timeout");
  });

  it("keeps what the model had written when the deadline cut it off", async () => {
    Object.assign(fake.state, { answer: "The refresh failed because a mirror did not answer, and here is more text that never finishes.", chunkSize: 8, delayMs: 150 });
    const result = await service({ limits: { timeoutMs: 400 } }).ask(caller("owner"), { question: "Why did it fail?" });
    expect(result.degraded).toMatchObject({ reason: "timeout" });
    expect(result.answer).toMatch(/^The refr/);
    expect(result.answer).toContain("(The model took too long, so the answer stops here.)");
  });

  it("cuts an answer off at its size limit", async () => {
    fake.state.answer = "word ".repeat(200);
    const result = await service({ limits: { answerChars: 50 } }).ask(caller("owner"), { question: "Say a lot" });
    expect(result.answer).toContain("(The answer was cut off at its size limit.)");
    expect(result.answer.length).toBeLessThan(120);
  });

  it("keeps the prompt within its budget", async () => {
    await service({ limits: { promptChars: 5_000, failedJobs: 10 } }).ask(caller("owner"), { question: "Why did my jobs fail?" });
    const [body] = fake.prompts();
    expect(body.messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(5_000);
    expect(body.options).toMatchObject({ num_predict: 1024, num_ctx: 8192 });
  });

  it("writes one answer at a time per account", async () => {
    const assistant = service();
    const first = assistant.begin(caller("owner"), { question: "one" });
    expect(thrown(() => assistant.begin(caller("owner"), { question: "two" }))).toMatchObject({ status: 429, code: "assistant_busy" });
    const other = assistant.begin(caller("operator"), { question: "three" });
    other.cancel();
    await first.run();
    assistant.begin(caller("owner"), { question: "four" }).cancel();
  });

  it("refuses an empty question, a long one, and a focus it does not understand", () => {
    const assistant = service();
    for (const body of [{}, { question: "   " }, { question: "x".repeat(2_001) }, { question: "q", context: { jobId: "not-a-uuid" } }, { question: "q", context: { appId: "../etc" } }, { question: "q", context: { other: 1 } }]) {
      expect(() => assistant.begin(caller("owner"), body), JSON.stringify(body).slice(0, 60)).toThrow(AssistantError);
    }
  });
});

describe("the audit trail", () => {
  it("records who asked, when, how many sources and how long, and never the question or the answer", async () => {
    fake.state.answer = "UNIQUE-ANSWER-4242 [S1].";
    const result = await service().ask(caller("operator"), { question: "What is UNIQUE-QUESTION-1717 about?" });
    expect(result.answer).toContain("UNIQUE-ANSWER-4242");
    const events = state.listAudit(50);
    const [asked] = events.filter((event) => event.type === "assistant.asked");
    expect(asked.actorId).toBe(accounts.operator.id);
    expect(asked.createdAt).toBeTruthy();
    expect(asked.details).toMatchObject({ role: "operator", outcome: "answered", model: "hermes3:8b", sources: result.sources.length });
    expect(Number.isInteger(asked.details.durationMs)).toBe(true);
    const everything = JSON.stringify(events);
    expect(everything).not.toContain("UNIQUE-QUESTION-1717");
    expect(everything).not.toContain("UNIQUE-ANSWER-4242");
  });
});

describe("streaming", () => {
  it("sends the sources first, then the answer as it is written, without the plan block", async () => {
    const events = [];
    const result = await service().ask(caller("owner"), { question: "Why did the package refresh fail?" }, { onEvent: (event, data) => events.push([event, data]) });
    expect(events[0][0]).toBe("sources");
    expect(events[0][1].sources.length).toBe(result.sources.length);
    const streamed = events.filter(([event]) => event === "delta").map(([, data]) => data.text).join("");
    expect(streamed.trim()).toBe(result.answer);
    expect(streamed).not.toContain("operationId");
  });
});

describe("embeddings", () => {
  it("embeds the question with the embedding model when there is one, and caches what it embedded", async () => {
    const assistant = service();
    await assistant.ask(caller("owner"), { question: "How do I restore a backup?" });
    const embeds = fake.requests.filter((entry) => entry.path === "/api/embed");
    expect(embeds[0].body.model).toBe("nomic-embed-text:latest");
    expect(embeds[0].body.input[0]).toBe("search_query: How do I restore a backup?");
    const status = await assistant.status(caller("operator"));
    expect(status.index.embedded).toBeGreaterThan(0);
    expect(status.models).toEqual(["hermes3:8b", "nomic-embed-text:latest"]);
  });

  it("uses keyword search alone when there is no embedding model", async () => {
    fake.state.models = ["hermes3:8b"];
    const result = await service().ask(caller("owner"), { question: "How do I restore a backup?" });
    expect(fake.requests.some((entry) => entry.path === "/api/embed")).toBe(false);
    expect(result.sources.some((source) => source.ref.path === "docs/BACKUPS.md")).toBe(true);
  });
});

describe("settings and status", () => {
  it("keeps the model on this network", () => {
    expect(normalizeAssistantSettings({ endpoint: "http://192.168.1.20:11434/", model: "qwen3:8b", embedModel: "" })).toEqual({ endpoint: "http://192.168.1.20:11434", model: "qwen3:8b", embedModel: null });
    expect(() => normalizeAssistantSettings({ endpoint: "https://api.example.com" })).toThrow(AssistantError);
    expect(() => normalizeAssistantSettings({ model: "bad model name!" })).toThrow(AssistantError);
  });

  it("records a change of model server in the audit trail", () => {
    service().saveSettings({ endpoint: fake.url, model: "hermes3:8b" }, { actorId: accounts.owner.id });
    const [changed] = state.listAudit(20).filter((event) => event.type === "settings.assistant.changed");
    expect(changed).toMatchObject({ actorId: accounts.owner.id, details: { endpoint: fake.url, model: "hermes3:8b", embedModel: null } });
  });

  it("shows the model list and address to an operator and the owner, and only whether it works to a viewer", async () => {
    const assistant = service();
    const viewer = await assistant.status(caller("viewer"));
    expect(viewer).toMatchObject({ ready: true, reachable: true, chatModel: "hermes3:8b", source: "setting" });
    expect(viewer).not.toHaveProperty("models");
    expect(viewer).not.toHaveProperty("endpoint");
    expect(viewer).not.toHaveProperty("settings");
    const owner = await assistant.status(caller("owner"));
    expect(owner).toMatchObject({ endpoint: fake.url, settings: { endpoint: fake.url } });
    expect(owner.index.operations).toBe(registry.list().length);
    expect(owner.index.documents).toBe(3);
  });
});
