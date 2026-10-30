import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

describe("a run held from acting (M45.7)", () => {
  it("says it carried out nothing on words in the owner's notes or documents", () => {
    render(<RunView run={run({ flags: { actHeld: true } })} />);
    expect(screen.getByText("It carried out nothing on what it read")).toBeTruthy();
  });
});

describe("tools by their titles, and citations that open their step (M48.7)", () => {
  const tools = [{ id: "server.facts", title: "Server facts" }, { id: "apps.usage", title: "App usage" }] as unknown as NonNullable<Parameters<typeof RunView>[0]["tools"]>;
  const steps = [
    { seq: 1, kind: "plan", name: null, state: "done", input: [{ step: "Read the server's facts", tool: "server_facts" }], output: null, flags: {}, startedAt: "2026-09-29T16:00:00Z", durationMs: 900, tokensIn: 300, tokensOut: 40 },
    { seq: 2, kind: "model", name: "unsloth/Qwen3.5-4B-GGUF", state: "done", input: [{ name: "server_facts", arguments: "{}" }], output: null, flags: {}, startedAt: "2026-09-29T16:00:01Z", durationMs: 4000, tokensIn: 600, tokensOut: 12 },
    { seq: 3, kind: "tool", name: "server.facts", state: "done", input: {}, output: "hostname: homebox", flags: {}, startedAt: "2026-09-29T16:00:05Z", durationMs: 30, tokensIn: null, tokensOut: null },
    { seq: 4, kind: "tool", name: "drives.list", state: "done", input: {}, output: "sda, sdb", flags: {}, startedAt: "2026-09-29T16:00:06Z", durationMs: 30, tokensIn: null, tokensOut: null },
  ] as Run["steps"];

  it("names a tool by its title where the catalog knows it, with its id beside, and by its dotted id where it does not", () => {
    render(<RunView run={run({ answer: "It is homebox [T1]; two drives [T2].", steps })} tools={tools} />);
    expect(screen.getByText("Asked for Server facts")).toBeTruthy();
    expect(screen.getByText("with Server facts")).toBeTruthy();
    const trace = screen.getByRole("list", { name: "What the agent did" });
    const factsStep = within(trace).getAllByRole("listitem").find((item) => item.textContent?.includes("T1"));
    expect(factsStep?.textContent).toContain("Server facts");
    expect(factsStep?.textContent).toContain("server.facts");
    expect(screen.getByText("drives.list")).toBeTruthy();
    cleanup();
    // Without the catalog: the ids as before, dotted.
    render(<RunView run={run({ answer: "It is homebox [T1].", steps })} />);
    expect(screen.getByText("Asked for server.facts")).toBeTruthy();
  });

  it("opens the cited step and scrolls to it when a citation in the answer is pressed", () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<RunView run={run({ answer: "It is homebox [T1]; two drives [T2].", steps })} tools={tools} />);
    // Closed to begin with: the tool's output is not drawn.
    expect(screen.queryByText("sda, sdb")).toBeNull();
    const cites = screen.getAllByRole("button", { name: "T2: open it in the trace" });
    expect(cites).toHaveLength(1);
    expect(cites[0].textContent).toBe("T2");
    fireEvent.click(cites[0]);
    expect(screen.getByText("sda, sdb")).toBeTruthy();
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(document.getElementById("agents-cite-T2")?.textContent).toContain("drives.list");
    // Pressed again, it stays open rather than closing: the reader asked to see it.
    fireEvent.click(screen.getByRole("button", { name: "T2: open it in the trace" }));
    expect(screen.getByText("sda, sdb")).toBeTruthy();
    expect(scrolled).toHaveBeenCalledTimes(2);
  });

  it("draws a citation as a plain mark where there is no trace to open", () => {
    render(<RunView run={run({ answer: "It is homebox [T1].", steps: [] })} />);
    expect(screen.queryByRole("button", { name: /^T1/ })).toBeNull();
    expect(document.querySelector("code.agents-answer__cite")?.textContent).toBe("T1");
  });
});

describe("a finding offered by meaning (M47.3)", () => {
  it("says so in the step's title, and nothing extra for one offered by words", () => {
    const step = (by: string | undefined) => ({ seq: 1, kind: "finding", name: "Environment Scout", state: "done", input: { id: "F1", noteId: "n1", agentId: "22222222-2222-4222-8222-222222222222", agent: "Environment Scout", writtenAt: "2026-09-29T15:00:00Z", freshUntil: "2026-09-30T15:00:00Z", ...(by ? { by } : {}) }, output: "The backup drive sdb is failing.", flags: { finding: "F1" }, startedAt: "2026-09-29T16:00:01Z", durationMs: null, tokensIn: null, tokensOut: null });
    render(<RunView run={run({ steps: [step("meaning")] as Run["steps"] })} />);
    expect(screen.getByText(/Offered Environment Scout's finding by meaning/)).toBeTruthy();
    cleanup();
    render(<RunView run={run({ steps: [step(undefined)] as Run["steps"] })} />);
    expect(screen.getByText(/^Offered Environment Scout's finding$/)).toBeTruthy();
  });
});
