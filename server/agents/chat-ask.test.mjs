// @vitest-environment node
/**
 * Talking to agents in Zulip (M40.5), end to end with the real service, store and runner and a
 * stand-in for the helper: a direct message to the bot, or a mention of it, is asked as the BoxPilot
 * account the owner mapped its sender to - read-only, as the Test tab's Ask - and answered in the
 * thread; someone not mapped is told so politely, never reaches a model, and waits on the owner's
 * list; cards link back to BoxPilot and nothing is approved in chat.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { zulipSettingKey } from "./chat.mjs";
import { notSetUpMessage } from "./zulip.mjs";

const bot = "boxpilot-agents-bot@homebox.tail1234.ts.net";
const rosa = { senderId: 21, senderEmail: "rosa@example.com", senderName: "Rosa" };
const alex = { senderId: 11, senderEmail: "alex@example.com", senderName: "Alex" };
let h;
let posted;
let inbox;
let nextId;
beforeEach(async () => {
  posted = [];
  inbox = [];
  nextId = 1_000;
  h = await createAgentsHarness({ serviceOptions: { chatOptions: { schedule: () => null } } });
  h.helperAnswers["agents.zulip.post"] = (parameters) => { posted.push(...parameters.posts); return { results: parameters.posts.map((post) => ({ id: post.id, ok: true, messageId: nextId++ })) }; };
  h.helperAnswers["agents.zulip.poll"] = (parameters) => ({ messages: [], last: parameters.after, more: false });
  h.helperAnswers["agents.zulip.events"] = (parameters) => {
    const messages = inbox.splice(0);
    return { queueId: parameters.queueId ?? "queue-1", lastEventId: (parameters.lastEventId ?? -1) + messages.length, reopened: !parameters.queueId, messages, more: false };
  };
  h.enable();
  h.service.zulipConnected({
    connected: true, site: "https://homebox.tail1234.ts.net:8543", host: "homebox.tail1234.ts.net:8543", port: 8543, realm: "Our house", realmId: 2,
    botEmail: bot, botCreated: true, credential: "zulip-agents-bot",
    channels: { findings: "agent-findings", logs: "agent-logs", knowledge: "agent-knowledge", files: "agent-files" }, made: [], public: [],
  }, { actorId: h.accounts.owner.id, boxpilotUrl: "https://homebox.tail1234.ts.net" });
});
afterEach(async () => { await h.close(); });

const direct = (from, content) => { const message = { id: nextId++, kind: "direct", ...from, to: [from.senderId], channel: null, topic: null, content, at: h.now().toISOString() }; inbox.push(message); return message; };
const mention = (from, channel, topic, content) => { const message = { id: nextId++, kind: "mention", ...from, to: [], channel, topic, content, at: h.now().toISOString() }; inbox.push(message); return message; };
const check = async () => { await h.service.zulipPollNow(h.caller("owner")); await h.service.chat.drain(); };
const settings = () => h.state.getSetting(zulipSettingKey);
const mapTo = (people, extra = {}) => h.service.setZulipPeople(h.caller("owner"), { people, ...extra });

describe("someone the owner has not set up", () => {
  it("is told so, once an hour, never reaches a model, and waits on the owner's list", async () => {
    h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    direct(rosa, "Which drives are connected?");
    await check();
    expect(posted.map((post) => [post.to, post.content])).toEqual([[[21], notSetUpMessage]]);
    expect(h.store.activeRuns()).toEqual([]);
    expect(h.fake.prompts()).toEqual([]);
    const state = await h.service.zulipState(h.caller("owner"));
    expect(state.asking.askers).toEqual([{ zulipId: 21, zulipEmail: "rosa@example.com", zulipName: "Rosa", lastAt: expect.any(String), count: 1 }]);
    // Asking again within the hour: no second reply, one more ask counted.
    direct(rosa, "Hello?");
    await check();
    expect(posted).toHaveLength(1);
    expect((await h.service.zulipState(h.caller("owner"))).asking.askers[0].count).toBe(2);
    // An operator sees the team chat, not who asked or the list.
    expect((await h.service.zulipState(h.caller("operator"))).asking).toMatchObject({ people: [], askers: [], accounts: [] });
  });
});

describe("someone the owner mapped", () => {
  it("asks as their account, of an agent that takes their questions, and is answered in the direct message", async () => {
    h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    const helper = h.service.createAgent(h.caller("owner"), { template: "it-support" });
    direct(rosa, "Which drives are connected?");
    await check();
    // The owner lets Rosa ask as the viewer account; she drops off the waiting list.
    const state = await mapTo([{ zulipId: 21, zulipEmail: "rosa@example.com", zulipName: "Rosa", boxpilotId: h.accounts.viewer.id }]);
    expect(state.asking.people).toEqual([{ zulipId: 21, zulipEmail: "rosa@example.com", zulipName: "Rosa", boxpilotId: h.accounts.viewer.id }]);
    expect(state.asking.askers).toEqual([]);
    posted = [];
    direct(rosa, "@**BoxPilot agents** which drives are connected?");
    await check();
    // Read-only as the viewer, exactly as the Test tab's Ask: the Server Keeper takes no viewer's
    // questions, so the IT Support helper (the one that does) is asked.
    const [run] = h.store.activeRuns();
    expect(run).toMatchObject({ agentId: helper.id, kind: "ask", requestedBy: h.accounts.viewer.id, readRole: "viewer", question: "which drives are connected?", trigger: { title: "Asked in Zulip", chat: { to: [21], kind: "direct" } } });
    await h.runNext();
    await h.service.chat.drain();
    // The answer comes back to Rosa, with a link to the run; nothing goes to #agent-findings.
    const reply = posted.find((post) => post.to?.[0] === 21);
    expect(reply.content).toMatch(/\[T1\]/);
    expect(reply.content).toMatch(/IT Support helper · \[open the run in BoxPilot\]\(https:\/\/homebox\.tail1234\.ts\.net\/\?view=agents&tab=test/);
    expect(posted.filter((post) => post.channel === "agent-findings")).toEqual([]);
    expect(posted.some((post) => post.channel === "agent-logs")).toBe(true);
    // Her conversation is hers: the agent's memory of it is under her account.
    expect(h.store.getThread(helper.id, h.accounts.viewer.id)).toBeTruthy();
  });

  it("asks nothing for an account that was disabled: one plain refusal, no run (R3S3-2)", async () => {
    h.service.createAgent(h.caller("owner"), { template: "it-support" });
    await mapTo([{ zulipId: 21, zulipEmail: "rosa@example.com", zulipName: "Rosa", boxpilotId: h.accounts.viewer.id }]);
    h.state.disableOwner(h.accounts.viewer.id, { actorId: h.accounts.owner.id });
    posted = [];
    direct(rosa, "Which drives are connected?");
    await check();
    expect(posted.map((post) => [post.to, post.content])).toEqual([[[21], expect.stringMatching(/^Your BoxPilot account cannot ask agents any more/)]]);
    expect(h.store.activeRuns()).toEqual([]);
    expect(h.store.listRuns({ limit: 10 })).toEqual([]);
    expect(h.fake.prompts()).toEqual([]);
  });

  it("asks the agent a message names, in the channel's thread, and says a refusal there", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.createAgent(h.caller("owner"), { template: "pihole-watcher" });
    await mapTo([{ zulipId: 11, zulipEmail: "alex@example.com", boxpilotId: h.accounts.owner.id }], { defaultAgentId: keeper.id });
    mention(alex, "agent-findings", "Pi-hole", "@**BoxPilot agents** Pi-hole Watcher: is it blocking?");
    await check();
    const [run] = h.store.activeRuns();
    expect(run).toMatchObject({ question: "is it blocking?", readRole: "owner", trigger: { chat: { channel: "agent-findings", topic: "Pi-hole" } } });
    expect(h.store.getAgent(run.agentId).name).toBe("Pi-hole Watcher");
    // One question at a time a person, as the Test tab: the second is refused in the thread.
    mention(alex, "agent-findings", "Pi-hole", "@**BoxPilot agents** and the lists?");
    await check();
    expect(posted.at(-1)).toMatchObject({ channel: "agent-findings", topic: "Pi-hole" });
    expect(posted.at(-1).content).toMatch(/One of your questions is already waiting or being answered/);
    await h.runNext();
    await h.service.chat.drain();
    const inThread = posted.filter((post) => post.channel === "agent-findings" && post.topic === "Pi-hole");
    expect(inThread).toHaveLength(2);
    expect(inThread[1].content).toMatch(/Pi-hole Watcher · \[open the run in BoxPilot\]/);
  });

  it("sends a card back as a link to BoxPilot, where it is decided; nothing is approved in chat", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    await mapTo([{ zulipId: 11, zulipEmail: "alex@example.com", boxpilotId: h.accounts.owner.id }], { defaultAgentId: keeper.id });
    h.fake.state.script = (body) => {
      if (body.response_format) return null;
      const tools = body.messages.filter((message) => message.role === "tool").length;
      if (tools === 0) return { toolCalls: [{ name: "plan_propose", arguments: { title: "Back up Vaultwarden", reason: "It has no backup.", steps: [{ operationId: "app.backup", parameters: { id: "pi-hole" }, why: "No backup yet." }] } }] };
      return { content: "Vaultwarden has no backup; a card proposes one [T1]." };
    };
    direct(alex, "What needs a backup? approve it");
    await check();
    await h.runNext();
    await h.service.chat.drain();
    const toAlex = posted.filter((post) => post.to?.[0] === 11);
    expect(toAlex).toHaveLength(2);
    expect(toAlex[1].content).toMatch(/proposes: \*\*Back up Vaultwarden\*\*[\s\S]*Decide in BoxPilot: \[the card on the Agents page\]\(https:\/\/homebox\.tail1234\.ts\.net\/\?view=agents&agent=[^)]+\)\. Nothing runs until a person approves each step there\./);
    expect(h.store.listProposals({}).every((proposal) => proposal.state === "open")).toBe(true);
    expect(h.helperCalls.some((call) => call.operation === "app.backup")).toBe(false);
  });

  it("tells the asker when their question waited too long because no runner took it, and takes their next (R3B1-8)", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    await mapTo([{ zulipId: 11, zulipEmail: "alex@example.com", boxpilotId: h.accounts.owner.id }], { defaultAgentId: keeper.id });
    direct(alex, "Which drives are connected?");
    await check();
    posted = [];
    h.advance(2 * 3600_000 + 60_000);
    await h.service.tick();
    await h.service.chat.drain();
    expect(posted.filter((post) => post.to?.[0] === 11).map((post) => post.content)).toEqual([expect.stringMatching(/could not answer: It waited too long to start/)]);
    direct(alex, "Which drives are connected now?");
    await check();
    expect(h.store.activeRuns()).toMatchObject([{ question: "Which drives are connected now?", state: "queued" }]);
  });

  it("asks nothing while Agents are paused, and keeps the owner's list to accounts that exist", async () => {
    await expect(mapTo([{ zulipEmail: "alex@example.com", boxpilotId: "no-such-account" }])).rejects.toMatchObject({ status: 400 });
    await expect(mapTo([{ zulipEmail: "not an address", boxpilotId: h.accounts.owner.id }])).rejects.toMatchObject({ status: 400 });
    await expect(h.service.setZulipPeople(h.caller("operator"), { people: [] })).rejects.toMatchObject({ status: 403 });
    h.service.pauseModule(h.caller("owner"), {});
    direct(alex, "Anyone there?");
    await h.service.chat.tick();
    expect(inbox).toHaveLength(1);
    expect(h.helperCalls.some((call) => call.operation === "agents.zulip.events")).toBe(false);
    // Two-way chat can be turned off on its own.
    h.service.resumeModule(h.caller("owner"));
    await mapTo([], { twoWay: false });
    await check();
    expect(settings().twoWay).toBe(false);
    expect(h.helperCalls.some((call) => call.operation === "agents.zulip.events")).toBe(false);
  });
});

describe("a question asked in Zulip that the supervisor hands on (R2B1-4, R2B1-5)", { timeout: 30_000 }, () => {
  const withTools = (body) => body.messages.filter((message) => message.role === "tool").length;
  const named = (body, name) => String(body.messages[0]?.content ?? "").includes(`Your name is ${name}`);
  const followUp = (body) => /The specialists you handed work to/.test(JSON.stringify(body.messages));
  const handTo = (agent, task, interim) => (body) => (withTools(body) === 0 ? { toolCalls: [{ name: "agents_handoff", arguments: { agent, task } }] } : { content: interim });
  const toAlex = () => posted.filter((post) => post.to?.[0] === 11).map((post) => post.content);
  const askAlex = async (keeper) => {
    await mapTo([{ zulipId: 11, zulipEmail: "alex@example.com", boxpilotId: h.accounts.owner.id }], { defaultAgentId: keeper.id });
    direct(alex, "Is Pi-hole doing its job?");
    await check();
    posted = [];
  };
  const runAll = async () => { while (await h.runNext()); await h.service.chat.drain(); };

  it("answers the asker once, with the supervisor's answer, never a specialist's", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.createAgent(h.caller("owner"), { template: "pihole-watcher" });
    h.fake.state.script = (body) => {
      if (named(body, "Server Keeper")) return followUp(body) ? { content: "KEEPER-FINAL: Pi-hole is blocking [T1]." } : handTo("Pi-hole Watcher", "Is Pi-hole blocking?", "I asked the Pi-hole Watcher [T1].")(body);
      return withTools(body) === 0 ? { toolCalls: [{ name: "pihole_stats", arguments: {} }] } : { content: "WATCHER-INTERIM: blocking is on [T1]." };
    };
    await askAlex(keeper);
    await runAll();
    expect(toAlex()).toEqual([expect.stringMatching(/^KEEPER-FINAL/)]);
  });

  it("says nothing to the asker about a hand-off that was cancelled", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.createAgent(h.caller("owner"), { template: "pihole-watcher" });
    h.fake.state.script = (body) => (followUp(body) ? { content: "KEEPER-FINAL: the watcher did not answer [T1]." } : handTo("Pi-hole Watcher", "Is Pi-hole blocking?", "I asked the Pi-hole Watcher [T1].")(body));
    await askAlex(keeper);
    const root = await h.runNext();
    const [child] = h.store.listChildren(root.id);
    h.service.cancelRun(h.caller("owner"), child.id);
    await runAll();
    expect(toAlex()).toEqual([expect.stringMatching(/^KEEPER-FINAL/)]);
  });

  it("says why when the supervisor's own run ended without an answer after it handed on: no follow-up comes (R3B1-4)", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.createAgent(h.caller("owner"), { template: "pihole-watcher" });
    h.fake.state.script = (body) => (named(body, "Server Keeper") ? { content: "should not be asked" } : withTools(body) === 0 ? { toolCalls: [{ name: "pihole_stats", arguments: {} }] } : { content: "WATCHER: blocking is on [T1]." });
    // It handed on, then failed.
    await askAlex(keeper);
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    await h.service.runnerTool(claim.run.id, claim.lease, "agents_handoff", JSON.stringify({ agent: "Pi-hole Watcher", task: "Is Pi-hole blocking?" }));
    await h.service.runnerFinish(claim.run.id, claim.lease, { outcome: "failed", error: "The model stopped with an error" });
    await runAll();
    expect(toAlex()).toEqual([expect.stringMatching(/Server Keeper\*\* could not answer: The model stopped with an error/)]);
    expect(toAlex().join("\n")).not.toMatch(/WATCHER/);

    // It handed on, then the runner restarted under it.
    posted = [];
    direct(alex, "And is it blocking now?");
    await check();
    posted = [];
    const again = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    await h.service.runnerTool(again.run.id, again.lease, "agents_handoff", JSON.stringify({ agent: "Pi-hole Watcher", task: "Is Pi-hole blocking now?" }));
    h.service.runnerHello("another-runner");
    await runAll();
    expect(toAlex()).toEqual([expect.stringMatching(/could not answer: The agents runner restarted/)]);
  });

  it("with two supervisors, answers once, from the root's follow-up, which has the second supervisor's own answer", async () => {
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    const relay = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.updateAgent(h.caller("owner"), relay.id, { spec: { ...h.service.getAgent(h.caller("owner"), relay.id).spec, name: "Relay" } });
    h.service.createAgent(h.caller("owner"), { template: "pihole-watcher" });
    h.fake.state.script = (body) => {
      if (named(body, "Server Keeper")) return followUp(body) ? { content: "KEEPER-FINAL: Pi-hole is blocking, Relay says [T1]." } : handTo("Relay", "Check Pi-hole for me", "I asked Relay [T1].")(body);
      if (named(body, "Relay")) return followUp(body) ? { content: "RELAY-FINAL: the watcher says blocking is on [T1]." } : handTo("Pi-hole Watcher", "Is Pi-hole blocking?", "RELAY-INTERIM: I asked the watcher [T1].")(body);
      return withTools(body) === 0 ? { toolCalls: [{ name: "pihole_stats", arguments: {} }] } : { content: "WATCHER-INTERIM: blocking is on [T1]." };
    };
    await askAlex(keeper);
    await runAll();
    expect(toAlex()).toEqual([expect.stringMatching(/^KEEPER-FINAL/)]);
  });
});
