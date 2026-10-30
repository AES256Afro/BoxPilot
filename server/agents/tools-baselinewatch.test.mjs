// @vitest-environment node
/**
 * The agents' eyes on BaselineWatch (M51.1): baselinewatch.digest hands a run the latest digest the
 * app wrote, through the same reader Today's card uses, held to the agent's app allowlist; open to
 * a viewer's run, since the app's own reading is open on this network; and the Server Keeper reads
 * it for its morning digest.
 */
import { describe, expect, it } from "vitest";
import { registry } from "../ops/index.mjs";
import { templateById } from "./templates.mjs";
import { toModelTool, toolAllowed, toolById, toolIdOf, toolsForQuestion } from "./tool-catalog.mjs";
import { createToolRunner } from "./tools.mjs";

const digest = "BaselineWatch's daily digest, written 2026-10-15T00:45:36.729Z.\n\nKnown exploited (CISA KEV): 15 added\n- Palo Alto Networks PAN-OS: Code Injection Vulnerability (due 2026-10-17)";
const appGlances = { digest: async (id) => (id === "baselinewatch" ? digest : `${id} has no reader`), has: (id) => id === "baselinewatch", list: async () => ({ glances: [], liveKnown: true }) };
const runner = createToolRunner({ state: {}, store: { listDocuments: () => [] }, registry, appGlances });
const context = (overrides = {}) => ({ spec: {}, readRole: "viewer", readAs: "person-1", ...overrides });

describe("baselinewatch.digest", () => {
  it("hands a run the digest, for a viewer too", async () => {
    expect(await runner.run("baselinewatch.digest", {}, context())).toBe(digest);
    expect(await runner.run("baselinewatch.digest", {}, context({ readRole: "owner" }))).toBe(digest);
  });

  it("is held to the agent's app allowlist, and says when there is no reader here", async () => {
    await expect(runner.run("baselinewatch.digest", {}, context({ spec: { allow: { apps: ["pi-hole"] } } }))).rejects.toThrow(/may not look at BaselineWatch/);
    expect(await runner.run("baselinewatch.digest", {}, context({ spec: { allow: { apps: ["baselinewatch"] } } }))).toBe(digest);
    const without = createToolRunner({ state: {}, store: { listDocuments: () => [] }, registry });
    await expect(without.run("baselinewatch.digest", {}, context())).rejects.toThrow(/cannot be read here/);
  });

  it("is an app read a viewer may use on any run, named as the model calls it, with no parameters", () => {
    const tool = toolById("baselinewatch.digest");
    expect(tool).toMatchObject({ category: "app", role: "viewer", cost: "moderate", fn: "baselinewatch_digest", params: {} });
    expect(toolIdOf("baselinewatch_digest")).toBe("baselinewatch.digest");
    expect(toolAllowed(tool, "auto", { kind: "schedule", readRole: "viewer" })).toBe(true);
    expect(toModelTool(tool).function.parameters).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
  });

  it("is what a question about CVEs, KEV, security news or a standard points at", () => {
    const offered = ["server.facts", "apps.list", "baselinewatch.digest"];
    for (const question of ["Which CVEs were added to KEV today?", "Any security news this morning?", "Did NIST 800-53 change?", "What does BaselineWatch say?"]) {
      expect(toolsForQuestion(question, offered), question).toContain("baselinewatch.digest");
    }
    expect(toolsForQuestion("Which apps are stopped?", offered)).not.toContain("baselinewatch.digest");
  });

  it("is read by the Server Keeper for its morning digest", () => {
    const { spec } = templateById("server-keeper");
    expect(spec.tools["baselinewatch.digest"]).toBe("auto");
    expect(spec.prompt.steps.some((step) => step.includes("baselinewatch.digest"))).toBe(true);
  });
});
