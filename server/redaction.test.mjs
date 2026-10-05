import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRedactor, loadRedactionPolicy, parseRedactionConfig, redactPrivateKeys } from "./redaction.mjs";

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

/**
 * An obviously fake key, made here from random bytes in a key's shape: never a real one. Each body
 * line starts FAKE and its number, so a line that survives redaction is easy to name.
 */
function fakeKey(label = "PRIVATE KEY", lines = 25) {
  const body = Array.from({ length: lines }, (_, index) => `FAKE${String(index).padStart(2, "0")}${randomBytes(48).toString("base64")}`.slice(0, 64));
  return { text: `-----BEGIN ${label}-----\n${body.join("\n")}\n-----END ${label}-----`, body };
}
const survivors = (output, body) => body.filter((line) => output.includes(line) || output.includes(line.slice(6, 40)));

describe("private keys (sweep 3)", () => {
  const { redact } = createRedactor();

  it("redacts every kind of private key header, and leaves certificates and public keys alone", () => {
    for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "DSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
      const key = fakeKey(label, 8);
      const output = redact(`before the key\n${key.text}\nafter the key`);
      expect(survivors(output, key.body), label).toEqual([]);
      expect(output, label).toBe("before the key\n[REDACTED_PRIVATE_KEY]\nafter the key");
    }
    const certificate = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUFAKE\n-----END CERTIFICATE-----\n-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIFAKE\n-----END PUBLIC KEY-----";
    expect(redact(certificate)).toBe(certificate);
  });

  it("redacts a key cut off before its END, from BEGIN to the end of the text", () => {
    const key = fakeKey("OPENSSH PRIVATE KEY", 20);
    const clipped = `ssh-keygen wrote:\n${key.text.slice(0, key.text.indexOf(key.body[12]) + 20)}…`;
    const output = redact(clipped);
    expect(survivors(output, key.body)).toEqual([]);
    expect(output).toBe("ssh-keygen wrote:\n[REDACTED_PRIVATE_KEY]");
  });

  it("redacts a key whose BEGIN was cut off the front, from the start of the text to its END", () => {
    const key = fakeKey("RSA PRIVATE KEY", 20);
    const tail = `${key.text.slice(key.text.indexOf(key.body[7]))}\nOct 05 12:00:01 app[42]: started`;
    const output = redact(tail);
    expect(survivors(output, key.body)).toEqual([]);
    expect(output).toBe("[REDACTED_PRIVATE_KEY]\nOct 05 12:00:01 app[42]: started");
  });

  it("redacts several keys and keeps the text between them", () => {
    const first = fakeKey("EC PRIVATE KEY", 4);
    const second = fakeKey("PRIVATE KEY", 4);
    expect(redactPrivateKeys(`a\n${first.text}\nb\n${second.text}\nc`)).toBe("a\n[REDACTED_PRIVATE_KEY]\nb\n[REDACTED_PRIVATE_KEY]\nc");
    expect(redactPrivateKeys("no keys here")).toBe("no keys here");
  });

  it("takes linear time over many unmatched markers", () => {
    const many = `${"-----END PRIVATE KEY----- x\n".repeat(20_000)}-----BEGIN PRIVATE KEY-----`;
    const started = performance.now();
    expect(redactPrivateKeys(many)).toBe("[REDACTED_PRIVATE_KEY] x\n[REDACTED_PRIVATE_KEY]");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("HTTP Basic credentials (sweep 3)", () => {
  const { redact } = createRedactor();
  // The Zulip bot's key travels as Basic auth, email:key in base64. A fake one, made here.
  const encoded = Buffer.from(`agents-bot@zulip.example.test:FAKE${randomBytes(16).toString("hex")}`).toString("base64");
  const short = Buffer.from("a:b").toString("base64");

  it("redacts the credential after Basic, however the header is written", () => {
    for (const line of [
      `Authorization: Basic ${encoded}`,
      `authorization: basic ${encoded}`,
      `Authorization=Basic ${encoded}`,
      `{"Authorization": "Basic ${encoded}"}`,
      `curl -H 'Authorization: Basic ${encoded}' http://127.0.0.1:8543/api/v1/messages`,
      `sent Basic ${encoded} to Zulip`,
      `Authorization: Basic ${short}`,
    ]) {
      const output = redact(line);
      expect(output, line).toContain("[REDACTED]");
      expect(output, line).not.toContain(encoded);
      if (line.includes(short)) expect(output, line).not.toContain(short);
    }
  });

  it("redacts a bearer credential in either form too", () => {
    for (const line of ["Authorization: Bearer FAKEtoken.abc", "Authorization=Bearer FAKEtoken.abc", "authorization: bearer FAKEtoken.abc"]) expect(redact(line), line).not.toContain("FAKEtoken");
  });

  it("leaves the word Basic in a sentence alone", () => {
    expect(redact("Basic authentication is on for the dashboard")).toBe("Basic authentication is on for the dashboard");
    expect(redact("Basic auth")).toBe("Basic auth");
  });
});
