// @vitest-environment node
import { describe, expect, it } from "vitest";
import { strictSchema } from "../src/index.mjs";

/*
 * Schemas for strict decoding (M45.2): rewritten where the meaning stays the same, refused where
 * strict decoding would change what they allow.
 */

describe("strictSchema", () => {
  it("turns a list of types into anyOf, and gives an enum its type", () => {
    expect(strictSchema({ type: ["string", "null"] })).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(strictSchema({ enum: ["a", "b"] })).toEqual({ type: "string", enum: ["a", "b"] });
    expect(strictSchema({ enum: ["a", null] })).toEqual({ anyOf: [{ type: "string", enum: ["a"] }, { type: "null" }] });
    expect(strictSchema({ const: "x" })).toEqual({ const: "x" });
  });

  it("moves the limits strict decoding cannot hold into the description, keeping what it can", () => {
    expect(strictSchema({ type: "string", description: "A name", minLength: 3, maxLength: 80, format: "hostname" })).toEqual({ type: "string", description: "A name\n\n{minLength: 3, maxLength: 80}", format: "hostname" });
    expect(strictSchema({ type: "array", minItems: 1, maxItems: 5, items: { type: "integer", minimum: 0 } })).toEqual({ type: "array", minItems: 1, description: "{maxItems: 5}", items: { type: "integer", description: "{minimum: 0}" } });
  });

  it("refuses an object left open or a value with no type, and never changes what it was given", () => {
    const open = { type: "object", properties: { step: { type: "object" } }, additionalProperties: false };
    expect(strictSchema(open)).toBeNull();
    expect(strictSchema({ type: "object", properties: {} })).toBeNull();
    expect(strictSchema({ type: "array", items: {} })).toBeNull();
    const given = { type: "object", additionalProperties: false, properties: { a: { type: ["string", "null"], maxLength: 3 } } };
    const copy = structuredClone(given);
    strictSchema(given);
    expect(given).toEqual(copy);
  });
});
