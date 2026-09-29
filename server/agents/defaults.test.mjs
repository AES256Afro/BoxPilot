// @vitest-environment node
/**
 * An agent's run may take 15 minutes by default (the owner's choice after the first real run timed
 * out). Agents saved with the old 10-minute default are moved to it once, as a version of their own
 * that says BoxPilot made it; any other limit the owner set stays.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { agentsMigrationsKey } from "./service.mjs";
import { budgetCeilings, normalizeSpec } from "./spec.mjs";

let h;
afterEach(async () => { await h?.close(); h = null; });

const withRunSeconds = (agent, runSeconds) => h.service.updateAgent(h.caller("owner"), agent.id, { spec: { ...agent.spec, budget: { ...agent.spec.budget, runSeconds } } });

describe("the longest run's default", () => {
  it("is 15 minutes, with a day's model time that holds two such runs", () => {
    expect(budgetCeilings.runSeconds).toEqual({ min: 30, max: 1_800, default: 900 });
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
});
