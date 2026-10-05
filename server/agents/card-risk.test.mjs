// @vitest-environment node
/**
 * An agent's card says the tier its step will be staged at (sweep 3). Installing the house's DNS
 * or VPN is medium by the operation's own tier and high by the app's manifest; the job layer
 * stages it high, so the card, and its copy in Zulip, say high too. The real registry with the
 * hook the web process installs, the real catalog, the real service.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { createCatalogService, installRiskLookup } from "../catalog/index.mjs";
import { registry } from "../ops/index.mjs";
import { cardMessage } from "./zulip.mjs";

let h;
beforeEach(async () => {
  registry.useRiskHooks({ "app.install": installRiskLookup(createCatalogService()) });
  h = await createAgentsHarness();
});
afterEach(async () => {
  await h.close();
  registry.useRiskHooks({});
});

const propose = (steps) => (body) => (body.messages.some((message) => message.role === "tool") ? { content: "Proposed [T1]." } : { toolCalls: [{ name: "plan_propose", arguments: { title: "Block ads for the house", reason: "Nothing filters DNS.", steps } }] });

describe("an agent's card", () => {
  it("shows installing Pi-hole as high, with the owner's password, in BoxPilot and in Zulip", async () => {
    h.enable();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.fake.state.script = propose([{ operationId: "app.install", parameters: { id: "pi-hole" } }, { operationId: "app.install", parameters: { id: "jellyfin" } }]);
    h.service.startRun(h.caller("owner"), agent.id, { kind: "ask", question: "Can we block ads?" });
    await h.runNext();
    const card = h.service.listProposals(h.caller("owner")).find((entry) => entry.kind === "plan");
    expect(card.steps.map((step) => [step.parameters.id, step.risk, step.approval])).toEqual([
      ["pi-hole", "high", "The owner's password"],
      ["jellyfin", "medium", "One confirmation, with a preview"],
    ]);
    expect(cardMessage({ agentName: "Server Keeper", proposal: card, redact: (text) => text })).toContain("`app.install` (high), `app.install` (medium)");
  });

  it("is never one for an operator when the job layer would stage the step high", async () => {
    h.enable();
    const agent = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.fake.state.script = propose([{ operationId: "app.install", parameters: { id: "wg-easy" } }]);
    h.service.startRun(h.caller("operator"), agent.id, { kind: "ask", question: "Can I reach home from outside?" });
    const run = await h.runNext();
    expect(run.steps.find((step) => step.kind === "proposal")).toMatchObject({ state: "refused", output: expect.stringMatching(/Install application is high risk here/) });
    expect(h.service.listProposals(h.caller("owner")).filter((entry) => entry.kind === "plan")).toEqual([]);
  });
});
