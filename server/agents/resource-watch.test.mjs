// @vitest-environment node
/**
 * Resource Watch (M47.9): the template that reads which apps use the machine, its seeds and its
 * golden question on the fact busiestApp, read from the Performance page's read; and a run of it on
 * the stand-in model that names the busiest app with its number.
 */
import { describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { gradeFact } from "./grade.mjs";
import { agentTemplates, evaluationFacts, seedExamples, templateById, templateQuestions } from "./templates.mjs";

describe("the Resource Watch template", () => {
  it("is listed before the House Guide, reads usage and the apps, keeps notes, proposes only app.action, and runs in the evening", () => {
    const ids = agentTemplates.map((template) => template.id);
    expect(ids.indexOf("resource-watch")).toBe(ids.indexOf("house-guide") - 1);
    const { spec } = templateById("resource-watch");
    expect(spec.tools).toMatchObject({ "apps.usage": "auto", "apps.list": "auto", "notes.write": "auto", "plan.propose": "auto", "logs.query": "ask", "firewall.status": "off", "operations.run": "off" });
    expect(spec.triggers).toMatchObject({ ask: true, schedule: { every: "daily", hour: 19, minute: 40, quietHours: false }, events: ["health.alert"] });
    expect(spec.allow).toEqual({ apps: "*", operations: ["app.action"] });
    expect(spec.prompt.steps[0]).toMatch(/apps\.usage/);
    expect(spec.outputs.notes).toBe(true);
    expect(seedExamples("resource-watch", spec).map((seed) => seed.id)).toEqual(["busiest", "memory", "swap", "restarting"]);
    expect(templateQuestions["resource-watch"]).toEqual([{ id: "busiest", question: "Which app is using the most processor right now?", expect: { fact: "busiestApp" } }]);
    expect(evaluationFacts).toContain("busiestApp");
  });

  it("reads the busiest app from the server as its evaluation's fact, and a run names it from apps.usage", async () => {
    const h = await createAgentsHarness();
    try {
      h.enable();
      const watch = h.service.createAgent(h.caller("owner"), { template: "resource-watch" });
      const started = await h.service.runEvaluation(h.caller("owner"), watch.id);
      expect(started.results.find((result) => result.questionId === "busiest").expected).toEqual({ fact: "busiestApp", value: "jellyfin" });
      h.service.startRun(h.caller("owner"), watch.id, { kind: "ask", question: "Which app is using the most processor right now?" });
      const run = await h.runNext();
      expect(run.state).toBe("completed");
      expect(h.service.getRun(h.caller("owner"), run.id).steps.filter((step) => step.kind === "tool").map((step) => step.name)).toContain("apps.usage");
      expect(gradeFact("busiestApp", "jellyfin", run.answer).passed).toBe(true);
      // No stats: the fact is unknown rather than a guess.
      h.helperAnswers["system.performance.inspect"] = () => ({ cpu: {}, memory: {}, swap: {}, statsAvailable: false, apps: [] });
      const other = h.service.createAgent(h.caller("owner"), { template: "resource-watch" });
      const again = await h.service.runEvaluation(h.caller("owner"), other.id);
      expect(again.results.find((result) => result.questionId === "busiest").expected).toEqual({ fact: "busiestApp", value: null });
    } finally {
      await h.close();
    }
  });
});
