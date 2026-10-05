import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../operations";
import type { PendingOperation } from "../../shell/ApproveDialog";
import type { PlanStep, Proposal } from "./api";
import { ProposalCard } from "./ProposalCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const proposal: Proposal = {
  id: "card-1", kind: "plan", question: null, agentId: "agent-1", agentName: "Server Keeper", runId: "run-1", source: "agent",
  title: "Tidy up the backup account", reason: "The nightly backup needs its own account.",
  steps: [{ operationId: "users.add", title: "Add a user", risk: "medium", readOnly: false, approval: "One confirmation, with a preview", typedConfirmation: false, parameters: { username: "backup", githubUser: "someone-else" }, why: "A service account for the nightly backup" }],
  dropped: [], flags: {}, state: "open", forRole: "owner", createdAt: "2026-09-29T00:00:00Z", expiresAt: "2026-10-06T00:00:00Z", jobIds: [],
};

// BoxPilot's own card when Unsloth publishes a newer Qwen: download it, then switch agents to it.
const model = { repo: "unsloth/Qwen3.6-4B-GGUF", file: "Qwen3.6-4B-UD-Q4_K_XL.gguf", projector: null };
const modelCard: Proposal = {
  ...proposal, id: "card-2", kind: "plan", agentId: null, agentName: "BoxPilot", runId: null, source: "runtime",
  title: "Switch agents to Qwen3.6-4B-GGUF", reason: "Unsloth published a newer Qwen.",
  steps: [
    { operationId: "agents.model.download", title: "Download a model for agents", risk: "medium", readOnly: false, approval: "One confirmation", typedConfirmation: false, parameters: model, why: "Download the newer model.", jobId: null, jobState: null, status: "ready" },
    { operationId: "agents.model.switch", title: "Switch the agents' model", risk: "medium", readOnly: false, approval: "One confirmation", typedConfirmation: false, parameters: model, why: "Use it for the next run.", jobId: null, jobState: null, status: "ready" },
  ],
};

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const withStep = (card: Proposal, index: number, change: Partial<PlanStep>): Proposal => ({ ...card, steps: card.steps.map((step, at) => (at === index ? { ...step, ...change } : step)) });

/**
 * The server's side of a card, as far as the card touches it: it keeps which job each step was
 * staged as, and answers each read with the card as it now stands. `served.card` is what it holds.
 */
function serveCard(first: Proposal) {
  const served = { card: first };
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input.toString(), "http://boxpilot.test").pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ method, path, body });
    const step = path.match(/\/steps\/(\d+)\/job$/);
    if (method === "POST" && step) {
      const index = Number(step[1]);
      const held = served.card.steps[index];
      if (held.jobId && held.jobId !== body.jobId && (held.status === "waiting" || held.status === "approved")) return json({ error: "This step is already staged: review the job waiting for it instead", code: "step_staged" }, 409);
      // Waiting until the jobs API says it was approved, which a test sets by changing `served`.
      served.card = withStep(served.card, index, { jobId: String(body.jobId), jobState: held.jobId === body.jobId ? held.jobState : "awaiting_approval", status: held.jobId === body.jobId ? held.status : "waiting" });
      return json(served.card);
    }
    if (method === "GET" && path === `/api/v1/agents/proposals/${first.id}`) return json(served.card);
    if (method === "DELETE" && path.startsWith("/api/v1/jobs/")) return json({ error: "Only jobs that are awaiting approval can be cancelled" }, 409);
    return json({ error: `unexpected ${method} ${path}` }, 500);
  }));
  return { served, calls };
}

/** A card drawn the way a page draws it: whatever the card hands back is what the page shows next. */
function Shown({ card, onStage }: { card: Proposal; onStage: (operation: PendingOperation) => void }) {
  const [shown, setShown] = useState(card);
  return <ProposalCard proposal={shown} csrfToken="csrf" role="owner" onStage={onStage} onDecided={setShown} />;
}

describe("an agent's card", () => {
  // The step's words are the model's; what it would be given is what runs. Both are on the card.
  it("lists what each step would be given, beside the agent's words", () => {
    render(<ProposalCard proposal={proposal} csrfToken="csrf" role="owner" onStage={() => {}} onDecided={() => {}} />);
    expect(screen.getByText("someone-else")).toBeTruthy();
    expect(screen.getByText("githubUser")).toBeTruthy();
  });

  it("stages a step saying which agent suggested it", () => {
    const onStage = vi.fn();
    render(<ProposalCard proposal={proposal} csrfToken="csrf" role="owner" onStage={onStage} onDecided={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Stage Add a user" }));
    expect(onStage).toHaveBeenCalledWith(expect.objectContaining({ operationId: "users.add", parameters: { username: "backup", githubUser: "someone-else" }, proposedBy: "Server Keeper" }));
  });

  // Sweep 3, R3B4-1: which step was staged lived in the card itself. Another tab, leaving the page
  // or a reload forgot it, and the download step offered Stage again: a second multi-GB download.
  it("keeps a staged step staged when the card is drawn again, so a download is never offered twice", async () => {
    const { served, calls } = serveCard(modelCard);
    const onStage = vi.fn();
    const { unmount } = render(<Shown card={modelCard} onStage={onStage} />);
    fireEvent.click(screen.getByRole("button", { name: "Stage Download a model for agents" }));
    const operation = onStage.mock.calls[0][0] as PendingOperation;
    // Staged: the server is told which job it is, and the card says it waits.
    await act(async () => { operation.onStaged?.({ id: "job-1" } as Job); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stage Download a model for agents" })).toBeNull());
    expect(calls.find((call) => call.method === "POST")).toMatchObject({ path: "/api/v1/agents/proposals/card-2/steps/0/job", body: { jobId: "job-1" } });
    expect(screen.getByRole("button", { name: "Review Download a model for agents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stage Switch the agents' model" })).toBeTruthy();
    // Approved in its dialog: the server is told again, and the job's approval is what it counts.
    served.card = withStep(served.card, 0, { jobState: "applying", status: "approved" });
    await act(async () => { operation.onApproved?.({ id: "job-1" } as Job); });
    expect(await screen.findByText("approved")).toBeTruthy();
    // Gone and drawn again (another tab, Usage and back, a reload): the card is the server's.
    unmount();
    render(<Shown card={served.card} onStage={onStage} />);
    expect(screen.queryByRole("button", { name: "Stage Download a model for agents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review Download a model for agents" })).toBeNull();
    expect(screen.getByText("approved")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stage Switch the agents' model" })).toBeTruthy();
    // The card is never decided from here: the server decides it once every step's job is approved.
    expect(calls.some((call) => call.path.endsWith("/decide"))).toBe(false);
  });

  // Sweep 3, R3B4-2: approved from a push, Activity or Today, the card never heard of it. Its own
  // dialog's Confirm then failed, Cancel's withdrawal was refused quietly, and Stage ran it twice.
  it("reads itself again once its dialog's withdrawal lands, and shows a step approved elsewhere as decided", async () => {
    const { served, calls } = serveCard(proposal);
    const onStage = vi.fn();
    render(<Shown card={proposal} onStage={onStage} />);
    fireEvent.click(screen.getByRole("button", { name: "Stage Add a user" }));
    const operation = onStage.mock.calls[0][0] as PendingOperation;
    await act(async () => { operation.onStaged?.({ id: "job-1" } as Job); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stage Add a user" })).toBeNull());
    // Approved on the phone: the jobs API approved it, and the server decided the card.
    served.card = { ...withStep(served.card, 0, { jobState: "applying", status: "approved" }), state: "staged", jobIds: ["job-1"] };
    // Cancel at the desk: the dialog's withdrawal is refused (the job was approved), then the card reads itself.
    await act(async () => { operation.onWithdrawn?.("job-1"); });
    const card = screen.getByRole("article", { name: "Card: Tidy up the backup account" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("staged"));
    expect(within(card).queryByRole("button", { name: "Stage Add a user" })).toBeNull();
    expect(within(card).getByText("approved")).toBeTruthy();
    expect(calls.filter((call) => call.method === "GET").map((call) => call.path)).toEqual(["/api/v1/agents/proposals/card-1"]);
  });

  // A reload with the dialog open left the job waiting; approved from Today, the card was decided.
  it("offers no Stage on a card the server decided, and Review, not Stage, for a step that waits", () => {
    const onStage = vi.fn();
    const decided: Proposal = { ...withStep(proposal, 0, { jobId: "job-1", jobState: "completed", status: "approved" }), state: "staged", jobIds: ["job-1"] };
    const { unmount } = render(<ProposalCard proposal={decided} csrfToken="csrf" role="owner" onStage={onStage} onDecided={() => {}} />);
    expect(screen.queryByRole("button", { name: "Stage Add a user" })).toBeNull();
    unmount();
    render(<ProposalCard proposal={withStep(proposal, 0, { jobId: "job-1", jobState: "awaiting_approval", status: "waiting" })} csrfToken="csrf" role="owner" onStage={onStage} onDecided={() => {}} />);
    expect(screen.queryByRole("button", { name: "Stage Add a user" })).toBeNull();
    expect(screen.getByText("waiting for approval")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review Add a user" }));
    // The job already staged, opened as it is: closing it leaves it waiting, and nothing new is staged.
    expect(onStage).toHaveBeenCalledWith(expect.objectContaining({ operationId: "users.add", existingJobId: "job-1" }));
    expect((onStage.mock.calls[0][0] as PendingOperation).onStaged).toBeUndefined();
  });

  it("offers Stage again for a step whose job was cancelled or never started", () => {
    render(<ProposalCard proposal={withStep(proposal, 0, { jobId: "job-1", jobState: "cancelled", status: "ready" })} csrfToken="csrf" role="owner" onStage={() => {}} onDecided={() => {}} />);
    expect(screen.getByRole("button", { name: "Stage Add a user" })).toBeTruthy();
  });

  // Two tabs pressed Stage on the same step: the server keeps the first job, and the second is withdrawn.
  it("withdraws a second job for a step another job already holds", async () => {
    const { calls } = serveCard(withStep(proposal, 0, { jobId: "job-1", jobState: "awaiting_approval", status: "waiting" }));
    const onStage = vi.fn();
    render(<ProposalCard proposal={proposal} csrfToken="csrf" role="owner" onStage={onStage} onDecided={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Stage Add a user" }));
    const operation = onStage.mock.calls[0][0] as PendingOperation;
    await act(async () => { operation.onStaged?.({ id: "job-2" } as Job); });
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/v1/jobs/job-2")).toBe(true));
    expect(screen.getByText(/already staged/)).toBeTruthy();
  });
});
