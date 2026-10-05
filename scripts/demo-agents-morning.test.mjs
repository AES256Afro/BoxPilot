// @vitest-environment node
/**
 * The demo built in the morning (2026-10 sweep, D-1). The demo seeds its agents' day relative to
 * whenever it is built, and the Pi-hole Watcher's 05:31 routine leaves a finding fresh for seven
 * hours: built between about 05:45 and 12:45 the Server Keeper took that finding instead of running
 * the watcher, so demo-agents.test.mjs failed on a dev box in the morning and would on CI at those
 * hours (UTC). Built here at 09:30, the hour it failed, with the clock still moving.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let demo;
let server;
let base;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 5, 9, 30, 0));
  demo = await import("./boxpilot-demo.mjs");
  server = demo.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
afterAll(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise((resolve) => server.close(resolve));
  await demo?.agentsDemo.close();
  vi.useRealTimers();
});

const get = async (path) => (await fetch(`${base}${path}`, { headers: { referer: "http://127.0.0.1/?scenario=default" } })).json();

describe("the demo's agents, built at 09:30", { timeout: 60_000 }, () => {
  it("still run the Pi-hole Watcher for the Server Keeper, and take only the Backup Auditor's finding", async () => {
    const overview = await get("/agents");
    const keeper = overview.agents.find((agent) => agent.template === "server-keeper");
    const { runs } = await get(`/agents/${keeper.id}/runs`);
    const asked = runs.find((entry) => entry.question === "Are the backups current, and is Pi-hole healthy?" && entry.kind === "ask");
    const run = await get(`/agents/runs/${asked.id}`);
    expect(run.steps.filter((step) => step.kind === "handoff").map((step) => [step.input.agent, Boolean(step.flags.reused)])).toEqual([["Backup Auditor", true], ["Pi-hole Watcher", false]]);
    expect(run.tree.map((entry) => [entry.agentName, entry.kind])).toEqual([["Server Keeper", "ask"], ["Pi-hole Watcher", "handoff"], ["Server Keeper", "continue"]]);
    // The watcher's own trace says why it did not read the other agents' findings either.
    const watcher = await get(`/agents/runs/${run.tree.find((entry) => entry.kind === "handoff").id}`);
    expect(watcher.steps.find((step) => step.name === "findings")?.flags.detail).toMatch(/fresh check/);
  });
});
