import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
