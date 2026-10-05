// @vitest-environment node
/**
 * The 2026-10 sweep 4, on the real service, store and runner with the stand-in model: what an agent
 * remembers is read, trusted and forgotten only as far as each person and each run may read; another
 * account's words stay data, held to their words; a flag goes wherever the words it came with went.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";

let h;
beforeEach(async () => { h = await createAgentsHarness(); h.enable(); });
afterEach(async () => { await h.close(); });

const make = (template, role = "owner", changes = {}) => {
  const agent = h.service.createAgent(h.caller(role), { template });
  return Object.keys(changes).length ? h.service.updateAgent(h.caller(role), agent.id, { spec: { ...agent.spec, ...changes } }) : agent;
};
const ask = (agent, role, question) => h.service.startRun(h.caller(role), agent.id, { kind: "ask", question });
const withTools = (body) => body.messages.filter((message) => message.role === "tool").length;
const thrown = (fn) => { try { fn(); } catch (error) { return error; } return null; };
const call = (claim, name, input) => h.service.runnerTool(claim.run.id, claim.lease, name, JSON.stringify(input));
const learn = async (agent, role, title, body) => {
  h.fake.state.script = (request) => (withTools(request) === 0 ? { toolCalls: [{ name: "notes_write", arguments: { title, body } }] } : { content: "Noted [T1]." });
  ask(agent, role, "Learn this");
  const run = await h.runNext();
  h.fake.state.script = null;
  return run;
};

describe("R4S1-1: a note is read, trusted and forgotten only as far as the person may read it", () => {
  it("keeps a same-title note learned at another role apart, and refuses an operator the owner's note and episode", async () => {
    const watch = make("storage-watch", "operator");
    await learn(watch, "operator", "Server notes", "Two drives, both healthy.");
    const [operators] = h.store.listNotes(watch.id);
    expect(operators.readRole).toBe("operator");
    // The owner's run of the operator's agent keeps a note of the same title with what only the owner reads.
    await learn(watch, "owner", "Server notes", "OWNER-ONLY-FACT: the restic key is in the owner's vault.");
    const notes = h.store.listNotes(watch.id);
    expect(notes.map((note) => note.readRole).sort()).toEqual(["operator", "owner"]);
    expect(h.store.getNote(watch.id, operators.id)).toMatchObject({ readRole: "operator", body: "Two drives, both healthy." });
    const owners = notes.find((note) => note.readRole === "owner");
    expect(owners.id).not.toBe(operators.id);

    // An empty edit would have answered with the whole note; trusting, pinning or forgetting it too.
    const operator = h.caller("operator");
    for (const attempt of [
      () => h.service.editMemory(operator, watch.id, owners.id, {}),
      () => h.service.editMemory(operator, watch.id, owners.id, { trusted: true }),
      () => h.service.editMemory(operator, watch.id, owners.id, { pinned: true }),
      () => h.service.forgetMemory(operator, watch.id, { kind: "note", id: owners.id }),
      () => h.service.deleteNote(operator, watch.id, owners.id),
    ]) {
      const error = thrown(attempt);
      expect(error?.status).toBe(404);
      expect(JSON.stringify(error ?? {})).not.toContain("OWNER-ONLY-FACT");
    }
    expect(h.store.getNote(watch.id, owners.id)).toMatchObject({ body: owners.body, pinned: false });
    // Their own is theirs to change, and the owner's to them all.
    expect(h.service.editMemory(operator, watch.id, operators.id, { pinned: true })).toMatchObject({ id: operators.id, pinned: true });
    expect(h.service.editMemory(h.caller("owner"), watch.id, owners.id, {})).toMatchObject({ id: owners.id });

    // An episode of the owner's run is the owner's too.
    const episode = h.store.listEpisodes(watch.id).find((entry) => entry.readRole === "owner");
    expect(episode).toBeTruthy();
    expect(thrown(() => h.service.forgetMemory(operator, watch.id, { kind: "episode", id: episode.id }))?.status).toBe(404);
    expect(h.store.listEpisodes(watch.id).some((entry) => entry.id === episode.id)).toBe(true);
    expect(h.service.forgetMemory(h.caller("owner"), watch.id, { kind: "episode", id: episode.id })).toEqual({ forgotten: true });
  });
});

describe("R4B4-1: an edit clears a fact's flag only with new words, or a word that it is fine", () => {
  it("keeps the flag when the same words come back with a new freshness or title", () => {
    const keeper = make("server-keeper");
    const note = h.store.writeNote(keeper.id, { title: "Sign-in", body: "The app asked for a sign-in.", readRole: "owner", source: { by: "agent", injection: true, injectionHop: 0 } });
    const owner = h.caller("owner");
    // The edit sheet sent what it was shown: the same title and words, and a new freshness.
    expect(h.service.editMemory(owner, keeper.id, note.id, { title: "Sign-in", body: "The app asked for a sign-in.", freshDays: 7 }).source).toMatchObject({ injection: true, injectionHop: 0 });
    expect(h.service.editMemory(owner, keeper.id, note.id, { title: "Sign-in prompts", body: "The app asked for a sign-in." }).source.injection).toBe(true);
    expect(h.service.editMemory(owner, keeper.id, note.id, { body: "Nothing needs a sign-in." }).source.injection).toBe(false);
  });
});
