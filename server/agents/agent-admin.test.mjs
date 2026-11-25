import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";

/*
 * Where an agent's data goes is the owner's to choose (M72), like its leave to carry out operations:
 * an operator could point an agent of their own at Claude, as-is, with the owner's documents, and
 * every operator-gated read its tools made would leave the box unredacted.
 */

let h;
afterEach(async () => { await h?.close(); h = null; });

const forbidden = { status: 403, code: "forbidden", message: expect.stringMatching(/Only the owner chooses where an agent's data goes/) };

describe("an agent's model settings", () => {
  it("are raised only by the owner, on making, editing, rolling back and importing", async () => {
    h = await createAgentsHarness();
    const operator = h.caller("operator");
    const made = h.service.createAgent(operator, { template: "server-keeper" });
    expect(made.spec.model).toMatchObject({ route: "local", dataPolicy: "redacted", claudeReadsDocuments: false, claudeForViewers: false });
    const raises = [{ route: "auto" }, { route: "claude" }, { dataPolicy: "as-is" }, { claudeReadsDocuments: true }, { claudeForViewers: true }];
    for (const raise of raises) {
      const spec = { ...made.spec, model: { ...made.spec.model, ...raise } };
      expect(() => h.service.updateAgent(operator, made.id, { spec }), JSON.stringify(raise)).toThrow(expect.objectContaining(forbidden));
      expect(() => h.service.createAgent(operator, { spec: { ...spec, name: "Another keeper" } }), JSON.stringify(raise)).toThrow(expect.objectContaining(forbidden));
    }
    expect(h.service.getAgent(h.caller("owner"), made.id).spec.model.route).toBe("local");

    // The owner may; an operator then edits something else and the owner's choice stands.
    const owned = h.service.updateAgent(h.caller("owner"), made.id, { spec: { ...made.spec, model: { ...made.spec.model, route: "claude", dataPolicy: "as-is", claudeReadsDocuments: true } } });
    const edited = h.service.updateAgent(operator, made.id, { spec: { ...owned.spec, description: "Keeps the server tidy, every morning" } });
    expect(edited.spec.model).toMatchObject({ route: "claude", dataPolicy: "as-is", claudeReadsDocuments: true });
    // And lowers any of it.
    const lowered = h.service.updateAgent(operator, made.id, { spec: { ...edited.spec, model: { ...edited.spec.model, route: "auto", dataPolicy: "redacted" } } });
    expect(lowered.spec.model).toMatchObject({ route: "auto", dataPolicy: "redacted", claudeReadsDocuments: true });
    // Rolling back to the owner's version raises it again: the owner's to do.
    expect(() => h.service.rollbackAgent(operator, made.id, { version: owned.version })).toThrow(expect.objectContaining(forbidden));

    // A file says nothing a person could not: an operator's import that sends data to Claude is refused.
    const definition = h.service.exportAgent(h.caller("owner"), made.id);
    const imported = { ...definition, spec: { ...definition.spec, name: "Imported keeper", model: { ...definition.spec.model, route: "claude" } } };
    expect(() => h.service.importAgent(operator, { definition: imported })).toThrow(expect.objectContaining(forbidden));
    expect(h.service.importAgent(h.caller("owner"), { definition: imported }).spec.model.route).toBe("claude");
  });

  it("lets an operator keep what BoxPilot gives a new agent once Claude is connected", async () => {
    h = await createAgentsHarness({ serviceOptions: { cloud: { settings: () => ({ connected: true }) } } });
    const operator = h.caller("operator");
    const made = h.service.createAgent(operator, { template: "server-keeper" });
    expect(made.spec.model.route).toBe("auto");
    expect(() => h.service.createAgent(operator, { spec: { ...made.spec, name: "Always Claude", model: { ...made.spec.model, route: "claude" } } })).toThrow(expect.objectContaining(forbidden));
  });
});
