import { describe, expect, it, vi } from "vitest";

// Password hashing runs at production scrypt cost; CI runners need more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });
import { createAuthService, hashPassword, securityInternals, verifyPassword, parseCookies } from "./security.mjs";

describe("owner security", () => {
  it("hashes passwords with scrypt and verifies without plaintext storage", async () => {
    const encoded = await hashPassword("a long private password");
    expect(encoded).toMatch(/^scrypt\$/);
    expect(encoded).not.toContain("a long private password");
    expect(await verifyPassword("a long private password", encoded)).toBe(true);
    expect(await verifyPassword("not the password", encoded)).toBe(false);
  });

  it("validates owner credentials", () => {
    expect(securityInternals.validateCredentials("op", "short")).toHaveLength(2);
    expect(securityInternals.validateCredentials("operator", "twelve-chars-ok")).toEqual([]);
  });

  it("parses only complete cookie pairs", () => {
    expect(securityInternals.parseCookies("one=1; boxpilot_session=abc%201; empty=")).toEqual({
      one: "1",
      boxpilot_session: "abc 1",
      empty: "",
    });
    expect(securityInternals.parseCookies("boxpilot_session=%E0%A4%A")).toEqual({});
  });
});

describe("cookies", () => {
  it("ignores a name that appears twice rather than picking one", () => {
    // A second cookie of the same name means somebody set one at a broader scope — on a tailnet
    // every node shares the registrable domain. Neither value can be trusted, so neither is used.
    expect(parseCookies("boxpilot_session=mine; other=1")).toEqual({ boxpilot_session: "mine", other: "1" });
    expect(parseCookies("boxpilot_session=mine; boxpilot_session=theirs")).toEqual({});
    expect(parseCookies("boxpilot_session=mine; boxpilot_session=theirs; other=1")).toEqual({ other: "1" });
  });
});

describe("what a wrong password reveals", () => {
  it("takes the same work whether the account exists or not", async () => {
    // Short-circuiting on a missing account made the two distinguishable by timing — a username
    // oracle — and made a flood of attempts against invented usernames free for an attacker.
    const auth = createAuthService({ recordAudit: () => {}, getSetting: () => null, setSetting: () => {} });
    const passwordHash = await hashPassword("correct horse battery staple");
    const attempt = async (owner, address) => {
      const request = { socket: { remoteAddress: address }, get: () => undefined, headers: {} };
      const started = process.hrtime.bigint();
      const verdict = await auth.checkPassword(request, owner, "wrong");
      return { ms: Number(process.hrtime.bigint() - started) / 1e6, verdict };
    };
    await attempt(null, "198.51.100.1"); // warm the decoy hash
    await attempt({ id: "warm", passwordHash }, "198.51.100.2");

    const known = await attempt({ id: "real", passwordHash }, "198.51.100.3");
    const unknown = await attempt(null, "198.51.100.4");
    expect(known.verdict.ok).toBe(false);
    expect(unknown.verdict.ok).toBe(false);
    // Generous bounds: the point is the same order of magnitude, not a stopwatch. Before this the
    // gap was ~370x.
    expect(Math.max(known.ms, unknown.ms)).toBeLessThan(Math.min(known.ms, unknown.ms) * 5 + 25);
  });
});
