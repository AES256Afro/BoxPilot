/**
 * The two reads M48.5 left for later (M48.8): a list of thirty runs read two hundred for everyone,
 * and a run that wanted the pinned documents read every document's text to find them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";

let h;
afterEach(async () => { await h?.close(); h = null; });

describe("the library's documents, read as needed", () => {
  it("lists the enabled, the pinned, and counts, in the query", async () => {
    h = await createAgentsHarness();
    const owner = h.accounts.owner.id;
    h.store.addDocument({ title: "Network", text: "The router is at the usual address.", createdBy: owner, pinned: true });
    h.store.addDocument({ title: "Backups", text: "The NAS holds them.", createdBy: owner });
    const old = h.store.addDocument({ title: "Old", text: "Gone.", createdBy: owner, pinned: true });
    h.store.setDocumentEnabled(old.id, false);
    expect(h.store.countDocuments()).toBe(3);
    expect(h.store.listDocuments().map((document) => document.title).sort()).toEqual(["Backups", "Network", "Old"]);
    expect(h.store.listDocuments({ enabled: true }).map((document) => document.title).sort()).toEqual(["Backups", "Network"]);
    expect(h.store.listDocuments({ enabled: true, pinned: true }).map((document) => document.title)).toEqual(["Network"]);
    expect(h.store.listDocuments({ pinned: false }).map((document) => document.title)).toEqual(["Backups"]);
    expect(h.store.listDocuments({ enabled: false }).map((document) => document.title)).toEqual(["Old"]);
  });
});

describe("an agent's runs, as far as a person may see them", () => {
  const run = (agentId, { requestedBy, readRole, kind = "ask", question = null }) => h.store.enqueueRun({ agentId, version: 1, kind, trigger: {}, question, requestedBy, readRole, readAs: requestedBy });

  it("reads only as many as the owner asks for, and for anyone else reads more only when the first page does not fill the list", async () => {
    h = await createAgentsHarness();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    const { owner, operator } = h.accounts;
    // The operator's three are the older; the owner's six, which the operator may not see, the newer.
    for (let index = 0; index < 3; index += 1) run(keeper.id, { requestedBy: operator.id, readRole: "operator", question: `operator ${index}` });
    for (let index = 0; index < 6; index += 1) run(keeper.id, { requestedBy: owner.id, readRole: "owner", question: `owner ${index}` });
    const reads = [];
    const listRuns = h.store.listRuns;
    h.store.listRuns = (options) => { reads.push(options.limit); return listRuns(options); };

    const ownersView = h.service.listRuns(h.caller("owner"), keeper.id, { limit: 2 });
    expect(ownersView.map((entry) => entry.question)).toEqual(["owner 5", "owner 4"]);
    expect(reads).toEqual([2]);

    reads.length = 0;
    const operatorsView = h.service.listRuns(h.caller("operator"), keeper.id, { limit: 2 });
    expect(operatorsView.map((entry) => entry.question)).toEqual(["operator 2", "operator 1"]);
    // Twice the list, all the owner's; then the rest.
    expect(reads).toEqual([4, 200]);

    reads.length = 0;
    // A first page that fills the list is all that is read.
    expect(h.service.listRuns(h.caller("operator"), keeper.id, { limit: 1 }).map((entry) => entry.question)).toEqual(["operator 2"]);
    expect(reads).toEqual([2, 200]);
    for (let index = 0; index < 4; index += 1) run(keeper.id, { requestedBy: operator.id, readRole: "operator", question: `operator later ${index}` });
    reads.length = 0;
    expect(h.service.listRuns(h.caller("operator"), keeper.id, { limit: 2 }).map((entry) => entry.question)).toEqual(["operator later 3", "operator later 2"]);
    expect(reads).toEqual([4]);
  });

  it("finds an agent's last learning run by its kind rather than reading fifty runs", async () => {
    h = await createAgentsHarness();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    const { owner } = h.accounts;
    const learned = run(keeper.id, { requestedBy: null, readRole: "owner", kind: "learn" });
    for (let index = 0; index < 5; index += 1) run(keeper.id, { requestedBy: owner.id, readRole: "owner", question: `later ${index}` });
    expect(h.store.listRuns({ agentId: keeper.id, kind: "learn", limit: 1 }).map((entry) => entry.id)).toEqual([learned.id]);
    expect(h.store.listRuns({ agentId: keeper.id, kind: "eval", limit: 1 })).toEqual([]);
    const knowledge = await h.service.knowledgeState(h.caller("owner"));
    expect(knowledge.learning.agents.find((entry) => entry.agentId === keeper.id)).toMatchObject({ state: "queued", at: learned.queuedAt });
  });
});

describe("the stored vectors a search reads", () => {
  it("are the ones its own items have, the same as picked out of every vector of their kinds", async () => {
    // A search over one agent's memory read every agent's vectors, and every document's, to use a few of them.
    h = await createAgentsHarness();
    const vector = (seed) => Buffer.from(new Float32Array([seed, seed + 1, seed + 2, seed + 3]).buffer);
    for (let index = 0; index < 450; index += 1) h.store.setVector("chunk", `doc-${index}:${index % 7}`, { model: "external", vector: vector(index), textHash: `c${index}` });
    for (let index = 0; index < 5; index += 1) h.store.setVector("note", `n${index}`, { model: index === 3 ? "older" : "external", vector: vector(1000 + index), textHash: `n${index}` });
    h.store.setVector("episode", "n1", { model: "external", vector: vector(2000), textHash: "e1" });
    const everything = new Map([...h.store.vectorsOf(["chunk"]), ...h.store.vectorsOf(["note"]), ...h.store.vectorsOf(["episode"])]);
    const pickedFrom = (keys) => new Map(keys.filter((key) => everything.has(key)).map((key) => [key, everything.get(key)]));
    const sorted = (map) => [...map].sort(([a], [b]) => a.localeCompare(b));
    // More than one lot of chunks (ids with a colon of their own), two notes, one id that is both a note and an episode, and some that are stored nowhere.
    const asked = [...Array.from({ length: 430 }, (_, index) => `chunk:doc-${index}:${index % 7}`), "note:n1", "note:n3", "note:n1", "episode:n1", "note:gone", "chunk:doc-9:9", "episode:", "nonsense"];
    const found = h.store.vectorsFor(asked);
    expect(found.size).toBe(433);
    expect(sorted(found)).toEqual(sorted(pickedFrom([...new Set(asked)])));
    expect(found.get("note:n3")).toEqual({ model: "older", vector: new Uint8Array(vector(1003)), textHash: "n3" });
    expect(found.has("note:n0")).toBe(false);
    expect(h.store.vectorsFor([]).size).toBe(0);
  });

  it("are not read at all to say which of an agent's memories are indexed", async () => {
    h = await createAgentsHarness();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.store.writeNote(keeper.id, { title: "Router", body: "The router is at the usual address." });
    h.store.writeNote(keeper.id, { title: "Switch", body: "The switch is under the desk." });
    const [note] = h.store.listNotes(keeper.id).filter((entry) => entry.title === "Router");
    // Indexed under the model in use is indexed; under another, or not at all, is not.
    const fresh = h.service.memoryOf(h.caller("owner"), keeper.id);
    expect(fresh.facts.map((fact) => fact.indexed)).toEqual([false, false]);
    h.store.setVector("note", note.id, { model: "external", vector: Buffer.alloc(16), textHash: "x" });
    const other = h.store.listNotes(keeper.id).find((entry) => entry.title === "Switch");
    h.store.setVector("note", other.id, { model: "a-model-no-longer-used", vector: Buffer.alloc(16), textHash: "y" });
    const before = h.service.memoryOf(h.caller("owner"), keeper.id);
    h.store.vectorsOf = () => { throw new Error("every vector was read"); };
    h.store.vectorsFor = () => { throw new Error("vectors were read"); };
    expect(h.service.memoryOf(h.caller("owner"), keeper.id)).toEqual(before);
    expect(Object.fromEntries(before.facts.map((fact) => [fact.title, fact.indexed]))).toEqual({ Router: true, Switch: false });
  });
});
