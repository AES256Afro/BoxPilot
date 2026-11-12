/**
 * A prompt that fits (M66). The time is the task message's last line and to the minute, so the
 * model server can reuse what it read for the run before; an agent's notes, what it recalls and the
 * other agents' findings share about a quarter of the model's context, whole or not at all, the
 * notes in the order they were first written; a supervisor reads a line of each specialist; a
 * degraded run's pasted tool lines are not kept as what the agent answered; and a run's count of
 * tool calls is the count its cap went by.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { plannerTaskMessage, systemMessage, taskMessage } from "./prompt.mjs";
import { agentsRuntimeKey } from "./service.mjs";
import { normalizeSpec } from "./spec.mjs";

let h;
afterEach(async () => { await h?.close(); h = null; });

describe("the time in what a run is told", () => {
  const wrapped = ["<agent_note written=\"2026-10-01\" trust=\"untrusted\">\nDisks\nTwo NVMe drives.\n</agent_note>"];

  it("is the last line, to the minute, under the same label", () => {
    const task = taskMessage({ kind: "ask", question: "How full is /srv?", notes: wrapped, memories: ["<memory>m</memory>"], findings: ["<finding>f</finding>"], now: new Date("2026-10-12T10:07:41.123Z") });
    expect(task.split("\n").at(-1)).toBe("Now: 2026-10-12T10:07Z");
    expect(task.match(/Now: /g)).toHaveLength(1);
    expect(task).toMatch(/^A person asked you the question below\. Answer it\.\n/);
    expect(plannerTaskMessage({ kind: "ask", question: "How full is /srv?", now: new Date("2026-10-12T10:07:41.123Z") }).split("\n").at(-1)).toBe("Now: 2026-10-12T10:07Z");
  });

  it("leaves two runs in the same minute the same message, and two in different minutes the same until the last line", () => {
    const at = (time) => taskMessage({ kind: "schedule", trigger: { title: "Its schedule" }, notes: wrapped, now: new Date(time) });
    expect(at("2026-10-12T10:07:59.999Z")).toBe(at("2026-10-12T10:07:00.000Z"));
    const [earlier, later] = [at("2026-10-12T10:07:00Z"), at("2026-10-13T04:30:00Z")];
    expect(later).not.toBe(earlier);
    expect(later.slice(0, later.lastIndexOf("\n"))).toBe(earlier.slice(0, earlier.lastIndexOf("\n")));
  });
});

describe("the specialists a supervisor is told of", () => {
  it("are a line each: the name, and at most 80 characters of the job", () => {
    const spec = normalizeSpec({ name: "Keeper", job: "Keep the server.", successCriteria: ["Says what changed"], triggers: { ask: true } });
    const job = `Watch Pi-hole and say when blocking is off.\n${"It also reads the query log, the lists and the upstream resolvers. ".repeat(6)}`;
    const text = systemMessage(spec, { specialists: [{ name: "Pi-hole Watcher", job }, { name: "Backup Auditor", job: "Say which apps have no backup that restores." }] });
    const [, block] = text.match(/<specialists>\n([\s\S]*?)\n<\/specialists>/);
    const lines = block.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^- Pi-hole Watcher: Watch Pi-hole and say when blocking is off\. It also reads .+…$/);
    expect(lines[0].length).toBeLessThanOrEqual("- Pi-hole Watcher: ".length + 80);
    expect(lines[1]).toBe("- Backup Auditor: Say which apps have no backup that restores.");
  });
});

describe("the room a task message gives what the agent remembers", () => {
  // Eight notes of 1,130 characters, about 1,200 each as the model reads them: 9,600 in all.
  const topics = ["Freezer", "Router", "Printer", "Camera", "Doorbell", "Thermostat", "Projector", "Scanner"];
  const bodyOf = (topic, lead = "") => `${lead}${`The ${topic.toLowerCase()} was looked at and nothing about it had changed. `.repeat(24)}`.slice(0, 1_129).concat(".");
  const writeNotes = (agentId) => topics.forEach((topic, index) => {
    h.advance(60_000);
    h.store.writeNote(agentId, { title: topic, body: bodyOf(topic, index === 0 ? "The zigbee sensor in the garage reads minus eighteen. " : ""), source: { kind: "learn" }, readRole: "owner" });
  });
  const contextOf = (contextTokens) => h.state.setSetting(agentsRuntimeKey, { ...h.service.runtimeSettings(), contextTokens });
  const scheduled = (agentId) => h.store.enqueueRun({ agentId, version: 1, kind: "schedule", trigger: {}, requestedBy: null, readRole: "owner", readAs: h.accounts.owner.id });
  const claim = async () => {
    const claimed = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    const prompt = h.store.listSteps(claimed.run.id).find((step) => step.kind === "prompt");
    const task = claimed.messages[1].content;
    return { claimed, task, flags: prompt.flags, titles: [...task.matchAll(/<agent_note[^>]*>\n([^\n]+)\n/g)].map((match) => match[1]) };
  };
  const finish = (claimed, result = {}) => h.service.runnerFinish(claimed.run.id, claimed.lease, { outcome: "completed", answer: "ok", usage: {}, ...result });
  const setUp = async (contextTokens) => {
    h = await createAgentsHarness();
    h.enable();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    writeNotes(keeper.id);
    if (contextTokens) contextOf(contextTokens);
    return keeper;
  };

  it("pastes every note while the context has room for them, oldest first", async () => {
    const keeper = await setUp(null);
    expect(h.service.runtimeSettings().contextTokens).toBe(16_384);
    scheduled(keeper.id);
    const { titles, flags } = await claim();
    expect(titles).toEqual(topics);
    expect(flags).toMatchObject({ notes: 8, notesLeftOut: 0, memoriesLeftOut: 0, findingsLeftOut: 0 });
  });

  it("leaves whole notes out of a small context, the latest kept, and says how many in the trace", async () => {
    const keeper = await setUp(8_192);
    scheduled(keeper.id);
    const { claimed, task, titles, flags } = await claim();
    // 8,192 tokens leave 7,373 characters: six of the eight, none cut short.
    expect(titles).toEqual(topics.slice(2));
    expect(flags).toMatchObject({ notes: 6, notesLeftOut: 2 });
    expect(task.match(/<\/agent_note>/g)).toHaveLength(6);
    expect(task).not.toMatch(/cut at \d+ characters/);
    const notesChars = task.match(/<agent_note[\s\S]*<\/agent_note>/)[0].length;
    expect(notesChars).toBeLessThanOrEqual(Math.round(8_192 * 3.6 * 0.25));
    await finish(claimed);

    // One note written again is the latest now, and stays where it was among the others.
    h.advance(60_000);
    h.store.writeNote(keeper.id, { title: "Camera", body: bodyOf("Camera", "Seen again. "), source: { kind: "learn" }, readRole: "owner" });
    scheduled(keeper.id);
    const again = await claim();
    expect(again.titles).toEqual(topics.slice(2));
    expect(again.task.slice(0, again.task.indexOf("Camera\n"))).toBe(task.slice(0, task.indexOf("Camera\n")));
  });

  it("keeps the note the question is about, however old", async () => {
    const keeper = await setUp(8_192);
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "What does the zigbee sensor in the garage read?" });
    const { titles, flags } = await claim();
    expect(titles[0]).toBe("Freezer");
    expect(titles).toHaveLength(6);
    expect(titles).toEqual(topics.filter((topic) => titles.includes(topic)));
    expect(flags).toMatchObject({ notes: 6, notesLeftOut: 2 });
  });

  it("never gives it less than 2,000 characters", async () => {
    // A context smaller than the settings allow, to see the floor: a quarter of 1,024 tokens is 922
    // characters, which holds no note; 2,000 hold the latest, and no part of a second.
    const keeper = await setUp(1_024);
    scheduled(keeper.id);
    const { titles, flags } = await claim();
    expect(titles).toEqual(["Scanner"]);
    expect(flags).toMatchObject({ notes: 1, notesLeftOut: 7 });
  });

  it("gives a learning run every note, whatever the room", async () => {
    const keeper = await setUp(8_192);
    h.service.relearn(h.caller("owner"), keeper.id);
    h.setTime(new Date(2026, 8, 30, 3, 0, 0));
    const { claimed, titles, flags } = await claim();
    expect(claimed.run.kind).toBe("learn");
    expect(titles).toEqual(topics);
    expect(flags).toMatchObject({ notes: 8, notesLeftOut: 0 });
  });

  it("offers a finding only while there is room after the notes, and the runner only the ones the model was shown", async () => {
    const finding = (auditor) => h.store.writeFinding(auditor.id, { kind: "routine", title: "Backups that restore", readRole: "owner", freshUntil: new Date(h.now().getTime() + 3_600_000).toISOString(), body: "Vaultwarden has no backup.", source: { agentId: auditor.id, agentName: "Backup Auditor", kind: "routine" } });
    const keeper = await setUp(8_192);
    finding(h.service.createAgent(h.caller("owner"), { template: "backup-auditor" }));
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Which apps have no backup?" });
    const small = await claim();
    expect(small.flags).toMatchObject({ notes: 6, notesLeftOut: 2, findings: 0, findingsLeftOut: 1 });
    expect(small.task).not.toMatch(/<finding|Vaultwarden/);
    expect(small.claimed.findings).toEqual([]);
    expect(small.claimed.understand.task).not.toMatch(/Backups that restore/);
    expect(small.claimed.findingsByMeaning).toBe(false);
    await h.close();

    const roomy = await setUp(null);
    finding(h.service.createAgent(h.caller("owner"), { template: "backup-auditor" }));
    h.service.startRun(h.caller("owner"), roomy.id, { kind: "ask", question: "Which apps have no backup?" });
    const large = await claim();
    expect(large.flags).toMatchObject({ notes: 8, notesLeftOut: 0, findings: 1, findingsLeftOut: 0 });
    expect(large.task).toMatch(/<finding id="F1"[^>]*>[\s\S]*Vaultwarden has no backup/);
    expect(large.claimed.findings.map((entry) => entry.id)).toEqual(["F1"]);
  });
});

describe("what a finished run leaves behind", () => {
  const withTools = (body) => body.messages.filter((message) => message.role === "tool").length;

  it("keeps a short turn, not the tools' lines, as what a degraded run answered", async () => {
    h = await createAgentsHarness();
    h.enable();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Is Jellyfin up?" });
    const first = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    const pasted = "The model stopped with an error, so this is what the tools found rather than an answer.\n\n- [T1] Apps: jellyfin: running, health unhealthy, 3 restarts.";
    await h.service.runnerFinish(first.run.id, first.lease, { outcome: "degraded", degradedReason: "model-error", answer: pasted, usage: {} });
    // The person still reads what the tools found; the conversation does not carry it on.
    expect(h.service.getRun(h.caller("owner"), first.run.id)).toMatchObject({ state: "degraded", answer: pasted });
    expect(h.store.getThread(keeper.id, h.accounts.owner.id).turns.map((turn) => [turn.role, turn.text])).toEqual([["user", "Is Jellyfin up?"], ["agent", "(It could not answer that time.)"]]);

    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "And now?" });
    const second = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(second.messages[1].content).toMatch(/They asked: Is Jellyfin up\?\nYou answered: \(It could not answer that time\.\)\n<\/conversation>/);
    expect(second.messages[1].content).not.toMatch(/The model stopped|\[T1\]/);
    await h.service.runnerFinish(second.run.id, second.lease, { outcome: "completed", answer: "Jellyfin is running.", usage: {} });
    expect(h.store.getThread(keeper.id, h.accounts.owner.id).turns.at(-1)).toMatchObject({ role: "agent", text: "Jellyfin is running." });
  });

  it("counts every call its cap counted as a tool call: a memory search and a note beside a read", async () => {
    h = await createAgentsHarness();
    h.enable();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    const calls = [{ name: "memory_search", arguments: { query: "media drive" } }, { name: "notes_write", arguments: { title: "Media drive", body: "The media drive is /mnt/media." } }];
    h.fake.state.script = (body) => (withTools(body) < calls.length ? { toolCalls: [calls[withTools(body)]] } : { content: "Noted [T2]." });
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Remember where the media drive is." });
    const run = await h.runNext();
    const made = run.steps.filter((step) => ["tool", "memory", "proposal", "note", "notify", "handoff", "action"].includes(step.kind));
    expect(made.map((step) => step.kind)).toEqual(expect.arrayContaining(["memory", "note"]));
    expect(run.usage.toolCalls).toBe(made.length);
    expect(run.usage.toolCalls).toBeGreaterThan(run.steps.filter((step) => step.kind === "tool").length);
  });
});
