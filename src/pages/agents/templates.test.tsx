import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentsPage from "./AgentsPage";
import type { AgentDetail, AgentSpec, Catalog, Overview, Template } from "./api";
import { scheduleWords } from "./format";
// The server's own templates, tools and limits, so the page is tested with the catalog it is
// served rather than a copy of it that could drift. Untyped .mjs, imported on purpose.
// @ts-expect-error -- untyped .mjs
import { agentTemplates, templateQuestions } from "../../../server/agents/templates.mjs";
// @ts-expect-error -- untyped .mjs
import { describeTools, toolCategories } from "../../../server/agents/tool-catalog.mjs";
// @ts-expect-error -- untyped .mjs
import { agentEvents, budgetCeilings, outputFormats } from "../../../server/agents/spec.mjs";

/*
 * Templates in the Builder (M37, M43): every template the server offers is listed with its job,
 * its tools and when it runs, and making an agent from each fills the Build form with that
 * template's own words, schedule and tool permissions - the Environment Scout and the four others
 * M43 added among them.
 */

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
beforeEach(() => { window.history.replaceState(null, "", "/?view=agents"); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = Date.parse("2026-10-04T10:00:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const templates: Template[] = (agentTemplates as Array<Omit<Template, "questions">>).map(({ id, title, summary, spec }) => ({ id, title, summary, spec, questions: (templateQuestions as Record<string, Template["questions"]>)[id] ?? [] }));
const catalog: Catalog = {
  templates,
  tools: describeTools(),
  events: Object.entries(agentEvents as Record<string, string>).map(([id, title]) => ({ id, title })),
  limits: { budget: budgetCeilings, module: { runsPerDay: { min: 10, max: 2_000 }, modelSecondsPerDay: { min: 60, max: 86_400 } } },
  categories: toolCategories, outputFormats, memoryTiers: { fact: "Facts it learned" },
};
const module = { enabled: true, paused: false, pausedUntil: null, killedAt: null, quietHours: { start: "02:00", end: "06:00" }, inQuietHours: false, notify: true };
const overview = { module, runner: { online: true, lastSeenAt: ago(0) }, agents: [], queue: { queued: 0, running: 0, dropped: 0 }, cardsWaiting: 0, can: { create: true, configure: true, pause: true } } as unknown as Overview;

const toolsOn = (spec: AgentSpec) => Object.entries(spec.tools).filter(([, permission]) => permission !== "off");
const idOf = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
/** The agent the server makes from a template: its spec exactly, version 1. */
const detailOf = (id: string, template: Template): AgentDetail => ({
  id, name: template.spec.name, template: template.id, version: 1, purpose: template.spec.purpose, paused: false, pausedUntil: null, status: "off", canEdit: true, canAsk: true,
  createdAt: ago(1), updatedAt: ago(1), lastRun: null, nextRunAt: null, waitsForQuietHours: Boolean(template.spec.triggers.schedule?.quietHours),
  budgetToday: { runsUsed: 0, runsPerDay: template.spec.budget.runsPerDay, modelSecondsUsed: 0, modelSecondsPerDay: template.spec.budget.modelSecondsPerDay, tokensUsed: 0 },
  toolsOn: toolsOn(template.spec).length, triggers: template.spec.triggers, audience: template.spec.audience,
  spec: template.spec, prompt: "BoxPilot's rules.", versions: [{ version: 1, note: null, createdBy: null, createdAt: ago(1) }], createdBy: null,
  warnings: [], webhook: { enabled: false, minted: false }, specialists: [],
} as unknown as AgentDetail);

function serve(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString(), "http://boxpilot.test");
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${url.pathname}`];
    return route === undefined ? json({ error: `unexpected ${method} ${url.pathname}` }, 500) : json(route, method === "POST" ? 201 : 200);
  }));
  return calls;
}
const base = (extra: Record<string, unknown> = {}) => ({
  "GET /api/v1/agents": overview,
  "GET /api/v1/agents/catalog": catalog,
  "GET /api/v1/agents/proposals": { proposals: [] },
  "GET /api/v1/agents/glance": { enabled: true, paused: false, runnerOnline: true, digest: null, cardsWaiting: 0 },
  ...extra,
});
const article = (title: string) => (/^[aeiou]/i.test(title) || /^IT\b/.test(title) ? "an" : "a");
const makeLabel = (template: Template) => (template.id === "blank" ? "Start blank" : `Make ${article(template.title)} ${template.title}`);

describe("the templates on the Build tab", () => {
  it("lists every template the server offers, each with its job, its tools and when it runs", async () => {
    serve(base());
    render(<AgentsPage csrfToken="csrf" now={() => now} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Build" }));
    await screen.findByRole("button", { name: "Make a Server Keeper" });
    for (const template of templates) {
      const card = screen.getByRole("article", { name: template.title });
      expect(card.textContent, template.id).toContain(template.summary);
      expect(card.textContent, template.id).toContain(template.spec.job);
      const count = toolsOn(template.spec).length;
      expect(card.textContent, template.id).toContain(`${count} ${count === 1 ? "tool" : "tools"}`);
      const when = scheduleWords(template.spec.triggers.schedule);
      if (when) expect(card.textContent, template.id).toContain(when);
      expect(within(card).getByRole("button", { name: makeLabel(template) })).toBeTruthy();
    }
    // The owner's ask, in plain words: a weekly survey on Sunday morning, in quiet hours.
    expect(screen.getByRole("article", { name: "Environment Scout" }).textContent).toContain("weekly on Sunday at 04:20");
    for (const title of ["Environment Scout", "App Doctor", "Storage Watch", "Update Planner", "House Guide"]) expect(screen.getByRole("article", { name: title })).toBeTruthy();
  });

  it("makes an agent from each, and fills the form with that template's words, schedule and tools", async () => {
    for (const [index, template] of templates.entries()) {
      const id = idOf(index + 1);
      const made = detailOf(id, template);
      // The page opens an agent it finds in the list it reads again once the agent is made.
      const listed = { ...overview, agents: [made] } as unknown as Overview;
      const calls = serve(base({ "GET /api/v1/agents": listed, "POST /api/v1/agents": made, [`GET /api/v1/agents/${id}`]: made }));
      render(<AgentsPage csrfToken="csrf" now={() => now} />);
      fireEvent.click(await screen.findByRole("tab", { name: "Build" }));
      fireEvent.click(await screen.findByRole("button", { name: makeLabel(template) }));
      await waitFor(() => expect(calls.find((call) => call.method === "POST" && call.path === "/api/v1/agents")?.body, template.id).toEqual({ template: template.id }));

      const { spec } = template;
      expect(((await screen.findByLabelText("Name")) as HTMLInputElement).value, template.id).toBe(spec.name);
      expect((screen.getByLabelText("Its one job") as HTMLInputElement).value, template.id).toBe(spec.job);
      expect((screen.getByLabelText("It did its job when") as HTMLTextAreaElement).value, template.id).toBe(spec.successCriteria.join("\n"));
      expect((screen.getByLabelText(/^Purpose/) as HTMLInputElement).value, template.id).toBe(spec.purpose);
      expect((screen.getByLabelText(/^Rules/) as HTMLTextAreaElement).value, template.id).toBe(spec.prompt.rules.join("\n"));
      expect((screen.getByLabelText(/^How it works/) as HTMLTextAreaElement).value, template.id).toBe(spec.prompt.steps.join("\n"));
      const schedule = spec.triggers.schedule;
      expect((screen.getByLabelText("Schedule") as HTMLSelectElement).value, template.id).toBe(schedule?.every ?? "none");
      if (schedule?.every === "weekly") expect((screen.getByLabelText("Day") as HTMLSelectElement).value, template.id).toBe(String(schedule.weekday));
      if (schedule && schedule.hour !== null) expect((screen.getByLabelText("Hour") as HTMLSelectElement).value, template.id).toBe(String(schedule.hour));
      // Each tool it uses is on (or "Asked") in the table; the rest are off.
      for (const tool of catalog.tools) {
        const group = screen.getByRole("radiogroup", { name: `${tool.title}: permission` });
        const want = { auto: "On", ask: "Asked", off: "Off" }[spec.tools[tool.id] ?? "off"];
        expect(within(group).getByRole("radio", { name: want }).getAttribute("aria-checked"), `${template.id}: ${tool.id}`).toBe("true");
      }
      cleanup();
      vi.unstubAllGlobals();
      window.history.replaceState(null, "", "/?view=agents");
    }
  }, 60_000);
});
