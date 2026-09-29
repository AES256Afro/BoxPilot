// @vitest-environment node
/**
 * The brain's pieces that need no model (M37): the understanding a model returns is checked before
 * it is trusted, the exact tools do sums and dates so the model does not, and memory's search and
 * conversation folding fit the model's context.
 */
import { describe, expect, it } from "vitest";
import { ExactError, calculate, convertUnits, extractJson, matchPattern, timeCalc } from "./deterministic.mjs";
import { planMessage, readUnderstanding, understandingSchema } from "./intent.mjs";
import { cosine, decodeVector, encodeVector, foldThread, hybridSearch, readVector, threadBudget } from "./memory.mjs";
import { answerFormat, readStructuredAnswer, systemMessage } from "./prompt.mjs";
import { normalizeSpec } from "./spec.mjs";

describe("the understanding a model returns", () => {
  const offered = ["server_facts", "pihole_stats"];
  it("keeps the known fields, the offered tools only, and a bounded plan", () => {
    const read = readUnderstanding(JSON.stringify({
      goal: "Say whether Pi-hole blocks", subject: "Pi-hole", constraints: ["network-wide only"], tools: ["pihole_stats", "shell_run", "server.facts"],
      confidence: 0.834, clarify: null, plan: [{ step: "Read Pi-hole", tool: "pihole_stats" }, { step: "Run a shell", tool: "shell_run" }, { step: "Answer", tool: null }],
    }), { offered });
    expect(read.understanding).toEqual({
      goal: "Say whether Pi-hole blocks", subject: "Pi-hole", constraints: ["network-wide only"], tools: ["pihole_stats", "server_facts"], confidence: 0.83, clarify: null,
      plan: [{ step: "Read Pi-hole", tool: "pihole_stats" }, { step: "Run a shell", tool: null }, { step: "Answer", tool: null }],
    });
    expect(read.dropped).toEqual(["shell_run"]);
    expect(planMessage(read.understanding)).toMatch(/^Your plan:\n1\. Read Pi-hole \(pihole_stats\)/);
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
});
