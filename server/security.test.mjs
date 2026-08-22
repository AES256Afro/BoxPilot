import { describe, expect, it, vi } from "vitest";

// Password hashing runs at production scrypt cost; CI runners need more than the 5 s default.
vi.setConfig({ testTimeout: 30_000 });
import { hashPassword, securityInternals, verifyPassword, parseCookies } from "./security.mjs";

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
