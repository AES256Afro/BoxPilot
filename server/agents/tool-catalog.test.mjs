import { describe, expect, it } from "vitest";
import { registry } from "../ops/index.mjs";
import { actToolIds, actToolLimit, coreToolIds, describeTools, lesserRole, readToolInput, roleAtLeast, toModelTool, toolAllowed, toolById, toolCatalog, toolIdOf } from "./tool-catalog.mjs";

describe("the tools catalog", () => {
  it("names each tool once, in a form a model can call, with a role and a cost", () => {
    const ids = toolCatalog.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tool of toolCatalog) {
      expect(tool.fn, tool.id).toMatch(/^[a-z_]{1,64}$/);
      expect(["viewer", "operator", "owner"], tool.id).toContain(tool.role);
      expect(["cheap", "moderate", "heavy"], tool.id).toContain(tool.cost);
      expect(toolById(tool.fn)).toBe(tool);
    }
  });

  it("writes on the server only through a job under a grant: the other tools that write keep notes, save a card or queue a notice", () => {
    expect(toolCatalog.filter((tool) => tool.writes).map((tool) => [tool.id, tool.writes])).toEqual([["notes.write", "notes"], ["plan.propose", "proposal"], ["operations.run", "job"], ["operations.plan", "job"], ["notify.owner", "notification"], ["agents.handoff", "subtask"]]);
    // M45.5 (ADR-013): the one tool that changes the server is for runs a person who may change it stands behind.
    expect(toolById("operations.run").role).toBe("operator");
    expect(toolById("operations.plan").role).toBe("operator");
  });

  it("gives an operator read (ADR-003) the operator role, as the registry does", () => {
    expect(toolById("logs.query").role).toBe(registry.get("logs.read").minimumRole);
    expect(toolById("pihole.stats").role).toBe(registry.get("app.pihole.inspect").minimumRole);
    expect(toolById("theyspy.status").role).toBe(registry.get("app.theyspy.inspect").minimumRole);
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

  // M66.2: thirty tools on, as an agent with a lot to read has: far more than one call carries.
  const thirty = toolCatalog.map((tool) => tool.id).filter((id) => !["web.search", "operations.run", "operations.plan", "json.extract", "regex.match", "theyspy.status", "baselinewatch.digest", "document.read"].includes(id));
  const everyRun = ["memory.search", "plan.propose", "notify.owner", "agents.handoff"];
  // Five tools, by id and by the name the model calls; time.calc is not calc, and app.backup is an operation, not a tool.
  const fiveSteps = ["Read the drives with storage.health, and what is wrong now with alerts.active.", "Call apps_list, then where.runs for where each one runs.", "Work out the growth with time.calc.", "Propose the fix with plan.propose. A card that rebuilds an app starts with app.backup."];

  it("has a set of its own for each agent: every tool it has on when they fit in one call", () => {
    expect(thirty).toHaveLength(30);
    // Five on: all five, the always-on ones first, whatever its steps say.
    expect(coreToolIds(["docs.search", "plan.propose", "alerts.active", "memory.search", "server.facts"], { steps: ["Answer from docs.search."] })).toEqual(["memory.search", "plan.propose", "server.facts", "alerts.active", "docs.search"]);
    // Exactly ten on is still all ten; an eleventh is where the steps begin to choose.
    const ten = thirty.filter((id) => !everyRun.includes(id)).slice(0, 8).concat("memory.search", "plan.propose");
    expect(coreToolIds(ten)).toHaveLength(actToolLimit);
    expect([...coreToolIds(ten)].sort()).toEqual([...ten].sort());
    const eleven = coreToolIds([...ten, "notify.owner"], { steps: ["Read server.facts."] });
    // The three always-on ones, the one its steps name, and the cheap reads up to the six a run with no plan carries.
    expect(eleven).toHaveLength(9);
    expect(eleven.slice(0, 3)).toEqual(["memory.search", "plan.propose", "notify.owner"]);
    expect(eleven).toContain("server.facts");
  });

  it("is the always-on ones, the ones its steps name, then the cheap reads up to six, when it has more on than fit", () => {
    // Five named, so one cheap read more: the first not yet in it.
    expect(coreToolIds(thirty, { steps: fiveSteps })).toEqual([...everyRun, "server.facts", "apps.list", "storage.health", "alerts.active", "where.runs", "time.calc"]);
    // A learning run's notes are always on for it, as they are for its plan.
    expect(coreToolIds(thirty, { steps: fiveSteps, kind: "learn" })).toEqual(["memory.search", "notes.read", "notes.write", "plan.propose", "notify.owner", "agents.handoff", "apps.list", "storage.health", "alerts.active", "where.runs"]);
    // A tool it does not have on is not carried for being named, and steps that name none leave the always-on ones.
    // A tool it does not have on is not carried for being named; steps that name none leave the cheap reads.
    const cheap = [...everyRun, "server.facts", "apps.list", "services.status", "storage.health", "alerts.active", "where.runs"];
    expect(coreToolIds(thirty, { steps: ["Search the web with web.search, then read baselinewatch_digest."] })).toEqual(cheap);
    expect(coreToolIds(thirty)).toEqual(cheap);
  });

  it("keeps the ones the steps name first when they name more than fit", () => {
    const eight = ["Use pihole.stats and where.runs.", "Check jobs.recent.", "Read server.facts, apps.list and storage.health.", "Then alerts.active and backups.status."];
    const core = coreToolIds(thirty, { steps: eight });
    expect(core).toHaveLength(actToolLimit);
    // Six fit beside the four always-on ones: the first six named, and then in the catalog's order.
    expect(core).toEqual([...everyRun, "server.facts", "apps.list", "storage.health", "where.runs", "jobs.recent", "pihole.stats"]);
  });

  it("carry the agent's own set whatever the plan, while the plan asks for nothing outside it", () => {
    const core = coreToolIds(thirty, { steps: fiveSteps });
    // Two questions, two plans, one list: the same bytes at the head of both prompts.
    expect(actToolIds(thirty, { planned: ["storage.health"], core })).toEqual(core);
    expect(actToolIds(thirty, { planned: ["apps_list", "alerts-active"], hinted: ["where.runs"], core })).toEqual(core);
    // A name that is no tool, or a tool it has off, was never carried: it does not count as asking for more.
    expect(actToolIds(thirty, { planned: ["storage.health", "shell.run", "web.search"], core })).toEqual(core);
    // Without a plan too, since the set holds tools to read with.
    expect(actToolIds(thirty, { planned: null, core })).toEqual(core);
    expect(actToolIds(thirty, { planned: null, hinted: ["where.runs"], core })).toEqual(core);
  });

  it("carry the plan's tools, as before, when it asks for one outside the agent's own set", () => {
    const core = coreToolIds(thirty, { steps: fiveSteps });
    expect(actToolIds(thirty, { planned: ["storage.health", "logs.query"], core })).toEqual([...everyRun, "logs.query", "storage.health"]);
    expect(actToolIds(thirty, { planned: ["storage.health", "logs.query"], core })).toEqual(actToolIds(thirty, { planned: ["storage.health", "logs.query"] }));
    // The request's own words count as the plan does.
    expect(actToolIds(thirty, { planned: ["storage.health"], hinted: ["pihole.stats"], core })).toEqual([...everyRun, "storage.health", "pihole.stats"]);
    expect(actToolIds(thirty, { planned: null, hinted: ["pihole.stats"], core })).toEqual(actToolIds(thirty, { planned: null, hinted: ["pihole.stats"] }));
    // A set of only the always-on ones has nothing to read with: without a plan, the cheap reads as before.
    expect(actToolIds(thirty, { planned: null, core: coreToolIds(thirty) })).toEqual(actToolIds(thirty, { planned: null }));
    expect(actToolIds(thirty, { planned: null, core: coreToolIds(thirty) })).toContain("server.facts");
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
