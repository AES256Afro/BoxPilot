import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, Evaluation as EvaluationState } from "./api";

const mocked = vi.hoisted(() => ({
  pending: new Map<string, (value: unknown) => void>(),
  saved: [] as Array<{ id: string; questions: unknown[] }>,
}));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    agentsApi: {
      ...actual.agentsApi,
      // Each read waits until the test answers it, so the answers can arrive in any order.
      evaluation: vi.fn((id: string) => new Promise((resolve) => { mocked.pending.set(id, resolve); })),
      saveEvaluation: vi.fn(async (_csrf: string, id: string, questions: unknown[]) => { mocked.saved.push({ id, questions }); return { questions, runs: [], canEdit: true }; }),
    },
  };
});

import { Evaluation } from "./Evaluation";

afterEach(() => { cleanup(); mocked.pending.clear(); mocked.saved = []; vi.restoreAllMocks(); });

const steve = { id: "11111111-1111-4111-8111-111111111111", name: "Steve", canEdit: true } as unknown as AgentSummary;
const watcher = { id: "33333333-3333-4333-8333-333333333333", name: "Pi-hole Watcher", canEdit: true } as unknown as AgentSummary;
const state = (question: string): EvaluationState => ({ questions: [{ id: "q1", question, expect: { includes: ["yes"] } }], runs: [], canEdit: true });

describe("golden questions, when another agent is chosen while its read is on the way", () => {
  it("shows and saves the agent chosen now, never the late answer for the one before", async () => {
    const props = { agents: [steve, watcher], csrfToken: "csrf", now: Date.parse("2026-09-29T16:00:00Z"), enabled: true, onSelectAgent: () => undefined, onOpenRun: () => undefined };
    const view = render(<Evaluation {...props} agentId={steve.id} />);
    await waitFor(() => expect(mocked.pending.has(steve.id)).toBe(true));
    view.rerender(<Evaluation {...props} agentId={watcher.id} />);
    await waitFor(() => expect(mocked.pending.has(watcher.id)).toBe(true));
    // Steve's answer arrives after the switch, before the Watcher's. It became the Watcher's drafts,
    // and the Watcher's own answer then kept them, as drafts already being edited.
    mocked.pending.get(steve.id)!(state("What is this server called?"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocked.pending.get(watcher.id)!(state("Is Pi-hole blocking ads?"));
    await screen.findByDisplayValue("Is Pi-hole blocking ads?");
    expect(screen.queryByDisplayValue("What is this server called?")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save the questions" }));
    await waitFor(() => expect(mocked.saved).toHaveLength(1));
    expect(mocked.saved[0]).toMatchObject({ id: watcher.id, questions: [{ question: "Is Pi-hole blocking ads?" }] });
  });
});

describe("adding a golden question", () => {
  // A new question was numbered from how many there were: after a removal it took the id of one
  // still there, and the two questions' grades were swapped.
  it("gives a new question an id no other question has, after one was removed, and after quick clicks", async () => {
    const props = { agents: [steve], csrfToken: "csrf", now: Date.parse("2026-09-29T16:00:00Z"), enabled: true, onSelectAgent: () => undefined, onOpenRun: () => undefined };
    render(<Evaluation {...props} agentId={steve.id} />);
    await waitFor(() => expect(mocked.pending.has(steve.id)).toBe(true));
    mocked.pending.get(steve.id)!({ questions: [
      { id: "q1", question: "What is this server called?", expect: { fact: "hostname" } },
      { id: "q2", question: "Is Pi-hole blocking ads?", expect: { includes: ["yes"] } },
    ], runs: [], canEdit: true });
    await screen.findByDisplayValue("Is Pi-hole blocking ads?");
    fireEvent.click(screen.getByRole("button", { name: "Remove question 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a question" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a question" }));
    const fields = screen.getAllByLabelText(/^Question \d$/) as HTMLInputElement[];
    fireEvent.change(fields[1], { target: { value: "How full is the backup drive?" } });
    fireEvent.change(fields[2], { target: { value: "Is Jellyfin up?" } });
    const expected = screen.getAllByLabelText("Expected answer") as HTMLInputElement[];
    for (const field of expected.slice(1)) fireEvent.change(field, { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the questions" }));
    await waitFor(() => expect(mocked.saved).toHaveLength(1));
    const ids = (mocked.saved[0].questions as Array<{ id: string }>).map((question) => question.id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe("q2");
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
  });
});
