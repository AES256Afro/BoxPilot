// @vitest-environment node
/**
 * An accuracy score that means something (M40): built-in questions each agent's own tools can
 * answer, graded against this server's facts; asked every night in quiet hours within the budgets,
 * as background work; followed over time with a drop flagged; and fed by people's "wrong".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { describeEval, runEvalSet } from "../../test/agents-eval.mjs";
import { ownerLikeStorage, ownersWrongAnswer } from "../../test/fixtures/agents-storage.mjs";
import { gradeDrives, gradeFact } from "./service.mjs";
import { builtInQuestions } from "./templates.mjs";
import { drivesOf } from "./tool-text.mjs";

const drives = drivesOf({ storage: ownerLikeStorage() });

describe("grading the built-in questions", () => {
  it("fails the owner's answer about the drives, and passes a right one however it is worded", () => {
    expect(gradeDrives(drives, ownersWrongAnswer)).toEqual({ passed: false, found: "Missing: /dev/nvme0n1" });
    expect(gradeDrives(drives, "Two drives: /dev/sda is the primary drive and nvme0n1 holds data.")).toEqual({ passed: false, found: "Wrong: calls /dev/sda the system disk" });
    expect(gradeDrives(drives, "/dev/nvme0n1 is the system disk, on NVMe. /dev/sda is an NVMe drive too.")).toEqual({ passed: false, found: "Wrong: calls /dev/sda NVME; it is USB" });
    expect(gradeDrives(drives, "Two: nvme0n1, the NVMe system disk holding /, and sda, a 16 TB USB drive.").passed).toBe(true);
    expect(gradeDrives(drives, "- **/dev/nvme0n1** (primary drive): NVMe SSD, 1.02 TB\n- **/dev/sda**: USB drive, 16.0 TB, not the system disk")).toEqual({ passed: true, found: "Names /dev/nvme0n1 and /dev/sda" });
    expect(gradeDrives(null, "anything").passed).toBe(false);
  });

  it("grades which apps are stopped, and the OS with its version", () => {
    expect(gradeFact("stoppedApps", ["nextcloud", "pi-hole"], "nextcloud and Pihole are stopped.").passed).toBe(true);
    expect(gradeFact("stoppedApps", ["nextcloud", "pi-hole"], "nextcloud is stopped.")).toEqual({ passed: false, found: "Missing: pi-hole" });
    expect(gradeFact("stoppedApps", [], "None: all apps are running.").passed).toBe(true);
    expect(gradeFact("stoppedApps", [], "jellyfin is stopped.").passed).toBe(false);
    expect(gradeFact("operatingSystem", "Ubuntu 24.04.3 LTS", "Ubuntu 22.04").passed).toBe(false);
  });

  it("scores every question right on the stand-in model, on a server laid out like the owner's", async () => {
    // Before M40 the same set scored 2 of 6 here: storage.health named no drive, and the root's
    // use and the stopped app were not where a reader looks first (test/agents-eval.mjs).
    const outcome = await runEvalSet();
    console.log(describeEval(outcome, "The built-in evaluation on the stand-in model"));
    expect(outcome.results.filter((result) => !result.passed)).toEqual([]);
    expect(outcome.results.find((result) => result.id === "pihole").tools[0]).toBe("where.runs");
  }, 60_000);

  it("asks an agent only what its own tools answer", () => {
    const tools = (on) => Object.fromEntries(on.map((id) => [id, "auto"]));
    expect(builtInQuestions({ tools: tools(["storage.health"]) }).map((question) => question.id)).toEqual(["builtin-drives", "builtin-root"]);
    expect(builtInQuestions({ tools: { "where.runs": "ask", "apps.list": "off" } }).map((question) => question.id)).toEqual(["builtin-pihole"]);
    expect(builtInQuestions({ tools: {} })).toEqual([]);
  });
});

// Each night is a few dozen real runs through the stand-in model: slower than one test's default.
describe("the evaluation, night after night", { timeout: 60_000 }, () => {
  let h;
  beforeEach(async () => {
    h = await createAgentsHarness({ start: new Date(2026, 8, 29, 10, 0, 0) });
    h.enable();
    h.snapshot.storage = ownerLikeStorage();
  });
  afterEach(async () => { await h.close(); });

  // Answers each built-in question from the right tool, rightly or (for the drives) as the owner's agent did.
  const answering = ({ drivesRight }) => (body) => {
    const question = String(body.messages?.[1]?.content ?? "");
    const route = [
      [/drives/, "storage_health", {}, drivesRight ? "/dev/nvme0n1 is the NVMe system disk [T1]. /dev/sda is a USB drive [T1]." : ownersWrongAnswer],
      [/root filesystem/, "storage_health", {}, "31% [T1]."],
      [/Pi-hole/, "where_runs", { name: "pihole" }, "Pi-hole runs as a BoxPilot app in the container bp-pi-hole [T1]."],
      [/stopped/, "apps_list", {}, "None: every app is running [T1]."],
      [/operating system/, "server_facts", {}, "Ubuntu 24.04.3 LTS [T1]."],
    ].find(([pattern]) => pattern.test(question));
    if (!route) return { content: "I do not know." };
    return body.messages.some((message) => message.role === "tool") ? { content: route[3] } : { toolCalls: [{ name: route[1], arguments: route[2] }] };
  };
  const drain = async () => { let ran = 0; while (await h.runNext()) ran += 1; return ran; };

  it("is queued in quiet hours as the agent's maker, runs after everything else, once a night", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.fake.state.script = answering({ drivesRight: true });
    // Not during the day.
    await h.service.tick();
    expect(h.store.activeRuns().filter((run) => run.kind === "eval")).toHaveLength(0);
    // In quiet hours: queued, as nobody's question, waiting for quiet hours like other background work.
    h.service.relearn(h.caller("owner"), keeper.id);
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await h.service.tick();
    const queued = h.store.activeRuns().filter((run) => run.kind === "eval");
    const evaluation = h.service.getEvaluation(h.caller("owner"), keeper.id);
    // Its two built-in questions the template's own do not already ask (drives, stopped apps), and the template's five.
    expect(evaluation.builtIn.map((question) => question.id)).toEqual(["builtin-drives", "builtin-stopped"]);
    expect(queued.length).toBe(7);
    expect(queued.every((run) => run.requestedBy === null && run.readRole === "owner" && run.trigger.quietHours === true)).toBe(true);
    // The learning pass queued before it goes first: an evaluation is the last thing in the queue.
    const first = await h.runNext();
    expect(first.kind).toBe("learn");
    await drain();
    const [done] = h.service.getEvaluation(h.caller("owner"), keeper.id).runs;
    expect(done).toMatchObject({ state: "done", createdBy: null });
    expect(done.results.filter((result) => result.questionId.startsWith("builtin-")).every((result) => result.passed)).toBe(true);
    // Once a night: the next tick in the same quiet hours queues nothing more.
    h.advance(10 * 60_000);
    await h.service.tick();
    expect(h.store.activeRuns().filter((run) => run.kind === "eval")).toHaveLength(0);
    expect(h.state.listAudit(200).filter((event) => event.type === "agents.evaluation.started").map((event) => event.details.nightly)).toEqual([true]);
  });

  it("waits a night when the budgets have no room, keeping half the day's model time for people", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    const current = h.service.getAgent(h.caller("owner"), keeper.id).spec;
    // 300 s a day: five built-in questions at two minutes each would take all of it.
    h.service.updateAgent(h.caller("owner"), keeper.id, { spec: { ...current, budget: { ...current.budget, modelSecondsPerDay: 300 } } });
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await h.service.tick();
    await h.service.tick();
    expect(h.store.activeRuns().filter((run) => run.kind === "eval")).toHaveLength(0);
    expect(h.state.listAudit(200).filter((event) => event.type === "agents.evaluation.skipped")).toHaveLength(1);
  });

  it("asks no nightly question the night's model time cannot pay for, and grades none it could not finish for want of it (R3B1-6)", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.setEvaluation(h.caller("owner"), keeper.id, { questions: [] });
    const night = (day) => { h.setTime(new Date(2026, 8, day, 2, 30, 0)); h.fake.state.script = answering({ drivesRight: true }); };
    night(30);
    await h.service.tick();
    await drain();
    expect(h.service.getEvaluation(h.caller("owner"), keeper.id).history.map((entry) => entry.score)).toEqual([1]);

    // The next night the questions are queued; then a person's run spends the agent's day down to
    // less than one question's worth above the half kept for people.
    night(31);
    await h.service.tick();
    const questions = h.store.activeRuns().filter((run) => run.kind === "eval");
    expect(questions.length).toBeGreaterThan(0);
    const day = h.service.getAgent(h.caller("owner"), keeper.id).spec.budget.modelSecondsPerDay * 1000;
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "manual" });
    const spender = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(spender.run.kind).toBe("manual");
    await h.service.runnerFinish(spender.run.id, spender.lease, { outcome: "completed", answer: "Done.", usage: { modelMs: day / 2 - 60_000 } });
    await drain();
    for (const question of questions) expect(h.store.getRun(question.id)).toMatchObject({ state: "refused", reason: expect.stringMatching(/model time/) });
    const [starved] = h.service.getEvaluation(h.caller("owner"), keeper.id).runs;
    expect(starved).toMatchObject({ state: "done", score: null });
    expect(starved.results.every((result) => result.skipped === true && result.passed === null)).toBe(true);
    // Not a drop: a question it was never asked is not one it got wrong.
    const evaluation = h.service.getEvaluation(h.caller("owner"), keeper.id);
    expect(evaluation.history.map((entry) => entry.score)).toEqual([1]);
    expect(evaluation.drop).toBeNull();

    // A question cut short for want of model time is not graded either; the rest are, as asked.
    night(32);
    await h.service.tick();
    // What goes before an evaluation (its schedule, the memory index) goes first.
    let first = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    while (first && first.run.kind !== "eval") { await h.runner.execute(first); first = await h.service.runnerNext(h.runnerId, { waitMs: 0 }); }
    expect(first.run.kind).toBe("eval");
    await h.service.runnerFinish(first.run.id, first.lease, { outcome: "degraded", answer: "The agent's model time for today is used up.", degradedReason: "budget" });
    await drain();
    const [cut] = h.service.getEvaluation(h.caller("owner"), keeper.id).runs;
    expect(cut.results.filter((result) => result.skipped)).toHaveLength(1);
    expect(cut).toMatchObject({ state: "done", score: 1 });
  });

  it("follows accuracy over time and flags a drop, on the tab and in the agent's summary", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.setEvaluation(h.caller("owner"), keeper.id, { questions: [] });
    const night = async (day, drivesRight) => {
      h.setTime(new Date(2026, 8, day, 2, 30, 0));
      h.fake.state.script = answering({ drivesRight });
      await h.service.tick();
      await drain();
    };
    await night(30, true);
    await night(31, true);
    let evaluation = h.service.getEvaluation(h.caller("owner"), keeper.id);
    expect(evaluation.history.map((entry) => entry.score)).toEqual([1, 1]);
    expect(evaluation.drop).toBeNull();
    // The model now answers the drives as it did for the owner: one of five wrong.
    await night(32, false);
    evaluation = h.service.getEvaluation(h.caller("owner"), keeper.id);
    expect(evaluation.history.map((entry) => entry.score)).toEqual([1, 1, 0.8]);
    expect(evaluation.drop).toBeNull();
    await night(33, false);
    // Then the Pi-hole question goes wrong too (it is no longer where the agent says): 60% against 90% before.
    h.helperAnswers["app.inspect"] = () => ({ applications: [] });
    await night(34, false);
    evaluation = h.service.getEvaluation(h.caller("owner"), keeper.id);
    expect(evaluation.history.at(-1).score).toBeLessThanOrEqual(0.6);
    expect(evaluation.drop).toMatchObject({ to: evaluation.history.at(-1).score });
    expect(h.service.getAgent(h.caller("owner"), keeper.id).accuracy).toMatchObject({ dropped: true });
    expect(h.state.listAudit(400).some((event) => event.type === "agents.evaluation.finished" && event.details.dropped)).toBe(true);
    // A viewer sees no accuracy, and cannot read the evaluation.
    expect(() => h.service.getEvaluation(h.caller("viewer"), keeper.id)).toThrow();
  });

  it("turns a person's \"wrong\" with the right words into a golden question", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.fake.state.script = answering({ drivesRight: false });
    const asked = h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "List the drives connected to BoxPilot" });
    await h.runNext();
    const given = h.service.giveFeedback(h.caller("owner"), asked.id, { verdict: "down", note: "sda is the USB drive", expect: ["nvme0n1", "USB"] });
    expect(given).toMatchObject({ verdict: "down", addedToEvaluation: { questionId: expect.any(String) } });
    const evaluation = h.service.getEvaluation(h.caller("owner"), keeper.id);
    expect(evaluation.questions.at(-1)).toMatchObject({ question: "List the drives connected to BoxPilot", expect: { includes: ["nvme0n1", "USB"] } });
    // Saying so again changes the words, not the list.
    h.service.giveFeedback(h.caller("owner"), asked.id, { verdict: "down", expect: ["nvme0n1"] });
    expect(h.service.getEvaluation(h.caller("owner"), keeper.id).questions.filter((question) => question.question === "List the drives connected to BoxPilot")).toHaveLength(1);
    // Only a "wrong" does it, and only for whoever may change the agent.
    expect(() => h.service.giveFeedback(h.caller("owner"), asked.id, { verdict: "up", expect: ["x"] })).toThrow(/Only a wrong answer/);
    const theirs = h.service.startRun(h.caller("operator"), keeper.id, { kind: "ask", question: "Which drives are there?" });
    await h.runNext();
    expect(() => h.service.giveFeedback(h.caller("operator"), theirs.id, { verdict: "down", expect: ["nvme0n1"] })).toThrow(/Only whoever may change this agent/);
    // The people's verdicts, by day, beside the scores.
    expect(evaluation.people).toEqual([{ day: expect.stringMatching(/^2026-09-29$/), up: 0, down: 1 }]);
  });
});
