// @vitest-environment node
/**
 * The agent templates (M37, M43): every one a spec BoxPilot accepts, using only tools the runtime
 * has, with budgets under the ceilings that still hold its own nightly evaluation, schedules inside
 * quiet hours, operations it may propose that exist and destroy nothing, and golden questions its
 * own tools can answer. Then the catalog route serves them, each makes an agent that matches it,
 * and the Environment Scout's weekly survey runs end to end on the stand-in model, proposing and
 * never acting.
 */
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { registry } from "../ops/index.mjs";
import { createAgentsRouter } from "../routes/agents.mjs";
import { defaultQuietHours, inQuietHours } from "./budget.mjs";
import { gradeFact, serviceLimits } from "./service.mjs";
import { understandingSchema } from "./intent.mjs";
import { budgetCeilings, normalizeSpec, scopeWarnings } from "./spec.mjs";
import { agentTemplates, builtInQuestions, evaluationFacts, templateById, templateQuestions } from "./templates.mjs";
import { actToolLimit, toolById, toolCatalog } from "./tool-catalog.mjs";
import { appUpdatesOf, failedServicesOf, unhealthyAppsOf } from "./tool-text.mjs";
import { createToolRunner } from "./tools.mjs";

const added = ["environment-scout", "app-doctor", "storage-watch", "update-planner", "house-guide"];
const on = (spec) => Object.entries(spec.tools).filter(([, permission]) => permission !== "off").map(([id]) => id);
// The tools the service answers itself; every other one the read-tool runner runs.
const serviceTools = new Set(["memory.search", "agents.handoff", "notes.read", "notes.write", "plan.propose", "notify.owner"]);
const readTools = createToolRunner({ state: {}, store: {}, registry });
// The tool whose output says each fact, as the evaluation reads it.
const factTool = {
  hostname: "server.facts", operatingSystem: "server.facts", installedApps: "apps.list", stoppedApps: "apps.list", unhealthyApps: "apps.list", appUpdates: "apps.list",
  rootDiskPercent: "storage.health", drives: "storage.health", piholePlacement: "where.runs", piholeBlocking: "pihole.stats", failedServices: "services.status",
  firewallEnabled: "firewall.status",
};
/** Every question the evaluation asks an agent made from this template: its built-in ones not covered, then its own. */
const evaluationOf = (template) => {
  const custom = templateQuestions[template.id] ?? [];
  const covered = new Set(custom.map((question) => question.expect.fact).filter(Boolean));
  return [...builtInQuestions(template.spec).filter((question) => !covered.has(question.expect.fact)), ...custom];
};
const promptText = (spec) => [...spec.prompt.rules, ...spec.prompt.steps, spec.prompt.output.style].join("\n");
const mentions = (text, id) => new RegExp(`(?<![\\w.-])${id.replace(/\./g, "\\.")}(?![\\w-]|\\.[a-z0-9])`).test(text);

describe("every template", () => {
  it("is a spec BoxPilot accepts as it is, and the catalog offers the five added in M43", () => {
    for (const template of agentTemplates) expect(normalizeSpec(template.spec), template.id).toEqual(template.spec);
    for (const id of added) expect(templateById(id), id).toBeTruthy();
    expect(new Set(agentTemplates.map((template) => template.id)).size).toBe(agentTemplates.length);
  });

  it("uses only tools the runtime has, and names in its prompt only tools it has on and operations it may propose", () => {
    for (const template of agentTemplates) {
      for (const id of on(template.spec)) {
        expect(toolById(id), `${template.id}: ${id}`).toBeTruthy();
        expect(readTools.has(id) || serviceTools.has(id), `${template.id}: ${id} is run by nothing`).toBe(true);
      }
      const text = promptText(template.spec);
      for (const tool of toolCatalog.filter((entry) => mentions(text, entry.id))) expect(template.spec.tools[tool.id], `${template.id} names ${tool.id}`).not.toBe("off");
      const allowed = template.spec.allow.operations;
      for (const operation of registry.list().filter((entry) => mentions(text, entry.id))) {
        expect(allowed === "*" || allowed.includes(operation.id), `${template.id} names ${operation.id}`).toBe(true);
      }
    }
  });

  it("keeps its budget under the ceilings, never cuts its own run short, and holds its nightly evaluation", () => {
    for (const template of agentTemplates) {
      const { budget } = template.spec;
      for (const [field, { min, max }] of Object.entries(budgetCeilings)) {
        expect(budget[field], `${template.id}: ${field}`).toBeGreaterThanOrEqual(min);
        expect(budget[field], `${template.id}: ${field}`).toBeLessThanOrEqual(max);
      }
      expect(budget.modelSecondsPerDay, `${template.id}: a day holds a whole run`).toBeGreaterThanOrEqual(budget.runSeconds);
      // The nightly evaluation is queued only when it leaves half the day's model time for people.
      const needed = evaluationOf(template).length * serviceLimits.evalSecondsPerQuestion;
      expect(budget.modelSecondsPerDay - needed, `${template.id}: room for its evaluation`).toBeGreaterThanOrEqual(budget.modelSecondsPerDay / 2);
      expect(budget.stepsPerRun * serviceLimits.toolCallsPerStep, template.id).toBeLessThanOrEqual(serviceLimits.maxToolCallsPerRun);
    }
  });

  it("does its scheduled work inside the default quiet hours when it waits for them, so it is not held a day", () => {
    for (const template of agentTemplates) {
      const schedule = template.spec.triggers.schedule;
      if (!schedule?.quietHours || !["daily", "weekly"].includes(schedule.every)) continue;
      expect(inQuietHours(new Date(2026, 9, 4, schedule.hour, schedule.minute), defaultQuietHours), template.id).toBe(true);
    }
  });

  it("may propose only registered operations that change something, and none that deletes", () => {
    for (const template of agentTemplates) {
      const { operations } = template.spec.allow;
      if (operations === "*") continue;
      expect(template.spec.outputs.proposals, template.id).toBe(true);
      for (const id of operations) {
        const operation = registry.get(id);
        expect(operation, `${template.id}: ${id}`).toBeTruthy();
        expect(operation.readOnly, `${template.id}: ${id}`).toBeFalsy();
        expect(id, template.id).not.toMatch(/purge|uninstall|delete|format|restore|remove|forget/);
      }
    }
  });

  it("offers a viewer-borrowable agent only tools a viewer may use, and lets it keep nothing and propose nothing", () => {
    for (const template of agentTemplates.filter((entry) => entry.spec.audience.includes("viewer"))) {
      expect(on(template.spec).every((id) => toolById(id).role === "viewer"), template.id).toBe(true);
      expect(template.spec.outputs, template.id).toMatchObject({ notes: false, proposals: false, notify: "never" });
    }
  });
});

describe("the templates added in M43", () => {
  it("fit in one call that acts, and the Builder has no warning for them", () => {
    for (const id of added) {
      const { spec } = templateById(id);
      expect(on(spec).length, id).toBeLessThanOrEqual(actToolLimit);
      expect(scopeWarnings(spec), id).toEqual([]);
    }
  });

  it("name at most eight tools in their steps besides the always-on ones, so their routine work fits in one plan", () => {
    const always = new Set(toolCatalog.filter((tool) => tool.always).map((tool) => tool.id));
    for (const id of added) {
      const { spec } = templateById(id);
      const named = toolCatalog.filter((tool) => !always.has(tool.id) && spec.prompt.steps.some((step) => mentions(step, tool.id)));
      expect(named.length, `${id}: ${named.map((tool) => tool.id).join(", ")}`).toBeLessThanOrEqual(understandingSchema.properties.plan.maxItems);
    }
  });

  it("start as the owner would want: asked always, the heavy ones on a quiet-hours schedule, and only the Scout weekly", () => {
    const scout = templateById("environment-scout").spec;
    expect(scout.triggers).toMatchObject({ ask: true, schedule: { every: "weekly", weekday: 0, hour: 4, minute: 20, quietHours: true }, events: [] });
    expect(scout.outputs).toMatchObject({ proposals: true, digest: false, notify: "never" });
    expect(templateById("app-doctor").spec.triggers).toMatchObject({ schedule: { every: "daily", quietHours: true }, events: ["health.alert", "job.failed"] });
    expect(templateById("storage-watch").spec.triggers).toMatchObject({ schedule: { every: "daily", quietHours: true }, events: ["drive.dropped"] });
    expect(templateById("update-planner").spec.triggers.schedule).toMatchObject({ every: "weekly", weekday: 5, quietHours: true });
    expect(templateById("house-guide").spec.triggers).toMatchObject({ ask: true, schedule: null, events: [] });
    for (const id of added) expect(templateById(id).spec.triggers.ask, id).toBe(true);
  });

  it("say what their tools cannot see instead of guessing at it", () => {
    // M47: the firewall and Repair are read on request; open ports, SSH settings and package updates still are not.
    expect(promptText(templateById("environment-scout").spec)).toMatch(/Asked about the firewall or Repair alone, read firewall\.status or repair\.findings for it; the weekly survey reads both/);
    expect(promptText(templateById("environment-scout").spec)).toMatch(/Open ports, SSH settings and waiting system package updates no tool of yours sees/);
    expect(promptText(templateById("environment-scout").spec)).toMatch(/Cloudflare Tunnel app/);
    expect(promptText(templateById("update-planner").spec)).toMatch(/cannot see how many system packages are waiting/);
    expect(promptText(templateById("storage-watch").spec)).toMatch(/cannot see what takes up the space/);
  });
});

describe("golden questions", () => {
  it("are well formed, ask a fact the template's own tools read or words a right answer holds, and fit in an evaluation", () => {
    for (const [id, questions] of Object.entries(templateQuestions)) {
      const template = templateById(id);
      expect(template, id).toBeTruthy();
      expect(new Set(questions.map((question) => question.id)).size, id).toBe(questions.length);
      for (const question of questions) {
        expect(question.id, id).toMatch(/^[a-z0-9-]{1,40}$/);
        expect(question.question.length, `${id}/${question.id}`).toBeGreaterThan(0);
        expect(question.question.length, `${id}/${question.id}`).toBeLessThanOrEqual(300);
        if (question.expect.fact) {
          expect(evaluationFacts, `${id}/${question.id}`).toContain(question.expect.fact);
          expect(["auto", "ask"], `${id}/${question.id} needs ${factTool[question.expect.fact]}`).toContain(template.spec.tools[factTool[question.expect.fact]]);
        } else {
          expect(question.expect.includes.length, `${id}/${question.id}`).toBeGreaterThan(0);
          expect(question.expect.includes.every((words) => typeof words === "string" && words.trim()), `${id}/${question.id}`).toBe(true);
        }
      }
      expect(evaluationOf(template).length, id).toBeLessThanOrEqual(serviceLimits.evalQuestions);
    }
    // Every template has some, except the blank one; and every fact a question may name has a tool that reads it.
    for (const template of agentTemplates.filter((entry) => entry.id !== "blank")) expect(templateQuestions[template.id]?.length, template.id).toBeGreaterThan(0);
    expect(Object.keys(factTool).sort()).toEqual([...evaluationFacts].sort());
  });

  it("read the new facts the way apps.list and services.status say them", () => {
    const applications = [
      { id: "jellyfin", installed: true, container: { running: true, status: "running", health: "unhealthy" }, updateAvailable: true },
      { id: "immich", installed: true, container: { running: true, status: "running", health: "starting" } },
      { id: "pi-hole", installed: true, container: { running: true, status: "running", health: "healthy" } },
      { id: "nextcloud", installed: false, container: { health: "unhealthy" }, updateAvailable: true },
    ];
    expect(unhealthyAppsOf(applications)).toEqual(["jellyfin", "immich"]);
    expect(appUpdatesOf(applications)).toEqual(["jellyfin"]);
    expect(failedServicesOf([{ unit: "smbd.service", active: "failed" }, { unit: "docker.service", active: "active" }])).toEqual(["smbd.service"]);
    expect([unhealthyAppsOf(null), appUpdatesOf(undefined), failedServicesOf(null)]).toEqual([null, null, null]);
  });

  it("grade the new facts the way a model writes them", () => {
    expect(gradeFact("unhealthyApps", ["jellyfin"], "Jellyfin is unhealthy [T1].").passed).toBe(true);
    expect(gradeFact("unhealthyApps", ["jellyfin", "pi-hole"], "Jellyfin is unhealthy.")).toEqual({ passed: false, found: "Missing: pi-hole" });
    expect(gradeFact("unhealthyApps", [], "None: every app is healthy.").passed).toBe(true);
    expect(gradeFact("unhealthyApps", [], "Jellyfin is unhealthy.").passed).toBe(false);
    expect(gradeFact("appUpdates", ["jellyfin"], "Jellyfin has an update waiting.").passed).toBe(true);
    expect(gradeFact("appUpdates", [], "No updates are waiting; all apps are up to date.").passed).toBe(true);
    expect(gradeFact("appUpdates", [], "Immich has an update.")).toEqual({ passed: false, found: "Expected: none is waiting for an update" });
    // A unit with or without ".service", as a person names it.
    expect(gradeFact("failedServices", ["smartd.service"], "smartd has failed [T1].").passed).toBe(true);
    expect(gradeFact("failedServices", ["smartd.service", "smbd.service"], "smartd.service failed.")).toEqual({ passed: false, found: "Missing: smbd.service" });
    expect(gradeFact("failedServices", [], "Nothing has failed.").passed).toBe(true);
    expect(gradeFact("failedServices", null, "Nothing has failed.").passed).toBe(false);
    // The stopped apps are graded as before.
    expect(gradeFact("stoppedApps", [], "None: all apps are running.")).toEqual({ passed: true, found: "Says none is stopped" });
  });
});

describe("making agents from them", () => {
  let h;
  beforeEach(async () => { h = await createAgentsHarness(); });
  afterEach(async () => { await h.close(); });

  it("makes each one as it is, with its golden questions, which the service takes back unchanged", () => {
    for (const template of agentTemplates) {
      const agent = h.service.createAgent(h.caller("owner"), { template: template.id });
      expect(agent, template.id).toMatchObject({ template: template.id, version: 1, name: template.spec.name });
      expect(agent.spec, template.id).toEqual(template.spec);
      const evaluation = h.service.getEvaluation(h.caller("owner"), agent.id);
      expect(evaluation.questions, template.id).toEqual(templateQuestions[template.id]);
      expect(h.service.setEvaluation(h.caller("owner"), agent.id, { questions: evaluation.questions }).questions, template.id).toEqual(templateQuestions[template.id]);
    }
    expect(h.service.overview(h.caller("owner")).agents).toHaveLength(agentTemplates.length);
    // A weekly schedule's first run: the Scout made on Tuesday 29 September runs on Sunday 4 October at 04:20.
    const scout = h.service.overview(h.caller("owner")).agents.find((agent) => agent.template === "environment-scout");
    expect(new Date(scout.nextRunAt)).toEqual(new Date(2026, 9, 4, 4, 20));
  });

  it("checks the Scout's golden questions against this server's facts, read as its tools read them", async () => {
    h.enable();
    const scout = h.service.createAgent(h.caller("owner"), { template: "environment-scout" });
    const route = [
      [/drives/, "storage_health", "There are no drives I can name [T1]."],
      [/stopped/, "apps_list", "None: every app is running [T1]."],
      [/operating system/, "server_facts", "Ubuntu 24.04.3 LTS [T1]."],
      [/unhealthy/, "apps_list", "Jellyfin is unhealthy [T1]."],
      [/services have failed/, "services_status", "smartd.service has failed [T1]."],
      [/root filesystem/, "storage_health", "42% [T1]."],
      [/firewall turned on/, "firewall_status", "The firewall (ufw) is on, incoming denied by default [T1]."],
      [/not check/, null, "Open ports, SSH settings and system package updates."],
    ];
    h.fake.state.script = (body) => {
      const found = route.find(([pattern]) => pattern.test(String(body.messages?.[1]?.content ?? "")));
      if (!found) return null;
      const [, tool, answer] = found;
      return !tool || body.messages.some((message) => message.role === "tool") ? { content: answer } : { toolCalls: [{ name: tool, arguments: {} }] };
    };
    const started = await h.service.runEvaluation(h.caller("owner"), scout.id);
    expect(started.results.map((result) => [result.questionId, result.expected])).toEqual([
      ["builtin-drives", { fact: "drives", value: null }],
      ["builtin-stopped", { fact: "stoppedApps", value: [] }],
      ["builtin-os", { fact: "operatingSystem", value: "Ubuntu 24.04.3 LTS" }],
      ["unhealthy", { fact: "unhealthyApps", value: ["jellyfin"] }],
      ["failed-services", { fact: "failedServices", value: ["smartd.service"] }],
      ["root-disk", { fact: "rootDiskPercent", value: 42 }],
      ["firewall", { fact: "firewallEnabled", value: "on" }],
      ["not-checked", { includes: ["ports"] }],
    ]);
    for (let asked = 0; asked < started.results.length; asked += 1) await h.runNext();
    const [done] = h.service.getEvaluation(h.caller("owner"), scout.id).runs;
    // Right on everything this server lets it be right about: the harness's server lists no drives.
    expect(done.results.filter((result) => !result.passed).map((result) => result.questionId)).toEqual(["builtin-drives"]);
  });
});

describe("the Environment Scout's weekly survey", () => {
  let h;
  beforeEach(async () => { h = await createAgentsHarness(); h.enable(); });
  afterEach(async () => { await h.close(); });

  // As its steps say, in a plan of five: the planner's schema holds no more.
  const reads = ["alerts_active", "storage_health", "apps_list", "backups_status", "server_facts"];
  const call = (name, args = {}) => ({ name, arguments: args });
  const survey = (body) => {
    if (body?.response_format?.json_schema?.name === "understanding") {
      return { understanding: { goal: "Survey this server and rank where to focus", subject: "this server", constraints: [], confidence: 0.9, clarify: null, plan: reads.map((tool) => ({ step: `Read ${tool}`, tool })) } };
    }
    const tools = body.messages.filter((message) => message.role === "tool").length;
    if (tools === 0) return { toolCalls: reads.slice(0, 3).map((name) => call(name)) };
    if (tools === 3) return { toolCalls: reads.slice(3).map((name) => call(name)) };
    if (tools === 5) {
      return { toolCalls: [
        call("plan_propose", { title: "Restart Jellyfin", reason: "Jellyfin is unhealthy, with 3 restarts [T3].", steps: [{ operationId: "app.action", parameters: { id: "jellyfin", action: "restart" }, why: "It is unhealthy." }, { operationId: "app.purge", parameters: { id: "jellyfin" }, why: "Start over." }] }),
        call("plan_propose", { title: "Rehearse restoring Jellyfin", reason: "No restore rehearsal is recorded [T4].", steps: [{ operationId: "app.backup.verify", parameters: { id: "jellyfin" }, why: "A backup never restored may not work." }] }),
      ] };
    }
    return { content: "Where to focus\n1. Jellyfin is unhealthy, with 3 restarts [T3]. A card proposes restarting it.\n2. No restore rehearsal is recorded [T4]. A card proposes one for Jellyfin.\nFine: no health alerts [T1].\nNot checked: the firewall, open ports, SSH settings, system package updates and Repair's findings." };
  };

  it("runs on Sunday in quiet hours, reads five tools, proposes the cards it may and nothing it may not, and changes nothing", async () => {
    const scout = h.service.createAgent(h.caller("owner"), { template: "environment-scout" });
    h.fake.state.script = survey;
    const jobsBefore = h.state.listJobs(200).length;
    h.setTime(new Date(2026, 9, 4, 4, 21));
    await h.service.tick();
    const run = await h.runNext();
    expect(run).toMatchObject({ agentId: scout.id, kind: "schedule", state: "completed", outputKind: "answer" });
    expect(run.steps.filter((step) => step.kind === "tool" && step.state === "done").map((step) => step.name)).toEqual(["alerts.active", "storage.health", "apps.list", "backups.status", "server.facts"]);
    expect(run.answer).toMatch(/^Where to focus/);
    // Every call that acted carried the plan's five reads and proposing: the whole survey fits.
    const acting = h.fake.prompts().filter((body) => Array.isArray(body.tools) && body.tools.length);
    expect(acting.length).toBeGreaterThan(0);
    for (const body of acting) expect(body.tools.map((tool) => tool.function.name).sort()).toEqual(["alerts_active", "apps_list", "backups_status", "plan_propose", "server_facts", "storage_health"]);

    // Two cards, as the owner's to approve; the step it may not propose never reached one.
    const cards = h.service.listProposals(h.caller("owner")).filter((card) => card.kind === "plan" && card.runId === run.id);
    expect(cards.map((card) => card.title).sort()).toEqual(["Rehearse restoring Jellyfin", "Restart Jellyfin"]);
    const restart = cards.find((card) => card.title === "Restart Jellyfin");
    expect(restart.steps.map((step) => step.operationId)).toEqual(["app.action"]);
    expect(restart.dropped).toEqual([{ index: 1, operationId: "app.purge", reason: "not on this agent's list of operations it may propose" }]);
    expect(h.state.listJobs(200).length).toBe(jobsBefore);

    // No note of its own: the survey is remembered as it ran, for next week's "what changed".
    expect(h.service.listNotes(h.caller("owner"), scout.id)).toEqual([]);
    expect(h.store.listEpisodes(scout.id).map((episode) => episode.runId)).toEqual([run.id]);
    // And the next survey is a week on.
    expect(new Date(h.store.getAgent(scout.id).nextRunAt)).toEqual(new Date(2026, 9, 11, 4, 20));
  });
});

describe("the catalog over HTTP", () => {
  let h;
  let server;
  let base;
  const auth = {
    requireCsrf: (_request, _response, next) => next(),
    requireRole: (role) => (request, response, next) => (request.boxpilotSession.owner.role === role ? next() : response.status(403).json({ error: "forbidden" })),
    checkPassword: async () => ({ ok: true, blocked: false }),
    rejectThrottled: (response) => response.status(429).json({ error: "throttled" }),
  };
  const request = async (method, pathname, { role = "owner", body } = {}) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: { "Content-Type": "application/json", "x-test-role": role }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  beforeAll(async () => {
    h = await createAgentsHarness();
    const app = express();
    app.use(express.json());
    app.use((incoming, _response, next) => {
      const role = incoming.headers["x-test-role"] ?? "owner";
      incoming.boxpilotSession = { owner: { id: h.accounts[role].id, role } };
      next();
    });
    app.use("/api/v1", createAgentsRouter({ agents: h.service, state: h.state, auth }));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    server?.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  });

  it("serves every template, with its spec and golden questions, to anyone signed in", async () => {
    for (const role of ["owner", "operator", "viewer"]) {
      const { status, body } = await request("GET", "/api/v1/agents/catalog", { role });
      expect(status, role).toBe(200);
      expect(body.templates.map((template) => template.id), role).toEqual(agentTemplates.map((template) => template.id));
      for (const template of body.templates) {
        expect(template.spec, template.id).toEqual(templateById(template.id).spec);
        expect(template.questions, template.id).toEqual(templateQuestions[template.id]);
        expect(template.summary.length, template.id).toBeGreaterThan(40);
      }
    }
  });

  it("makes an agent from each new one for the owner, and none for a viewer", async () => {
    for (const id of added) {
      const made = await request("POST", "/api/v1/agents", { body: { template: id } });
      expect(made.status, id).toBe(201);
      expect(made.body, id).toMatchObject({ template: id, spec: templateById(id).spec });
    }
    expect((await request("POST", "/api/v1/agents", { role: "viewer", body: { template: "environment-scout" } })).status).toBe(403);
    expect((await request("POST", "/api/v1/agents", { body: { template: "security-auditor" } }))).toMatchObject({ status: 400, body: { code: "invalid_agent" } });
  });
});
