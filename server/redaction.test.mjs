import { describe, expect, it, vi } from "vitest";
import { createRedactor, loadRedactionPolicy, parseRedactionConfig } from "./redaction.mjs";

describe("support-bundle redaction policy", () => {
  it("loads only bounded literals and path prefixes without exposing configured values", async () => {
    const policy = await loadRedactionPolicy({ inspect: vi.fn(async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 128, mode: 0o100640 })), read: vi.fn(async () => JSON.stringify({ additionalLiterals: ["private-owner"], additionalPathPrefixes: ["/srv/private"] })) });
    const redactor = createRedactor(policy);
    expect(redactor.metadata()).toMatchObject({ status: "loaded", additionalLiteralCount: 1, additionalPathPrefixCount: 1, configuredValuesIncluded: false });
    const output = redactor.redact({ message: "private-owner used /srv/private/app? token=abc", password: "secret", url: "https://example.test/path?token=abc" });
    expect(output).toEqual({ message: "[REDACTED_LITERAL] used [REDACTED_PATH]/app? token=[REDACTED]", password: "[REDACTED_FIELD]", url: "https://example.test/path?[query-redacted]" });
  });

  it("rejects arbitrary keys, regex syntax, oversized lists, and alternate config paths", async () => {
    expect(parseRedactionConfig('{"patterns":[".*"]}').status).toBe("invalid");
    expect(parseRedactionConfig(JSON.stringify({ additionalPathPrefixes: ["/srv/*"] })).status).toBe("invalid");
    expect(parseRedactionConfig(JSON.stringify({ additionalLiterals: Array.from({ length: 33 }, (_, index) => `item-${index}`) })).status).toBe("invalid");
    expect((await loadRedactionPolicy({ configPath: "/tmp/operator-selected.json", read: vi.fn() })).status).toBe("invalid-path");
    expect((await loadRedactionPolicy({ inspect: vi.fn(async () => ({ isFile: () => true, isSymbolicLink: () => true, size: 128, mode: 0o100640 })), read: vi.fn() })).status).toBe("invalid-file");
  });

  it("redacts bearer values, private keys, secret assignments, cycles, and depth", () => {
    const redactor = createRedactor();
    const cyclic = { message: "Authorization: Bearer abc.def", key: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" };
    cyclic.self = cyclic;
    const output = redactor.redact(cyclic);
    expect(output.message).not.toContain("abc.def");
    expect(output.key).not.toContain("secret");
    expect(output.self).toBe("[REDACTED_CYCLE]");
  });
});
