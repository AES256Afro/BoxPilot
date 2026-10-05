import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../operations";
import type { PendingOperation } from "../../shell/ApproveDialog";
import type { Proposal } from "./api";
import { ProposalCard } from "./ProposalCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const proposal: Proposal = {
  id: "card-1", kind: "plan", question: null, agentId: "agent-1", agentName: "Server Keeper", runId: "run-1", source: "agent",
  title: "Tidy up the backup account", reason: "The nightly backup needs its own account.",
  steps: [{ operationId: "users.add", title: "Add a user", risk: "medium", readOnly: false, approval: "One confirmation, with a preview", typedConfirmation: false, parameters: { username: "backup", githubUser: "someone-else" }, why: "A service account for the nightly backup" }],
  dropped: [], flags: {}, state: "open", forRole: "owner", createdAt: "2026-09-29T00:00:00Z", expiresAt: "2026-10-06T00:00:00Z", jobIds: [],
};

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

  // Decided when the job was staged, the card stayed decided after the approval was cancelled and
  // the job withdrawn: Stage was gone, and the server said the card was already decided.
  it("is decided only once its step is approved, so a cancelled approval can be staged again", async () => {
    const decided: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      decided.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Promise.resolve(new Response(JSON.stringify({ proposal: { ...proposal, state: "staged", jobIds: ["job-1"] } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }));
    const onStage = vi.fn();
    const onDecided = vi.fn();
    render(<ProposalCard proposal={proposal} csrfToken="csrf" role="owner" onStage={onStage} onDecided={onDecided} />);
    fireEvent.click(screen.getByRole("button", { name: "Stage Add a user" }));
    const operation = onStage.mock.calls[0][0] as PendingOperation;
    // Staged, then cancelled: nothing is decided, and the step can be staged again.
    operation.onStaged?.({ id: "job-1" } as Job);
    await act(async () => {});
    expect(decided).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Stage Add a user" })).toBeTruthy();
    // Approved: the card is done, with the job that came of it.
    await act(async () => { operation.onApproved?.({ id: "job-2" } as Job); });
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
    expect(decided).toEqual([expect.objectContaining({ decision: "staged", jobIds: ["job-2"] })]);
  });
});
