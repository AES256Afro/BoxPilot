import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, Run } from "./api";

const mocked = vi.hoisted(() => ({ runs: [] as unknown[], followed: [] as string[] }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, runs: vi.fn(async () => ({ runs: mocked.runs })) },
    followRun: vi.fn((id: string, onEvent: (event: { event: "snapshot"; data: unknown }) => void) => {
      mocked.followed.push(id);
      const run = mocked.runs.find((entry) => (entry as Run).id === id);
      if (run) onEvent({ event: "snapshot", data: run });
      return () => undefined;
    }),
  };
});

import { Console } from "./Console";

afterEach(() => { cleanup(); mocked.runs = []; mocked.followed = []; vi.restoreAllMocks(); });

const now = Date.parse("2026-09-29T16:00:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const agentId = "11111111-1111-4111-8111-111111111111";
const agent = { id: agentId, name: "Steve", purpose: "Knows this server.", canAsk: true, canEdit: true } as unknown as AgentSummary;
const run = (id: string, question: string, minutes: number): Run => ({
  id, agentId, agentName: "Steve", version: 2, kind: "ask", trigger: {}, question, state: "completed", reason: null, readRole: "owner",
  queuedAt: ago(minutes), startedAt: ago(minutes), finishedAt: ago(minutes), answer: `Answer to ${question}`, outputKind: "answer",
  usage: { modelMs: 8000, loadMs: 0, promptTokens: 900, completionTokens: 40, toolCalls: 1 }, flags: {}, proposals: [], steps: [],
} as unknown as Run);

describe("earlier runs", () => {
  it("opens the chosen run above, scrolls to it, and keeps it when the page renders again", async () => {
    const latest = run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Most important issue right now?", 1);
    const earlier = run("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "What runs on this server?", 40);
    mocked.runs = [latest, earlier];
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    // The page opened the latest run itself (a card's "Open the run"), and hands a new callback on
    // every render, as AgentsPage does.
    const props = { agents: [agent], agentId, runId: latest.id, csrfToken: "csrf", role: "owner", now, enabled: true, onSelectAgent: () => undefined, onStage: () => undefined };
    const view = render(<Console {...props} onRunFinished={() => undefined} />);
    const table = await screen.findByRole("table", { name: "Runs of Steve" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3));
    expect(within(table).getByRole("button", { name: "Showing this run above" })).toBeTruthy();

    fireEvent.click(within(table).getByRole("button", { name: "Open this run" }));
    expect(mocked.followed.at(-1)).toBe(earlier.id);
    expect(scrolled).toHaveBeenCalledTimes(1);
    const shown = within(table).getByRole("button", { name: "Showing this run above" });
    expect(shown.closest("tr")?.textContent).toContain("What runs on this server?");

    // A render with a new callback must not follow the page's run again over the opened one.
    const follows = mocked.followed.length;
    view.rerender(<Console {...props} now={now + 1000} onRunFinished={() => undefined} />);
    view.rerender(<Console {...props} now={now + 2000} onRunFinished={() => undefined} />);
    expect(mocked.followed.length).toBe(follows);
    expect(within(table).getByRole("button", { name: "Showing this run above" }).closest("tr")?.textContent).toContain("What runs on this server?");
  });
});
