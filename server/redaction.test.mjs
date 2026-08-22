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

describe("shapes this product's own logs and configs actually produce", () => {
  const { redact } = createRedactor({ status: "default", additionalLiterals: [], additionalPathPrefixes: [] });

  it("redacts a credential however it is written", () => {
    // Every one of these was untouched: the rule needed the key bare and the value to stop at a
    // space, and these are BoxPilot's own webdav field, its cloud tokens, restic's unit
    // environment, an rclone config line, an rclone flag, and a webdav URL with credentials in it.
    for (const line of [
      '{"password":"hunter2"}',
      '{"access_token":"ya29.abc","refresh_token":"1//0gXYZ"}',
      "Environment=RESTIC_PASSWORD=hunter2-recovery-passphrase",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI",
      "secret_access_key = wJalrXUtnFEMI",
      "rclone: --sftp-pass 8fj20fj20fj2 --sftp-user backup",
      "https://alice:hunter2@cloud.example.com/dav",
    ]) {
      expect(redact(line), line).toContain("REDACTED");
      expect(redact(line), line).not.toMatch(/hunter2-recovery-passphrase|ya29\.abc|wJalrXUtnFEMI|8fj20fj20fj2/);
    }
  });

  it("redacts a secret field whatever its type, and leaves ordinary fields alone", () => {
    expect(redact({ apiKey: "abcd", key: "K001x", token: 12345678, pin: 1234 })).toEqual({
      apiKey: "[REDACTED_FIELD]", key: "[REDACTED_FIELD]", token: "[REDACTED_FIELD]", pin: 1234,
    });
    // "passed" is a real field in this codebase's own evidence; redacting it would hide whether a
    // restore drill succeeded. A boolean can never be a credential, so booleans are left alone
    // whatever they are called — which is what keeps flags like credentialsIncluded readable.
    expect(redact({ restoreDrill: { passed: true }, passes: 2, credentialsIncluded: false })).toEqual({
      restoreDrill: { passed: true }, passes: 2, credentialsIncluded: false,
    });
    // A session id is a credential, so it goes even though "sessionCount" goes with it.
    expect(redact({ sessionId: "abc", sessionCount: 3 })).toEqual({ sessionId: "[REDACTED_FIELD]", sessionCount: "[REDACTED_FIELD]" });
  });
});
