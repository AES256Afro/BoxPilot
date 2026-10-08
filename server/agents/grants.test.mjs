// @vitest-environment node
import { describe, expect, it } from "vitest";
import { registry } from "../ops/index.mjs";
import { grantNow, grantProblem } from "./grants.mjs";
import { exportDefinition, readDefinition } from "./portable.mjs";
import { normalizeSpec } from "./spec.mjs";

/*
 * What an agent may do itself (M45.5, ADR-013): which operations may have which grant, the fences
 * no grant opens, and the grant as it stands for one job.
 */

const operation = (changes = {}) => ({ id: "x.do", title: "Do it", risk: "low", readOnly: false, internal: false, elevatedOnly: false, parameters: { fields: {} }, confirm: null, confirmWhen: null, oneTimeFields: [], ...changes });

describe("which operations may have a grant", () => {
  it("lets anything be proposed, and a low risk operation run", () => {
    expect(grantProblem(undefined, "propose")).toBeNull();
    expect(grantProblem(operation(), "run")).toBeNull();
    expect(grantProblem(operation(), "ask")).toBeNull();
  });

  it("lets a medium risk operation be asked for, never run", () => {
    expect(grantProblem(operation({ risk: "medium" }), "ask")).toBeNull();
    expect(grantProblem(operation({ risk: "medium" }), "run")).toMatch(/only low risk runs without a person/);
  });

  it("keeps high risk a card, whatever the grant", () => {
    expect(grantProblem(operation({ risk: "high" }), "ask")).toMatch(/always a card/);
    expect(grantProblem(operation({ risk: "high" }), "run")).toMatch(/always a card/);
  });

  it("grants nothing BoxPilot runs itself, a read, one that reveals or takes a secret, or no operation at all", () => {
    expect(grantProblem(operation({ internal: true }), "ask")).toMatch(/plumbing/);
    expect(grantProblem(operation({ readOnly: true }), "ask")).toMatch(/only reads/);
    expect(grantProblem(operation({ elevatedOnly: true }), "ask")).toMatch(/reveals secrets/);
    expect(grantProblem(operation({ parameters: { fields: { token: { type: "string", secret: true } } } }), "ask")).toMatch(/takes a secret/);
    expect(grantProblem(operation({ oneTimeFields: ["code"] }), "ask")).toMatch(/takes a secret/);
    expect(grantProblem(undefined, "ask")).toMatch(/no such operation/);
    expect(grantProblem(registry.get("agents.runtime.disable"), "run")).toMatch(/changes how agents run/);
    expect(grantProblem(registry.get("agents.cloud.cap"), "ask")).toMatch(/changes how agents run/);
    expect(grantProblem(operation(), "always")).toMatch(/one of propose, ask, run/);
  });

  it("asks a person for one that wants typed confirmation", () => {
    expect(grantProblem(operation({ confirm: () => "yes" }), "run")).toMatch(/typed confirmation/);
    expect(grantProblem(operation({ confirm: () => "yes" }), "ask")).toBeNull();
  });

  it("holds the registry's own operations to the same rules", () => {
    for (const entry of registry.list()) {
      if (entry.risk === "high" || entry.internal || entry.readOnly) expect(grantProblem(entry, "ask"), entry.id).not.toBeNull();
    }
    const low = registry.list().find((entry) => entry.risk === "low" && !entry.readOnly && !entry.internal && !entry.elevatedOnly && !entry.confirm && !Object.values(entry.parameters?.fields ?? {}).some((field) => field.secret));
    expect(grantProblem(low, "run"), low?.id).toBeNull();
  });
});

describe("the grant as it stands for one job", () => {
  it("runs a low risk job under a run grant", () => {
    expect(grantNow("run", { risk: "low" })).toBe("run");
    expect(grantNow("ask", { risk: "low" })).toBe("ask");
  });

  it("asks a person when what it acts on raises the tier, it wants confirmation, or the owner always wants a password", () => {
    expect(grantNow("run", { risk: "medium" })).toBe("ask");
    expect(grantNow("run", { risk: "low", confirms: true })).toBe("ask");
    expect(grantNow("run", { risk: "low", mode: "always-password" })).toBe("ask");
  });

  it("makes a high risk job a card, and an unknown grant a card", () => {
    expect(grantNow("run", { risk: "high" })).toBe("propose");
    expect(grantNow("ask", { risk: "high" })).toBe("propose");
    expect(grantNow("whatever", { risk: "low" })).toBe("propose");
  });
});

describe("grants in an agent's definition", () => {
  const base = { name: "Keeper", job: "Keep the server well.", successCriteria: ["Says what it changed."], triggers: { ask: true } };

  it("keeps Ask and Run, drops Propose, and is absent when there are none", () => {
    expect(normalizeSpec({ ...base, allow: { grants: { "apt.refresh": "run", "app.restart": "ask", "app.update": "propose" } } }).allow.grants).toEqual({ "app.restart": "ask", "apt.refresh": "run" });
    expect(normalizeSpec(base).allow.grants).toBeUndefined();
  });

  it("turns the acting tool on with grants and off without, and never carries them in a file", () => {
    const granted = normalizeSpec({ ...base, allow: { grants: { "app.action": "run" } } });
    expect(granted.tools["operations.run"]).toBe("auto");
    expect(normalizeSpec({ ...base, tools: { "operations.run": "ask" }, allow: { grants: { "app.action": "run" } } }).tools["operations.run"]).toBe("ask");
    expect(normalizeSpec({ ...base, tools: { "operations.run": "auto" } }).tools["operations.run"]).toBe("off");
    const file = exportDefinition({ spec: granted, template: null });
    expect(file.spec.allow.grants).toBeUndefined();
    const imported = readDefinition({ ...file, spec: { ...file.spec, allow: { ...file.spec.allow, grants: { "app.action": "run" } } } });
    expect(imported.spec.allow.grants).toBeUndefined();
    expect(imported.spec.tools["operations.run"]).toBe("off");
  });

  it("refuses a grant for an operation off its list, an unknown level, or a malformed id", () => {
    expect(() => normalizeSpec({ ...base, allow: { operations: ["app.restart"], grants: { "apt.refresh": "run" } } })).toThrow(/not on its list/);
    expect(() => normalizeSpec({ ...base, allow: { grants: { "apt.refresh": "always" } } })).toThrow(/one of propose, ask, run/);
    expect(() => normalizeSpec({ ...base, allow: { grants: { "Not An Id": "run" } } })).toThrow(/not an operation id/);
  });
});
