import { describe, expect, it } from "vitest";
import { act, createFakeProvider, createModelSession, createToolbox, defineTool, paceDefaults } from "../src/index.mjs";

/*
 * One more try after a 5xx (M48.9): llama-server answers 500 when the model's tool call is not JSON
 * it can parse, which the next sample usually is; the owner's Environment Scout lost an eight-step
 * survey to one. A second 5xx ends the call as before. A timeout, a cancel or a 4xx is never tried
 * again: those are the run's own limits or the request's own fault.
 */

const fast = { ...paceDefaults, promptPerSecond: 100_000, generatePerSecond: 100_000, minAnswerTokens: 1, fitMargin: 1 };
const disks = defineTool({ name: "disks_list", kind: "read", description: "The disks.", run: async () => ({ title: "Disks", text: "nvme0n1: 1 TB, the system" }) });
const serverError = (status, message) => Object.assign(new Error(`The model server answered ${status}: ${message}`), { code: "model_error", status });

async function actOn(script, { seconds = 600 } = {}) {
  const { provider, calls } = createFakeProvider({ script });
  const run = { degraded: null, limitReached: false, limitKind: null };
  const used = { modelMs: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, readTokens: 0, modelCalls: 0 };
  const notes = [];
  const clock = { at: 0 };
  const note = async (name, detail, state = "done") => { notes.push({ name, detail, state }); };
  const session = createModelSession({ signal: new AbortController().signal, now: () => clock.at, run, used, pace: fast, timeLeft: () => ({ ms: seconds * 1000 - clock.at, binding: "timeout" }), note });
  session.use({ provider, model: "fake-model" }, { settings: { maxTokens: 512 } });
  const toolbox = createToolbox({ tools: [disks] });
  const steps = [];
  const conversation = { tools: toolbox.schemas, messages: [{ role: "system", content: "Rules." }, { role: "user", content: "Which disk holds the system?" }], last: null };
  const acted = await act({
    session, run, conversation, callTool: (call) => toolbox.call(call), sources: () => toolbox.outputs(), record: async (step) => { steps.push(step); }, note,
    limits: { steps: 6, tokens: 20_000, maxToolCalls: 6, toolCallsPerStep: 3 }, tokensUsed: () => used.readTokens + used.completionTokens, fields: null, pace: fast,
  });
  return { acted, run, calls, notes, steps };
}

describe("one more try after the model server's 5xx", () => {
  it("asks again once after a 500, says so in the trace, and the run goes on", async () => {
    const { acted, run, calls, notes } = await actOn([
      serverError(500, "Failed to parse tool call"),
      { toolCalls: [{ id: "c1", name: "disks_list", arguments: "{}" }] },
      { content: "The system is on nvme0n1 [T1]." },
    ]);
    expect(acted.answer).toBe("The system is on nvme0n1 [T1].");
    expect(run.degraded).toBeNull();
    expect(calls).toHaveLength(3);
    const said = notes.find((entry) => /answered 500 during the next step: asking once more/.test(entry.detail));
    expect(said).toBeTruthy();
    expect(said.detail).toContain("Failed to parse tool call");
    expect(said.state).toBe("done");
  });

  it("ends the call after a second 5xx, as it did after the first", async () => {
    const { acted, run, calls, notes } = await actOn([serverError(500, "Failed to parse tool call"), serverError(503, "loading model")]);
    expect(acted.answer).toBeNull();
    expect(run.degraded).toBe("model-error");
    expect(calls).toHaveLength(2);
    expect(notes.filter((entry) => /asking once more/.test(entry.detail))).toHaveLength(1);
    expect(notes.at(-1)).toMatchObject({ state: "failed" });
    expect(notes.at(-1).detail).toContain("answered 503");
  });

  it("never tries again after a timeout or a 4xx", async () => {
    const timedOut = await actOn([Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })]);
    expect(timedOut.run.degraded).toBe("timeout");
    expect(timedOut.calls).toHaveLength(1);
    const refused = await actOn([Object.assign(new Error("The model server answered 400: Message too long"), { code: "model_error", status: 400 })]);
    expect(refused.run.degraded).toBe("model-error");
    expect(refused.calls).toHaveLength(1);
    expect(refused.notes.some((entry) => /asking once more/.test(entry.detail))).toBe(false);
  });
});
