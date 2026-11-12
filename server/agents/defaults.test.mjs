/**
 * An agent's run may take 15 minutes by default (the owner's choice after the first real run timed
 * out). Agents saved with the old 10-minute default are moved to it once, as a version of their own
 * that says BoxPilot made it; any other limit the owner set stays.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { agentsMigrationsKey } from "./service.mjs";
import { budgetCeilings, normalizeSpec } from "./spec.mjs";
import { templateById } from "./templates.mjs";

let h;
afterEach(async () => { await h?.close(); h = null; });

const withRunSeconds = (agent, runSeconds) => h.service.updateAgent(h.caller("owner"), agent.id, { spec: { ...agent.spec, budget: { ...agent.spec.budget, runSeconds } } });

describe("the longest run's default", () => {
  it("is 15 minutes, with a day's model time that holds two such runs", () => {
    expect(budgetCeilings.runSeconds).toEqual({ min: 30, max: 3_600, default: 900 });
    const spec = normalizeSpec({ name: "Watcher", job: "Watch the disks.", successCriteria: ["Says which disk is fullest."], triggers: { ask: true } });
    expect(spec.budget.runSeconds).toBe(900);
    expect(spec.budget.modelSecondsPerDay).toBeGreaterThanOrEqual(2 * spec.budget.runSeconds);
  });

  it("moves agents saved with the old default to it once, as a version BoxPilot made, and leaves the owner's own limits", async () => {
    h = await createAgentsHarness();
    const steve = withRunSeconds(h.service.createAgent(h.caller("owner"), { template: "server-keeper" }), 600);
    const greg = h.service.createAgent(h.caller("owner"), { template: "it-support" });
    const slow = withRunSeconds(h.service.createAgent(h.caller("owner"), { template: "blank" }), 1_200);
    expect(steve).toMatchObject({ version: 2, spec: { budget: { runSeconds: 600 } } });

    // The later raise of every limit (M65) has its own test: here it has already run.
    h.state.setSetting(agentsMigrationsKey, { headroom: {} }, { updatedBy: null });
    expect(h.service.migrateDefaults()).toBe(1);
    const moved = h.service.getAgent(h.caller("owner"), steve.id);
    expect(moved.version).toBe(3);
    expect(moved.spec.budget.runSeconds).toBe(900);
    expect(moved.versions[0]).toMatchObject({ version: 3, note: "BoxPilot raised the time limit to the new 15-minute default", createdBy: null });
    expect(h.service.versionDetail(h.caller("owner"), steve.id, 3).changes.map((change) => change.field)).toEqual(["budget.runSeconds"]);
    // The others keep what they were saved with: the helper's 5 minutes, the owner's 20.
    expect(h.service.getAgent(h.caller("owner"), greg.id)).toMatchObject({ version: 1, spec: { budget: { runSeconds: 300 } } });
    expect(h.service.getAgent(h.caller("owner"), slow.id)).toMatchObject({ version: 2, spec: { budget: { runSeconds: 1_200 } } });
    expect(h.state.getSetting(agentsMigrationsKey)).toMatchObject({ runSeconds: { raised: 1 } });
    expect(h.state.listAudit(50).find((event) => event.type === "agents.updated" && event.details?.by === "boxpilot")).toMatchObject({ subjectId: steve.id, details: { fields: ["budget.runSeconds"] } });

    // Once: an owner who sets 10 minutes again keeps it.
    withRunSeconds(moved, 600);
    expect(h.service.migrateDefaults()).toBe(0);
    expect(h.service.getAgent(h.caller("owner"), steve.id).spec.budget.runSeconds).toBe(600);
  });

  it("gives agents still at the old limits more room once, and leaves a limit the owner set (M65)", async () => {
    h = await createAgentsHarness();
    const owner = h.caller("owner");
    const keeper = h.service.createAgent(owner, { template: "server-keeper" });
    const cut = h.service.createAgent(owner, { template: "pihole-watcher" });
    const former = { runsPerDay: 24, modelSecondsPerDay: 3_600, stepsPerRun: 6, tokensPerRun: 20_000, runSeconds: 1_200 };
    h.service.updateAgent(owner, keeper.id, { spec: { ...h.store.getAgent(keeper.id).spec, budget: former } });
    h.service.updateAgent(owner, cut.id, { spec: { ...h.store.getAgent(cut.id).spec, budget: { runsPerDay: 8, modelSecondsPerDay: 300, stepsPerRun: 3, tokensPerRun: 5_000, runSeconds: 200 } } });
    h.state.setSetting(agentsMigrationsKey, { runSeconds: {}, sharing: {}, examples: {}, eyes: {}, surveyWide: {}, eyesMore: {} }, { updatedBy: null });
    expect(h.service.migrateDefaults()).toBe(1);
    const raised = h.service.getAgent(owner, keeper.id);
    expect(raised.spec.budget).toEqual({ runsPerDay: 24, modelSecondsPerDay: 5_400, stepsPerRun: 10, tokensPerRun: 40_000, runSeconds: 1_500 });
    expect(raised.versions[0]).toMatchObject({ note: "BoxPilot gave it more room: more steps, tokens and time for each run", createdBy: null });
    expect(h.store.getAgent(cut.id).spec.budget).toMatchObject({ modelSecondsPerDay: 300, stepsPerRun: 3, tokensPerRun: 5_000, runSeconds: 200 });
    expect(h.state.getSetting(agentsMigrationsKey)).toMatchObject({ headroom: { raised: 1 } });
    expect(h.service.migrateDefaults()).toBe(0);
  });

  it("rewords a Keeper's and a Scout's lines still in the template's old words, once, and leaves a line the maker wrote (M66)", async () => {
    h = await createAgentsHarness();
    const owner = h.caller("owner");
    const keeper = h.service.createAgent(owner, { template: "server-keeper" });
    const scout = h.service.createAgent(owner, { template: "environment-scout" });
    const own = h.service.createAgent(owner, { template: "server-keeper" });
    const oldStep = "Check memory.search for what you learned before; say when a note may be out of date.";
    const oldRules = [
      "Asked about the firewall or Repair alone, read firewall.status or repair.findings for it; the weekly survey reads both.",
      "Open ports, SSH settings and waiting system package updates no tool of yours sees: name them under Not checked, with the page to open (Updates).",
      "Asked about one area, read the tool for it: services.status for which services failed, jobs.recent for jobs that failed, firewall.status for the firewall, repair.findings for what Repair found.",
    ];
    const withPrompt = (id, change) => { const spec = h.store.getAgent(id).spec; h.service.updateAgent(owner, id, { spec: { ...spec, prompt: change(spec.prompt) } }); };
    withPrompt(keeper.id, (prompt) => ({ ...prompt, steps: prompt.steps.map((step) => (step.startsWith("Your notes and what you remember") ? oldStep : step)) }));
    withPrompt(scout.id, (prompt) => ({ ...prompt, rules: [...prompt.rules.filter((rule) => !rule.startsWith("Asked about the firewall or Repair alone") && !rule.startsWith("firewall.status lists the ports")), ...oldRules] }));
    withPrompt(own.id, (prompt) => ({ ...prompt, steps: prompt.steps.map((step) => (step.startsWith("Your notes and what you remember") ? "Search my memory my own way." : step)) }));
    h.state.setSetting(agentsMigrationsKey, { runSeconds: {}, sharing: {}, examples: {}, eyes: {}, surveyWide: {}, eyesMore: {}, headroom: {} }, { updatedBy: null });
    expect(h.service.migrateDefaults()).toBe(2);
    expect(h.store.getAgent(keeper.id).spec.prompt.steps).toEqual(templateById("server-keeper").spec.prompt.steps);
    const rules = h.store.getAgent(scout.id).spec.prompt.rules;
    expect([...rules].sort()).toEqual([...templateById("environment-scout").spec.prompt.rules].sort());
    expect(rules.some((rule) => oldRules.includes(rule))).toBe(false);
    expect(h.store.getAgent(own.id).spec.prompt.steps).toContain("Search my memory my own way.");
    expect(h.service.getAgent(owner, keeper.id).versions[0]).toMatchObject({ note: "BoxPilot reworded its steps and rules for what it is already shown and what its tools read", createdBy: null });
    expect(h.service.migrateDefaults()).toBe(0);
  });

  it("takes out the Scout's rule said twice in the wording from before it read the firewall, too (M66)", async () => {
    h = await createAgentsHarness();
    const owner = h.caller("owner");
    const scout = h.service.createAgent(owner, { template: "environment-scout" });
    const lone = h.service.createAgent(owner, { template: "environment-scout" });
    // As a Scout made before M47.1 has it: the rule ends at the jobs, and names neither the firewall nor Repair.
    const older = "Asked about one area, read the tool for it: services.status for which services failed, jobs.recent for jobs that failed.";
    const firewallOld = "Asked about the firewall or Repair alone, read firewall.status or repair.findings for it; the weekly survey reads both.";
    const withRules = (id, change) => { const spec = h.store.getAgent(id).spec; h.service.updateAgent(owner, id, { spec: { ...spec, prompt: { ...spec.prompt, rules: change(spec.prompt.rules) } } }); };
    withRules(scout.id, (rules) => [...rules.filter((rule) => !rule.startsWith("Asked about the firewall or Repair alone")), firewallOld, older]);
    // One whose maker took the firewall's rule out keeps the older line: it is said once there.
    withRules(lone.id, (rules) => [...rules.filter((rule) => !rule.startsWith("Asked about the firewall or Repair alone")), older]);
    h.state.setSetting(agentsMigrationsKey, { runSeconds: {}, sharing: {}, examples: {}, eyes: {}, surveyWide: {}, eyesMore: {}, headroom: {} }, { updatedBy: null });
    expect(h.service.migrateDefaults()).toBe(1);
    const rules = h.store.getAgent(scout.id).spec.prompt.rules;
    expect(rules).not.toContain(older);
    expect(rules).not.toContain(firewallOld);
    expect([...rules].sort()).toEqual([...templateById("environment-scout").spec.prompt.rules].sort());
    expect(h.store.getAgent(lone.id).spec.prompt.rules).toContain(older);
  });

  it("rewords the Keeper's step that said its notes were under the question, once (M66.2)", async () => {
    h = await createAgentsHarness();
    const owner = h.caller("owner");
    const keeper = h.service.createAgent(owner, { template: "server-keeper" });
    const said = "Your notes and what you remember are under the question. Use memory.search only for what they do not cover; say when a note may be out of date.";
    const spec = h.store.getAgent(keeper.id).spec;
    h.service.updateAgent(owner, keeper.id, { spec: { ...spec, prompt: { ...spec.prompt, steps: spec.prompt.steps.map((step) => (step.startsWith("Your notes and what you remember") ? said : step)) } } });
    h.state.setSetting(agentsMigrationsKey, { runSeconds: {}, sharing: {}, examples: {}, eyes: {}, surveyWide: {}, eyesMore: {}, headroom: {}, wording: {} }, { updatedBy: null });
    expect(h.service.migrateDefaults()).toBe(1);
    expect(h.store.getAgent(keeper.id).spec.prompt.steps).toEqual(templateById("server-keeper").spec.prompt.steps);
    expect(h.store.getAgent(keeper.id).spec.prompt.steps).not.toContain(said);
    expect(h.service.migrateDefaults()).toBe(0);
  });
});
