import { describe, expect, it, vi } from "vitest";
import { OperationRegistry, createRegistry, defineOperation, validateParameters } from "./registry.mjs";
import { registry } from "./index.mjs";
import { helperOperations, legacyHelperOperations, validateHelperRequest } from "../helper-protocol.mjs";

describe("operation registry", () => {
  it("rejects malformed definitions", () => {
    expect(() => defineOperation({ id: "Bad Id", title: "x", risk: "low", run() {} })).toThrow("lower-case");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "extreme", run() {} })).toThrow("risk");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "medium", readOnly: true, run() {} })).toThrow("read-only and must be low");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "low" })).toThrow("run(");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "low", timeoutMs: 0, run() {} })).toThrow("timeoutMs");
  });

  it("validates parameters against a declarative spec", () => {
    const spec = { fields: { name: { type: "string", pattern: /^[a-z]+$/ }, count: { type: "number", optional: true }, note: { type: "string", nullable: true, optional: true } } };
    expect(validateParameters(spec, { name: "abc" })).toBeNull();
    expect(validateParameters(spec, { name: "abc", count: 2, note: null })).toBeNull();
    expect(validateParameters(spec, { name: "ABC" })).toContain("invalid value");
    expect(validateParameters(spec, { name: "abc", extra: true })).toContain('does not accept parameter "extra"');
    expect(validateParameters(spec, {})).toContain('requires parameter "name"');
    expect(validateParameters(spec, { name: "abc", count: "2" })).toContain("must be a number");
    expect(validateParameters(spec, { name: "abc", count: Number.NaN })).toContain("finite");
    expect(validateParameters({ fields: {} }, { anything: 1 })).toContain("accepts no parameters");
    expect(validateParameters({ fields: {} }, [])).toContain("must be an object");
    expect(validateParameters({ fields: { v: { validate: (value) => (value === "bad" ? "is bad" : null) } } }, { v: "bad" })).toContain("is bad");
  });

  it("registers, lists, validates, and executes operations with injected dependencies", async () => {
    const run = vi.fn(async (parameters, { helper }) => helper.do(parameters.name));
    const instance = new OperationRegistry();
    instance.register({ id: "demo.run", title: "Demo", risk: "medium", timeoutMs: 5000, parameters: { fields: { name: { type: "string" } } }, run });
    instance.register({ id: "demo.inspect", title: "Demo inspect", risk: "low", readOnly: true, run: async () => ({ ok: true }) });
    expect(() => instance.register({ id: "demo.run", title: "Dup", risk: "low", run() {} })).toThrow("already registered");
    expect(instance.ids()).toEqual(["demo.run", "demo.inspect"]);
    expect(instance.readOnlyIds()).toEqual(["demo.inspect"]);
    expect(instance.timeoutFor("demo.run")).toBe(5000);
    expect(instance.timeoutFor("missing")).toBeNull();
    expect(instance.validate("demo.run", { name: 1 })).toContain("must be a string");
    expect(instance.validate("missing", {})).toBe("Operation is not registered");
    await expect(instance.execute("demo.run", { name: "x" }, { helper: { do: async (name) => `did ${name}` } })).resolves.toBe("did x");
    await expect(instance.execute("demo.run", {}, {})).rejects.toThrow("requires parameter");
    await expect(instance.execute("missing", {}, {})).rejects.toThrow("not registered");
    expect(instance.describe()).toEqual([
      { id: "demo.run", title: "Demo", description: "", risk: "medium", readOnly: false, elevatedOnly: false, timeoutMs: 5000, parameterNames: ["name"] },
      { id: "demo.inspect", title: "Demo inspect", description: "", risk: "low", readOnly: true, elevatedOnly: false, timeoutMs: 180000, parameterNames: [] },
    ]);
    expect(createRegistry([() => [defineOperation({ id: "x.y", title: "x", risk: "low", run() {} })]]).ids()).toEqual(["x.y"]);
  });
});

describe("default registry and legacy allowlists stay consistent", () => {
  it("declares every operation in exactly one place", () => {
    for (const id of registry.ids()) expect(legacyHelperOperations.has(id), `${id} is declared both in the registry and the legacy allowlist`).toBe(false);
    for (const id of registry.ids()) expect(helperOperations.has(id)).toBe(true);
    for (const id of legacyHelperOperations) expect(helperOperations.has(id)).toBe(true);
    expect(helperOperations.size).toBe(registry.ids().length + legacyHelperOperations.size);
  });

  it("routes registered operations through the registry validator", () => {
    const request = (operation, parameters) => ({ version: 1, id: "11111111-2222-4333-8444-555555555555", operation, parameters });
    expect(validateHelperRequest(request("canary.verify", {}))).toBeNull();
    expect(validateHelperRequest(request("prerequisite.docker.install", { expectedVersion: "28.2.2-0ubuntu1" }))).toBeNull();
    expect(validateHelperRequest(request("prerequisite.docker.install", { expectedVersion: "28.2.2-0ubuntu1", extra: 1 }))).toContain("does not accept");
    expect(validateHelperRequest(request("nope.nothing", {}))).toBe("Operation is not allowlisted");
  });

  it("gives every registered operation a title, a risk tier, and a sane timeout", () => {
    for (const operation of registry.list()) {
      expect(operation.title.length).toBeGreaterThan(2);
      expect(["low", "medium", "high"]).toContain(operation.risk);
      expect(operation.timeoutMs).toBeGreaterThanOrEqual(1000);
      expect(operation.timeoutMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      if (operation.readOnly) expect(operation.risk).toBe("low");
    }
  });
});

describe("what the approval dialog has to show", () => {
  it("gives a description for every operation that asks to be approved", async () => {
    // A read-only operation answers straight away; anything else stages a job and the owner is
    // shown a dialog with the title, the risk, and this. Five medium-risk operations reached that
    // dialog with nothing under the title at all, including one that deletes a backup.
    const { operationModules } = await import("./index.mjs");
    const bare = operationModules.flatMap((build) => build())
      .filter((operation) => !operation.readOnly && !operation.description)
      .map((operation) => `${operation.id} (${operation.risk})`);
    expect(bare, "these ask the owner to approve something the dialog cannot explain").toEqual([]);
  });

  it("describes what happens, not what the product will not do", async () => {
    // ADR-001: say what the action does. The boundary language the old control plane used had a
    // habit of coming back through descriptions.
    const { operationModules } = await import("./index.mjs");
    const retired = /\b(safety-first|control plane|sanitized|durable lifecycle|guarded (creation|retention|offline|VM))\b/i;
    const offenders = operationModules.flatMap((build) => build())
      .filter((operation) => retired.test(operation.description ?? ""))
      .map((operation) => operation.id);
    expect(offenders).toEqual([]);
  });
});
