// @vitest-environment node
/**
 * Findings by meaning (M47.3, M44's "Next"): a finding whose words share nothing with the request
 * is still offered once the runner has embedded the request and the memory index has embedded the
 * finding; it goes in as the next F, beside the ones words found, with the trace saying it was
 * matched by meaning; it is never offered twice, never past the places left, never to an agent
 * that does not use findings, and never when the person asked for a fresh check.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { serviceLimits } from "./service.mjs";

let h;
beforeEach(async () => { h = await createAgentsHarness(); h.enable(); });
afterEach(async () => { await h?.close(); h = null; });

const fresh = () => new Date(h.now().getTime() + 6 * 3_600_000).toISOString();
const findingSteps = (runId) => h.service.getRun(h.caller("owner"), runId).steps.filter((step) => step.kind === "finding");
const actPrompt = () => h.fake.prompts().find((body) => Array.isArray(body.tools) && body.tools.length && !body.response_format);

describe("findings by meaning", () => {
  it("offers a finding words did not find, once the index embedded it, and the trace says by meaning", async () => {
    const scout = h.service.createAgent(h.caller("owner"), { template: "environment-scout" });
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    // The Scout's finding shares no word with the question below.
    h.store.writeFinding(scout.id, { kind: "routine", title: "Survey this server", body: "The backup drive sdb is failing its SMART checks and holds Jellyfin's media [T2].", readRole: "owner", freshUntil: fresh(), source: { agentId: scout.id, runKind: "schedule" } });
    // Before the index ran, nothing is near by meaning: only words apply, and they find nothing.
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Is my storage in trouble?" });
    const before = await h.runNext();
    expect(findingSteps(before.id)).toEqual([]);
    // The memory index embeds the finding (a note) and the Keeper's examples.
    h.service.reindexMemory(h.caller("owner"));
    expect((await h.runNext()).kind).toBe("index");
    h.fake.reset();
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Is my storage in trouble?" });
    const run = await h.runNext();
    expect(run.state).toBe("completed");
    const steps = findingSteps(run.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ name: "Environment Scout", flags: { finding: "F1" }, input: { id: "F1", by: "meaning" } });
    // In the prompt the calls that act read, boxed as F1, and said so in the trace.
    expect(JSON.stringify(actPrompt().messages)).toMatch(/sdb is failing/);
    expect(h.service.getRun(h.caller("owner"), run.id).steps.some((step) => step.kind === "system" && step.name === "findings" && /offered by meaning: F1/.test(String(step.flags?.detail)))).toBe(true);
  });

  it("asks for none when the agent does not use findings, the person wants a fresh check, or the places are full", async () => {
    const scout = h.service.createAgent(h.caller("owner"), { template: "environment-scout" });
    h.store.writeFinding(scout.id, { kind: "routine", title: "Survey this server", body: "The backup drive sdb is failing [T2].", readRole: "owner", freshUntil: fresh(), source: { agentId: scout.id, runKind: "schedule" } });
    h.service.reindexMemory(h.caller("owner"));
    await h.runNext();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    // A fresh check asked for: nothing by words, nothing by meaning.
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Check now: is my storage in trouble?" });
    expect(findingSteps((await h.runNext()).id)).toEqual([]);
    // An agent that uses no findings.
    const spec = h.store.getAgent(keeper.id).spec;
    h.service.updateAgent(h.caller("owner"), keeper.id, { spec: { ...spec, sharing: { ...spec.sharing, useFindings: false } } });
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Is my storage in trouble?" });
    expect(findingSteps((await h.runNext()).id)).toEqual([]);
    // Directly: the places left, and a vector that is none.
    const run = h.store.listRuns({ agentId: keeper.id, limit: 1 })[0];
    expect(() => h.service.runnerFindings(run.id, "not-a-lease", { vector: [1, 0, 0, 0, 0, 0, 0, 0] })).toThrow();
    expect(serviceLimits.findingsMinCosine).toBe(0.55);
  });
});
