import { describe, expect, it } from "vitest";
import { hashPassword, securityInternals, verifyPassword } from "./security.mjs";

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
