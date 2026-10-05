// @vitest-environment node
/**
 * The agents' background work against their budgets and quiet hours (sweep 1, 2026-10): the
 * nightly evaluation took the Environment Scout's four runs a day, so its Sunday routine was
 * refused every week; a run queued just after quiet hours was cancelled before the next ones
 * began; a failed memory index or image description was queued again every minute of the night,
 * past the day's budget; an evaluation was given the agent's whole day when every agent's model
 * time was spent; and two ticks at once could start two evaluations.
 *
 * Sweep 2: the evaluation's questions counted as the agent's two runs in the queue, so a routine
 * due while they waited was dropped for the day; one read that never answered (the inventory, a
 * folder on a NAS) held up every later tick for good; a description stopped by its own deadline
 * spent none of its image's tries; and an evaluation's run could use the half of the day kept for
 * people.
 */
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { agentsRuntimeKey, defaultRuntimeSettings } from "./service.mjs";

let h;
afterEach(async () => { await h?.close(); h = null; });

const setup = async (options = {}) => { h = await createAgentsHarness(options); h.enable(); return h; };
const make = (template, role = "owner") => h.service.createAgent(h.caller(role), { template });
const ask = (agent, role, question = "How is the server?") => h.service.startRun(h.caller(role), agent.id, { kind: "ask", question });
const drain = async () => { const ran = []; for (let run = await h.runNext(); run; run = await h.runNext()) ran.push(run); return ran; };
const active = (kind) => h.store.activeRuns().filter((run) => run.kind === kind);
const skipped = () => h.state.listAudit(200).filter((event) => event.type === "agents.evaluation.skipped");

/** A model address nothing listens at: the model cannot be started. */
async function noModel() {
  const closed = http.createServer();
  closed.listen(0, "127.0.0.1");
  await new Promise((resolve) => closed.once("listening", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  h.state.setSetting(agentsRuntimeKey, { ...defaultRuntimeSettings(), driver: "external", endpoint: `http://127.0.0.1:${port}` });
}

describe("the nightly evaluation and an agent's runs a day (B1-1)", { timeout: 60_000 }, () => {
  it("leaves the Environment Scout its four runs, so its Sunday routine runs after the night's evaluation", async () => {
    // Saturday 3 October 2026: the Scout's routine is weekly, Sunday at 04:20 in quiet hours.
    await setup({ start: new Date(2026, 9, 3, 10, 0, 0) });
    const scout = make("environment-scout");
    expect(new Date(scout.nextRunAt)).toEqual(new Date(2026, 9, 4, 4, 20));
    // Sunday 02:00: its seven questions are queued, and answered.
    h.setTime(new Date(2026, 9, 4, 2, 0, 0));
    await h.service.tick();
    expect(active("eval")).toHaveLength(7);
    expect((await drain()).map((run) => run.kind)).toEqual(Array(7).fill("eval"));
    // They took none of its four runs.
    expect(h.service.getAgent(h.caller("owner"), scout.id).budgetToday).toMatchObject({ runsUsed: 0, runsPerDay: 4 });
    // 04:20: its routine is queued, not refused, and runs.
    h.setTime(new Date(2026, 9, 4, 4, 20, 0));
    await h.service.tick();
    const routine = await h.runNext();
    expect(routine).toMatchObject({ agentId: scout.id, kind: "schedule" });
    expect(["completed", "degraded"]).toContain(routine.state);
    expect(h.store.listRuns({ agentId: scout.id, states: ["refused"] })).toEqual([]);
    // And the owner may still ask it that day.
    h.setTime(new Date(2026, 9, 4, 10, 0, 0));
    expect(ask(scout, "owner", "Which apps are unhealthy?").state).toBe("queued");
  });

  it("waits a night when every agent's runs a day would leave less than half for people", async () => {
    await setup();
    h.service.saveModule(h.caller("owner"), { budget: { runsPerDay: 10 } });
    make("server-keeper");
    // Seven questions of ten runs a day for every agent: three would be left.
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await h.service.tick();
    await h.service.tick();
    expect(active("eval")).toHaveLength(0);
    expect(skipped()).toHaveLength(1);
    expect(skipped()[0].details).toMatchObject({ reason: "budget", questions: 7 });
  });
});

describe("an evaluation's model time (B1-6)", () => {
  it("is none once every agent's model time for today is spent, not the agent's whole day", async () => {
    await setup();
    h.service.saveModule(h.caller("owner"), { budget: { modelSecondsPerDay: 60 } });
    const helper = make("it-support");
    ask(helper, "owner");
    const first = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    await h.service.runnerFinish(first.run.id, first.lease, { outcome: "completed", answer: "ok", usage: { modelMs: 60_000 } });
    await h.service.runEvaluation(h.caller("owner"), helper.id);
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(claim.run.kind).toBe("eval");
    expect(claim.limits.remainingModelMs).toBe(0);
  });
});

describe("a run that waits for quiet hours (B1-2)", () => {
  it("is kept until the next quiet hours, though they begin twenty hours after it was queued", async () => {
    await setup();
    const keeper = make("server-keeper");
    // Queued a minute after quiet hours ended (02:00 to 06:00).
    h.setTime(new Date(2026, 8, 30, 6, 1, 0));
    h.service.relearn(h.caller("owner"), keeper.id);
    const [learn] = active("learn");
    expect(learn.trigger.quietHours).toBe(true);
    expect(await h.service.runnerNext(h.runnerId, { waitMs: 0 })).toBeNull();
    h.setTime(new Date(2026, 9, 1, 2, 30, 0));
    const run = await h.runNext();
    expect(run).toMatchObject({ id: learn.id, kind: "learn" });
    expect(run.state).not.toBe("cancelled");
  });

  it("still goes once it has waited eighteen hours from when quiet hours began", async () => {
    await setup();
    const keeper = make("server-keeper");
    h.setTime(new Date(2026, 8, 30, 6, 1, 0));
    h.service.relearn(h.caller("owner"), keeper.id);
    const [learn] = active("learn");
    // Quiet hours began at 02:00 on 1 October; eighteen hours later is 20:00.
    h.setTime(new Date(2026, 9, 1, 20, 1, 0));
    expect(await h.service.runnerNext(h.runnerId, { waitMs: 0 })).toBeNull();
    expect(h.store.getRun(learn.id)).toMatchObject({ state: "cancelled", reason: "It waited too long to start" });
  });
});

describe("indexing and describing in quiet hours (B1-3)", { timeout: 30_000 }, () => {
  it("tries a failed index once a night, not every minute of it", async () => {
    await setup();
    h.service.addDocument(h.caller("owner"), { title: "Router", text: "The router is at 192.168.1.1." });
    // A model server with no embedder: the index run ends degraded.
    h.client.embed = async () => { throw new Error("no embedder here"); };
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await h.service.tick();
    const [index] = await drain();
    expect(index).toMatchObject({ kind: "index", state: "degraded" });
    for (const minutes of [1, 30, 200]) {
      h.setTime(new Date(2026, 8, 30, 2, 30 + minutes, 0));
      await h.service.tick();
      expect(active("index"), `${minutes} minutes later`).toHaveLength(0);
    }
    // The next night it is tried again.
    h.setTime(new Date(2026, 9, 1, 2, 30, 0));
    await h.service.tick();
    expect(active("index")).toHaveLength(1);
  });

  it("queues no index or description once every agent's runs or model time for today are spent", async () => {
    await setup();
    h.service.saveModule(h.caller("owner"), { budget: { modelSecondsPerDay: 60 } });
    h.service.addDocument(h.caller("owner"), { title: "Router", text: "The router is at 192.168.1.1." });
    h.store.addDocument({ title: "Image: rack", text: "An image from #agent-files. Not described yet.", createdBy: h.accounts.owner.id, source: "zulip", mediaType: "image/png", media: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    h.setTime(new Date(2026, 8, 30, 1, 30, 0));
    ask(make("it-support"), "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    await h.service.runnerFinish(claim.run.id, claim.lease, { outcome: "completed", answer: "ok", usage: { modelMs: 60_000 } });
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await h.service.tick();
    expect(active("index")).toHaveLength(0);
    expect(active("describe")).toHaveLength(0);
  });

  it("counts a try when describing fails before the model sees the image, and waits for the next night", async () => {
    await setup();
    const image = h.store.addDocument({ title: "Image: rack", text: "An image from #agent-files. Not described yet.", createdBy: h.accounts.owner.id, source: "zulip", mediaType: "image/png", media: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    await noModel();
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await h.service.tick();
    const described = (await drain()).find((run) => run.kind === "describe");
    expect(described.state).toBe("failed");
    expect(h.store.getDocument(image.id).describeAttempts).toBe(1);
    for (const minutes of [1, 30]) {
      h.setTime(new Date(2026, 8, 30, 2, 30 + minutes, 0));
      await h.service.tick();
      expect(active("describe"), `${minutes} minutes later`).toHaveLength(0);
      expect(active("index"), `${minutes} minutes later`).toHaveLength(0);
    }
    h.setTime(new Date(2026, 9, 1, 2, 30, 0));
    await h.service.tick();
    expect(active("describe")).toHaveLength(1);
  });
});

describe("the service's tick (B1-11)", () => {
  it("starts one evaluation when two ticks go at once", async () => {
    await setup();
    const keeper = make("server-keeper");
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await Promise.all([h.service.tick(), h.service.tick()]);
    expect(h.store.listEvalRuns(keeper.id, 5)).toHaveLength(1);
    expect(active("eval")).toHaveLength(7);
  });
});

/** Whether `promise` settles within `ms`. */
const settles = (promise, ms = 3_000) => Promise.race([
  Promise.resolve(promise).then(() => true, () => true),
  new Promise((resolve) => { setTimeout(() => resolve(false), ms).unref?.(); }),
]);

describe("a routine that falls due while its agent's evaluation waits (R2B1-1)", { timeout: 30_000 }, () => {
  it("is queued, not dropped as a full queue, and so is an event", async () => {
    await setup();
    const keeper = make("server-keeper");
    // 02:30: the Server Keeper's seven questions are queued; none has run yet.
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await h.service.tick();
    expect(active("eval")).toHaveLength(7);
    // 05:31: its morning digest is due. Before, the seven counted as its two runs in the queue.
    h.setTime(new Date(2026, 8, 30, 5, 31, 0));
    await h.service.tick();
    expect(active("schedule")).toEqual([expect.objectContaining({ agentId: keeper.id })]);
    expect(Date.parse(h.store.getAgent(keeper.id).nextRunAt)).toBe(new Date(2026, 9, 1, 5, 30).getTime());
    // A health alert while they still wait starts its run too.
    h.service.onHealthRound({ active: [] });
    h.service.onHealthRound({ active: ["storage.root.full:root"] });
    expect(active("event")).toEqual([expect.objectContaining({ agentId: keeper.id })]);
  });

  it("stays due while the agent's queue is full, and is queued at the next tick with room", async () => {
    await setup();
    const keeper = make("server-keeper");
    const due = h.store.getAgent(keeper.id).nextRunAt;
    h.setTime(new Date(2026, 8, 30, 5, 29, 0));
    const asked = [ask(keeper, "owner"), ask(keeper, "operator")];
    h.setTime(new Date(2026, 8, 30, 5, 31, 0));
    await h.service.tick();
    expect(active("schedule")).toHaveLength(0);
    // Not moved on to tomorrow: the morning's digest is still owed.
    expect(h.store.getAgent(keeper.id).nextRunAt).toBe(due);
    for (const run of asked) h.service.cancelRun(h.caller("owner"), run.id);
    h.setTime(new Date(2026, 8, 30, 5, 32, 0));
    await h.service.tick();
    expect(active("schedule")).toEqual([expect.objectContaining({ agentId: keeper.id })]);
    expect(Date.parse(h.store.getAgent(keeper.id).nextRunAt)).toBe(new Date(2026, 9, 1, 5, 30).getTime());
  });
});

describe("a tick that waits on something that never answers (R2B1-2)", { timeout: 30_000 }, () => {
  it("holds up no later tick: the 05:31 digest is queued while the 02:10 evaluation still waits on the inventory", async () => {
    await setup({ limits: { factsTimeoutMs: 1_500 } });
    const keeper = make("server-keeper");
    // df or docker stuck in D-state: the inventory never answers.
    let inspected = 0;
    h.inventory.inspect = () => { inspected += 1; return new Promise(() => {}); };
    h.setTime(new Date(2026, 8, 30, 2, 10, 0));
    const stuck = h.service.tick();
    await vi.waitFor(() => expect(inspected).toBeGreaterThan(0));
    const asked = inspected;
    h.setTime(new Date(2026, 8, 30, 5, 31, 0));
    expect(await settles(h.service.tick(), 1_000)).toBe(true);
    expect(active("schedule")).toEqual([expect.objectContaining({ agentId: keeper.id })]);
    // The evaluation still waiting on its facts is not started a second time beside it.
    expect(inspected).toBe(asked);
    expect(active("eval")).toHaveLength(0);
    // Its time up, it goes on without what the inventory would have said.
    expect(await settles(stuck, 5_000)).toBe(true);
    expect(active("eval")).toHaveLength(7);
  });

  it("gives up on facts that do not come in time, so the night's evaluation still starts", async () => {
    await setup({ limits: { factsTimeoutMs: 50 } });
    const keeper = make("server-keeper");
    h.inventory.inspect = () => new Promise(() => {});
    h.setTime(new Date(2026, 8, 30, 2, 10, 0));
    expect(await settles(h.service.tick())).toBe(true);
    expect(active("eval")).toHaveLength(7);
    // What the inventory would have said is unknown; what the other reads said is there.
    const [evaluation] = h.store.listEvalRuns(keeper.id, 1);
    const expected = (fact) => evaluation.results.find((result) => result.expected?.fact === fact)?.expected.value;
    expect(expected("hostname")).toBeNull();
    expect(expected("stoppedApps")).toEqual([]);
  });

  it("gives up on a folder scan that hangs, and starts no second scan while it still hangs", async () => {
    let scans = 0;
    await setup({ limits: { folderScanTimeoutMs: 50 }, serviceOptions: { folderScan: () => { scans += 1; return new Promise(() => {}); } } });
    h.service.saveModule(h.caller("owner"), { folder: { enabled: true, path: "/srv/notes" } });
    make("server-keeper");
    h.setTime(new Date(2026, 8, 30, 2, 10, 0));
    expect(await settles(h.service.tick())).toBe(true);
    expect(active("eval")).toHaveLength(7);
    // An hour on, the scan is still hanging: the next is not started beside it, and the owner is told why.
    h.setTime(new Date(2026, 8, 30, 3, 20, 0));
    expect(await settles(h.service.tick())).toBe(true);
    expect(await h.service.syncFolderNow(h.caller("owner"))).toEqual({ error: expect.stringMatching(/still being read/) });
    expect(scans).toBe(1);
  });
});

describe("a description that runs into its own ten minutes (R2B1-6)", { timeout: 30_000 }, () => {
  it("counts a try for the image, as one that failed any other way", async () => {
    await setup();
    h.service.saveModule(h.caller("owner"), { embeddings: false });
    const image = h.store.addDocument({ title: "Image: rack", text: "An image from #agent-files. Not described yet.", createdBy: h.accounts.owner.id, source: "zulip", mediaType: "image/png", media: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await h.service.tick();
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(claim.run.kind).toBe("describe");
    // The model reads slowly, and the run's ten minutes are all but gone: the runner's own deadline stops it.
    h.fake.state.delayMs = 2_000;
    h.advance(600_000);
    await h.runner.execute(claim);
    expect(h.store.getRun(claim.run.id).state).toBe("failed");
    expect(h.store.getDocument(image.id).describeAttempts).toBe(1);
  });
});

describe("the nightly evaluation's model time (R2B1-7)", { timeout: 30_000 }, () => {
  it("gives each question what the agent has left today less the half kept for people", async () => {
    await setup();
    // No index run to go before the questions.
    h.service.saveModule(h.caller("owner"), { embeddings: false });
    const keeper = make("server-keeper");
    // 01:30: a person's question takes 500 of its 3,600 seconds today.
    h.setTime(new Date(2026, 8, 30, 1, 30, 0));
    ask(keeper, "owner");
    const asked = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    await h.service.runnerFinish(asked.run.id, asked.lease, { outcome: "completed", answer: "ok", usage: { modelMs: 500_000 } });
    h.setTime(new Date(2026, 8, 30, 2, 30, 0));
    await h.service.tick();
    expect(active("eval")).toHaveLength(7);
    // 3,100 s left, 1,800 kept for people.
    const first = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(first.run.kind).toBe("eval");
    expect(first.limits.remainingModelMs).toBe(1_300_000);
    await h.service.runnerFinish(first.run.id, first.lease, { outcome: "completed", answer: "ok", usage: { modelMs: 1_000_000 } });
    const second = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(second.limits.remainingModelMs).toBe(300_000);
    await h.service.runnerFinish(second.run.id, second.lease, { outcome: "completed", answer: "ok", usage: { modelMs: 400_000 } });
    // The half kept for people is not touched: none is left for the rest of the questions, which
    // are not handed out to fail for want of it (sweep 3, R3B1-6) but refused, and not graded.
    expect(await h.service.runnerNext(h.runnerId, { waitMs: 0 })).toBeNull();
    expect(h.store.listRuns({ agentId: keeper.id, limit: 20 }).filter((run) => run.kind === "eval" && run.state === "refused")).toHaveLength(5);
    const [evaluation] = h.service.getEvaluation(h.caller("owner"), keeper.id).runs;
    expect(evaluation.results.filter((result) => result.skipped)).toHaveLength(5);
  });
});
