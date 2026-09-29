// @vitest-environment node
import { describe, expect, it } from "vitest";
import { registry } from "../ops/index.mjs";
import { actToolIds, actToolLimit, describeTools, lesserRole, readToolInput, roleAtLeast, toModelTool, toolAllowed, toolById, toolCatalog, toolIdOf } from "./tool-catalog.mjs";

describe("the tools catalog", () => {
  it("names each tool once, in a form a model can call, with a role and a cost", () => {
    const ids = toolCatalog.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tool of toolCatalog) {
      expect(tool.fn, tool.id).toMatch(/^[a-z_]{1,64}$/);
      expect(["viewer", "operator"], tool.id).toContain(tool.role);
      expect(["cheap", "moderate", "heavy"], tool.id).toContain(tool.cost);
      expect(toolById(tool.fn)).toBe(tool);
    }
  });

  it("writes nothing on the server: the only tools that write keep notes, save a card or queue a notice", () => {
    expect(toolCatalog.filter((tool) => tool.writes).map((tool) => [tool.id, tool.writes])).toEqual([["notes.write", "notes"], ["plan.propose", "proposal"], ["notify.owner", "notification"], ["agents.handoff", "subtask"]]);
  });

  it("gives an operator read (ADR-003) the operator role, as the registry does", () => {
    expect(toolById("logs.query").role).toBe(registry.get("logs.read").minimumRole);
    expect(toolById("pihole.stats").role).toBe(registry.get("app.pihole.inspect").minimumRole);
  });

  it("is described to the model as JSON schema with no extra properties", () => {
    const schema = toModelTool(toolById("logs.query"));
    expect(schema).toMatchObject({ type: "function", function: { name: "logs_query", parameters: { type: "object", required: ["kind", "target"], additionalProperties: false } } });
    expect(schema.function.parameters.properties.lines).toMatchObject({ type: "integer", minimum: 10, maximum: 200 });
    expect(describeTools().find((tool) => tool.id === "plan.propose").params.map((param) => param.name)).toEqual(["title", "reason", "steps"]);
  });
});

describe("the tools a call that acts carries", () => {
  const keeper = ["calc", "time.calc", "units.convert", "server.facts", "apps.list", "services.status", "logs.query", "storage.health", "docs.search", "document.read", "memory.search", "notes.read", "notes.write", "jobs.recent", "records.query", "alerts.active", "backups.status", "pihole.stats", "where.runs", "plan.propose", "notify.owner", "agents.handoff"];

  it("are the always-on ones offered, then the plan's, each group in the catalog's order whatever order the plan gave", () => {
    expect(actToolIds(keeper, { planned: ["storage.health", "alerts_active", "apps-list"] })).toEqual(["memory.search", "plan.propose", "notify.owner", "agents.handoff", "apps.list", "storage.health", "alerts.active"]);
    // The same plan in another order is the same tools, byte for byte.
    expect(actToolIds(keeper, { planned: ["apps.list", "alerts.active", "storage.health"] })).toEqual(actToolIds(keeper, { planned: ["storage.health", "alerts_active", "apps-list"] }));
    // Only what was offered: an agent without memory or hand-offs gets neither.
    expect(actToolIds(["server.facts", "alerts.active", "docs.search"], { planned: ["alerts.active", "shell.run"] })).toEqual(["alerts.active"]);
  });

  it("are capped at ten, and without a plan are the cheap reads first", () => {
    expect(actToolIds(keeper, { planned: keeper })).toHaveLength(actToolLimit);
    expect(actToolIds(keeper, { planned: keeper }).slice(0, 4)).toEqual(["memory.search", "plan.propose", "notify.owner", "agents.handoff"]);
    expect(actToolIds(keeper, { planned: null })).toEqual(["memory.search", "plan.propose", "notify.owner", "agents.handoff", "server.facts", "apps.list", "services.status", "storage.health", "alerts.active", "where.runs"]);
    // A learning run keeps its notes whatever it planned.
    expect(actToolIds(keeper, { planned: ["server.facts"], kind: "learn" })).toEqual(["memory.search", "notes.read", "notes.write", "plan.propose", "notify.owner", "agents.handoff", "server.facts"]);
  });

  it("describe themselves to the model in fewer words when they are sent every time, and in full to the Builder", () => {
    for (const tool of toolCatalog.filter((entry) => entry.always)) {
      expect(toModelTool(tool).function.description, tool.id).toBe(tool.brief);
      expect(tool.brief.length, tool.id).toBeLessThan(`${tool.title}: ${tool.description}`.length);
      expect(describeTools().find((entry) => entry.id === tool.id).description).toBe(tool.description);
    }
    expect(toModelTool(toolById("alerts.active")).function.description).toBe(`Health alerts: ${toolById("alerts.active").description}`);
  });

  it("are found however the model spelled them", () => {
    for (const [name, id] of [["alerts.active", "alerts.active"], ["alerts_active", "alerts.active"], ["alerts-active", "alerts.active"], ["Alerts Active", "alerts.active"], ["functions.memory_search", "memory.search"], ["time_calc", "time.calc"], ["calc", "calc"]]) expect(toolIdOf(name), name).toBe(id);
    for (const name of ["shell_run", "", "alerts", null, 42]) expect(toolIdOf(name), String(name)).toBeNull();
    expect(toolById("alerts-active")).toBe(toolById("alerts.active"));
  });
});

describe("a tool's input", () => {
  const logs = toolById("logs.query");
  it("is read from the model's JSON, checked name by name", () => {
    expect(readToolInput(logs, '{"kind":"unit","target":"docker.service","lines":"50"}')).toEqual({ value: { kind: "unit", target: "docker.service", lines: 50 } });
    expect(readToolInput(logs, "")).toMatchObject({ problem: expect.stringMatching(/needs "kind"/) });
    expect(readToolInput(logs, "not json")).toEqual({ problem: "The arguments are not JSON" });
    expect(readToolInput(logs, "[]")).toEqual({ problem: "The arguments must be an object" });
    expect(readToolInput(logs, { kind: "unit", target: "x", command: "rm -rf /" })).toMatchObject({ problem: expect.stringMatching(/takes no "command"/) });
    expect(readToolInput(logs, { kind: "shell", target: "x" })).toMatchObject({ problem: expect.stringMatching(/one of group, unit, container/) });
    expect(readToolInput(logs, { kind: "unit", target: "x", lines: 5000 })).toMatchObject({ problem: expect.stringMatching(/10 to 200/) });
    expect(readToolInput(logs, { kind: "unit", target: "x", since: "1y" })).toMatchObject({ problem: expect.any(String) });
    expect(readToolInput(toolById("where.runs"), { name: "pi-hole; rm" })).toMatchObject({ problem: expect.any(String) });
  });
});

describe("who may use a tool", () => {
  it("follows the run's role, the agent's permission and what started the run", () => {
    const logs = toolById("logs.query");
    const facts = toolById("server.facts");
    expect(toolAllowed(logs, "auto", { kind: "ask", readRole: "viewer" })).toBe(false);
    expect(toolAllowed(logs, "auto", { kind: "ask", readRole: "operator" })).toBe(true);
    expect(toolAllowed(logs, "ask", { kind: "schedule", readRole: "owner" })).toBe(false);
    expect(toolAllowed(logs, "ask", { kind: "manual", readRole: "owner" })).toBe(true);
    expect(toolAllowed(facts, "off", { kind: "ask", readRole: "owner" })).toBe(false);
    expect(toolAllowed(facts, "sometimes", { kind: "ask", readRole: "owner" })).toBe(false);
    expect(roleAtLeast("owner", "operator")).toBe(true);
    expect(roleAtLeast("viewer", "operator")).toBe(false);
    expect(lesserRole("owner", "viewer")).toBe("viewer");
  });
});
