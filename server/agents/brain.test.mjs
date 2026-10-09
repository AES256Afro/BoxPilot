// @vitest-environment node
/**
 * The brain's pieces that need no model (M37): the understanding a model returns is checked before
 * it is trusted, the exact tools do sums and dates so the model does not, and memory's search and
 * conversation folding fit the model's context.
 */
import { describe, expect, it } from "vitest";
import { answerFormat, readStructuredAnswer } from "../../packages/harness/src/index.mjs";
import { ExactError, calculate, convertUnits, extractJson, matchPattern, timeCalc } from "./deterministic.mjs";
import { planMessage, plannerMessages, readUnderstanding, understandingFormatFor, understandingSchema } from "./intent.mjs";
import { cosine, decodeVector, diversify, encodeVector, episodeOf, foldThread, hybridSearch, itemSimilarity, readVector, threadBudget } from "./memory.mjs";
import { systemMessage } from "./prompt.mjs";
import { normalizeSpec } from "./spec.mjs";
import { toolIdOf } from "./tool-catalog.mjs";

describe("the understanding a model returns", () => {
  const offered = ["server_facts", "pihole_stats"];
  it("keeps the known fields, the offered tools only, and a bounded plan, naming tools by their registry ids", () => {
    const read = readUnderstanding(JSON.stringify({
      goal: "Say whether Pi-hole blocks", subject: "Pi-hole", constraints: ["network-wide only"], tools: ["pihole_stats", "shell_run", "server.facts"],
      confidence: 0.834, clarify: null, plan: [{ step: "Read Pi-hole", tool: "pihole_stats" }, { step: "Run a shell", tool: "shell_run" }, { step: "Answer", tool: null }],
    }), { offered });
    expect(read.understanding).toEqual({
      goal: "Say whether Pi-hole blocks", subject: "Pi-hole", constraints: ["network-wide only"], tools: ["pihole.stats", "server.facts"], confidence: 0.83, clarify: null,
      plan: [{ step: "Read Pi-hole", tool: "pihole.stats" }, { step: "Run a shell", tool: null }, { step: "Answer", tool: null }],
    });
    expect(read.dropped).toEqual(["shell_run"]);
    // The model is told its plan with the names it calls the tools by.
    expect(planMessage(read.understanding)).toMatch(/^Your plan:\n1\. Read Pi-hole \(pihole_stats\)/);
  });

  it("reads the plan the first real run got, and never shows punctuation or a number as a step", () => {
    // Qwen 3.5 4B's reply on the owner's server (2026-09-29), under the old schema: valid JSON, the
    // steps' words "}," and numbers, the tools spelled with underscores.
    const owners = { goal: "Find the most important issue to focus on", subject: "the server", constraints: [], tools: ["alerts_active", "storage_health", "services_status", "apps_list", "memory_search"], confidence: 0.7, clarify: null,
      plan: [{ step: "},", tool: "alerts_active" }, { step: "2", tool: "storage_health" }, { step: "3", tool: "services_status" }, { step: "4", tool: "apps_list" }, { step: "5", tool: "memory_search" }, { step: "6", tool: null }] };
    const offeredFns = ["alerts_active", "storage_health", "services_status", "apps_list", "memory_search", "docs_search", "server_facts"];
    const read = readUnderstanding(JSON.stringify(owners), { offered: offeredFns });
    expect(read.understanding.tools).toEqual(["alerts.active", "storage.health", "services.status", "apps.list", "memory.search"]);
    expect(read.understanding.plan).toEqual([
      { step: "Use Health alerts", tool: "alerts.active" }, { step: "Use Drives, filesystems and SMART", tool: "storage.health" }, { step: "Use Service status", tool: "services.status" },
      { step: "Use Apps and containers", tool: "apps.list" }, { step: "Use Search memory", tool: "memory.search" },
    ]);
    expect(read.dropped).toEqual([]);
    const told = planMessage(read.understanding);
    expect(told).not.toMatch(/},|\d\. \d\b/);
    expect(told).toMatch(/^Your plan:\n1\. Use Health alerts \(alerts_active\)\n2\. Use Drives, filesystems and SMART \(storage_health\)/);
  });

  it("reads a tool however the model spelled it", () => {
    const read = readUnderstanding({ goal: "Check the alerts", plan: [{ step: "Read alerts", tool: "alerts-active" }, { step: "Read disks", tool: "Storage.Health" }, { step: "Read facts", tool: "functions.server_facts" }] }, { offered: ["alerts.active", "storage_health", "server.facts"] });
    expect(read.understanding.plan.map((entry) => entry.tool)).toEqual(["alerts.active", "storage.health", "server.facts"]);
    expect(toolIdOf("alerts_active")).toBe("alerts.active");
    expect(toolIdOf("time-calc")).toBe("time.calc");
    expect(toolIdOf("shell_run")).toBeNull();
  });

  it("asks for a bounded plan whose tools can only be ones the run was offered", () => {
    const format = understandingFormatFor(["alerts_active", "server_facts"]);
    const step = format.json_schema.schema.properties.plan.items.properties;
    expect(step.tool.enum).toEqual(["alerts_active", "server_facts", null]);
    expect(step.step).toMatchObject({ type: "string", minLength: 3, maxLength: 80 });
    expect(format.json_schema.schema.properties.plan.maxItems).toBe(5);
    expect(format.json_schema.schema.required).not.toContain("tools");
  });

  it("gives the planner the same system message for every run of an agent, with the JSON's shape", () => {
    const agent = { name: "Server Keeper", purpose: "Knows this server.", job: "Answer questions about it.", steps: ["Read server.facts."] };
    const tools = [{ fn: "server_facts", title: "Server facts" }, { fn: "alerts_active", title: "Health alerts" }];
    const [system, user] = plannerMessages(agent, tools, "Now: 2026-09-29T10:00:00.000Z\n<question>\nIs all well?\n</question>");
    expect(system.content).toBe(plannerMessages(agent, tools, "Something else entirely")[0].content);
    expect(system.content).not.toMatch(/2026/);
    expect(system.content).toContain('"plan":[{"step":"Read what the answer needs","tool":"server_facts"},{"step":"Answer with citations","tool":null}]');
    expect(system.content).toMatch(/Tools:\n- server_facts: Server facts\n- alerts_active: Health alerts$/);
    expect(user.content).toMatch(/Is all well\?[\s\S]*Answer only with the JSON\.$/);
  });

  it("is refused when it is not JSON or has no goal, and a clarifying question is kept", () => {
    expect(readUnderstanding("I will look at the logs", { offered }).problem).toMatch(/not JSON/);
    expect(readUnderstanding("{\"subject\":\"x\"}", { offered }).problem).toMatch(/no goal/);
    expect(readUnderstanding("```json\n{\"goal\":\"Fix it\",\"clarify\":\"Which drive do you mean?\",\"confidence\":2}\n```", { offered }).understanding).toMatchObject({ clarify: "Which drive do you mean?", confidence: 1 });
  });

  it("is asked for against a strict schema the model cannot add to", () => {
    expect(understandingSchema).toMatchObject({ additionalProperties: false, required: expect.arrayContaining(["goal", "plan", "clarify", "confidence"]) });
  });
});

describe("the structured prompt and answer", () => {
  const spec = normalizeSpec({
    name: "Disk Watcher", job: "Say which disk is fullest.", successCriteria: ["Names the disk"],
    prompt: { rules: ["Never guess."], steps: ["Read storage.health"], output: { format: "json", fields: [{ name: "disk", description: "The fullest disk" }, { name: "percent" }] }, escalate: ["A disk over 95%"] },
    triggers: { ask: true },
  });
  it("tells the model its job, its criteria, its steps and the fields it must answer with", () => {
    const text = systemMessage(spec, { specialists: [{ name: "Pi-hole Watcher", job: "Watch Pi-hole" }] });
    expect(text).toMatch(/Your one job: Say which disk is fullest\./);
    expect(text).toMatch(/You did it well when:\n- Names the disk/);
    expect(text).toMatch(/1\. Read storage\.health/);
    expect(text).toMatch(/- disk: The fullest disk\n- percent: percent/);
    expect(text).toMatch(/- Pi-hole Watcher: Watch Pi-hole/);
    // BoxPilot's rules come first, whatever the owner wrote.
    expect(text.indexOf("BoxPilot's rules")).toBeLessThan(text.indexOf("Your one job"));
  });

  it("reads a JSON answer against its fields, and says what is wrong with one that is not", () => {
    expect(answerFormat(spec.prompt.output.fields).json_schema.schema).toMatchObject({ required: ["disk", "percent"], additionalProperties: false });
    expect(readStructuredAnswer("{\"disk\":\"/mnt/media [T1]\",\"percent\":81}", spec.prompt.output.fields)).toEqual({ value: { disk: "/mnt/media [T1]", percent: "81" } });
    expect(readStructuredAnswer("The media disk", spec.prompt.output.fields).problem).toMatch(/not JSON/);
    expect(readStructuredAnswer("{\"disk\":\"x\"}", spec.prompt.output.fields).problem).toMatch(/no percent/);
  });
});

describe("exact work", () => {
  it("does arithmetic with precedence and functions, and refuses anything else", () => {
    expect(calculate("(4.2 - 3.7) / 3.7 * 100")).toBeCloseTo(13.5135, 3);
    expect(calculate("2 ^ 3 ^ 2")).toBe(512);
    expect(calculate("-2^2")).toBe(-4);
    expect(calculate("round(9112 / 48210 * 100, 1)")).toBe(18.9);
    expect(calculate("max(3, 7, 5) + min(1, 2) % 2")).toBe(8);
    for (const bad of ["process.exit()", "1 / 0", "2 +", "sqrt(-1)", "1 2", "constructor"]) expect(() => calculate(bad), bad).toThrow(ExactError);
  });

  it("works out dates, units and JSON exactly", () => {
    expect(timeCalc({ op: "add", at: "2026-09-29T05:30:00Z", amount: 90, unit: "minutes" })).toMatch(/is 2026-09-29T07:00:00\.000Z/);
    expect(timeCalc({ op: "between", at: "2026-09-20T00:00:00Z", to: "2026-09-29T12:00:00Z" })).toMatch(/9\.5 days, 228 hours/);
    expect(() => timeCalc({ op: "format", at: "2026-09-29T00:00:00Z", timeZone: "Mars/Olympus" })).toThrow(/no time zone/);
    expect(convertUnits({ value: "8", from: "GiB", to: "GB" })).toBe("8 GiB is 8.589934592 GB.");
    expect(convertUnits({ value: "100", from: "C", to: "F" })).toBe("100 C is 212 F.");
    expect(() => convertUnits({ value: "1", from: "GB", to: "h" })).toThrow(/different things/);
    expect(extractJson({ json: JSON.stringify({ services: [{ unit: "a", state: "ok" }, { unit: "b", state: "failed" }] }), path: "services[*].state" })).toBe("services[*].state: [\n \"ok\",\n \"failed\"\n]");
    expect(extractJson({ json: "{}", path: "a.b" })).toBe("Nothing at a.b.");
  });

  it("matches patterns line by line, and stops one that runs away", async () => {
    await expect(matchPattern({ pattern: "failed \\((\\w+)\\)", text: "ok\nsmartd failed (exit)\nnginx failed (signal)" })).resolves.toBe("2 matches:\nline 2: failed (exit) (groups: exit)\nline 3: failed (signal) (groups: signal)");
    await expect(matchPattern({ pattern: "(", text: "x" })).rejects.toThrow(/not a regular expression/);
    const started = Date.now();
    await expect(matchPattern({ pattern: "(a+)+$", text: `${"a".repeat(40)}b` }, { timeoutMs: 300 })).rejects.toThrow(/took longer than 300 ms/);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);
});

describe("memory", () => {
  it("stores a vector as unit-length floats, and compares only vectors of one size", () => {
    const blob = encodeVector([3, 4, 0, 0, 0, 0, 0, 0]);
    const vector = decodeVector(blob);
    expect(Array.from(vector.slice(0, 2)).map((value) => Math.round(value * 100) / 100)).toEqual([0.6, 0.8]);
    expect(cosine(vector, vector)).toBeCloseTo(1, 5);
    expect(cosine(vector, new Float32Array(4))).toBeNull();
    expect(readVector([1, 2])).toBeNull();
    expect(readVector(new Array(8).fill("x"))).toBeNull();
  });

  it("finds by words and by meaning together, and by words alone without a vector", () => {
    const items = [
      { key: "a", title: "Pi-hole", text: "Pi-hole runs in the container bp-pi-hole", vector: decodeVector(encodeVector([1, 0, 0, 0, 0, 0, 0, 0])) },
      { key: "b", title: "Backups", text: "Nextcloud has no backup", vector: decodeVector(encodeVector([0, 1, 0, 0, 0, 0, 0, 0])) },
      { key: "c", title: "Disks", text: "The media drive is 4 TB", vector: decodeVector(encodeVector([0, 0, 1, 0, 0, 0, 0, 0])) },
    ];
    expect(hybridSearch(items, { query: "pi-hole container", limit: 2 })[0]).toMatchObject({ key: "a", via: ["words"] });
    // "storage" shares no word with the disks note; its vector finds it.
    const byMeaning = hybridSearch(items, { query: "storage", queryVector: [0, 0, 0.9, 0.1, 0, 0, 0, 0], limit: 1 });
    expect(byMeaning[0]).toMatchObject({ key: "c", via: ["meaning"] });
  });

  it("spreads what it returns: the same fact as a note, an episode and a finding fills one place, not three (M46.2)", () => {
    const fact = "Pi-hole runs in the container bp-pi-hole on this server, as a BoxPilot app";
    const items = [
      { key: "note", title: "Pi-hole", text: fact },
      { key: "episode", title: "A run on 2026-10-01", text: `Asked where Pi-hole runs. ${fact}.` },
      { key: "finding", title: "Asked: where does Pi-hole run?", text: `${fact} [T1]` },
      { key: "blocking", title: "Pi-hole blocking", text: "Pi-hole blocked 15% of 1,000 queries in the last day; gravity updated two days ago" },
      { key: "disks", title: "Disks", text: "The media drive is 4 TB" },
    ];
    const found = hybridSearch(items, { query: "pi-hole", limit: 3 });
    // The nearest copy of the fact once; then Pi-hole's other fact; never the second and third copies.
    expect(found.map((item) => item.key)).toEqual(["note", "blocking"]);
    // By vectors: two items at the same point are one; the next pick is the one farthest from it.
    const at = (angle) => decodeVector(encodeVector([Math.cos(angle), Math.sin(angle), 0, 0, 0, 0, 0, 0]));
    const vectors = [
      { key: "p", title: "Pi-hole", text: "one", vector: at(0) },
      { key: "p2", title: "Pi-hole", text: "two", vector: at(0.01) },
      { key: "q", title: "Pi-hole", text: "three", vector: at(0.4) },
      { key: "r", title: "Pi-hole", text: "four", vector: at(0.8) },
    ];
    expect(hybridSearch(vectors, { query: "pi-hole", queryVector: [1, 0, 0, 0, 0, 0, 0, 0], limit: 3 }).map((item) => item.key)).toEqual(["p", "r", "q"]);
    // The spread itself, on scores alone.
    expect(diversify([{ score: 1, title: "Drive", text: "the backup drive is failing" }, { score: 0.9, title: "Drive", text: "the backup drive is failing" }, { score: 0.2, title: "Disks", text: "the disks are fine" }], { limit: 2 }).map((item) => item.text)).toEqual(["the backup drive is failing", "the disks are fine"]);
    expect(diversify([], { limit: 2 })).toEqual([]);
    expect(itemSimilarity({ title: "", text: "" }, { title: "a", text: "b" })).toBe(0);
  });

  it("folds a long conversation into a running summary that fits the model's context", () => {
    const turns = [];
    for (let index = 0; index < 20; index += 1) turns.push({ role: "user", text: `Question ${index}: ${"x".repeat(300)}` }, { role: "agent", text: `Answer ${index}. ${"y".repeat(600)} [T1]` });
    const folded = foldThread({ summary: "", turns }, { keep: 6 });
    const kept = folded.turns.reduce((sum, turn) => sum + turn.text.length, 0);
    expect(kept).toBeLessThanOrEqual(threadBudget.turnChars);
    expect(folded.summary.length).toBeLessThanOrEqual(threadBudget.summaryChars);
    expect(folded.turns.at(-1).text).toMatch(/^Answer 19\./);
    expect(folded.summary).toMatch(/answered: Answer \d+\./);
    expect(folded.summary).not.toMatch(/\[T1\]/);
  });

  it("keeps a run as an episode without its citation marks", () => {
    expect(episodeOf({ question: "Is Pi-hole blocking?", answer: "It is blocking [T1]. Lists are fresh [T1, T2]." })).toBe('Asked "Is Pi-hole blocking?". It is blocking. Lists are fresh.');
    expect(episodeOf({ question: null, trigger: { title: "Its schedule" }, answer: "" })).toBeNull();
  });
});
