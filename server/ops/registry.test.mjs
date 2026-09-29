import { describe, expect, it, vi } from "vitest";
import { OperationRegistry, budgetFor, createRegistry, defineOperation, maskSecrets, moreTimeCeilingMs, nextBudgetMs, placeholderPaths, rerunsAfterInterrupt, restoreSecrets, secretPaths, secretPlaceholder, splitSecrets, validateParameters } from "./registry.mjs";
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

describe("where the secrets are (M29.1)", () => {
  const operation = defineOperation({
    id: "demo.set", title: "Demo", risk: "medium", run() {},
    parameters: { fields: { id: { type: "string" }, password: { type: "string", optional: true, nullable: true, secret: true }, values: { type: "object", optional: true, secretEnvOf: "id" }, note: { type: "string", optional: true } } },
  });
  const lookup = async (id) => (id === "known" ? ["TOKEN", "PIN"] : null);

  it("finds top-level secrets and an app's own, and nothing that holds no value", async () => {
    const parameters = { id: "known", password: "pw", note: "not secret", values: { env: { TOKEN: "tok", PIN: 1234, TZ: "UTC" }, ports: { web: 8080 } } };
    expect(await secretPaths(operation, parameters, { secretEnvNamesFor: lookup })).toEqual([["password"], ["values", "env", "TOKEN"], ["values", "env", "PIN"]]);
    expect(await secretPaths(operation, { id: "known", password: "", values: { env: { TOKEN: null, PIN: "" } } }, { secretEnvNamesFor: lookup })).toEqual([]);
    expect(await secretPaths(operation, { id: "known", password: null }, { secretEnvNamesFor: lookup })).toEqual([]);
  });

  it("counts every app setting when the catalog cannot say which is the secret", async () => {
    const values = { env: { TOKEN: "tok", TZ: "UTC" } };
    const expected = [["values", "env", "TOKEN"], ["values", "env", "TZ"]];
    expect(await secretPaths(operation, { id: "unknown", values }, { secretEnvNamesFor: lookup })).toEqual(expected);
    expect(await secretPaths(operation, { id: "{{ steps.pick.id }}", values }, { secretEnvNamesFor: lookup })).toEqual(expected);
    expect(await secretPaths(operation, { id: "known", values })).toEqual(expected);   // nobody to ask
  });

  it("masks, splits and restores along those paths without touching the caller's object", async () => {
    const parameters = { id: "known", password: "pw", values: { env: { TOKEN: "tok", TZ: "UTC" }, ports: { web: 8080 } } };
    const paths = await secretPaths(operation, parameters, { secretEnvNamesFor: lookup });
    const { stored, secrets } = splitSecrets(parameters, paths);
    expect(stored).toEqual({ id: "known", password: secretPlaceholder, values: { env: { TOKEN: secretPlaceholder, TZ: "UTC" }, ports: { web: 8080 } } });
    expect(maskSecrets(parameters, paths)).toEqual(stored);
    expect(parameters.values.env.TOKEN).toBe("tok");
    expect(placeholderPaths(stored)).toEqual([["password"], ["values", "env", "TOKEN"]]);
    const restored = restoreSecrets(JSON.parse(JSON.stringify(stored)), secrets);
    expect(restored).toEqual(parameters);
    expect(placeholderPaths(restored)).toEqual([]);
    // With the staged copy gone the placeholder stays, and placeholderPaths is what refuses to run it.
    expect(placeholderPaths(restoreSecrets(stored, []))).toHaveLength(2);
  });

  it("keeps a key spelled __proto__ a key when it writes one", async () => {
    const parameters = JSON.parse('{ "id": "unknown", "values": { "env": { "__proto__": "tok" } } }');
    const paths = await secretPaths(operation, parameters, { secretEnvNamesFor: lookup });
    const { stored } = splitSecrets(parameters, paths);
    expect(Object.hasOwn(stored.values.env, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(stored.values.env)).toBe(Object.prototype);
    expect(JSON.stringify(stored)).not.toContain("tok");
  });

  it("refuses a secretEnvOf that names no parameter or sits on the wrong kind of field", () => {
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "low", run() {}, parameters: { fields: { values: { type: "object", secretEnvOf: "id" } } } })).toThrow("not a parameter");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "low", run() {}, parameters: { fields: { id: { type: "string" }, values: { type: "string", secretEnvOf: "id" } } } })).toThrow("object field");
  });

  it("declares the app install values of the real registry as holding the app's own secrets", () => {
    for (const id of ["app.install", "app.reconfigure"]) expect(registry.get(id).parameters.fields.values.secretEnvOf).toBe("id");
  });
});

describe("more time for an operation that ran out of it (M30.3)", () => {
  const pull = defineOperation({ id: "demo.pull", title: "Pull", risk: "medium", timeoutMs: 25 * 60_000, maxTimeoutMs: 100 * 60_000, run() {} });
  const plain = defineOperation({ id: "demo.plain", title: "Plain", risk: "medium", timeoutMs: 25 * 60_000, run() {} });

  it("doubles the budget that ran out, up to the declared maximum, and then stops offering", () => {
    expect(nextBudgetMs(pull)).toBe(50 * 60_000);
    expect(nextBudgetMs(pull, 50 * 60_000)).toBe(100 * 60_000);
    expect(nextBudgetMs(pull, 80 * 60_000)).toBe(100 * 60_000);
    expect(nextBudgetMs(pull, 100 * 60_000)).toBeNull();
    expect(nextBudgetMs(plain)).toBeNull();
  });

  it("only lets a budget between the normal one and the maximum count", () => {
    expect(budgetFor(pull, 50 * 60_000)).toBe(50 * 60_000);
    expect(budgetFor(pull, 101 * 60_000)).toBe(25 * 60_000); // past the maximum: normal
    expect(budgetFor(pull, 60_000)).toBe(25 * 60_000); // shorter than normal: normal
    expect(budgetFor(pull, "3000000")).toBe(25 * 60_000);
    expect(budgetFor(plain, 50 * 60_000)).toBe(25 * 60_000); // offers no more time at all
  });

  it("refuses a maximum that is not above the budget, or past the ceiling, or on a read", () => {
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "medium", timeoutMs: 1000, maxTimeoutMs: 1000, run() {} })).toThrow("maxTimeoutMs");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "medium", timeoutMs: 1000, maxTimeoutMs: moreTimeCeilingMs + 1, run() {} })).toThrow("maxTimeoutMs");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "low", readOnly: true, timeoutMs: 1000, maxTimeoutMs: 2000, run() {} })).toThrow("only a job");
  });

  it("is offered by the pulls and nothing else, each at most four times its budget", () => {
    const offered = registry.list().filter((operation) => operation.maxTimeoutMs).map((operation) => operation.id).sort();
    expect(offered).toEqual(["app.install", "app.model.pull", "app.reinstall", "app.rollback", "app.update"]);
    for (const id of offered) expect(registry.get(id).maxTimeoutMs).toBe(registry.get(id).timeoutMs * 4);
  });
});

describe("running an interrupted job again (M30.2)", () => {
  it("is declared, and cannot be declared where a second run is not safe", () => {
    expect(rerunsAfterInterrupt(defineOperation({ id: "a.read", title: "x", risk: "low", readOnly: true, run() {} }))).toBe(true);
    expect(rerunsAfterInterrupt(defineOperation({ id: "a.change", title: "x", risk: "medium", run() {} }))).toBe(false);
    expect(rerunsAfterInterrupt(defineOperation({ id: "a.sync", title: "x", risk: "medium", rerunAfterInterrupt: true, run() {} }))).toBe(true);
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "high", rerunAfterInterrupt: true, run() {} })).toThrow("high risk");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "medium", confirm: () => "yes", rerunAfterInterrupt: true, run() {} })).toThrow("typed confirmation");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "medium", restartsService: true, rerunAfterInterrupt: true, run() {} })).toThrow("restarts BoxPilot");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "medium", rerunAfterInterrupt: true, parameters: { fields: { password: { type: "string", secret: true } } }, run() {} })).toThrow("secrets");
    expect(() => defineOperation({ id: "a.b", title: "x", risk: "medium", rerunAfterInterrupt: true, parameters: { fields: { id: { type: "string" }, values: { type: "object", secretEnvOf: "id" } } }, run() {} })).toThrow("secrets");
  });

  it("is declared by exactly the operations whose entries say why", () => {
    // Adding one here means writing down, on its registry entry, why a second run is harmless.
    expect(registry.list().filter((operation) => operation.rerunAfterInterrupt).map((operation) => operation.id).sort()).toEqual(["backup.sync", "dns.names.apply", "homepage.sync"]);
  });
});
