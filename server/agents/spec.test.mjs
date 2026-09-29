// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SpecError, diffSpecs, lineDiff, normalizeSpec, specText } from "./spec.mjs";
import { agentTemplates, templateById, templateQuestions } from "./templates.mjs";
import { toolCatalog } from "./tool-catalog.mjs";

const minimal = { name: "Watcher", triggers: { ask: true } };

describe("an agent's spec", () => {
  it("fills in what was left out, with every tool off unless it was turned on", () => {
    const spec = normalizeSpec({ ...minimal, tools: { "server.facts": "auto" } });
    expect(spec).toMatchObject({ name: "Watcher", purpose: "", audience: ["owner", "operator"], triggers: { ask: true, schedule: null, events: [] } });
    expect(spec.tools["server.facts"]).toBe("auto");
    expect(Object.keys(spec.tools)).toEqual(toolCatalog.map((tool) => tool.id));
    expect(Object.values(spec.tools).filter((permission) => permission !== "off")).toEqual(["auto"]);
    expect(spec.budget).toEqual({ runsPerDay: 12, modelSecondsPerDay: 900, stepsPerRun: 6, tokensPerRun: 12_000, runSeconds: 600 });
  });

  it("refuses what it does not know rather than guessing", () => {
    for (const input of [
      {}, { name: "" }, { name: "x".repeat(61) },
      { ...minimal, tools: { "shell.run": "auto" } },
      { ...minimal, tools: { "server.facts": "always" } },
      { ...minimal, triggers: { ask: true, events: ["disk.full"] } },
      { ...minimal, triggers: { schedule: { every: "fortnightly" } } },
      { ...minimal, audience: ["guest"] },
      { ...minimal, audience: ["viewer"] },
      { ...minimal, budget: { stepsPerRun: 50 } },
      { ...minimal, budget: { runsPerDay: 0 } },
      { ...minimal, knowledge: { internet: true } },
      { name: "Never runs", triggers: { ask: false } },
      { ...minimal, instructions: "x".repeat(8_001) },
    ]) expect(() => normalizeSpec(input), JSON.stringify(input).slice(0, 80)).toThrow(SpecError);
  });

  it("keeps a budget inside its ceilings", () => {
    expect(normalizeSpec({ ...minimal, budget: { stepsPerRun: 12, runSeconds: 1_800 } }).budget).toMatchObject({ stepsPerRun: 12, runSeconds: 1_800 });
    expect(() => normalizeSpec({ ...minimal, budget: { runSeconds: 1_801 } })).toThrow(/Seconds a run/);
  });

  it("turns a tool off when its output is off", () => {
    const spec = normalizeSpec({ ...minimal, tools: { "notes.write": "auto", "plan.propose": "auto", "notify.owner": "auto" }, outputs: { notes: false, proposals: false, notify: "never" } });
    expect([spec.tools["notes.write"], spec.tools["plan.propose"], spec.tools["notify.owner"]]).toEqual(["off", "off", "off"]);
  });

  it("strips control characters from single lines and keeps line breaks in instructions", () => {
    const spec = normalizeSpec({ ...minimal, name: "Line\u0007 one", instructions: "First\nSecond\u0000" });
    expect(spec.name).toBe("Line  one");
    expect(spec.instructions).toBe("First\nSecond");
  });

  it("compares by what it says, not by key order", () => {
    const a = normalizeSpec(minimal);
    const b = JSON.parse(JSON.stringify(a));
    expect(specText(a)).toBe(specText(Object.fromEntries(Object.entries(b).reverse())));
  });
});

describe("versions", () => {
  it("lists each changed field, and the instructions line by line", () => {
    const before = normalizeSpec({ ...minimal, instructions: "Look at the disks.\nWrite a note." });
    const after = normalizeSpec({ ...minimal, instructions: "Look at the disks.\nWrite a short note.", budget: { runsPerDay: 20 }, tools: { "server.facts": "ask" } });
    const changes = diffSpecs(before, after);
    expect(changes.map((change) => change.field).sort()).toEqual(["budget.runsPerDay", "instructions", "tools.server.facts"]);
    expect(changes.find((change) => change.field === "budget.runsPerDay")).toEqual({ field: "budget.runsPerDay", before: 12, after: 20 });
    expect(changes.find((change) => change.field === "instructions").lines).toEqual([
      { op: "keep", text: "Look at the disks." }, { op: "remove", text: "Write a note." }, { op: "add", text: "Write a short note." },
    ]);
    expect(diffSpecs(before, before)).toEqual([]);
  });

  it("diffs lines as a longest common subsequence", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd").map((line) => `${line.op}:${line.text}`)).toEqual(["keep:a", "remove:b", "keep:c", "add:d"]);
  });
});

describe("templates", () => {
  it("are all valid specs, and the named ones exist", () => {
    expect(agentTemplates.map((template) => template.id)).toEqual(["server-keeper", "pihole-watcher", "backup-auditor", "it-support", "blank"]);
    for (const template of agentTemplates) expect(normalizeSpec(template.spec)).toEqual(template.spec);
  });

  it("keep the Server Keeper's heavy work in quiet hours, and the IT helper borrowable and read-only", () => {
    expect(templateById("server-keeper").spec.triggers.schedule).toMatchObject({ every: "daily", quietHours: true });
    expect(templateById("server-keeper").spec.outputs.digest).toBe(true);
    const helper = templateById("it-support").spec;
    expect(helper.audience).toEqual(["owner", "operator", "viewer"]);
    expect([helper.tools["notes.write"], helper.tools["plan.propose"], helper.tools["logs.query"], helper.tools["pihole.stats"]]).toEqual(["off", "off", "off", "off"]);
    // Every tool the IT helper uses is one a viewer may use.
    expect(toolCatalog.filter((tool) => helper.tools[tool.id] !== "off").every((tool) => tool.role === "viewer")).toBe(true);
  });

  it("each have golden questions that name a real fact or words", () => {
    for (const [id, questions] of Object.entries(templateQuestions)) {
      expect(templateById(id), id).toBeTruthy();
      for (const question of questions) expect(question.expect.fact || question.expect.includes?.length, `${id}/${question.id}`).toBeTruthy();
    }
  });
});
