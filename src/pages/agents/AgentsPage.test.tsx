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
  name: "Server Keeper", purpose: "Knows this server.", job: "Keep a picture of this server.", successCriteria: ["Names the server"],
  prompt: { rules: ["Look before you answer."], steps: ["Read the facts"], output: { format: "text", fields: [], style: "" }, escalate: [] },
  instructions: "Look before you answer.\nCite the tools.",
  audience: ["owner", "operator"], knowledge: { docs: true, registry: true, catalog: true, notes: true, documents: true },
  tools: { "server.facts": "auto", "logs.query": "ask", "plan.propose": "auto" },
  triggers: { ask: true, schedule: { every: "daily", hour: 5, minute: 30, weekday: null, quietHours: true }, events: ["health.alert"], webhook: false },
  budget: { runsPerDay: 24, modelSecondsPerDay: 1800, stepsPerRun: 6, tokensPerRun: 12000, runSeconds: 600 },
  outputs: { notes: true, digest: true, notify: "important", proposals: true },
  memory: { enabled: true, freshDays: 14, maxNotes: 80, share: true, threads: true, turns: 6 },
  escalation: { lowConfidence: true, limits: true, actions: true, risk: true },
  allow: { apps: "*", operations: "*" },
  model: { thinking: false },
  orchestration: { supervisor: true, delegates: "*", maxDepth: 2 },
};
const summary = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, template: "server-keeper", version: 2, purpose: `${name} knows things.`, paused: false, pausedUntil: null, status: "idle", canEdit: true, canAsk: true,
  createdAt: ago(600), updatedAt: ago(60), lastRun: { id: "run-1", kind: "ask", state: "completed", finishedAt: ago(5) }, nextRunAt: null, waitsForQuietHours: true,
  budgetToday: { runsUsed: 3, runsPerDay: 24, modelSecondsUsed: 42, modelSecondsPerDay: 1800, tokensUsed: 4000 }, toolsOn: 3, triggers: spec.triggers, audience: spec.audience, ...extra,
});
const module = { enabled: true, paused: false, pausedUntil: null, killedAt: null, quietHours: { start: "02:00", end: "06:00" }, inQuietHours: false, notify: true };
const runner = { online: true, lastSeenAt: ago(0), version: "1.135.0", startedAt: ago(120), hostBusy: false, usage: { state: "idle", cpuPercent: 0.4, memoryBytes: 180e6, memoryPeakBytes: 3e9, cpuQuotaPercent: 100, memoryMaxBytes: 8 * 1024 ** 3, throttledMs: 0, modelLoaded: false, model: null, cgroup: true, readAt: ago(0) } };
const overview = (extra: Partial<Overview> = {}): Overview => ({
  module, runner, agents: [summary(keeperId, "Server Keeper"), summary(helperId, "IT Support helper", { template: "it-support", lastRun: null, triggers: { ask: true, schedule: null, events: [], webhook: false } })] as Overview["agents"],
  queue: { queued: 0, running: 0, dropped: 0 }, cardsWaiting: 1, can: { create: true, configure: true, pause: true }, ...extra,
});
const proposal: Proposal = {
  id: "33333333-3333-4333-8333-333333333333", kind: "plan", question: null, agentId: keeperId, agentName: "Server Keeper", runId: "run-1", source: "agent", title: "Back up Vaultwarden", reason: "It has never been backed up.",
  steps: [{ operationId: "app.backup", title: "Back up application data", risk: "medium", readOnly: false, approval: "Preview, then confirm", typedConfirmation: false, parameters: { id: "vaultwarden" }, why: "No backup exists." }],
  dropped: [], flags: {}, state: "open", forRole: "owner", createdAt: ago(10), expiresAt: ago(-60 * 24), jobIds: [],
};
const catalog: Catalog = {
  templates: [
    { id: "server-keeper", title: "Server Keeper", summary: "The resident agent.", spec, questions: [] },
    { id: "blank", title: "Blank", summary: "Start from nothing.", spec: { ...spec, name: "New agent", triggers: { ask: true, schedule: null, events: [], webhook: false } }, questions: [] },
  ],
  tools: [
    { id: "server.facts", fn: "server_facts", title: "Server facts", description: "Name, system, load.", category: "boxpilot", categoryTitle: "BoxPilot's reads", role: "viewer", cost: "cheap", writes: null, defaultOff: false, params: [] },
    { id: "logs.query", fn: "logs_query", title: "Logs", description: "Bounded logs.", category: "boxpilot", categoryTitle: "BoxPilot's reads", role: "operator", cost: "moderate", writes: null, defaultOff: false, params: [] },
    { id: "plan.propose", fn: "plan_propose", title: "Propose a plan", description: "A card.", category: "action", categoryTitle: "Actions (proposed only)", role: "viewer", cost: "cheap", writes: "cards", defaultOff: false, params: [] },
    { id: "web.search", fn: "web_search", title: "Web search (SearXNG)", description: "Opt-in.", category: "web", categoryTitle: "Web (opt-in)", role: "operator", cost: "moderate", writes: null, defaultOff: true, params: [] },
  ],
  events: [{ id: "health.alert", title: "A health alert is raised" }],
  limits: { budget: { runsPerDay: { min: 1, max: 200, default: 12 }, modelSecondsPerDay: { min: 10, max: 7200, default: 900 }, stepsPerRun: { min: 1, max: 12, default: 6 }, tokensPerRun: { min: 500, max: 32000, default: 12000 }, runSeconds: { min: 30, max: 1800, default: 600 } }, module: { runsPerDay: { min: 10, max: 2000 }, modelSecondsPerDay: { min: 60, max: 86400 } } },
  categories: { boxpilot: "BoxPilot's reads", action: "Actions (proposed only)", web: "Web (opt-in)" }, outputFormats: ["text", "json"], memoryTiers: { fact: "Facts it learned" },
};
const detail = (version = 2, name = "Server Keeper"): AgentDetail => ({
  ...(summary(keeperId, name, { version }) as unknown as AgentDetail), spec: { ...spec, name }, prompt: "BoxPilot's rules.\nLook before you answer.",
  versions: [{ version: 1, note: null, createdBy: null, createdAt: ago(600) }, { version: 2, note: "Tighter budget", createdBy: null, createdAt: ago(60) }], createdBy: null,
  warnings: [], webhook: { enabled: false, minted: false }, specialists: [],
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
  it("says the overview could not be read when the server answers in another shape, instead of failing the page", async () => {
    serve(base({ "GET /api/v1/agents": { status: "ok" } }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    expect(await screen.findByText("Agents could not be read")).toBeTruthy();
    expect(screen.getByText(/not the expected shape/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeTruthy();
  });

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
    // Each guardrail's range and default, as the server gives them.
    expect(screen.getByText("30–1800 seconds, 600 by default")).toBeTruthy();
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

describe("the builder's team chat (M38)", () => {
  it("has every output on by default for an agent saved before it, and saves the channel, topic and switches the owner sets", async () => {
    const calls = serve(base({
      "POST /api/v1/agents": detail(1),
      [`GET /api/v1/agents/${keeperId}`]: detail(2),
      [`PUT /api/v1/agents/${keeperId}`]: (init: RequestInit | undefined) => json(detail(3, JSON.parse(String(init?.body)).spec.name)),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Build" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make a Server Keeper" }));
    const channel = await screen.findByLabelText("Findings channel");
    expect((channel as HTMLInputElement).placeholder).toBe("agent-findings");
    expect(screen.getByRole("switch", { name: "Post logs" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(channel, { target: { value: "#house" } });
    fireEvent.change(screen.getByLabelText("Findings topic"), { target: { value: "Keeper answers" } });
    fireEvent.click(screen.getByRole("switch", { name: "Post logs" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect((calls.find((call) => call.method === "PUT")?.body as { spec: AgentSpec }).spec.outputs.chat).toEqual({
      findings: { enabled: true, channel: "house", topic: "Keeper answers" }, logs: { enabled: false, channel: null, topic: null }, knowledge: { enabled: true, channel: null, topic: null },
    });
  });
});

describe("the builder's steps", () => {
  it("warns when a job reads like several, asks for its answer as JSON fields, and makes a webhook URL shown once", async () => {
    window.history.replaceState(null, "", `/?view=agents&tab=build&agent=${keeperId}`);
    const wide = { ...detail(2), warnings: ["It reads like several jobs: an agent that does one job well is more use than one that tries everything."], webhook: { enabled: true, minted: false }, spec: { ...spec, triggers: { ...spec.triggers, webhook: true } } };
    const calls = serve(base({
      [`GET /api/v1/agents/${keeperId}`]: wide,
      [`PUT /api/v1/agents/${keeperId}`]: (init: RequestInit | undefined) => json({ ...wide, version: 3, spec: JSON.parse(String(init?.body)).spec }),
      [`POST /api/v1/agents/${keeperId}/webhook`]: { token: "t".repeat(43), path: `/api/v1/hooks/agents/${keeperId}/${"t".repeat(43)}` },
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    expect((await screen.findByText("About its scope")).closest(".ui-notice")?.textContent).toContain("several jobs");
    // The steps, in order.
    expect(Array.from(document.querySelectorAll(".agents-form__step")).map((step) => step.textContent)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect((screen.getByLabelText("Its one job") as HTMLTextAreaElement | HTMLInputElement).value).toBe("Keep a picture of this server.");

    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Its answer" })).getByRole("radio", { name: "JSON fields" }));
    fireEvent.change(screen.getByLabelText("Field 1"), { target: { value: "hostname" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    await waitFor(() => expect((calls.find((call) => call.method === "PUT")?.body as { spec: AgentSpec } | undefined)?.spec.prompt.output).toEqual({ format: "json", fields: [{ name: "hostname", description: "" }], style: "" }));

    const webhook = screen.getByRole("region", { name: "Webhook" });
    fireEvent.click(within(webhook).getByRole("button", { name: "Make its URL" }));
    expect(await within(webhook).findByText("Copy it now")).toBeTruthy();
    expect(webhook.textContent).toContain(`/api/v1/hooks/agents/${keeperId}/`);
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

describe("the brain in the console", () => {
  it("shows how a request was understood and planned, the runs of one request, a question card, and takes feedback", async () => {
    window.history.replaceState(null, "", `/?view=agents&tab=test&agent=${keeperId}`);
    const childId = "99999999-9999-4999-8999-999999999999";
    const question: Proposal = { ...proposal, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "question", question: "Which disk do you mean: the system disk or the backup disk?", title: "Server Keeper asks", reason: "It was not sure what was meant.", steps: [] };
    const run: Run = {
      ...finishedRun, question: "How full is it?", answer: "The backup disk is 81% full [T1].", proposals: [question], feedback: null,
      tree: [
        { id: finishedRun.id, parentRunId: null, depth: 0, agentId: keeperId, agentName: "Server Keeper", kind: "manual", state: "completed", question: "How full is it?", finishedAt: ago(0) },
        { id: childId, parentRunId: finishedRun.id, depth: 1, agentId: helperId, agentName: "Backup Auditor", kind: "handoff", state: "completed", question: "Which disk is fullest?", finishedAt: ago(0) },
      ],
      steps: [
        { seq: 1, kind: "intent", name: "understanding", state: "done", input: { goal: "Say how full a disk is", subject: "disk", constraints: [], tools: ["server_facts"], confidence: 0.42, clarify: null }, output: null, flags: {}, startedAt: ago(1), durationMs: 900, tokensIn: 400, tokensOut: 40 },
        { seq: 2, kind: "plan", name: "plan", state: "done", input: [{ step: "Read the disks", tool: "server_facts" }, { step: "Answer with the fullest", tool: null }], output: null, flags: {}, startedAt: ago(1), durationMs: null, tokensIn: null, tokensOut: null },
        { seq: 3, kind: "recall", name: "memory", state: "done", input: null, output: "The backup disk is /mnt/backup.", flags: { read: 1 }, startedAt: ago(1), durationMs: 3, tokensIn: null, tokensOut: null },
        ...(finishedRun.steps ?? []).slice(1).map((step) => ({ ...step, seq: step.seq + 2 })),
      ],
    };
    const calls = serve(base({
      [`GET /api/v1/agents/${keeperId}/runs`]: { runs: [run] },
      [`GET /api/v1/agents/runs/${finishedRun.id}`]: run,
      [`POST /api/v1/agents/runs/${finishedRun.id}/feedback`]: { verdict: "down", note: "It was the system disk.", mine: true },
    }));
    vi.stubGlobal("EventSource", undefined);
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    const trace = await screen.findByRole("list", { name: "What the agent did" }, { timeout: 8000 });
    // The intent and the plan are open as they arrive; low confidence is marked.
    expect(within(trace).getByText("Understood: Say how full a disk is")).toBeTruthy();
    expect(within(trace).getByText("42%")).toBeTruthy();
    expect(within(trace).getByText("Planned 2 steps")).toBeTruthy();
    expect(within(trace).getByText("Read the disks")).toBeTruthy();
    expect(within(trace).getByText("Recalled 1 memory")).toBeTruthy();
    // One request, two runs: the supervisor's and the specialist's.
    const tree = screen.getByRole("navigation", { name: "This request's runs" });
    expect(within(tree).getByRole("button", { name: "Server Keeper" }).getAttribute("aria-current")).toBe("true");
    expect(within(tree).getByRole("button", { name: "Backup Auditor" })).toBeTruthy();
    // A question card asks; it has no steps to stage.
    const card = screen.getByRole("article", { name: "Card: Server Keeper asks" });
    expect(card.getAttribute("data-kind")).toBe("question");
    expect(card.textContent).toContain("Which disk do you mean");
    expect(within(card).queryByRole("button", { name: /^Stage/ })).toBeNull();
    // Feedback on every run.
    const feedback = screen.getByRole("group", { name: "Was this right?" });
    fireEvent.click(within(feedback).getByRole("button", { name: "Wrong" }));
    fireEvent.change(within(feedback).getByLabelText("What was wrong"), { target: { value: "It was the system disk." } });
    fireEvent.click(within(feedback).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.find((call) => call.path.endsWith("/feedback"))?.body).toEqual({ verdict: "down", note: "It was the system disk." }));
    expect(await within(feedback).findByText("you said wrong")).toBeTruthy();
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

// The owner's server: Agents on, Unsloth installed and the model downloaded, the runner's unit
// never started, a question waiting. Every step that fixes it is staged and approved at its tier.
describe("a runner that is not running", () => {
  const offline = { ...runner, online: false, lastSeenAt: null, usage: null };
  const inactive = { unit: "boxpilot-agents.service", loaded: true, active: "inactive", sub: "dead", enabled: "disabled" };
  /** The runtime as the helper reads it: Unsloth there or not, the model downloaded or not, the unit's state. */
  const runtimeWith = ({ unsloth = true, downloaded = true, active = "inactive" } = {}): RuntimeState => ({
    ...runtime, runner: offline,
    library: [libraryModel("Qwen3.5-4B-GGUF", "Qwen 3.5 4B", { recommended: true, downloaded, current: true }), libraryModel("Qwen3.5-2B-GGUF", "Qwen 3.5 2B", {})] as RuntimeState["library"],
    installed: { runtime: { installed: unsloth, path: "/var/lib/boxpilot-agents/unsloth/bin/unsloth" }, service: { ...inactive, active, sub: active === "active" ? "running" : "dead" }, models: [], diskFreeBytes: 200e9 },
  });
  const waitingRun: Run = { ...finishedRun, id: "77777777-7777-4777-8777-777777777777", kind: "ask", question: "Why is Jellyfin restarting?", state: "queued", startedAt: null, finishedAt: null, answer: null, outputKind: null, usage: {}, proposals: [], steps: [] };
  const stoppedOverview = (extra: Partial<Overview> = {}) => overview({
    runner: offline, queue: { queued: 1, running: 0, dropped: 0 },
    agents: [summary(keeperId, "Server Keeper", { status: "queued" }), summary(helperId, "IT Support helper", { lastRun: null })] as Overview["agents"], ...extra,
  });
  /** Staging, approving and reading each job: a job is named after its operation, and completes. */
  const jobs = (operations: string[]) => Object.fromEntries(operations.flatMap((operationId) => {
    const job = (state: string) => ({ id: operationId, type: `op:${operationId}`, title: operationId, state, risk: "medium", error: null, result: null, steps: [], approvals: [], parameters: {} });
    return [
      [`POST /api/v1/operations/${operationId}/jobs`, () => json({ job: job("awaiting_approval"), approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk", confirmText: null } }, 201)],
      [`POST /api/v1/jobs/${operationId}/approve`, () => json({ job: job("applying"), elevatedUntil: null }, 202)],
      [`GET /api/v1/jobs/${operationId}`, () => json({ job: job("completed") })],
    ];
  }));
  const staged = (calls: Array<{ method: string; path: string }>) => calls.filter((call) => call.method === "POST" && /^\/api\/v1\/operations\/[^/]+\/jobs$/.test(call.path)).map((call) => call.path.split("/")[4]);
  const header = () => document.querySelector(".ui-page-header") as HTMLElement;

  it("turns Agents on and walks the owner through each missing step, ending with the runner started", async () => {
    let enabled = false;
    const calls = serve(base({
      "GET /api/v1/agents": () => json(overview({ module: { ...module, enabled }, runner: offline })),
      "GET /api/v1/agents/runtime": runtimeWith({ unsloth: false, downloaded: false }),
      "PUT /api/v1/settings/agents": () => { enabled = true; return json({ module }); },
      ...jobs(["agents.runtime.install", "agents.model.download", "agents.runtime.enable"]),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    await waitFor(() => expect(calls.some((call) => call.path === "/api/v1/agents/runtime")).toBe(true));
    fireEvent.click((await screen.findAllByRole("button", { name: "Turn Agents on" }))[0]);
    const sheet = await screen.findByRole("dialog", { name: "Turn Agents on" });
    // The sheet says what follows, one approval at a time.
    await waitFor(() => expect(Array.from(sheet.querySelectorAll(".agents-setup li")).map((item) => item.textContent)).toEqual(["Install Unsloth for agents", "Download Qwen 3.5 4B", "Start the agents runner"]));
    fireEvent.change(within(sheet).getByLabelText("Your password"), { target: { value: "right" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Turn on" }));

    // The first step opens at once, at its tier; nothing after it is staged yet.
    expect(await screen.findByRole("dialog", { name: "Install Unsloth for agents" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Turn Agents on" })).toBeNull();
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(staged(calls)).toEqual(["agents.runtime.install"]);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next: Download Qwen 3.5 4B" }));
    expect(await screen.findByRole("dialog", { name: "Download Qwen 3.5 4B" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    const last = await screen.findByRole("button", { name: "Next: Start the agents runner" });
    expect(last.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(last);
    expect(await screen.findByRole("dialog", { name: "Start the agents runner" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText("Completed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Next/ })).toBeNull();

    // Three jobs, in order, each approved on its own: the last one starts the runner.
    expect(staged(calls)).toEqual(["agents.runtime.install", "agents.model.download", "agents.runtime.enable"]);
    expect(calls.filter((call) => call.path.endsWith("/approve")).map((call) => call.path.split("/")[4])).toEqual(["agents.runtime.install", "agents.model.download", "agents.runtime.enable"]);
    expect(calls.find((call) => call.path === "/api/v1/operations/agents.model.download/jobs")?.body).toEqual({ parameters: { repo: "unsloth/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B-GGUF-UD-Q4_K_XL.gguf", projector: "mmproj-F16.gguf" } });
  }, 20_000);

  it("offers the runner at once when Unsloth and the model are already there", async () => {
    let enabled = false;
    const calls = serve(base({
      "GET /api/v1/agents": () => json(overview({ module: { ...module, enabled }, runner: offline })),
      "GET /api/v1/agents/runtime": runtimeWith(),
      "PUT /api/v1/settings/agents": () => { enabled = true; return json({ module }); },
      ...jobs(["agents.runtime.enable"]),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    await waitFor(() => expect(calls.some((call) => call.path === "/api/v1/agents/runtime")).toBe(true));
    fireEvent.click((await screen.findAllByRole("button", { name: "Turn Agents on" }))[0]);
    const sheet = await screen.findByRole("dialog", { name: "Turn Agents on" });
    fireEvent.change(within(sheet).getByLabelText("Your password"), { target: { value: "right" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("dialog", { name: "Start the agents runner" })).toBeTruthy();
    await waitFor(() => expect(staged(calls)).toEqual(["agents.runtime.enable"]));
  });

  it("says the runner is stopped at the top and offers the step that starts it; a run waiting says why", async () => {
    const calls = serve(base({
      "GET /api/v1/agents": stoppedOverview(),
      "GET /api/v1/agents/runtime": runtimeWith(),
      "GET /api/v1/agents/glance": { enabled: true, paused: false, runnerOnline: false, queued: 1, digest: null, cardsWaiting: 1 },
      ...jobs(["agents.runtime.enable"]),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    const chip = (await screen.findByText("Runner stopped")).closest(".ui-chip");
    expect(chip?.getAttribute("data-status")).toBe("warning");
    await waitFor(() => expect(header().textContent).toContain("Agents are on, but nothing runs until the runner is started."));
    // In the header's actions, beside Pause all, with its tier.
    const start = await within(header()).findByRole("button", { name: "Start the runner" });
    expect(start.getAttribute("data-risk")).toBe("medium");
    expect(within(header()).getByRole("button", { name: "Pause all" })).toBeTruthy();
    // The list says why the run waits, with the same step, and the agent says it waits for the runner.
    const waiting = screen.getByText("Waiting for the runner, which is stopped").closest(".ui-notice") as HTMLElement;
    expect(waiting.textContent).toContain("1 run waits, and it starts as soon as the runner does.");
    expect(within(waiting).getByRole("button", { name: "Start the runner" })).toBeTruthy();
    const keeper = within(screen.getByRole("table", { name: "Agents on this server" })).getAllByRole("row").find((row) => row.textContent?.includes("Server Keeper"));
    expect(keeper?.textContent).toContain("waiting for the runner");
    expect(screen.getByRole("tab", { name: /Usage/ }).textContent).toContain("the runner is stopped");

    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start the agents runner" })).toBeTruthy();
    await waitFor(() => expect(staged(calls)).toEqual(["agents.runtime.enable"]));
  });

  it("offers the missing step instead when Unsloth or the model is not there yet", async () => {
    const cases = [
      { runtime: runtimeWith({ unsloth: false, downloaded: false }), action: "Install Unsloth", sentence: "nothing runs until Unsloth is installed, the model is downloaded and the runner is started." },
      { runtime: runtimeWith({ downloaded: false }), action: "Download the model", sentence: "nothing runs until the model is downloaded and the runner is started." },
    ];
    for (const entry of cases) {
      serve(base({ "GET /api/v1/agents": stoppedOverview(), "GET /api/v1/agents/runtime": entry.runtime }));
      render(<AgentsPage csrfToken="csrf" now={() => now} />);
      await screen.findByText("Runner stopped");
      const action = await within(header()).findByRole("button", { name: entry.action });
      expect(action.getAttribute("data-risk")).toBe("medium");
      expect(within(header()).queryByRole("button", { name: "Start the runner" })).toBeNull();
      expect(header().textContent).toContain(entry.sentence);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("says a unit that runs but a runner that does not answer, and offers nothing to start", async () => {
    serve(base({ "GET /api/v1/agents": stoppedOverview(), "GET /api/v1/agents/runtime": runtimeWith({ active: "active" }) }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    expect(await screen.findByText("Runner not answering")).toBeTruthy();
    expect(screen.getByText("Waiting for the runner, which is not answering")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start the runner" })).toBeNull();
  });

  it("shows an operator the words, and no step they cannot take", async () => {
    serve(base({ "GET /api/v1/agents": stoppedOverview(), "GET /api/v1/agents/runtime": runtimeWith() }));
    render(<AgentsPage csrfToken="csrf" role="operator" now={() => now} />);
    expect(await screen.findByText("Runner stopped")).toBeTruthy();
    await waitFor(() => expect(header().textContent).toContain("nothing runs until the runner is started."));
    const waiting = screen.getByText("Waiting for the runner, which is stopped").closest(".ui-notice") as HTMLElement;
    expect(within(waiting).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start the runner" })).toBeNull();
    expect(within(header()).getByRole("button", { name: "Pause all" })).toBeTruthy();
  });

  it("says in the console that a question waits for the stopped runner, with the owner's step", async () => {
    window.history.replaceState(null, "", `/?view=agents&tab=test&agent=${keeperId}`);
    const calls = serve(base({
      "GET /api/v1/agents": stoppedOverview(),
      "GET /api/v1/agents/runtime": runtimeWith(),
      [`GET /api/v1/agents/${keeperId}/runs`]: { runs: [waitingRun] },
      [`GET /api/v1/agents/runs/${waitingRun.id}`]: waitingRun,
      ...jobs(["agents.runtime.enable"]),
    }));
    vi.stubGlobal("EventSource", undefined);
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    const live = await screen.findByRole("region", { name: "Run" });
    const notice = (await within(live).findByText("Waiting for the runner, which is stopped", {}, { timeout: 6000 })).closest(".ui-notice") as HTMLElement;
    expect(notice.textContent).toContain("It starts as soon as the runner does.");
    fireEvent.click(await within(notice).findByRole("button", { name: "Start the runner" }));
    expect(await screen.findByRole("dialog", { name: "Start the agents runner" })).toBeTruthy();
    await waitFor(() => expect(staged(calls)).toEqual(["agents.runtime.enable"]));
  }, 15_000);

  it("shows a viewer who asked only the words", async () => {
    window.history.replaceState(null, "", "/?view=agents&tab=test");
    const asked = { ...waitingRun, agentId: helperId, agentName: "IT Support helper", readRole: "viewer" };
    const calls = serve({
      "GET /api/v1/agents": stoppedOverview({ agents: [summary(helperId, "IT Support helper", { canEdit: false, lastRun: null, status: "queued" })] as Overview["agents"], cardsWaiting: 0, can: { create: false, configure: false, pause: false } }),
      "GET /api/v1/agents/catalog": catalog,
      [`POST /api/v1/agents/${helperId}/ask`]: () => json(asked, 202),
      [`GET /api/v1/agents/runs/${asked.id}`]: asked,
    });
    vi.stubGlobal("EventSource", undefined);
    render(<AgentsPage csrfToken="csrf" role="viewer" now={() => now} />);
    fireEvent.change(await screen.findByLabelText("Question"), { target: { value: "Why is Jellyfin restarting?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const notice = (await screen.findByText("Waiting for the runner, which is stopped")).closest(".ui-notice") as HTMLElement;
    expect(within(notice).queryByRole("button")).toBeNull();
    // A viewer never asks for the runtime: what the unit is doing is not theirs to read.
    expect(calls.some((call) => call.path === "/api/v1/agents/runtime")).toBe(false);
  });

  it("says on Usage that the model cannot load until the runner starts, with the same step, and keeps Start and Stop in Runtime", async () => {
    window.history.replaceState(null, "", "/?view=agents&tab=usage");
    const calls = serve(base({
      "GET /api/v1/agents": stoppedOverview(),
      "GET /api/v1/agents/usage": { ...usage, runner: offline, queue: { queued: 1, running: 0, dropped: 0 } },
      "GET /api/v1/agents/runtime": runtimeWith(),
      ...jobs(["agents.runtime.enable"]),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    const tile = (await screen.findByText("cannot load until the runner starts")).closest(".ui-metric") as HTMLElement;
    expect(tile.textContent).toContain("Not loaded");
    expect(tile.textContent).not.toContain("starts when a run needs it");
    expect(tile.getAttribute("data-status")).toBe("warning");
    const panel = screen.getByRole("region", { name: "Runtime" });
    expect(within(panel).getByRole("button", { name: "Start the runner" }).getAttribute("data-risk")).toBe("medium");
    expect(within(panel).queryByRole("button", { name: "Stop the runner" })).toBeNull();
    fireEvent.click(within(tile).getByRole("button", { name: "Start the runner" }));
    expect(await screen.findByRole("dialog", { name: "Start the agents runner" })).toBeTruthy();
    await waitFor(() => expect(staged(calls)).toEqual(["agents.runtime.enable"]));
  });

  it("says the caps the server reports, four processors as four, never one assumed", async () => {
    window.history.replaceState(null, "", "/?view=agents&tab=usage");
    const wide = { ...caps, cpuQuotaPercent: 400, modelThreads: 4 };
    serve(base({
      "GET /api/v1/agents": stoppedOverview(),
      "GET /api/v1/agents/usage": { ...usage, runner: offline, caps: wide },
      "GET /api/v1/agents/runtime": { ...runtimeWith(), caps: wide },
      ...jobs(["agents.runtime.enable"]),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    expect(await screen.findByText("of a 400% cap (four processors)")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Hard caps" }).textContent).toContain("Model threads4");
    fireEvent.click(within(screen.getByRole("region", { name: "Runtime" })).getByRole("button", { name: "Start the runner" }));
    expect(await screen.findByText("boxpilot-agents.service: four processors at most, idle priority, 8 GiB, this machine only.")).toBeTruthy();
    // What the page is for says the same caps.
    expect(document.querySelector(".ui-page-header__about")?.textContent).toContain("(four processors at most, idle priority, 8 GiB, this machine only)");
  });

  it("shows the processors while someone waits and in the background, and saves the owner's two numbers (M40)", async () => {
    window.history.replaceState(null, "", "/?view=agents&tab=usage");
    const cores = { waiting: 8, background: 4, ceiling: 8, processors: 16, physical: 8, limits: { min: 2, max: 8, keepFree: 2 }, now: { processors: 8, burst: true, at: ago(1), resetAt: ago(-15), error: null } };
    const raised = { ...usage, runner: { ...runner, usage: { ...runner.usage, cpuQuotaPercent: 800 } }, caps: { ...caps, cpuQuotaPercent: 400, waitingQuotaPercent: 800 }, module: { ...usage.module, cores } };
    const calls = serve(base({
      "GET /api/v1/agents/usage": raised,
      "GET /api/v1/agents/runtime": { ...runtime, caps: { ...caps, cpuQuotaPercent: 400, waitingQuotaPercent: 800 } },
      "PUT /api/v1/settings/agents": { module: { ...usage.module, cores } },
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    expect(await screen.findByText("of a 800% cap (eight processors, while someone waits)")).toBeTruthy();
    const hard = screen.getByRole("region", { name: "Hard caps" });
    expect(hard.textContent).toContain("4 in the background · 8 while you wait");
    expect(hard.textContent).toContain("800% · raised while someone waits");
    const waiting = await screen.findByRole("spinbutton", { name: "Processors while you wait" });
    expect(waiting.getAttribute("max")).toBe("8");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Processors in the background" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    fireEvent.change(await screen.findByLabelText("Your password"), { target: { value: "right" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT" && call.path === "/api/v1/settings/agents")?.body).toMatchObject({ password: "right", cores: { waiting: 8, background: 3 } }));
  });

  it("goes on from downloading the model on Usage to starting the runner", async () => {
    window.history.replaceState(null, "", "/?view=agents&tab=usage");
    const calls = serve(base({
      "GET /api/v1/agents": stoppedOverview(),
      "GET /api/v1/agents/usage": { ...usage, runner: offline },
      "GET /api/v1/agents/runtime": runtimeWith({ downloaded: false }),
      ...jobs(["agents.model.download", "agents.runtime.enable"]),
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    const models = await screen.findByRole("table", { name: "Models agents can use" });
    fireEvent.click(within(models).getByRole("button", { name: "Download Qwen 3.5 4B" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next: Start the agents runner" }));
    expect(await screen.findByRole("dialog", { name: "Start the agents runner" })).toBeTruthy();
    await waitFor(() => expect(staged(calls)).toEqual(["agents.model.download", "agents.runtime.enable"]));
  }, 15_000);
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
  it("changes what agents read and brings in outside data only with the owner's password, and stages a connector's sync at its tier", async () => {
    window.history.replaceState(null, "", "/?view=agents&tab=knowledge");
    const calls = serve(base({
      "GET /api/v1/agents/knowledge": {
        sources: [
          { id: "docs", title: "BoxPilot's documents", enabled: true, items: 38, size: 412, unit: "sections", indexedAt: ago(30) },
          { id: "documents", title: "Your documents", enabled: true, items: 1, size: 900, unit: "characters", indexedAt: ago(300) },
        ],
        documents: [{ id: "77777777-7777-4777-8777-777777777777", title: "How the network is laid out", enabled: true, createdAt: ago(300), characters: 900, source: "pdf", externalId: null, pinned: false }],
        search: { kind: "words (BM25) and meaning (embeddings), fused", embeddings: "12 pieces indexed", pending: 0, vectors: 12, enabled: true },
        learning: { quietHours: { start: "02:00", end: "06:00" }, agents: [{ agentId: keeperId, name: "Server Keeper", state: "completed", at: ago(600) }] },
        canChange: true,
        connectors: { notion: { enabled: true, credential: "notion-token" }, slack: { enabled: false, credential: null, channels: [] } },
        folder: { enabled: false, path: null }, webSearch: { enabled: false, endpoint: null },
      },
      "PUT /api/v1/agents/knowledge/documents/77777777-7777-4777-8777-777777777777/pin": { pinned: true },
      "PUT /api/v1/settings/agents": { module },
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    const documents = await screen.findByRole("table", { name: "Documents you gave the agents" });
    expect(within(documents).getByText("PDF")).toBeTruthy();
    fireEvent.click(within(documents).getByRole("button", { name: "Pin How the network is laid out" }));
    await waitFor(() => expect(calls.find((call) => call.path.endsWith("/pin"))?.body).toEqual({ pinned: true }));

    const sources = screen.getByRole("table", { name: "What agents may read" });
    const mine = within(sources).getAllByRole("row").find((row) => row.textContent?.includes("Your documents"));
    fireEvent.click(within(mine!).getByRole("switch"));
    let sheet = await screen.findByRole("dialog", { name: "Change what agents read" });
    fireEvent.change(within(sheet).getByLabelText("Your password"), { target: { value: "right" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Change it" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT" && call.path === "/api/v1/settings/agents")?.body).toEqual({ password: "right", knowledge: { documents: false } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Outside data: off until the owner turns it on, saved with the password.
    const outside = screen.getByRole("region", { name: "Outside data" });
    fireEvent.click(within(outside).getByRole("switch", { name: /Web search/ }));
    fireEvent.change(within(outside).getByLabelText("SearXNG's address"), { target: { value: "http://192.168.1.20:8089" } });
    fireEvent.click(within(outside).getByRole("button", { name: "Save" }));
    sheet = await screen.findByRole("dialog", { name: "Save outside data" });
    fireEvent.change(within(sheet).getByLabelText("Your password"), { target: { value: "right" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/v1/settings/agents").at(-1)?.body).toMatchObject({ password: "right", webSearch: { enabled: true, endpoint: "http://192.168.1.20:8089" }, connectors: { notion: { enabled: true, credential: "notion-token" } } }));
    // A connector's sync is a registered operation, shown with its tier.
    expect(within(outside).getByRole("button", { name: "Sync Notion" }).getAttribute("data-risk")).toBe("low");
  });

  it("says when images wait because the model server cannot see (M40.6)", async () => {
    window.history.replaceState(null, "", "/?view=agents&tab=knowledge");
    serve(base({
      "GET /api/v1/agents/knowledge": {
        sources: [{ id: "documents", title: "Your documents", enabled: true, items: 1, size: 120, unit: "characters", indexedAt: null }],
        documents: [{ id: "99999999-9999-4999-8999-999999999999", title: "Image: rack", enabled: true, createdAt: ago(300), characters: 120, source: "zulip", externalId: "302:/user_uploads/rack.png", pinned: false, mediaType: "image/png", describedAt: null }],
        search: { kind: "words (BM25)", embeddings: "off", pending: 0, vectors: 0, enabled: false },
        learning: { quietHours: { start: "02:00", end: "06:00" }, agents: [] },
        canChange: true,
        vision: { vision: false, reason: "it started without its vision projector (mmproj load failed)", at: ago(60) },
      },
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    expect(await screen.findByText("An image waits for a model that can see")).toBeTruthy();
    expect(screen.getByText(/The model server said it cannot see images: it started without its vision projector \(mmproj load failed\)\. Nothing is sent to it/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "How agents search" }).textContent).toContain("waiting: the model cannot see them (it started without its vision projector (mmproj load failed))");
  });
});

describe("memory", () => {
  it("shows what an agent remembers by tier, and lets the owner pin, edit and make it forget", async () => {
    window.history.replaceState(null, "", `/?view=agents&tab=memory&agent=${keeperId}`);
    const fact = { id: "88888888-8888-4888-8888-888888888888", title: "The server", body: "It is homebox.", source: { by: "agent", tools: ["server.facts"] }, createdAt: ago(600), updatedAt: ago(600), freshUntil: ago(-6000), stale: false, pinned: false, shared: true, readRole: "owner", indexed: true };
    const calls = serve(base({
      [`GET /api/v1/agents/${keeperId}/memory`]: {
        facts: [fact],
        shared: [{ id: "s1", title: "Where Pi-hole runs", body: "As the app pi-hole.", from: "Pi-hole Watcher", updatedAt: ago(100), stale: false }],
        episodes: [{ id: "e1", runId: "run-1", text: "Asked \"What is this server?\". It is homebox.", createdAt: ago(60), indexed: false }],
        thread: { summary: "Asked about the disks.", turns: [{ role: "user", text: "And the apps?" }, { role: "agent", text: "Eleven apps run." }], updatedAt: ago(5) },
        settings: { enabled: true, share: true, threads: true, turns: 6, freshDays: 14, maxNotes: 80 },
        search: { byMeaning: true, model: "unsloth/Qwen3.5-4B-GGUF", pending: 1, vectors: 12 },
      },
      [`PUT /api/v1/agents/${keeperId}/memory/notes/${fact.id}`]: { ...fact, pinned: true },
      [`DELETE /api/v1/agents/${keeperId}/memory/notes/${fact.id}`]: { forgotten: true },
      [`DELETE /api/v1/agents/${keeperId}/memory/episodes/e1`]: { forgotten: true },
      [`DELETE /api/v1/agents/${keeperId}/memory/thread`]: { forgotten: true },
      "POST /api/v1/agents/knowledge/reindex": { queued: true, pending: 1 },
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    const facts = await screen.findByRole("table", { name: "Facts Server Keeper learned" });
    expect(within(facts).getByText("It is homebox.")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Facts other agents share" }).textContent).toContain("Pi-hole Watcher");
    expect(screen.getByRole("region", { name: "Your conversation with it" }).textContent).toContain("Asked about the disks.");
    fireEvent.click(within(facts).getByRole("button", { name: "Pin The server" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ pinned: true }));
    fireEvent.click(within(facts).getByRole("button", { name: "Forget the fact The server" }));
    fireEvent.click(screen.getByRole("button", { name: "Forget this run" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Your conversation with it" })).getByRole("button", { name: "Forget it" }));
    fireEvent.click(screen.getByRole("button", { name: "Index now" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path.split("/memory/")[1])).toEqual([`notes/${fact.id}`, "episodes/e1", "thread"]));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/reindex"))).toBe(true));
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
    fireEvent.click(screen.getByRole("button", { name: "Run the evaluation now" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/evaluation/run"))).toBe(true));
  });

  it("lists the built-in questions, follows accuracy over time and flags a drop (M40)", async () => {
    window.history.replaceState(null, "", `/?view=agents&tab=evaluation&agent=${keeperId}`);
    const point = (id: string, hoursAgo: number, score: number, version: number) => ({ id, at: ago(hoursAgo * 60), score, version, model: "unsloth/Qwen3.5-4B-GGUF", nightly: true, right: Math.round(score * 5), questions: 5 });
    serve(base({
      [`GET /api/v1/agents/${keeperId}/evaluation`]: {
        builtIn: [
          { id: "builtin-drives", question: "Which drives are connected to this server?", expect: { fact: "drives" }, tool: "storage.health", builtIn: true },
          { id: "builtin-pihole", question: "Where does Pi-hole run on this server?", expect: { fact: "piholePlacement" }, tool: "where.runs", builtIn: true },
        ],
        questions: [],
        runs: [{ id: "e3", version: 3, state: "done", score: 0.6, createdAt: ago(60), finishedAt: ago(55), createdBy: null, results: [
          { questionId: "builtin-drives", question: "Which drives are connected to this server?", expected: { fact: "drives", value: [{ device: "/dev/nvme0n1", transport: "nvme", system: true }, { device: "/dev/sda", transport: "usb", system: false }] }, runId: finishedRun.id, passed: false, found: "Wrong: calls /dev/sda the system disk" },
        ] }],
        canEdit: true,
        history: [point("e1", 50, 1, 2), point("e2", 26, 1, 2), point("e3", 1, 0.6, 3)],
        drop: { from: 1, to: 0.6, previous: 1, at: ago(55), evalId: "e3", version: 3, previousVersion: 2, model: "unsloth/Qwen3.5-4B-GGUF", previousModel: "unsloth/Qwen3.5-4B-GGUF" },
        people: [{ day: "2026-09-29", up: 2, down: 1 }],
        nightly: { quietHours: { start: "02:00", end: "06:00" }, next: "tonight" },
      },
    }));
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    const drop = await screen.findByText("Accuracy dropped to 60%");
    expect(drop.closest("[role]")?.textContent ?? drop.parentElement?.textContent).toMatch(/against 100% before\. Its instructions changed in between \(v2 to v3\)/);
    const builtIn = screen.getByRole("region", { name: "Built-in questions" });
    expect(builtIn.textContent).toContain("Which drives are connected to this server?");
    expect(builtIn.textContent).toContain("asked every night, 02:00 to 06:00");
    expect(within(screen.getByRole("table", { name: "The latest evaluation's answers" })).getAllByRole("row")[1].textContent).toContain("Which drives are connected: /dev/nvme0n1 (system), /dev/sda");
    const accuracy = screen.getByRole("region", { name: "Accuracy over time" });
    expect(accuracy.textContent).toContain("From 100% to 60% over 3 evaluations.");
    expect(accuracy.textContent).toContain("people said 2 right and 1 wrong this month");
    const rows = within(within(accuracy).getByRole("table", { name: "Each evaluation's score" })).getAllByRole("row").slice(1);
    expect(rows[0].getAttribute("data-status")).toBe("warning");
    expect(rows[0].textContent).toContain("60% · 3/5");
  });
});
