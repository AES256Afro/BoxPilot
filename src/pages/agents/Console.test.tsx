import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, Run } from "./api";

const mocked = vi.hoisted(() => ({ runs: [] as unknown[], followed: [] as string[], runsFor: null as null | ((id: string) => Promise<{ runs: unknown[] }>), cancelled: null as unknown }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    agentsApi: {
      ...actual.agentsApi,
      runs: vi.fn(async (id: string) => (mocked.runsFor ? mocked.runsFor(id) : { runs: mocked.runs })),
      cancel: vi.fn(async () => mocked.cancelled),
    },
    followRun: vi.fn((id: string, onEvent: (event: { event: "snapshot"; data: unknown }) => void) => {
      mocked.followed.push(id);
      const run = mocked.runs.find((entry) => (entry as Run).id === id);
      if (run) onEvent({ event: "snapshot", data: run });
      return () => undefined;
    }),
  };
});

import { Console } from "./Console";

afterEach(() => { cleanup(); mocked.runs = []; mocked.followed = []; mocked.runsFor = null; mocked.cancelled = null; vi.restoreAllMocks(); });

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

describe("one request, several runs", () => {
  it("keeps a delegate's run open, though it is another agent's, when nothing was chosen for the page", async () => {
    // The Test tab opens with no run chosen, so the console follows the agent's latest. It followed
    // it again whenever the run on show was another agent's: opening the delegate's run from the
    // request's tree snapped straight back to the supervisor's.
    const helperId = "22222222-2222-4222-8222-222222222222";
    const supervisor = { ...run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Why is the backup late?", 1) } as Run;
    const delegated = { ...run("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Read the backup job's log", 1), agentId: helperId, agentName: "Log Reader", answer: "The log says the disk was full." } as Run;
    const tree = [
      { id: supervisor.id, parentRunId: null, depth: 0, agentId, agentName: "Steve", kind: "ask", state: "completed", question: supervisor.question, finishedAt: supervisor.finishedAt },
      { id: delegated.id, parentRunId: supervisor.id, depth: 1, agentId: helperId, agentName: "Log Reader", kind: "ask", state: "completed", question: delegated.question, finishedAt: delegated.finishedAt },
    ] as Run["tree"];
    mocked.runs = [{ ...supervisor, tree }, { ...delegated, tree }];
    const props = { agents: [agent], agentId, runId: null, csrfToken: "csrf", role: "owner", now, enabled: true, onSelectAgent: () => undefined, onStage: () => undefined, onRunFinished: () => undefined };
    render(<Console {...props} />);
    const requestRuns = await screen.findByRole("navigation", { name: "This request's runs" });
    expect(mocked.followed).toEqual([supervisor.id]);

    fireEvent.click(within(requestRuns).getByRole("button", { name: "Log Reader" }));
    await waitFor(() => expect(screen.getAllByText("The log says the disk was full.").length).toBeGreaterThan(0));
    expect(mocked.followed).toEqual([supervisor.id, delegated.id]);
  });

  it("opens the latest run of the agent chosen now, not of the one chosen before whose list arrived late", async () => {
    const otherId = "33333333-3333-4333-8333-333333333333";
    const other = { id: otherId, name: "Pi-hole Watcher", purpose: "Watches Pi-hole.", canAsk: true, canEdit: true } as unknown as AgentSummary;
    const steveLatest = run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Most important issue right now?", 1);
    const watcherLatest = { ...run("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "Is Pi-hole blocking?", 2), agentId: otherId, agentName: "Pi-hole Watcher" } as Run;
    mocked.runs = [steveLatest, watcherLatest];
    let answerSteve: (value: { runs: unknown[] }) => void = () => undefined;
    mocked.runsFor = (id) => (id === agentId ? new Promise((resolve) => { answerSteve = resolve; }) : Promise.resolve({ runs: [watcherLatest] }));
    const props = { agents: [agent, other], runId: null, csrfToken: "csrf", role: "owner", now, enabled: true, onSelectAgent: () => undefined, onStage: () => undefined, onRunFinished: () => undefined };
    const view = render(<Console {...props} agentId={agentId} />);
    // Chosen again before Steve's list came back; then Steve's arrives, late.
    view.rerender(<Console {...props} agentId={otherId} />);
    await screen.findByRole("table", { name: "Runs of Pi-hole Watcher" });
    await waitFor(() => expect(mocked.followed).toEqual([watcherLatest.id]));
    answerSteve({ runs: [steveLatest] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const table = screen.getByRole("table", { name: "Runs of Pi-hole Watcher" });
    expect(within(table).getAllByRole("row").map((row) => row.textContent).join(" ")).not.toContain("Most important issue");
    expect(mocked.followed).toEqual([watcherLatest.id]);
  });
});

describe("the run on show", () => {
  const props = { agents: [agent], agentId, csrfToken: "csrf", role: "owner", now, enabled: true, onSelectAgent: () => undefined, onStage: () => undefined, onRunFinished: () => undefined };

  // The verdict form had no key: a "Wrong" opened on one run was still open, half-filled, on the next.
  it("starts each run's verdict afresh, without another run's open Wrong form", async () => {
    const latest = run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Most important issue right now?", 1);
    const earlier = run("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "What runs on this server?", 40);
    mocked.runs = [latest, earlier];
    Element.prototype.scrollIntoView = vi.fn();
    render(<Console {...props} runId={latest.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Wrong" }));
    fireEvent.change(screen.getByLabelText("What was wrong"), { target: { value: "It named the wrong disk" } });
    const table = await screen.findByRole("table", { name: "Runs of Steve" });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3));
    fireEvent.click(within(table).getByRole("button", { name: "Open this run" }));
    await waitFor(() => expect(within(table).getByRole("button", { name: "Showing this run above" }).closest("tr")?.textContent).toContain("What runs on this server?"));
    expect(screen.queryByLabelText("What was wrong")).toBeNull();
  });

  // The cancel reply carries no trace and no tree: put in place of the run, it emptied the trace.
  it("keeps the trace and the request's runs when a run is stopped", async () => {
    const step = { seq: 1, kind: "tool", name: "storage.overview", state: "done", input: {}, output: "3 drives", flags: {}, startedAt: ago(1), durationMs: 20, tokensIn: null, tokensOut: null };
    const live = { ...run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "How full are the drives?", 1), state: "running", finishedAt: null, answer: null, steps: [step],
      tree: [
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", parentRunId: null, depth: 0, agentId, agentName: "Steve", kind: "ask", state: "running", question: "How full are the drives?", finishedAt: null },
        { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", parentRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", depth: 1, agentId: "22222222-2222-4222-8222-222222222222", agentName: "Log Reader", kind: "ask", state: "running", question: "Read the log", finishedAt: null },
      ] } as unknown as Run;
    mocked.runs = [live];
    const { steps: _steps, tree: _tree, ...bare } = live;
    mocked.cancelled = { ...bare, state: "cancelled", reason: "Cancelled by a person", finishedAt: ago(0) };
    render(<Console {...props} runId={live.id} />);
    const trace = await screen.findByRole("list", { name: "What the agent did" });
    expect(within(trace).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Cancelled by a person");
    expect(within(screen.getByRole("list", { name: "What the agent did" })).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "This request's runs" })).toBeTruthy();
  });
});
