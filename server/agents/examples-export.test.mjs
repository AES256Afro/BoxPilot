// @vitest-environment node
/**
 * The example book as training data (M46.3): one chat-shaped record an example, the planner's own
 * system message and request wording, the model's understanding as the answer; the house's names
 * replaced with stand-ins everywhere; a covering subset on request; seeds marked and droppable; and
 * the same records from the API (the owner's) and from the script against the database.
 */
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { plannerToolsOf, toJsonl, trainingRecords, understandingOf } from "./examples-export.mjs";
import { templateById } from "./templates.mjs";

let h;
afterEach(async () => { await h?.close(); h = null; });

const keeperSpec = templateById("server-keeper").spec;
const examples = [
  { id: "1", request: "Where does Pi-hole run on homebox?", plan: [{ step: "Read where.runs", tool: "where.runs" }, { step: "Answer", tool: null }], intent: { goal: "Find where Pi-hole runs on homebox", subject: "Pi-hole", constraints: [], confidence: 0.8 }, signal: "thumbs-up", seed: false, route: "local", model: "qwen", createdAt: "2026-10-09T10:00:00.000Z", answer: "It runs as a BoxPilot app on homebox [T1]." },
  { id: "2", request: "Is Pi-hole blocking ads right now?", plan: [{ step: "Read Pi-hole", tool: "pihole.stats" }], intent: null, signal: "seed", seed: true, createdAt: "2026-10-09T09:00:00.000Z" },
  { id: "3", request: "Which drives are connected?", plan: [{ step: "Read drives", tool: "storage.health" }], intent: null, signal: "seed", seed: true, createdAt: "2026-10-09T09:00:00.000Z" },
];

describe("training records", () => {
  it("are chat-shaped, in the planner's own words, with the house's names replaced", () => {
    const records = trainingRecords({ agent: { name: "Server Keeper", spec: keeperSpec }, examples, names: { hosts: ["homebox"], domains: ["home.example.org"], users: ["jamie"] } });
    expect(records).toHaveLength(3);
    const [first] = records;
    expect(first.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    expect(first.messages[0].content).toMatch(/^You work out what a request to Server Keeper asks for/);
    expect(first.messages[0].content).toContain("- where_runs: Where does it run?");
    expect(first.messages[1].content).toBe("Where does Pi-hole run on host-1?\n\nWork out what is asked and plan it. Answer only with the JSON.");
    const answer = JSON.parse(first.messages[2].content);
    expect(answer).toEqual({ goal: "Find where Pi-hole runs on host-1", subject: "Pi-hole", constraints: [], confidence: 0.8, clarify: null, plan: [{ step: "Read where.runs", tool: "where_runs" }, { step: "Answer", tool: null }] });
    expect(first.meta).toMatchObject({ agent: "Server Keeper", signal: "thumbs-up", seed: false, tools: ["where_runs"], route: "local", answer: "It runs as a BoxPilot app on host-1 [T1]." });
    expect(JSON.stringify(records)).not.toContain("homebox");
    // A seed's understanding is plain, and says it is a seed.
    expect(JSON.parse(records[1].messages[2].content)).toMatchObject({ goal: "Answer “Is Pi-hole blocking ads right now?”", confidence: 0.9, plan: [{ step: "Read Pi-hole", tool: "pihole_stats" }] });
    expect(records[1].meta).toMatchObject({ seed: true, signal: "seed" });
    expect(records[1].meta.answer).toBeUndefined();
  });

  it("can leave the seeds out, and pick a covering subset", () => {
    expect(trainingRecords({ agent: { spec: keeperSpec }, examples, seeds: false })).toHaveLength(1);
    const covered = trainingRecords({ agent: { spec: keeperSpec }, examples, cover: 2 });
    expect(covered).toHaveLength(2);
    // The first stays; the farthest from it (by words, no vectors) comes next: the drives, not Pi-hole's other question.
    expect(covered.map((record) => record.messages[1].content.split("\n")[0])).toEqual(["Where does Pi-hole run on homebox?", "Which drives are connected?"]);
    expect(trainingRecords({ agent: { spec: keeperSpec }, examples, cover: 10 })).toHaveLength(3);
  });

  it("lists the planner's tools from the spec, and writes JSON Lines", () => {
    expect(plannerToolsOf(keeperSpec).map((tool) => tool.fn)).toContain("where_runs");
    expect(plannerToolsOf({ tools: { "where.runs": "off" } })).toEqual([]);
    expect(understandingOf({ request: "x", plan: [] })).toMatchObject({ goal: "Answer “x”", plan: [] });
    expect(toJsonl([])).toBe("");
    expect(toJsonl([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });
});

describe("exporting the book", () => {
  it("is the owner's from the API, with this house's names as stand-ins, and the same from the script against the database", async () => {
    h = await createAgentsHarness();
    h.enable();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Which BoxPilot apps are stopped?" });
    const run = await h.runNext();
    h.service.giveFeedback(h.caller("owner"), run.id, { verdict: "up" });
    const exported = h.service.exportExamples(h.caller("owner"), keeper.id, {});
    expect(exported.filename).toMatch(/^boxpilot-examples-server-keeper-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const records = exported.jsonl.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.length).toBe(h.service.examplesOf(h.caller("owner"), keeper.id).counts.total);
    const kept = records.find((record) => !record.meta.seed);
    expect(kept.messages[1].content).toMatch(/^Which BoxPilot apps are stopped\?/);
    expect(JSON.parse(kept.messages[2].content).plan.some((entry) => entry.tool === "apps_list")).toBe(true);
    expect(typeof JSON.parse(kept.messages[2].content).confidence).toBe("number");
    // Seeds out, and a covering subset, on request.
    expect(h.service.exportExamples(h.caller("owner"), keeper.id, { seeds: false }).jsonl.trim().split("\n")).toHaveLength(1);
    expect(h.service.exportExamples(h.caller("owner"), keeper.id, { cover: 4 }).jsonl.trim().split("\n")).toHaveLength(4);
    // The owner's alone: the maker who is an operator may read the book but not send it off the box.
    expect(() => h.service.exportExamples(h.caller("operator"), keeper.id, {})).toThrow(/owner/);
    // The script reads the same database and writes the same records.
    const script = spawnSync(process.execPath, ["scripts/boxpilot-agents-examples.mjs", "export", h.state.databasePath, "--agent", "Server Keeper", "--host", "homebox"], { encoding: "utf8", cwd: process.cwd() });
    expect(script.status, script.stderr).toBe(0);
    const fromScript = script.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(fromScript.length).toBe(records.length);
    expect(fromScript.map((record) => record.messages[1].content).sort()).toEqual(records.map((record) => record.messages[1].content).sort());
    const listed = spawnSync(process.execPath, ["scripts/boxpilot-agents-examples.mjs", "list", h.state.databasePath], { encoding: "utf8", cwd: process.cwd() });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toMatch(/Server Keeper\s+\d+ examples/);
  });
});
