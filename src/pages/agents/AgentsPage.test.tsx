import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentsPage from "./AgentsPage";
import type { AgentDetail, AgentSpec, Catalog, Overview, Proposal, Run, RuntimeState, Usage } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
beforeEach(() => { window.history.replaceState(null, "", "/?view=agents"); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = Date.parse("2026-09-29T10:00:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const keeperId = "11111111-1111-4111-8111-111111111111";
const helperId = "22222222-2222-4222-8222-222222222222";
const spec: AgentSpec = {
  name: "Server Keeper", purpose: "Knows this server.", instructions: "Look before you answer.\nCite the tools.",
  audience: ["owner", "operator"], knowledge: { docs: true, registry: true, catalog: true, notes: true, documents: true },
  tools: { "server.facts": "auto", "logs.query": "ask", "plan.propose": "auto" },
  triggers: { ask: true, schedule: { every: "daily", hour: 5, minute: 30, weekday: null, quietHours: true }, events: ["health.alert"] },
  budget: { runsPerDay: 24, modelSecondsPerDay: 1800, stepsPerRun: 6, tokensPerRun: 12000, runSeconds: 600 },
  outputs: { notes: true, digest: true, notify: "important", proposals: true },
  memory: { enabled: true, freshDays: 14, maxNotes: 80 },
};
const summary = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, template: "server-keeper", version: 2, purpose: `${name} knows things.`, paused: false, pausedUntil: null, status: "idle", canEdit: true, canAsk: true,
  createdAt: ago(600), updatedAt: ago(60), lastRun: { id: "run-1", kind: "ask", state: "completed", finishedAt: ago(5) }, nextRunAt: null, waitsForQuietHours: true,
  budgetToday: { runsUsed: 3, runsPerDay: 24, modelSecondsUsed: 42, modelSecondsPerDay: 1800, tokensUsed: 4000 }, toolsOn: 3, triggers: spec.triggers, audience: spec.audience, ...extra,
});
const module = { enabled: true, paused: false, pausedUntil: null, killedAt: null, quietHours: { start: "02:00", end: "06:00" }, inQuietHours: false, notify: true };
const runner = { online: true, lastSeenAt: ago(0), version: "1.135.0", startedAt: ago(120), hostBusy: false, usage: { state: "idle", cpuPercent: 0.4, memoryBytes: 180e6, memoryPeakBytes: 3e9, cpuQuotaPercent: 100, memoryMaxBytes: 8 * 1024 ** 3, throttledMs: 0, modelLoaded: false, model: null, cgroup: true, readAt: ago(0) } };
const overview = (extra: Partial<Overview> = {}): Overview => ({
  module, runner, agents: [summary(keeperId, "Server Keeper"), summary(helperId, "IT Support helper", { template: "it-support", lastRun: null, triggers: { ask: true, schedule: null, events: [] } })] as Overview["agents"],
  queue: { queued: 0, running: 0, dropped: 0 }, cardsWaiting: 1, can: { create: true, configure: true, pause: true }, ...extra,
});
const proposal: Proposal = {
  id: "33333333-3333-4333-8333-333333333333", agentId: keeperId, agentName: "Server Keeper", runId: "run-1", source: "agent", title: "Back up Vaultwarden", reason: "It has never been backed up.",
  steps: [{ operationId: "app.backup", title: "Back up application data", risk: "medium", readOnly: false, approval: "Preview, then confirm", typedConfirmation: false, parameters: { id: "vaultwarden" }, why: "No backup exists." }],
  dropped: [], flags: {}, state: "open", forRole: "owner", createdAt: ago(10), expiresAt: ago(-60 * 24), jobIds: [],
};
const catalog: Catalog = {
  templates: [
    { id: "server-keeper", title: "Server Keeper", summary: "The resident agent.", spec, questions: [] },
    { id: "blank", title: "Blank", summary: "Start from nothing.", spec: { ...spec, name: "New agent", triggers: { ask: true, schedule: null, events: [] } }, questions: [] },
  ],
  tools: [
    { id: "server.facts", fn: "server_facts", title: "Server facts", description: "Name, system, load.", role: "viewer", cost: "cheap", writes: null, params: [] },
    { id: "logs.query", fn: "logs_query", title: "Logs", description: "Bounded logs.", role: "operator", cost: "moderate", writes: null, params: [] },
    { id: "plan.propose", fn: "plan_propose", title: "Propose a plan", description: "A card.", role: "viewer", cost: "cheap", writes: "cards", params: [] },
  ],
  events: [{ id: "health.alert", title: "A health alert is raised" }],
  limits: { budget: { runsPerDay: { min: 1, max: 200, default: 12 }, modelSecondsPerDay: { min: 10, max: 7200, default: 900 }, stepsPerRun: { min: 1, max: 12, default: 6 }, tokensPerRun: { min: 500, max: 32000, default: 12000 }, runSeconds: { min: 30, max: 1800, default: 600 } } },
};
const detail = (version = 2, name = "Server Keeper"): AgentDetail => ({
  ...(summary(keeperId, name, { version }) as unknown as AgentDetail), spec: { ...spec, name }, prompt: "BoxPilot's rules.\nLook before you answer.",
  versions: [{ version: 1, note: null, createdBy: null, createdAt: ago(600) }, { version: 2, note: "Tighter budget", createdBy: null, createdAt: ago(60) }], createdBy: null,
});
const finishedRun: Run = {
  id: "44444444-4444-4444-8444-444444444444", agentId: keeperId, agentName: "Server Keeper", version: 2, kind: "manual", trigger: {}, question: "What is this server called?", state: "completed", reason: null, readRole: "owner",
  queuedAt: ago(1), startedAt: ago(1), finishedAt: ago(0), answer: "It is homebox [T1].", outputKind: "answer", usage: { modelMs: 8000, loadMs: 0, promptTokens: 900, completionTokens: 40, toolCalls: 1 },
  flags: {}, proposals: [proposal],
  steps: [
    { seq: 1, kind: "system", name: "model", state: "done", input: null, output: null, flags: { detail: "The model is ready" }, startedAt: ago(1), durationMs: null, tokensIn: null, tokensOut: null },
    { seq: 2, kind: "model", name: "unsloth/Qwen3.5-4B-GGUF", state: "done", input: [{ name: "server_facts", arguments: "{}" }], output: null, flags: {}, startedAt: ago(1), durationMs: 4000, tokensIn: 600, tokensOut: 12 },
    { seq: 3, kind: "tool", name: "server.facts", state: "done", input: {}, output: "hostname: homebox", flags: {}, startedAt: ago(1), durationMs: 30, tokensIn: null, tokensOut: null },
    { seq: 4, kind: "model", name: "unsloth/Qwen3.5-4B-GGUF", state: "done", input: null, output: "It is homebox [T1].", flags: {}, startedAt: ago(0), durationMs: 4000, tokensIn: 300, tokensOut: 28 },
  ],
};
const caps = { cpuQuotaPercent: 100, cpuWeight: "idle", nice: 19, ioSchedulingClass: "idle", memoryMaxBytes: 8 * 1024 ** 3, memorySwapMaxBytes: 0, tasksMax: 256, modelThreads: 1, unit: "boxpilot-agents.service" };
const usage: Usage = { runner, caps, today: { runs: 3, modelSeconds: 42, tokens: 4000, perAgent: [{ agentId: keeperId, name: "Server Keeper", runs: 3, runsPerDay: 24, modelSeconds: 42, modelSecondsPerDay: 1800, tokens: 4000 }] }, queue: { queued: 0, running: 0, dropped: 0 }, module };
const libraryModel = (id: string, title: string, extra: Record<string, unknown>) => ({ id, title, repo: `unsloth/${id}`, file: `${id}-UD-Q4_K_XL.gguf`, projector: "mmproj-F16.gguf", quant: "UD-Q4_K_XL", parameters: 4, memoryBytes: 6.2e9, contextTokens: 8192, tokensPerSecond: 4.2, vision: true, recommended: false, note: "A model.", preview: { bytes: 3.58e9, fastMinutes: 2, slowMinutes: 12, memoryBytes: 6.2e9 }, fitsCap: true, downloaded: false, current: false, ...extra });
const runtime: RuntimeState = {
  settings: { driver: "unsloth", repo: "unsloth/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B-UD-Q4_K_XL.gguf", idleStopMinutes: 60 },
  library: [
    libraryModel("Qwen3.5-4B-GGUF", "Qwen 3.5 4B", { recommended: true, downloaded: true, current: true }),
    libraryModel("Qwen3.5-2B-GGUF", "Qwen 3.5 2B", { downloaded: true, tokensPerSecond: 8.3 }),
    libraryModel("Qwen3.5-9B-GGUF", "Qwen 3.5 9B", { memoryBytes: 10.7e9, fitsCap: false, tokensPerSecond: 2.3 }),
  ] as RuntimeState["library"],
  installed: { runtime: { installed: true, path: "/var/lib/boxpilot-agents/unsloth/bin/unsloth" }, service: { unit: "boxpilot-agents.service", loaded: true, active: "active", sub: "running", enabled: "enabled" }, models: [], diskFreeBytes: 200e9 },
  unsloth: { version: "unsloth 2026.10.3", installerSha256: "f".repeat(64), installedAt: ago(3000), testedVersion: "2026.9.12" },
  newer: null, checkedAt: null, runner, caps,
};

type Handler = (init: RequestInit | undefined, url: string) => Response | Promise<Response>;
/** A stand-in for the server: each "METHOD /path" answers; anything else is a 500 the test would see. */
function serve(routes: Record<string, Handler | unknown>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString(), "http://boxpilot.test");
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}`;
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[key];
    if (route === undefined) return json({ error: `unexpected ${key}` }, 500);
    return typeof route === "function" ? (route as Handler)(init, url.toString()) : json(route);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}
const base = (extra: Record<string, Handler | unknown> = {}) => ({
  "GET /api/v1/agents": overview(),
  "GET /api/v1/agents/catalog": catalog,
  "GET /api/v1/agents/proposals": { proposals: [proposal] },
  "GET /api/v1/agents/glance": { enabled: true, paused: false, runnerOnline: true, digest: { agentId: keeperId, agentName: "Server Keeper", runId: finishedRun.id, at: ago(240), excerpt: "All well. Backups ran [T1].", state: "completed" }, cardsWaiting: 1 },
  ...extra,
});

describe("Agents page", () => {
  it("says first whether agents are running cool, then lists them with their last run and budget, and the cards waiting with each step's tier", async () => {
    serve(base());
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Agents" })).toBeTruthy();
    expect((await screen.findByText("Running cool")).closest(".ui-chip")?.getAttribute("data-status")).toBe("good");
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("2 agents · 0 running · 0 waiting · 1 card · CPU 0.4% of 100%");
    const table = screen.getByRole("table", { name: "Agents on this server" });
    const keeper = within(table).getAllByRole("row").find((row) => row.textContent?.includes("Server Keeper"));
    expect(keeper?.textContent).toContain("asked · daily at 05:30 · 1 event · quiet hours");
    expect(keeper?.textContent).toContain("answered");
    expect(keeper?.textContent).toContain("3/24 runs · 42/1800 s");
    // The digest leads, its citations drawn as marks.
    expect(screen.getByRole("region", { name: "Latest digest" }).textContent).toContain("All well. Backups ran");
    const card = await screen.findByRole("article", { name: "Card: Back up Vaultwarden" });
    const stage = within(card).getByRole("button", { name: "Stage Back up application data" });
    expect(stage.getAttribute("data-risk")).toBe("medium");
    // What the page is for waits behind the info toggle.
    expect(screen.getByRole("button", { name: "About Agents" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("pauses every agent, until tomorrow, or stops them all; and one agent on its own", async () => {
    const calls = serve(base({
      "POST /api/v1/agents/module/pause": { ...module, paused: true },
      "POST /api/v1/agents/module/kill": { module: { ...module, paused: true, killedAt: ago(0) }, cancelled: 1, stopped: 0 },
      [`POST /api/v1/agents/${keeperId}/pause`]: summary(keeperId, "Server Keeper", { paused: true }),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Until tomorrow" }));
    await waitFor(() => expect(calls.find((call) => call.path === "/api/v1/agents/module/pause")?.body).toEqual({ until: "tomorrow" }));
    fireEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/v1/agents/module/kill" && call.method === "POST")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Pause Server Keeper until tomorrow" }));
    await waitFor(() => expect(calls.find((call) => call.path === `/api/v1/agents/${keeperId}/pause`)?.body).toEqual({ until: "tomorrow" }));
  });

  it("says Agents are off, and turns them on only with the owner's password", async () => {
    const calls = serve(base({
      "GET /api/v1/agents": overview({ module: { ...module, enabled: false }, runner: { ...runner, online: false, usage: null } }),
      "PUT /api/v1/settings/agents": (init: RequestInit | undefined) => (JSON.parse(String(init?.body)).password === "right" ? json({ module }) : json({ error: "Owner password required to change how agents run" }, 401)),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    expect((await screen.findByText("Off")).closest(".ui-chip")?.getAttribute("data-status")).toBe("neutral");
    expect(screen.queryByRole("button", { name: "Pause all" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Turn Agents on" })[0]);
    const sheet = await screen.findByRole("dialog", { name: "Turn Agents on" });
    fireEvent.change(within(sheet).getByLabelText("Your password"), { target: { value: "wrong" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Turn on" }));
    expect(await within(sheet).findAllByText("Owner password required to change how agents run")).not.toHaveLength(0);
    fireEvent.change(within(sheet).getByLabelText("Your password"), { target: { value: "right" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((call) => call.path === "/api/v1/settings/agents").map((call) => call.body)).toEqual([{ password: "wrong", enabled: true }, { password: "right", enabled: true }]);
  });
});

describe("the builder", () => {
  it("makes an agent from a template, saves a change as a new version, and compares and rolls back versions", async () => {
    const calls = serve(base({
      "POST /api/v1/agents": detail(1),
      [`GET /api/v1/agents/${keeperId}`]: detail(2),
      [`PUT /api/v1/agents/${keeperId}`]: (init: RequestInit | undefined) => json(detail(3, JSON.parse(String(init?.body)).spec.name)),
      [`GET /api/v1/agents/${keeperId}/versions/1`]: { version: { version: 1, note: null, createdBy: null, createdAt: ago(600), spec }, changes: [], againstCurrent: [{ field: "instructions", lines: [{ op: "remove", text: "Look before you answer." }, { op: "add", text: "Look first." }] }, { field: "budget.runsPerDay", before: 24, after: 12 }] },
      [`POST /api/v1/agents/${keeperId}/rollback`]: detail(4),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Build" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make a Server Keeper" }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST" && call.path === "/api/v1/agents")?.body).toEqual({ template: "server-keeper" }));

    const name = await screen.findByLabelText("Name");
    expect((name as HTMLInputElement).value).toBe("Server Keeper");
    // Each tool's permission, with the operator reads marked.
    expect(screen.getByRole("radiogroup", { name: "Logs: permission" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Tools and their permissions" }).textContent).toContain("operator");
    fireEvent.change(name, { target: { value: "Keeper" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    expect(await screen.findByText("Saved as version 3.")).toBeTruthy();
    expect((calls.find((call) => call.method === "PUT")?.body as { spec: AgentSpec }).spec.name).toBe("Keeper");

    fireEvent.click(screen.getByRole("button", { name: "Compare version 1" }));
    const sheet = await screen.findByRole("dialog", { name: "Version 1" });
    expect(within(sheet).getByText("budget.runsPerDay")).toBeTruthy();
    expect(within(sheet).getByText("+ Look first.", { exact: false })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Roll back to version 1" }));
    await waitFor(() => expect(calls.find((call) => call.path.endsWith("/rollback"))?.body).toEqual({ version: 1 }));
  });
});

describe("the test console", () => {
  it("runs an agent once, follows its trace to the answer, and stages a card's step through the approval dialog", async () => {
    window.history.replaceState(null, "", `/?view=agents&tab=test&agent=${keeperId}`);
    let reads = 0;
    const calls = serve(base({
      [`GET /api/v1/agents/${keeperId}/runs`]: { runs: [] },
      [`POST /api/v1/agents/${keeperId}/runs`]: () => json({ ...finishedRun, state: "queued", steps: [], answer: null, proposals: [] }, 202),
      [`GET /api/v1/agents/runs/${finishedRun.id}`]: () => { reads += 1; return json(reads > 1 ? finishedRun : { ...finishedRun, state: "running", answer: null, proposals: [], steps: finishedRun.steps?.slice(0, 2) }); },
      "POST /api/v1/operations/app.backup/jobs": () => json({ job: { id: "55555555-5555-4555-8555-555555555555", type: "op:app.backup", title: "Back up application data", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201),
      [`POST /api/v1/agents/proposals/${proposal.id}/decide`]: { ...proposal, state: "staged", jobIds: ["55555555-5555-4555-8555-555555555555"] },
    }));
    vi.stubGlobal("EventSource", undefined);
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    fireEvent.change(await screen.findByLabelText("Question"), { target: { value: "What is this server called?" } });
    fireEvent.click(screen.getByRole("button", { name: "Run with this question" }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST" && call.path === `/api/v1/agents/${keeperId}/runs`)?.body).toEqual({ question: "What is this server called?" }), { timeout: 4000 });
    const trace = await screen.findByRole("list", { name: "What the agent did" }, { timeout: 8000 });
    expect(within(trace).getByText("Asked for server.facts")).toBeTruthy();
    expect(await screen.findAllByText("answered", {}, { timeout: 8000 })).not.toHaveLength(0);
    expect(screen.getByRole("list", { name: "What the agent did" }).textContent).toContain("T1");
    expect(document.querySelector(".agents-answer")?.textContent).toBe("It is homebox T1.");

    const card = screen.getByRole("article", { name: "Card: Back up Vaultwarden" });
    fireEvent.click(within(card).getByRole("button", { name: "Stage Back up application data" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(calls.find((call) => call.path.endsWith("/decide"))?.body).toEqual({ decision: "staged", jobIds: ["55555555-5555-4555-8555-555555555555"] }));
    expect(calls.find((call) => call.path === "/api/v1/operations/app.backup/jobs")?.body).toEqual({ parameters: { id: "vaultwarden" } });
  }, 15_000);
});

describe("usage and the runtime", () => {
  it("measures the runner against its caps, gives each runtime step its tier, and says which model does not fit", async () => {
    window.history.replaceState(null, "", "/?view=agents&tab=usage");
    serve(base({ "GET /api/v1/agents/usage": usage, "GET /api/v1/agents/runtime": runtime }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    expect(await screen.findByText("of a 100% cap (one processor)")).toBeTruthy();
    const now_ = screen.getByRole("region", { name: "Right now" });
    expect(within(now_).getByText("Running cool")).toBeTruthy();
    expect(within(now_).getByText("of a 100% cap (one processor)")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Hard caps" }).textContent).toContain("CPUWeight=idle · Nice 19");
    // Unsloth is not the release BoxPilot was measured with, and says so.
    expect(screen.getByText(/is not the release BoxPilot was measured with/)).toBeTruthy();
    const models = screen.getByRole("table", { name: "Models agents can use" });
    const nine = within(models).getAllByRole("row").find((row) => row.textContent?.includes("Qwen 3.5 9B"));
    expect(nine?.textContent).toContain("over the cap");
    expect(within(models).getByRole("button", { name: "Download Qwen 3.5 9B" }).getAttribute("data-risk")).toBe("medium");
    expect(within(models).getByRole("button", { name: "Use Qwen 3.5 2B" }).getAttribute("data-risk")).toBe("medium");
    expect(within(models).queryByRole("button", { name: "Remove Qwen 3.5 4B" })).toBeNull();
    expect(screen.getByRole("button", { name: /Stop the runner/ }).getAttribute("data-risk")).toBe("low");
  });
});

describe("a viewer", () => {
  it("sees only the agents they may ask, no builder, knowledge or evaluation, and asks", async () => {
    window.history.replaceState(null, "", "/?view=agents&tab=test");
    const calls = serve({
      "GET /api/v1/agents": overview({ agents: [summary(helperId, "IT Support helper", { canEdit: false, lastRun: null })] as Overview["agents"], cardsWaiting: 0, can: { create: false, configure: false, pause: false } }),
      "GET /api/v1/agents/catalog": catalog,
      [`POST /api/v1/agents/${helperId}/ask`]: () => json({ ...finishedRun, id: "66666666-6666-4666-8666-666666666666", agentId: helperId, state: "queued", steps: [], proposals: [], answer: null }, 202),
      "GET /api/v1/agents/runs/66666666-6666-4666-8666-666666666666": { ...finishedRun, id: "66666666-6666-4666-8666-666666666666", agentId: helperId, proposals: [] },
    });
    vi.stubGlobal("EventSource", undefined);
    render(<AgentsPage csrfToken="csrf" role="viewer" now={() => now} />);
    const tabs = await screen.findByRole("tablist", { name: "Agents" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/, "").trim())).toEqual(["Agents", "Ask", "Usage"]);
    expect(screen.queryByRole("button", { name: "Pause all" })).toBeNull();
    fireEvent.change(await screen.findByLabelText("Question"), { target: { value: "How do I restore a backup?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(calls.find((call) => call.path.endsWith("/ask"))?.body).toEqual({ question: "How do I restore a backup?" }));
    expect(calls.some((call) => call.path === "/api/v1/agents/proposals" || call.path === "/api/v1/agents/glance")).toBe(false);
  });
});

describe("the learning library", () => {
  it("changes what agents read only with the owner's password, and deletes a wrong note", async () => {
    window.history.replaceState(null, "", `/?view=agents&tab=knowledge&agent=${keeperId}`);
    const calls = serve(base({
      "GET /api/v1/agents/knowledge": {
        sources: [
          { id: "docs", title: "BoxPilot's documents", enabled: true, items: 38, size: 412, unit: "sections", indexedAt: ago(30) },
          { id: "documents", title: "Your documents", enabled: true, items: 1, size: 900, unit: "characters", indexedAt: ago(300) },
        ],
        documents: [{ id: "77777777-7777-4777-8777-777777777777", title: "How the network is laid out", enabled: true, createdAt: ago(300), characters: 900 }],
        search: { kind: "keyword (BM25)", embeddings: "Next: Unsloth's own embeddings." },
        learning: { quietHours: { start: "02:00", end: "06:00" }, agents: [{ agentId: keeperId, name: "Server Keeper", state: "completed", at: ago(600) }] },
        canChange: true,
      },
      [`GET /api/v1/agents/${keeperId}/notes`]: { notes: [{ id: "88888888-8888-4888-8888-888888888888", title: "The server", body: "It is homebox.", source: { by: "agent", tools: ["server.facts"] }, createdAt: ago(600), updatedAt: ago(600), freshUntil: ago(-6000), stale: false }] },
      [`DELETE /api/v1/agents/${keeperId}/notes/88888888-8888-4888-8888-888888888888`]: { deleted: true },
      "PUT /api/v1/settings/agents": { module },
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    const notes = await screen.findByRole("table", { name: "Notes of Server Keeper" });
    expect(await within(notes).findByText("It is homebox.")).toBeTruthy();
    fireEvent.click(within(notes).getByRole("button", { name: "Delete the note The server" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path.endsWith("/notes/88888888-8888-4888-8888-888888888888"))).toBe(true));

    const sources = screen.getByRole("table", { name: "What agents may read" });
    const mine = within(sources).getAllByRole("row").find((row) => row.textContent?.includes("Your documents"));
    fireEvent.click(within(mine!).getByRole("switch"));
    const sheet = await screen.findByRole("dialog", { name: "Change what agents read" });
    fireEvent.change(within(sheet).getByLabelText("Your password"), { target: { value: "right" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Change it" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ password: "right", knowledge: { documents: false } }));
  });
});

describe("the evaluation", () => {
  it("shows how the last evaluation scored, each answer against what right means, and runs it again", async () => {
    window.history.replaceState(null, "", `/?view=agents&tab=evaluation&agent=${keeperId}`);
    const calls = serve(base({
      [`GET /api/v1/agents/${keeperId}/evaluation`]: {
        questions: [{ id: "q1", question: "What is this server called?", expect: { fact: "hostname" } }, { id: "q2", question: "How do I restore?", expect: { includes: ["backup"] } }],
        runs: [{ id: "99999999-9999-4999-8999-999999999999", version: 2, state: "done", score: 0.5, createdAt: ago(120), finishedAt: ago(118), results: [
          { questionId: "q1", question: "What is this server called?", expected: { fact: "hostname", value: "homebox" }, runId: finishedRun.id, passed: true, found: "homebox" },
          { questionId: "q2", question: "How do I restore?", expected: { includes: ["backup"] }, runId: null, passed: false, found: null },
        ] }],
        canEdit: true,
      },
      [`POST /api/v1/agents/${keeperId}/evaluation/run`]: () => json({ id: "run-e", version: 2, state: "running", results: [], score: null, createdAt: ago(0), finishedAt: null }, 202),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    const result = await screen.findByRole("table", { name: "The latest evaluation's answers" });
    const rows = within(result).getAllByRole("row").slice(1);
    expect(rows[0].textContent).toContain("Its name: homebox");
    expect(rows[0].getAttribute("data-status")).toBeNull();
    expect(rows[1].getAttribute("data-status")).toBe("danger");
    expect(screen.getByRole("region", { name: "Latest result" }).textContent).toContain("1 of 2 right");
    fireEvent.click(screen.getByRole("button", { name: "Run the evaluation" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/evaluation/run"))).toBe(true));
  });
});
