// @vitest-environment node
/**
 * How a run ends, whoever ends it (sweep 1, 2026-10). Only the runner's finish carried a run's end
 * on: a hand-off that the server cancelled, timed out or interrupted left its supervisor waiting
 * for good, a question asked in Zulip that the server ended was never answered there, and a live
 * trace showed the run going forever. Pausing did not stop a run already going; a run was handed
 * out after its agent's runs for the day were spent; and a run claimed for a runner that had hung
 * up was never delivered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { directRunnerApi } from "./runner.mjs";

let h;
afterEach(async () => { await h?.close(); h = null; });

const setup = async (options = {}) => { h = await createAgentsHarness(options); h.enable(); return h; };
const make = (template, role = "owner") => h.service.createAgent(h.caller(role), { template });
const ask = (agent, role, question = "How is the server?") => h.service.startRun(h.caller(role), agent.id, { kind: "ask", question });
const withBudget = (agent, budget) => h.service.updateAgent(h.caller("owner"), agent.id, { spec: { ...agent.spec, budget: { ...agent.spec.budget, ...budget } } });
const withTools = (body) => body.messages.filter((message) => message.role === "tool").length;
const system = (body) => String(body.messages[0]?.content ?? "");

describe("pausing or turning Agents off stops a run already going (B1-4)", () => {
  it("ends it as cancelled and tells the runner to stop, and to stop its model when everything is paused", async () => {
    await setup();
    const agent = make("it-support");
    ask(agent, "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    h.service.pauseModule(h.caller("operator"));
    expect(h.service.runnerHeartbeat(claim.run.id, claim.lease)).toEqual({ continue: false, reason: "paused", stopModel: true });
    expect(h.store.getRun(claim.run.id)).toMatchObject({ state: "cancelled", reason: "Agents were paused while it ran" });
  });

  it("does the same when one agent is paused, leaving the model for the others", async () => {
    await setup();
    const agent = make("it-support");
    ask(agent, "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    h.service.pauseAgent(h.caller("owner"), agent.id);
    expect(h.service.runnerHeartbeat(claim.run.id, claim.lease)).toEqual({ continue: false, reason: "paused", stopModel: false });
    expect(h.store.getRun(claim.run.id)).toMatchObject({ state: "cancelled", reason: "IT Support helper was paused while it ran" });
  });

  it("and when Agents are turned off", async () => {
    await setup();
    ask(make("it-support"), "owner");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    h.service.saveModule(h.caller("owner"), { enabled: false });
    expect(h.service.runnerHeartbeat(claim.run.id, claim.lease)).toEqual({ continue: false, reason: "paused", stopModel: true });
    expect(h.store.getRun(claim.run.id)).toMatchObject({ state: "cancelled", reason: "Agents were turned off while it ran" });
  });

  it("stops the real runner mid-call: the model's call is closed and the run is left cancelled", async () => {
    // A heartbeat every 50 ms, a runner that thinks its model fast, and a model that reads slowly.
    await setup({ limits: { heartbeatMs: 50 }, runnerOptions: { promptPerSecond: 1e5, generatePerSecond: 1e4 } });
    h.fake.state.speed = { promptPerSecond: 20, generatePerSecond: 5 };
    // Paused the moment the model is asked, so the call is going when the runner hears of it.
    let pausedAt = null;
    h.fake.state.script = () => { if (!pausedAt) { pausedAt = Date.now(); h.service.pauseModule(h.caller("owner")); } return null; };
    const queued = ask(make("it-support"), "owner", "What is this server called?");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(await h.runner.execute(claim)).toEqual({ outcome: "paused" });
    expect(Date.now() - pausedAt).toBeLessThan(5_000);
    expect(h.store.getRun(queued.id)).toMatchObject({ state: "cancelled" });
    // The model server hears the call close a moment after the runner lets it go.
    await vi.waitFor(() => expect(h.fake.calls()[0]?.stopped).toBe("closed"));
  });
});

/** A supervisor's question that it handed to a specialist: the specialist's run waits. */
async function handedOver() {
  const keeper = make("server-keeper");
  const watcher = make("pihole-watcher");
  h.fake.state.script = (body) => {
    if (system(body).includes("Your name is Server Keeper") && !/The specialists you handed work to|was asked:/.test(JSON.stringify(body.messages))) {
      return withTools(body) === 0 ? { toolCalls: [{ name: "agents_handoff", arguments: { agent: "Pi-hole Watcher", task: "Is Pi-hole blocking?" } }] } : { content: "I asked the Pi-hole Watcher [T1]." };
    }
    if (system(body).includes("Your name is Pi-hole Watcher")) return withTools(body) === 0 ? { toolCalls: [{ name: "pihole_stats", arguments: {} }] } : { content: "Blocking is on [T1]." };
    return { content: "The watcher did not answer, so I cannot say [T1]." };
  };
  ask(keeper, "owner", "Is Pi-hole doing its job?");
  const parent = await h.runNext();
  const [child] = h.store.listChildren(parent.id);
  expect(child).toMatchObject({ kind: "handoff", state: "queued", agentId: watcher.id });
  return { keeper, watcher, parent, child };
}

describe("a hand-off ended without the runner's finish still brings the supervisor back (B1-5)", { timeout: 30_000 }, () => {
  const ways = {
    "cancelled by a person": ({ child }) => h.service.cancelRun(h.caller("owner"), child.id),
    "its agent paused": ({ watcher }) => h.service.pauseAgent(h.caller("owner"), watcher.id),
    "its agent deleted": ({ watcher }) => h.service.deleteAgent(h.caller("owner"), watcher.id),
    "waited too long": async () => { h.advance(2 * 3600_000 + 60_000); expect(await h.service.runnerNext(h.runnerId, { waitMs: 0 })).toBeNull(); },
    "timed out on the server": async () => { await h.service.runnerNext(h.runnerId, { waitMs: 0 }); h.advance(10 * 60_000); await h.service.tick(); },
    "its runner stopped answering": async () => { await h.service.runnerNext(h.runnerId, { waitMs: 0 }); h.advance(61_000); await h.service.tick(); },
    "its runner restarted": async () => { await h.service.runnerNext(h.runnerId, { waitMs: 0 }); h.service.runnerHello("7f1b8f8e-4d0a-4f7e-8f55-0c7a2b1d9e10", {}); },
    "Agents paused while it ran": async ({ child }) => {
      const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
      h.service.pauseModule(h.caller("owner"));
      h.service.runnerHeartbeat(child.id, claim.lease);
      h.service.resumeModule(h.caller("owner"));
    },
  };
  for (const [way, end] of Object.entries(ways)) {
    it(`when it was ${way}`, async () => {
      await setup();
      const tree = await handedOver();
      await end(tree);
      expect(h.store.getRun(tree.child.id).state).not.toMatch(/^(queued|running)$/);
      const follow = await h.runNext();
      expect(follow).toMatchObject({ agentId: tree.keeper.id, kind: "continue", parentRunId: tree.parent.id, state: "completed" });
      expect(follow.steps.find((step) => step.kind === "tool" && step.name === "agents.handoff").output).toMatch(/It did not answer \((cancelled|killed|timeout|interrupted)\)/);
    });
  }
});

describe("a hand-off ended while its supervisor still ran (B1-5)", () => {
  it("brings the supervisor back as it finishes", async () => {
    await setup();
    const keeper = make("server-keeper");
    const watcher = make("pihole-watcher");
    ask(keeper, "owner", "Is Pi-hole doing its job?");
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    const handed = await h.service.runnerTool(claim.run.id, claim.lease, "agents_handoff", JSON.stringify({ agent: "Pi-hole Watcher", task: "Is Pi-hole blocking?" }));
    expect(handed.ok).toBe(true);
    const [child] = h.store.listChildren(claim.run.id);
    h.service.pauseAgent(h.caller("owner"), watcher.id);
    expect(h.store.getRun(child.id).state).toBe("cancelled");
    await h.service.runnerFinish(claim.run.id, claim.lease, { outcome: "completed", answer: "I asked the Pi-hole Watcher [T1]." });
    expect(h.store.listChildren(claim.run.id).map((run) => [run.kind, run.state])).toEqual([["handoff", "cancelled"], ["continue", "queued"]]);
  });
});

describe("every way a run ends is streamed to whoever watches it (B1-9)", () => {
  it("when its agent is paused, deleted, or it waited too long", async () => {
    await setup();
    const watch = (run) => { const events = []; h.service.subscribeRun(h.caller("owner"), run.id, (event, data) => events.push([event, data.state])); return events; };
    const agent = make("it-support");
    const paused = watch(ask(agent, "owner"));
    h.service.pauseAgent(h.caller("owner"), agent.id);
    expect(paused).toEqual([["state", "cancelled"]]);
    h.service.resumeAgent(h.caller("owner"), agent.id);
    const late = watch(ask(agent, "owner"));
    h.advance(2 * 3600_000 + 60_000);
    await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(late).toEqual([["state", "cancelled"]]);
    const deleted = watch(ask(agent, "owner"));
    h.service.deleteAgent(h.caller("owner"), agent.id);
    expect(deleted).toEqual([["state", "cancelled"]]);
  });

  it("when the kill switch cancels what waits", async () => {
    await setup();
    const agent = make("it-support");
    ask(agent, "owner");
    const waiting = ask(agent, "operator");
    const events = [];
    h.service.subscribeRun(h.caller("owner"), waiting.id, (event, data) => events.push([event, data.state]));
    await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    h.service.killSwitch(h.caller("owner"));
    expect(events).toEqual([["state", "cancelled"]]);
  });
});

describe("a question asked in Zulip that the server ended is answered there (B1-8)", () => {
  const bot = "boxpilot-agents-bot@homebox.tail1234.ts.net";
  const rosa = { senderId: 21, senderEmail: "rosa@example.com", senderName: "Rosa" };
  let posted;
  let inbox;
  let nextId;
  const zulip = async () => {
    posted = [];
    inbox = [];
    nextId = 1_000;
    await setup({ serviceOptions: { chatOptions: { schedule: () => null } } });
    h.helperAnswers["agents.zulip.post"] = (parameters) => { posted.push(...parameters.posts); return { results: parameters.posts.map((post) => ({ id: post.id, ok: true, messageId: nextId++ })) }; };
    h.helperAnswers["agents.zulip.poll"] = (parameters) => ({ messages: [], last: parameters.after, more: false });
    h.helperAnswers["agents.zulip.events"] = (parameters) => {
      const messages = inbox.splice(0);
      return { queueId: parameters.queueId ?? "queue-1", lastEventId: (parameters.lastEventId ?? -1) + messages.length, reopened: !parameters.queueId, messages, more: false };
    };
    h.service.zulipConnected({
      connected: true, site: "https://homebox.tail1234.ts.net:8543", host: "homebox.tail1234.ts.net:8543", port: 8543, realm: "Our house", realmId: 2,
      botEmail: bot, botCreated: true, credential: "zulip-agents-bot",
      channels: { findings: "agent-findings", logs: "agent-logs", knowledge: "agent-knowledge", files: "agent-files" }, made: [], public: [],
    }, { actorId: h.accounts.owner.id, boxpilotUrl: "https://homebox.tail1234.ts.net" });
    make("it-support");
    await h.service.setZulipPeople(h.caller("owner"), { people: [{ zulipId: 21, zulipEmail: "rosa@example.com", zulipName: "Rosa", boxpilotId: h.accounts.owner.id }] });
    inbox.push({ id: nextId++, kind: "direct", ...rosa, to: [21], channel: null, topic: null, content: "@**BoxPilot agents** what is this server called?", at: h.now().toISOString() });
    await h.service.zulipPollNow(h.caller("owner"));
    await h.service.chat.drain();
    posted = [];
    const [run] = h.store.activeRuns();
    expect(run).toMatchObject({ kind: "ask", trigger: { chat: { to: [21] } } });
    return run;
  };
  const replies = () => posted.filter((post) => post.to?.[0] === 21).map((post) => post.content);

  it("when it ran past its time", async () => {
    const run = await zulip();
    await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    h.advance(10 * 60_000);
    await h.service.tick();
    expect(h.store.getRun(run.id).state).toBe("timeout");
    await h.service.chat.drain();
    expect(replies()).toEqual([expect.stringMatching(/could not answer: It ran past its time limit/)]);
  });

  it("when it waited too long to start", async () => {
    const run = await zulip();
    h.advance(2 * 3600_000 + 60_000);
    await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(h.store.getRun(run.id).state).toBe("cancelled");
    await h.service.chat.drain();
    expect(replies()).toEqual([expect.stringMatching(/could not answer: It waited too long to start/)]);
  });
});

describe("a run is handed out only while its agent has runs left today (B1-10)", () => {
  it("refuses the second of two waiting questions when the agent has one run a day", async () => {
    await setup();
    const agent = withBudget(make("it-support"), { runsPerDay: 1 });
    ask(agent, "owner");
    const second = ask(agent, "operator");
    expect((await h.runNext()).state).toBe("completed");
    expect(await h.service.runnerNext(h.runnerId, { waitMs: 0 })).toBeNull();
    expect(h.store.getRun(second.id)).toMatchObject({ state: "refused", reason: "It has used its 1 runs for today" });
  });

  it("still hands a supervisor its follow-up, which the person's question already paid for", async () => {
    await setup();
    const tree = await handedOver();
    withBudget(h.store.getAgent(tree.keeper.id), { runsPerDay: 1 });
    expect((await h.runNext()).kind).toBe("handoff");
    expect(await h.runNext()).toMatchObject({ kind: "continue", state: "completed" });
  });
});

describe("a runner that hangs up on its long poll (B1-12)", () => {
  it("is handed nothing, and a run claimed while it left goes back in the queue", async () => {
    await setup();
    const queued = ask(make("it-support"), "owner");
    const gone = new AbortController();
    gone.abort();
    expect(await h.service.runnerNext(h.runnerId, { waitMs: 0, signal: gone.signal })).toBeNull();
    expect(h.store.getRun(queued.id).state).toBe("queued");
    // It hangs up while the run's processors are set.
    const leaving = new AbortController();
    const cpu = h.helperAnswers["agents.runtime.cpu"];
    h.helperAnswers["agents.runtime.cpu"] = (parameters) => { leaving.abort(); return cpu(parameters); };
    expect(await h.service.runnerNext(h.runnerId, { waitMs: 0, signal: leaving.signal })).toBeNull();
    expect(h.store.getRun(queued.id)).toMatchObject({ state: "queued", startedAt: null });
    h.helperAnswers["agents.runtime.cpu"] = cpu;
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(claim.run.id).toBe(queued.id);
    expect(h.store.listSteps(queued.id).filter((step) => step.name === "claimed")).toHaveLength(1);
    expect(h.service.usage(h.caller("owner")).today.runs).toBe(1);
  });

  it("is handed no run that was cancelled while its processors were set (R2B1-8)", async () => {
    await setup();
    const queued = ask(make("it-support"), "owner");
    const events = [];
    h.service.subscribeRun(h.caller("owner"), queued.id, (event, data) => events.push([event, data.state]));
    const cpu = h.helperAnswers["agents.runtime.cpu"];
    let once = false;
    h.helperAnswers["agents.runtime.cpu"] = (parameters) => { if (!once) { once = true; h.service.cancelRun(h.caller("owner"), queued.id); } return cpu(parameters); };
    expect(await h.service.runnerNext(h.runnerId, { waitMs: 0 })).toBeNull();
    expect(h.store.getRun(queued.id).state).toBe("cancelled");
    // Its watchers saw it end, and nothing after: it never went running again.
    expect(events).toEqual([["state", "cancelled"]]);
    expect(h.store.listSteps(queued.id).some((step) => step.name === "claimed")).toBe(false);
  });

  it("is handed no run that the kill switch stopped while its processors were set, and is told to stop its model (R2B1-8)", async () => {
    await setup();
    const queued = ask(make("it-support"), "owner");
    const cpu = h.helperAnswers["agents.runtime.cpu"];
    let once = false;
    h.helperAnswers["agents.runtime.cpu"] = (parameters) => { if (!once) { once = true; h.service.killSwitch(h.caller("owner")); } return cpu(parameters); };
    const answer = await directRunnerApi(h.service, h.runnerId).next({ waitMs: 0 });
    expect(answer).toMatchObject({ claim: null, stopModel: true });
    expect(h.store.getRun(queued.id).state).toBe("killed");
  });

  it("sets processors within a time that fits twice in the runner's fifteen seconds past its long poll", async () => {
    await setup();
    const timeouts = [];
    const request = h.helper.request;
    h.helper.request = (operation, parameters, options) => { if (operation === "agents.runtime.cpu") timeouts.push(options?.timeoutMs); return request(operation, parameters, options); };
    ask(make("it-support"), "owner");
    await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(timeouts.length).toBeGreaterThan(0);
    for (const timeoutMs of timeouts) expect(timeoutMs * 2).toBeLessThan(15_000);
  });
});
