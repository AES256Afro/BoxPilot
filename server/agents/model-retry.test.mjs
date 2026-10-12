// @vitest-environment node
/**
 * One more try after the model server's 5xx (M48.9), through the whole runner: the fake model
 * answers one chat call with a 500 ("Failed to parse tool call", as llama-server does when the
 * model's tool call is not JSON it can parse), and the run still answers, with the retry in its trace.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";

let h;
afterEach(async () => { await h?.close(); h = null; });

describe("a run that meets a 500 from the model server", () => {
  it("asks once more and answers, with the retry in its trace", async () => {
    h = await createAgentsHarness();
    h.enable();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    let chats = 0;
    h.fake.state.script = () => { chats += 1; return chats === 2 ? { status: 500, error: "Failed to parse tool call: invalid JSON" } : null; };
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "What is this server called?" });
    const run = await h.runNext();
    expect(run.state).toBe("completed");
    expect(run.answer).toBeTruthy();
    const steps = h.store.listSteps(run.id);
    const retried = steps.find((step) => step.kind === "system" && /answered 500 during the .*: asking once more/.test(step.flags?.detail ?? step.output ?? ""));
    expect(retried).toBeTruthy();
    expect(chats).toBeGreaterThanOrEqual(3);
  });

  it("gives up after a second 5xx, as before, and says so", async () => {
    h = await createAgentsHarness();
    h.enable();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.fake.state.script = () => ({ status: 500, error: "the model crashed" });
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "What is this server called?" });
    const run = await h.runNext();
    expect(run.state).toBe("degraded");
    expect(run.flags?.degraded).toBe("model-error");
    const steps = h.store.listSteps(run.id);
    expect(steps.filter((step) => /asking once more/.test(step.flags?.detail ?? step.output ?? "")).length).toBeGreaterThanOrEqual(1);
  });
});
