import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeHelperOperation, validateHelperRequest } from "./helper-protocol.mjs";

function request(overrides = {}) {
  return { version: 1, id: randomUUID(), operation: "canary.verify", parameters: {}, ...overrides };
}

describe("restricted helper protocol", () => {
  it("executes the no-mutation canary", async () => {
    const result = await executeHelperOperation(request());
    expect(result).toMatchObject({ ok: true, result: { verified: true, mutationPerformed: false } });
  });

  it("rejects arbitrary operation names and parameters", () => {
    expect(validateHelperRequest(request({ operation: "shell.exec" }))).toBe("Operation is not allowlisted");
    expect(validateHelperRequest(request({ parameters: { command: "id" } }))).toBe("Canary operation accepts no parameters");
  });

  it("rejects incompatible versions and malformed ids", () => {
    expect(validateHelperRequest(request({ version: 99 }))).toBe("Unsupported helper protocol version");
    expect(validateHelperRequest(request({ id: "not-a-uuid" }))).toBe("Request id must be a UUID");
  });
});
