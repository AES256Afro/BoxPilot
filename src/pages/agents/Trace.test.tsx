import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPlan, Run } from "./api";
import { RunView } from "./Trace";

/*
 * A run's view says which model answered it (M45.4): Claude alone, or the local model then Claude,
 * why it moved, and what it cost; and that a shaky local answer is being asked again on Claude.
 */

afterEach(cleanup);

const run = (extra: Partial<Run> = {}): Run => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", agentId: "11111111-1111-4111-8111-111111111111", agentName: "Steve", version: 2, kind: "ask", trigger: {},
  question: "Which apps are running?", state: "completed", reason: null, readRole: "owner",
  queuedAt: "2026-09-29T16:00:00Z", startedAt: "2026-09-29T16:00:00Z", finishedAt: "2026-09-29T16:00:30Z", answer: "Two apps run [T1].", outputKind: "answer",
  usage: { modelMs: 8000, loadMs: 0, promptTokens: 900, completionTokens: 40, toolCalls: 1 }, flags: {}, proposals: [], steps: [], ...extra,
} as Run);

describe("which model answered", () => {
  it("says nothing of Claude for a run that stayed on the local model", () => {
    render(<RunView run={run()} />);
    expect(screen.queryByText("Answered by")).toBeNull();
    expect(screen.queryByText(/Moved to Claude/)).toBeNull();
  });

  it("names the local model then Claude, why it moved, and the cost", () => {
    render(<RunView run={run({ usage: { modelMs: 9000, route: "both", model: "claude-opus-5-5", costUsd: 0.0123, cloudCalls: 2, routeReason: "The local model was unsure of its plan (confidence 0.3)" } })} />);
    expect(screen.getByText("local, then claude-opus-5-5")).toBeTruthy();
    expect(screen.getByText("$0.0123")).toBeTruthy();
    expect(screen.getByText("Moved to Claude: The local model was unsure of its plan (confidence 0.3).")).toBeTruthy();
  });

  it("marks a second opinion, and says one is coming on the run it was asked for", () => {
    render(<RunView run={run({ trigger: { secondOpinionOf: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, usage: { route: "claude", model: "claude-opus-5-5", costUsd: 1.5 } })} />);
    expect(screen.getByText("second opinion")).toBeTruthy();
    expect(screen.getByText("$1.50")).toBeTruthy();
    cleanup();
    render(<RunView run={run({ state: "degraded", flags: { degraded: "model-error", secondOpinion: { runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", reason: "The local model's answer was cut short (model-error)" } } })} />);
    expect(screen.getByText("Asked again on Claude")).toBeTruthy();
    expect(screen.getByText(/cut short \(model-error\)\. Claude answers it as a run of its own/)).toBeTruthy();
  });
});

describe("a plan the run made (M45.6)", () => {
  const plan: AgentPlan = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "Restart and back up Jellyfin", state: "waiting", reason: null, cursor: 2, createdAt: "2026-09-29T16:00:00Z", deadlineAt: "2026-09-30T16:00:00Z",
    steps: [
      { kind: "operation", title: "Start, stop, pause, or restart application", operationId: "app.action", state: "done", note: "It finished.", jobId: "j1", grant: "run", risk: "low" },
      { kind: "check", title: "Check: Jellyfin runs again", operationId: null, state: "done", note: "Jellyfin runs [T2].", jobId: null, grant: null, risk: null },
      { kind: "operation", title: "Back up application data", operationId: "app.backup", state: "waiting", note: null, jobId: "j2", grant: "ask", risk: "medium" },
    ],
  };

  it("shows each step and how it went, and stops the plan while it is going", () => {
    const onStop = vi.fn();
    render(<RunView run={run({ plan })} onStopPlan={onStop} />);
    expect(screen.getByText("Restart and back up Jellyfin")).toBeTruthy();
    expect(screen.getByText("waiting for a person")).toBeTruthy();
    expect(screen.getByText("ran under its leave")).toBeTruthy();
    expect(screen.getByText("Jellyfin runs [T2].")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop the plan" }));
    expect(onStop).toHaveBeenCalledWith(plan.id);
  });

  it("offers no stop once it has ended, and says why it stopped", () => {
    render(<RunView run={run({ plan: { ...plan, state: "failed", reason: "It stopped at step 3: Back up application data failed: disk full" } })} onStopPlan={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Stop the plan" })).toBeNull();
    expect(screen.getByText(/disk full/)).toBeTruthy();
  });
});
