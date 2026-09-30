// @vitest-environment node
/**
 * The agent checks itself before it answers (M40), end to end: the real service, tools and runner,
 * the stand-in model scripted to give the owner's wrong answer about the drives, on a server laid
 * out like the owner's. The check catches it; the model is asked once to correct it when that fits
 * in what is left, the correction is checked too, and what still does not match is said plainly.
 * The model's speed is the owner's server's, measured on 2026-09-29 (52 tokens a second read, 10
 * written, four threads), on the harness's clock: the correction's cost is printed for the record.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { ownerLikeStorage, ownersWrongAnswer } from "../../test/fixtures/agents-storage.mjs";
import { runnerCaps } from "./caps.mjs";
import { defaultRuntimeSettings, modelSpeedKey } from "./service.mjs";
import { correctionSystem } from "./verify.mjs";

const rightAnswer = "Two drives are connected: /dev/nvme0n1, an NVMe SSD of 1.02 TB and the system disk, which holds / (528 GB, 31% used) [T1]; and /dev/sda, a 16.0 TB USB drive holding /mnt/archive, 15% used [T1].";
const question = "List the drives connected to BoxPilot";

let h;
afterEach(async () => { await h?.close(); h = null; });

async function setUp({ correction = rightAnswer, speed = { promptPerSecond: 52, generatePerSecond: 10 }, runSeconds = null } = {}) {
  h = await createAgentsHarness();
  h.enable();
  h.snapshot.storage = ownerLikeStorage();
  const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
  if (runSeconds) {
    const current = h.service.getAgent(h.caller("owner"), agent.id).spec;
    h.service.updateAgent(h.caller("owner"), agent.id, { spec: { ...current, budget: { ...current.budget, runSeconds } } });
  }
  h.fake.state.speed = speed;
  h.fake.state.clock = (ms) => h.advance(ms);
  // BoxPilot measured this speed before, so the runner plans every call with it from the first.
  h.state.setSetting(modelSpeedKey, { ...speed, source: "server", model: defaultRuntimeSettings().repo, threads: runnerCaps.modelThreads, runs: 1, measuredAt: h.now().toISOString() });
  const corrections = [];
  h.fake.state.script = (body) => {
    const system = String(body.messages?.find((message) => message.role === "system")?.content ?? "");
    if (system === correctionSystem) { corrections.push(body.messages[1].content); return { content: correction }; }
    const tools = (body.messages ?? []).filter((message) => message.role === "tool").length;
    return tools === 0 ? { toolCalls: [{ name: "storage_health", arguments: {} }] } : { content: ownersWrongAnswer };
  };
  return { agent, corrections };
}

async function ask(agent) {
  const queued = h.service.startRun(h.caller("owner"), agent.id, { kind: "ask", question });
  const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
  const started = h.now().getTime();
  await h.runner.execute(claim);
  return { run: h.service.getRun(h.caller("owner"), queued.id), wallMs: h.now().getTime() - started };
}

describe("the check before answering", () => {
  it("catches the owner's wrong answer about the drives and has the model correct it, within the run", async () => {
    const { agent, corrections } = await setUp();
    const { run, wallMs } = await ask(agent);
    expect(run.state).toBe("completed");
    expect(run.answer).toBe(rightAnswer);
    // The model was shown only what it needed: the failing claim, what did not match, and the lines about it.
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatch(/Checks that failed:\n- "- \*\*\/dev\/sda\*\* \(primary drive\): 528 GB total, 31% used": T1 gives 528 GB for something else/);
    expect(corrections[0]).toMatch(/\[T1\] - \/dev\/sda: USB drive \(spinning disk\), 16\.0 TB/);
    expect(corrections[0].length).toBeLessThan(3_500);
    const check = run.steps.filter((step) => step.kind === "system" && step.name === "check");
    expect(check).toHaveLength(1);
    expect(check[0].flags.detail).toMatch(/^Checked the answer against the tool output it cites: \d statements did not match; the model corrected them \(\d+(\.\d)? s\)\.$/);
    expect(run.flags.check).toEqual({ claims: 1, checked: 1, mismatches: 0, corrected: true, found: 3, unsure: false });
    // What it cost, on the owner's server's speed.
    const correction = run.steps.filter((step) => step.kind === "model").at(-1);
    console.log(`The check: ${run.usage.checkMs} ms of text work; the correction ${correction.tokensIn} tokens read, ${correction.tokensOut} written, ${Math.round(run.usage.correctionMs / 100) / 10} s at 52 and 10 tokens a second; the whole run ${Math.round(wallMs / 1000)} s.`);
    expect(run.usage.checkMs).toBeLessThan(50);
    expect(run.usage.correctionMs).toBeLessThan(40_000);
    expect(run.usage.correctionMs).toBeGreaterThan(0);
  });

  it("says plainly what it is not sure of when the correction is no better", async () => {
    const { agent } = await setUp({ correction: ownersWrongAnswer });
    const { run } = await ask(agent);
    expect(run.state).toBe("completed");
    expect(run.answer.startsWith(ownersWrongAnswer)).toBe(true);
    expect(run.answer).toMatch(/\n\nChecked against the tools, some of this does not match what they said, so I am not sure of it:\n- "- \*\*\/dev\/sda\*\* \(primary drive\): 528 GB total, 31% used": T1 gives 528 GB for something else/);
    expect(run.answer).toMatch(/T1 says \/dev\/sda is not the system disk; the system disk is \/dev\/nvme0n1\./);
    expect(run.flags.check).toMatchObject({ corrected: false, unsure: true, mismatches: 3 });
    expect(run.steps.find((step) => step.name === "check")).toMatchObject({ state: "failed" });
  });

  it("does not ask for a correction that cannot fit, and does not end the run degraded for it", async () => {
    // At 52 and 10 tokens a second the run takes about 65 s before the check and the correction
    // about 15 s; a 90 s run keeps 15 s back for its finish, which leaves no room for it.
    const { agent, corrections } = await setUp({ runSeconds: 90 });
    const { run } = await ask(agent);
    expect(corrections).toHaveLength(0);
    expect(run.state).toBe("completed");
    expect(run.flags.degraded).toBeUndefined();
    expect(run.answer).toMatch(/so I am not sure of it:/);
    expect(run.steps.some((step) => step.kind === "system" && /^Not starting the correction/.test(step.flags?.detail ?? ""))).toBe(true);
  });

  it("leaves a right answer as it is, and says it checked", async () => {
    const { agent, corrections } = await setUp();
    h.fake.state.script = (body) => ((body.messages ?? []).some((message) => message.role === "tool") ? { content: rightAnswer } : { toolCalls: [{ name: "storage_health", arguments: {} }] });
    const { run } = await ask(agent);
    expect(corrections).toHaveLength(0);
    expect(run.answer).toBe(rightAnswer);
    expect(run.flags.check).toEqual({ claims: 1, checked: 1, mismatches: 0, corrected: false, found: 0, unsure: false });
    expect(run.steps.find((step) => step.name === "check").flags.detail).toBe("Checked the answer against the tool output it cites: 1 statement with facts to check, all match.");
  });
});
