import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, createHash, randomBytes } from "node:crypto";
import {
  base64urlToBuffer, bufferToBase64url, isSecureOrigin, isSupportedAlgorithm, parseAuthenticatorData,
  relyingPartyId, verifyAssertion, verifyRegistration, verifySignature,
} from "./webauthn.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest();

/** A software stand-in for a P-256 platform authenticator, enough to drive the real crypto path. */
function makeAuthenticator({ rpId = "boxpilot.lan" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const authData = ({ signCount = 1, up = true, uv = true } = {}) => {
    const flags = (up ? 0x01 : 0) | (uv ? 0x04 : 0);
    const head = Buffer.concat([sha256(Buffer.from(rpId, "utf8")), Buffer.from([flags])]);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount, 0);
    return Buffer.concat([head, counter]);
  };
  const clientData = (type, challenge, origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  const sign = (authenticatorData, clientDataJSON) =>
    cryptoSign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), { key: privateKey, dsaEncoding: "der" });
  return { publicKeyDer, publicKey: bufferToBase64url(publicKeyDer), algorithm: -7, authData, clientData, sign };
}

const challenge = bufferToBase64url(randomBytes(32));
const origin = "https://boxpilot.lan:8443";
const rpId = "boxpilot.lan";
const expected = { challenge, origin, rpId, requireUserVerification: false };

describe("encoding helpers", () => {
  it("round-trips base64url without padding", () => {
    const buffer = randomBytes(20);
    expect(base64urlToBuffer(bufferToBase64url(buffer)).equals(buffer)).toBe(true);
    expect(bufferToBase64url(buffer)).not.toMatch(/[+/=]/);
  });
});

describe("origin and RP ID rules", () => {
  it("treats https and http-localhost as secure, everything else not", () => {
    expect(isSecureOrigin("https://boxpilot.lan:8443")).toBe(true);
    expect(isSecureOrigin("http://localhost:8787")).toBe(true);
    expect(isSecureOrigin("http://127.0.0.1:8787")).toBe(true);
    expect(isSecureOrigin("http://boxpilot.lan:8787")).toBe(false);
  });
  it("derives the host as RP ID and rejects IP addresses", () => {
    expect(relyingPartyId("https://boxpilot.lan:8443")).toBe("boxpilot.lan");
    expect(relyingPartyId("https://homebox.tail0a1b.ts.net")).toBe("homebox.tail0a1b.ts.net");
    expect(() => relyingPartyId("https://192.168.50.20:8443")).toThrow(/host name/);
  });
  it("knows which algorithms it can verify", () => {
    expect(isSupportedAlgorithm(-7)).toBe(true);
    expect(isSupportedAlgorithm(-257)).toBe(true);
    expect(isSupportedAlgorithm(-999)).toBe(false);
  });
});

describe("authenticator data parsing", () => {
  it("reads the flags and counter", () => {
    const auth = makeAuthenticator();
    const parsed = parseAuthenticatorData(auth.authData({ signCount: 42, up: true, uv: true }));
    expect(parsed.signCount).toBe(42);
    expect(parsed.flags.userPresent).toBe(true);
    expect(parsed.flags.userVerified).toBe(true);
  });
  it("rejects truncated data", () => {
    expect(() => parseAuthenticatorData(Buffer.alloc(10))).toThrow(/too short/);
  });
});

describe("registration", () => {
  it("accepts a well-formed create ceremony", () => {
    const auth = makeAuthenticator();
    const clientDataJSON = auth.clientData("webauthn.create", challenge, origin);
    const result = verifyRegistration({ clientDataJSON, authenticatorData: auth.authData(), publicKeyDer: auth.publicKeyDer, algorithm: -7, expected });
    expect(result.ok).toBe(true);
  });
  it("rejects a wrong challenge, wrong origin, wrong RP ID, and absent user presence", () => {
    const auth = makeAuthenticator();
    const good = auth.clientData("webauthn.create", challenge, origin);
    expect(() => verifyRegistration({ clientDataJSON: auth.clientData("webauthn.create", bufferToBase64url(randomBytes(32)), origin), authenticatorData: auth.authData(), publicKeyDer: auth.publicKeyDer, algorithm: -7, expected })).toThrow(/challenge/);
    expect(() => verifyRegistration({ clientDataJSON: auth.clientData("webauthn.create", challenge, "https://evil.example"), authenticatorData: auth.authData(), publicKeyDer: auth.publicKeyDer, algorithm: -7, expected })).toThrow(/origin/);
    const otherRp = makeAuthenticator({ rpId: "evil.example" });
    expect(() => verifyRegistration({ clientDataJSON: good, authenticatorData: otherRp.authData(), publicKeyDer: auth.publicKeyDer, algorithm: -7, expected })).toThrow(/RP ID/);
    expect(() => verifyRegistration({ clientDataJSON: good, authenticatorData: auth.authData({ up: false }), publicKeyDer: auth.publicKeyDer, algorithm: -7, expected })).toThrow(/user presence/);
  });
  it("requires user verification when asked", () => {
    const auth = makeAuthenticator();
    const clientDataJSON = auth.clientData("webauthn.create", challenge, origin);
    expect(() => verifyRegistration({ clientDataJSON, authenticatorData: auth.authData({ uv: false }), publicKeyDer: auth.publicKeyDer, algorithm: -7, expected: { ...expected, requireUserVerification: true } })).toThrow(/user verification/);
  });
});

describe("authentication", () => {
  it("verifies a real signature and advances the counter", () => {
    const auth = makeAuthenticator();
    const authenticatorData = auth.authData({ signCount: 5 });
    const clientDataJSON = auth.clientData("webauthn.get", challenge, origin);
    const signature = auth.sign(authenticatorData, clientDataJSON);
    const result = verifyAssertion({ clientDataJSON, authenticatorData, signature, credential: { publicKey: auth.publicKey, algorithm: -7, signCount: 1 }, expected });
    expect(result.ok).toBe(true);
    expect(result.newSignCount).toBe(5);
    expect(result.cloned).toBe(false);
  });
  it("rejects a forged signature", () => {
    const auth = makeAuthenticator();
    const attacker = makeAuthenticator();
    const authenticatorData = auth.authData();
    const clientDataJSON = auth.clientData("webauthn.get", challenge, origin);
    const signature = attacker.sign(authenticatorData, clientDataJSON); // signed by the wrong key
    expect(() => verifyAssertion({ clientDataJSON, authenticatorData, signature, credential: { publicKey: auth.publicKey, algorithm: -7, signCount: 0 }, expected })).toThrow(/did not verify/);
  });
  it("rejects a replay with a stale challenge or tampered authenticator data", () => {
    const auth = makeAuthenticator();
    const authenticatorData = auth.authData();
    const clientDataJSON = auth.clientData("webauthn.get", challenge, origin);
    const signature = auth.sign(authenticatorData, clientDataJSON);
    // A different expected challenge (as if the server issued a new one) fails the common check.
    expect(() => verifyAssertion({ clientDataJSON, authenticatorData, signature, credential: { publicKey: auth.publicKey, algorithm: -7, signCount: 0 }, expected: { ...expected, challenge: bufferToBase64url(randomBytes(32)) } })).toThrow(/challenge/);
    // Flipping a byte of authenticator data breaks the signature.
    const tampered = Buffer.from(authenticatorData); tampered[33] ^= 0xff;
    expect(() => verifyAssertion({ clientDataJSON, authenticatorData: tampered, signature, credential: { publicKey: auth.publicKey, algorithm: -7, signCount: 0 }, expected })).toThrow();
  });
  it("flags a counter that goes backwards as a possible clone", () => {
    const auth = makeAuthenticator();
    const authenticatorData = auth.authData({ signCount: 3 });
    const clientDataJSON = auth.clientData("webauthn.get", challenge, origin);
    const signature = auth.sign(authenticatorData, clientDataJSON);
    const result = verifyAssertion({ clientDataJSON, authenticatorData, signature, credential: { publicKey: auth.publicKey, algorithm: -7, signCount: 10 }, expected });
    expect(result.cloned).toBe(true);
  });
  it("verifySignature returns false rather than throwing on a bad key", () => {
    expect(verifySignature({ algorithm: -7, publicKeyDer: Buffer.from("not a key"), authenticatorData: Buffer.alloc(37), clientDataJSON: Buffer.from("{}"), signature: Buffer.alloc(64) })).toBe(false);
  });
});
