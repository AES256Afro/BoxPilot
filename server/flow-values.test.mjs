import { describe, expect, it } from "vitest";
import { holdsPlaceholder, referencesIn, resolveValues, stepNamePattern } from "./flow-values.mjs";

describe("what counts as a reference", () => {
  it("finds every placeholder, wherever it sits in the parameters", () => {
    expect(referencesIn({
      artifact: "{{ steps.snapshot.artifact }}",
      note: "restored from {{steps.snapshot.artifact}} after {{ steps.check.report.status }}",
      nested: { list: ["{{ steps.snapshot.sizeBytes }}"] },
      plain: "no reference here",
    })).toEqual([
      { step: "snapshot", path: ["artifact"] },
      { step: "snapshot", path: ["artifact"] },
      { step: "check", path: ["report", "status"] },
      { step: "snapshot", path: ["sizeBytes"] },
    ]);
    expect(referencesIn({})).toEqual([]);
  });

  it("does not mistake braces, other roots, or bad names for references", () => {
    expect(referencesIn({ a: "{{ nope.x }}", b: "{ steps.a.b }", c: "{{ steps.Bad.x }}", d: "{{ steps.a }}" })).toEqual([]);
    expect(holdsPlaceholder({ a: "{{ steps.ok.value }}" })).toBe(true);
    expect(holdsPlaceholder({ a: "{{ steps.noPath }}" })).toBe(false);
  });

  it("keeps step names small and boring", () => {
    expect(stepNamePattern.test("snapshot")).toBe(true);
    expect(stepNamePattern.test("step-2")).toBe(true);
    expect(stepNamePattern.test("Snapshot")).toBe(false);
    expect(stepNamePattern.test("2step")).toBe(false);
    expect(stepNamePattern.test("a".repeat(25))).toBe(false);
  });
});

describe("resolving values from earlier results", () => {
  const results = { snapshot: { artifact: "machine-20260827.tar.gz", sizeBytes: 4096, drill: { passed: true } } };

  it("hands a lone placeholder on with its own type, and splices primitives into longer strings", () => {
    expect(resolveValues({ artifact: "{{ steps.snapshot.artifact }}" }, results)).toEqual({ artifact: "machine-20260827.tar.gz" });
    expect(resolveValues({ size: "{{ steps.snapshot.sizeBytes }}" }, results)).toEqual({ size: 4096 });
    expect(resolveValues({ passed: "{{ steps.snapshot.drill.passed }}" }, results)).toEqual({ passed: true });
    expect(resolveValues({ note: "kept {{ steps.snapshot.artifact }} ({{ steps.snapshot.sizeBytes }} bytes)" }, results))
      .toEqual({ note: "kept machine-20260827.tar.gz (4096 bytes)" });
    expect(resolveValues({ deep: { list: ["{{ steps.snapshot.artifact }}", 7] }, untouched: true }, results))
      .toEqual({ deep: { list: ["machine-20260827.tar.gz", 7] }, untouched: true });
  });

  it("says exactly which reference failed and why", () => {
    expect(() => resolveValues({ a: "{{ steps.missing.artifact }}" }, results))
      .toThrow(/reads steps\.missing, and no earlier step with that name has finished/);
    expect(() => resolveValues({ a: "{{ steps.snapshot.nothing }}" }, results))
      .toThrow(/steps\.snapshot\.nothing, which that step's recorded result does not contain/);
    expect(() => resolveValues({ a: "inside {{ steps.snapshot.drill }} a string" }, results))
      .toThrow(/whole object/);
  });

  it("cannot be walked out of the results it was handed", () => {
    // The reader's security surface: no prototype chain, no inherited properties, no eval of any kind.
    expect(() => resolveValues({ a: "{{ steps.snapshot.constructor.name }}" }, results)).toThrow(/not a readable path/);
    expect(() => resolveValues({ a: "{{ steps.snapshot.__proto__.polluted }}" }, results)).toThrow(/not a readable path/);
    expect(() => resolveValues({ a: "{{ steps.snapshot.artifact.length }}" }, results)).toThrow(/does not contain/);
    expect(() => resolveValues({ a: "{{ steps.snapshot.drill.toString }}" }, results)).toThrow(/does not contain/);
  });
});
