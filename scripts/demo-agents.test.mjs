// @vitest-environment node
/**
 * The demo's Agents section (M43): every world offers every template, and the default world's
 * Environment Scout shows a survey a person can trust - five reads, a ranked list whose every
 * number its own check found in the tool output, two cards, and what it could not check. Built
 * from the real service, runner and stand-in model, as the demo serves it; dates are the demo's
 * own, relative to whenever it runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentTemplates } from "../server/agents/templates.mjs";
import { agentsDemo, app, scenarioNames } from "./boxpilot-demo.mjs";

let server;
let base;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await agentsDemo.close();
});

const get = async (path, scenario = "default") => {
  const response = await fetch(`${base}${path}`, { headers: { referer: `http://127.0.0.1/?scenario=${scenario}` } });
  return { status: response.status, body: await response.json() };
};

describe("the demo's agents", { timeout: 60_000 }, () => {
  it("offer every template in every world", async () => {
    for (const scenario of scenarioNames) {
      const { status, body } = await get("/agents/catalog", scenario);
      expect(status, scenario).toBe(200);
      expect(body.templates.map((template) => template.id), scenario).toEqual(agentTemplates.map((template) => template.id));
    }
  });

  it("show the Environment Scout's survey in the default world, checked against what its tools said", async () => {
    const { body: overview } = await get("/agents");
    const scout = overview.agents.find((agent) => agent.template === "environment-scout");
    expect(scout).toMatchObject({ name: "Environment Scout", triggers: { schedule: { every: "weekly", weekday: 0 } } });
    const { body: listed } = await get(`/agents/${scout.id}/runs`);
    const { body: run } = await get(`/agents/runs/${listed.runs[0].id}`);
    expect(run).toMatchObject({ state: "completed", outputKind: "answer", flags: { check: { mismatches: 0, unsure: false } } });
    expect(run.steps.filter((step) => step.kind === "tool").map((step) => step.name)).toEqual(["alerts.active", "storage.health", "apps.list", "backups.status", "server.facts"]);
    expect(run.answer).toMatch(/^Where to focus\n/);
    expect(run.answer).toMatch(/\nFine: /);
    expect(run.answer).toMatch(/\nNot checked: the firewall, open ports, SSH settings/);
    const { body: proposals } = await get("/agents/proposals");
    expect(proposals.proposals.filter((card) => card.agentId === scout.id).map((card) => card.steps.map((step) => step.operationId))).toEqual([["app.update"], ["app.backup.many"]]);
    // The trouble world keeps its four agents: the Scout is the default world's.
    const { body: trouble } = await get("/agents", "trouble");
    expect(trouble.agents.some((agent) => agent.template === "environment-scout")).toBe(false);
  });
});
