import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { publicJwk, signJwt, verifyJwt } from "./jwt.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const now = 1_700_000_000;

describe("ES256 JWT", () => {
  it("signs and verifies a round trip, carrying the claims and standard times", () => {
    const token = signJwt({ iss: "https://boxpilot.lan", sub: "owner-1", aud: "grafana" }, { privateKey, kid: "k1", now, expiresInSeconds: 600 });
    expect(token.split(".")).toHaveLength(3);
    const payload = verifyJwt(token, { publicKey, now });
    expect(payload).toMatchObject({ iss: "https://boxpilot.lan", sub: "owner-1", aud: "grafana", iat: now, exp: now + 600 });
  });

  it("uses the JOSE raw signature (64 bytes), not DER", () => {
    const token = signJwt({ sub: "x" }, { privateKey, kid: "k1", now });
    const signature = Buffer.from(token.split(".")[2], "base64url");
    expect(signature).toHaveLength(64); // r||s; a DER signature would be ~70 bytes and variable
  });

  it("rejects a tampered payload", () => {
    const token = signJwt({ sub: "owner-1", role: "viewer" }, { privateKey, kid: "k1", now });
    const [header, , signature] = token.split(".");
    const forged = `${header}.${Buffer.from(JSON.stringify({ sub: "owner-1", role: "owner", iat: now, exp: now + 300 })).toString("base64url")}.${signature}`;
    expect(() => verifyJwt(forged, { publicKey, now })).toThrow(/verify/);
  });

  it("rejects an expired token past the clock tolerance", () => {
    const token = signJwt({ sub: "x" }, { privateKey, kid: "k1", now, expiresInSeconds: 60 });
    expect(() => verifyJwt(token, { publicKey, now: now + 200 })).toThrow(/expired/);
    // Within tolerance it still passes.
    expect(verifyJwt(token, { publicKey, now: now + 90 }).sub).toBe("x");
  });

  it("wrong key does not verify", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const token = signJwt({ sub: "x" }, { privateKey, kid: "k1", now });
    expect(() => verifyJwt(token, { publicKey: other.publicKey, now })).toThrow();
  });

  it("publishes a usable EC public JWK", () => {
    const jwk = publicJwk(publicKey, "k1");
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256", use: "sig", alg: "ES256", kid: "k1" });
    expect(typeof jwk.x).toBe("string");
    expect(typeof jwk.y).toBe("string");
    expect(jwk).not.toHaveProperty("d"); // never the private scalar
  });
});
