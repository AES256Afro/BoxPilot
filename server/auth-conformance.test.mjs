/**
 * The sign-in path against its specifications: WebAuthn Level 2, RFC 7515/7519 (JWS/JWT) and the
 * OIDC authorization-code flow with PKCE (RFC 7636). BoxPilot verifies these with node:crypto
 * rather than a library (webauthn.mjs explains why), so the cases a library's own conformance suite
 * would cover are held here: a published known-answer vector, every algorithm offered, and the
 * malformed and hostile inputs a verifier has to refuse.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { signJwt, verifyJwt } from "./jwt.mjs";
import { createOidcService } from "./oidc.mjs";
import { createStateStore } from "./state.mjs";
import { bufferToBase64url, decodeClientData, isSecureOrigin, parseAuthenticatorData, verifyAssertion, verifyRegistration, verifySignature } from "./webauthn.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest();
const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** A small seeded generator, so a fuzz case that fails fails the same way on the next run. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const randomBuffer = (random, length) => Buffer.from(Array.from({ length }, () => Math.floor(random() * 256)));

describe("JWS/JWT (RFC 7515, RFC 7519)", () => {
  // RFC 7515 Appendix A.3: the ES256 example, verified with the published public key.
  const rfcKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" }, format: "jwk" });
  const rfcToken = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const now = 1_800_000_000;

  it("verifies the RFC 7515 A.3 ES256 example", () => {
    expect(verifyJwt(rfcToken, { publicKey: rfcKey, now: 1300819380 })).toEqual({ iss: "joe", exp: 1300819380, "http://example.com/is_root": true });
  });

  it("refuses the RFC example once a single bit of it changes", () => {
    const [header, payload, signature] = rfcToken.split(".");
    const flipped = Buffer.from(signature, "base64url"); flipped[10] ^= 0x01;
    expect(() => verifyJwt(`${header}.${payload}.${flipped.toString("base64url")}`, { publicKey: rfcKey, now: 1300819380 })).toThrow(/signature/);
    expect(() => verifyJwt(`${header}.${b64url({ iss: "joe", exp: 1300819380, "http://example.com/is_root": false })}.${signature}`, { publicKey: rfcKey, now: 1300819380 })).toThrow(/signature/);
  });

  it("refuses alg none, HMAC with the public key as its secret, and every alg but ES256", () => {
    const body = b64url({ sub: "x", exp: now + 60 });
    const spki = publicKey.export({ format: "pem", type: "spki" });
    const hmac = createHash("sha256").update(spki).digest("base64url");
    for (const alg of ["none", "HS256", "RS256", "ES384", "PS256", "EdDSA", "es256"]) {
      expect(() => verifyJwt(`${b64url({ alg })}.${body}.${alg === "none" ? "" : hmac}`, { publicKey, now }), alg).toThrow(/unexpected alg/);
    }
  });

  it("refuses an ES256 signature in DER form, and one of the wrong length", () => {
    const signingInput = `${b64url({ alg: "ES256" })}.${b64url({ sub: "x", exp: now + 60 })}`;
    const der = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "der" });
    expect(() => verifyJwt(`${signingInput}.${der.toString("base64url")}`, { publicKey, now })).toThrow(/signature/);
    const raw = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
    expect(() => verifyJwt(`${signingInput}.${raw.subarray(0, 63).toString("base64url")}`, { publicKey, now })).toThrow(/signature/);
    expect(verifyJwt(`${signingInput}.${raw.toString("base64url")}`, { publicKey, now })).toMatchObject({ sub: "x" });
  });

  it("refuses a critical header it does not understand (RFC 7515 §4.1.11)", () => {
    const signingInput = `${b64url({ alg: "ES256", crit: ["exp"], exp: now + 60 })}.${b64url({ sub: "x", exp: now + 60 })}`;
    const signature = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    expect(() => verifyJwt(`${signingInput}.${signature}`, { publicKey, now })).toThrow(/critical/);
  });

  it("refuses a token with no expiry, and holds the clock tolerance to the second", () => {
    const unsigned = (claims) => { const input = `${b64url({ alg: "ES256" })}.${b64url(claims)}`; return `${input}.${cryptoSign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`; };
    expect(() => verifyJwt(unsigned({ sub: "x" }), { publicKey, now })).toThrow(/no expiry/);
    expect(() => verifyJwt(unsigned({ sub: "x", exp: "9999999999" }), { publicKey, now })).toThrow(/no expiry/);
    const token = signJwt({ sub: "x" }, { privateKey, now, expiresInSeconds: 300 });
    expect(verifyJwt(token, { publicKey, now: now + 300 + 60 })).toMatchObject({ sub: "x" });
    expect(() => verifyJwt(token, { publicKey, now: now + 300 + 61 })).toThrow(/expired/);
  });

  it("refuses anything that is not three dot-separated parts", () => {
    const token = signJwt({ sub: "x" }, { privateKey, now });
    for (const bad of ["", "a.b", `${token}.extra`, token.replace(/\./g, ""), `!!!.${token.split(".")[1]}.${token.split(".")[2]}`]) {
      expect(() => verifyJwt(bad, { publicKey, now }), JSON.stringify(bad)).toThrow();
    }
  });

  it("never accepts a random token, whatever it decodes to", () => {
    const random = seeded(7515);
    for (let index = 0; index < 300; index += 1) {
      const parts = [0, 1, 2].map(() => randomBuffer(random, Math.floor(random() * 80)).toString("base64url"));
      if (index % 3 === 0) parts[0] = b64url({ alg: "ES256" });
      if (index % 5 === 0) parts[1] = b64url({ exp: now + 60 });
      expect(() => verifyJwt(parts.join("."), { publicKey, now })).toThrow();
    }
  });
});

describe("WebAuthn (Level 2)", () => {
  const rpId = "boxpilot.lan";
  const origin = "https://boxpilot.lan:8443";
  const challenge = bufferToBase64url(randomBytes(32));
  const expected = { challenge, origin, rpId, requireUserVerification: false };

  /** A software authenticator for one algorithm: the real key types and signature encodings. */
  function authenticator({ algorithm = -7, keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" }), hash = "sha256", dsaEncoding = "der" } = {}) {
    const publicKeyDer = keyPair.publicKey.export({ format: "der", type: "spki" });
    const authData = ({ signCount = 1, flags = 0x05, rp = rpId } = {}) => {
      const counter = Buffer.alloc(4); counter.writeUInt32BE(signCount, 0);
      return Buffer.concat([sha256(Buffer.from(rp, "utf8")), Buffer.from([flags]), counter]);
    };
    const clientData = (fields = {}) => Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false, ...fields }), "utf8");
    const sign = (authenticatorData, clientDataJSON) => cryptoSign(hash, Buffer.concat([authenticatorData, sha256(clientDataJSON)]), algorithm === -8 ? keyPair.privateKey : { key: keyPair.privateKey, dsaEncoding, padding: undefined });
    const credential = (signCount = 0) => ({ publicKey: bufferToBase64url(publicKeyDer), algorithm, signCount });
    const assert = ({ data = authData(), client = clientData(), signCount = 0, expect: want = expected } = {}) => verifyAssertion({ clientDataJSON: client, authenticatorData: data, signature: sign(data, client), credential: credential(signCount), expected: want });
    return { publicKeyDer, algorithm, authData, clientData, sign, credential, assert };
  }

  it("verifies a real signature for every algorithm it offers", () => {
    const cases = [
      { name: "ES256", algorithm: -7, keyPair: generateKeyPairSync("ec", { namedCurve: "P-256" }), hash: "sha256" },
      { name: "ES384", algorithm: -35, keyPair: generateKeyPairSync("ec", { namedCurve: "P-384" }), hash: "sha384" },
      { name: "ES512", algorithm: -36, keyPair: generateKeyPairSync("ec", { namedCurve: "P-521" }), hash: "sha512" },
      { name: "RS256", algorithm: -257, keyPair: generateKeyPairSync("rsa", { modulusLength: 2048 }), hash: "sha256" },
      { name: "RS512", algorithm: -259, keyPair: generateKeyPairSync("rsa", { modulusLength: 2048 }), hash: "sha512" },
      { name: "Ed25519", algorithm: -8, keyPair: generateKeyPairSync("ed25519"), hash: null },
    ];
    for (const { name, ...options } of cases) {
      const device = authenticator(options);
      expect(verifyRegistration({ clientDataJSON: device.clientData({ type: "webauthn.create" }), authenticatorData: device.authData(), publicKeyDer: device.publicKeyDer, algorithm: device.algorithm, expected }), name).toEqual({ ok: true });
      expect(device.assert(), name).toMatchObject({ ok: true, newSignCount: 1, cloned: false });
    }
  });

  it("refuses at registration a key that is not what its algorithm says, or an RSA key under 2048 bits", () => {
    const register = (keyPair, algorithm) => {
      const device = authenticator({ keyPair, algorithm });
      return () => verifyRegistration({ clientDataJSON: device.clientData({ type: "webauthn.create" }), authenticatorData: device.authData(), publicKeyDer: device.publicKeyDer, algorithm, expected });
    };
    expect(register(generateKeyPairSync("ec", { namedCurve: "P-384" }), -7)).toThrow(/not a ES256 key/);
    expect(register(generateKeyPairSync("ec", { namedCurve: "P-256" }), -35)).toThrow(/not a ES384 key/);
    expect(register(generateKeyPairSync("rsa", { modulusLength: 2048 }), -7)).toThrow(/not a ES256 key/);
    expect(register(generateKeyPairSync("ed25519"), -257)).toThrow(/not a RS256 key/);
    expect(register(generateKeyPairSync("rsa", { modulusLength: 1024 }), -257)).toThrow(/at least 2048 bits/);
    expect(register(generateKeyPairSync("ec", { namedCurve: "P-256" }), -65535)).toThrow(/unsupported key algorithm/);
  });

  it("refuses a ceremony of the other type: a sign-in can never register, nor a registration sign in", () => {
    const device = authenticator();
    expect(() => verifyRegistration({ clientDataJSON: device.clientData({ type: "webauthn.get" }), authenticatorData: device.authData(), publicKeyDer: device.publicKeyDer, algorithm: -7, expected })).toThrow(/ceremony type/);
    expect(() => device.assert({ client: device.clientData({ type: "webauthn.create" }) })).toThrow(/ceremony type/);
    expect(() => device.assert({ client: device.clientData({ type: "payment.get" }) })).toThrow(/ceremony type/);
  });

  it("refuses an origin that differs in any way from the one expected", () => {
    const device = authenticator();
    for (const other of ["https://boxpilot.lan", "https://boxpilot.lan:8443/", "http://boxpilot.lan:8443", "https://BOXPILOT.lan:8443", "https://evil.boxpilot.lan:8443", "https://boxpilot.lan.evil:8443", "null"]) {
      expect(() => device.assert({ client: device.clientData({ origin: other }) }), other).toThrow(/origin does not match/);
    }
    expect(() => device.assert({ client: device.clientData({ origin: undefined }) })).toThrow(/origin does not match/);
  });

  it("refuses a cross-origin ceremony, a challenge that is not the issued string, and a missing one", () => {
    const device = authenticator();
    expect(() => device.assert({ client: device.clientData({ crossOrigin: true }) })).toThrow(/cross-origin/);
    expect(() => device.assert({ client: device.clientData({ challenge: [challenge] }) })).toThrow(/challenge/);
    expect(() => device.assert({ client: device.clientData({ challenge: `${challenge}=` }) })).toThrow(/challenge/);
    expect(() => device.assert({ client: device.clientData({ challenge: undefined }) })).toThrow(/challenge/);
  });

  it("refuses an RP ID hash for a parent domain, a sibling, or a different case", () => {
    const device = authenticator();
    for (const rp of ["lan", "other.lan", "Boxpilot.lan", "boxpilot.lan.", ""]) {
      expect(() => device.assert({ data: device.authData({ rp }) }), rp).toThrow(/RP ID hash/);
    }
  });

  it("requires user presence always, and user verification when the action asks for it", () => {
    const device = authenticator();
    expect(() => device.assert({ data: device.authData({ flags: 0x04 }) })).toThrow(/user presence/);
    expect(() => device.assert({ data: device.authData({ flags: 0x01 }), expect: { ...expected, requireUserVerification: true } })).toThrow(/user verification/);
    expect(device.assert({ data: device.authData({ flags: 0x05 }), expect: { ...expected, requireUserVerification: true } })).toMatchObject({ ok: true, userVerified: true });
  });

  it("treats the signature counter as WebAuthn §7.2 step 22 does", () => {
    const device = authenticator();
    const counter = (stored, reported) => device.assert({ data: device.authData({ signCount: reported }), signCount: stored });
    expect(counter(0, 0)).toMatchObject({ cloned: false, newSignCount: 0 });
    expect(counter(0, 7)).toMatchObject({ cloned: false, newSignCount: 7 });
    expect(counter(5, 6)).toMatchObject({ cloned: false, newSignCount: 6 });
    // Equal or lower, including a drop to zero after counting, is a possible clone, and the stored
    // counter keeps its high mark so the next use of the copy is surfaced as well.
    expect(counter(5, 5)).toMatchObject({ cloned: true, newSignCount: 5 });
    expect(counter(5, 3)).toMatchObject({ cloned: true, newSignCount: 5 });
    expect(counter(5, 0)).toMatchObject({ cloned: true, newSignCount: 5 });
  });

  it("verifies over exactly authenticatorData || SHA-256(clientDataJSON)", () => {
    const device = authenticator();
    const data = device.authData();
    const client = device.clientData();
    const signature = device.sign(data, client);
    const args = { algorithm: -7, publicKeyDer: device.publicKeyDer, authenticatorData: data, clientDataJSON: client, signature };
    expect(verifySignature(args)).toBe(true);
    // The same bytes, split at another place, are a different message.
    expect(verifySignature({ ...args, authenticatorData: data.subarray(0, 36), clientDataJSON: Buffer.concat([data.subarray(36), client]) })).toBe(false);
    // Whitespace in the client data changes its hash, so it changes what was signed.
    expect(verifySignature({ ...args, clientDataJSON: Buffer.from(` ${client.toString("utf8")}`) })).toBe(false);
    expect(verifySignature({ ...args, algorithm: -257 })).toBe(false);
  });

  it("only treats https, and plain http to the machine itself, as a secure context", () => {
    for (const secure of ["https://boxpilot.lan", "http://localhost:5173", "http://127.0.0.1:8080", "http://[::1]:8080"]) expect(isSecureOrigin(secure), secure).toBe(true);
    for (const insecure of ["http://boxpilot.lan", "http://192.168.1.5", "ftp://localhost", "http://localhost.evil", "javascript:alert(1)", "not a url", ""]) expect(isSecureOrigin(insecure), insecure).toBe(false);
  });

  it("never accepts, and never fails with anything but an Error, on random authenticator and client data", () => {
    const device = authenticator();
    const random = seeded(2019);
    for (let index = 0; index < 400; index += 1) {
      const data = index % 4 === 0 ? device.authData({ signCount: Math.floor(random() * 1e6), flags: Math.floor(random() * 256) }) : randomBuffer(random, Math.floor(random() * 80));
      const client = index % 3 === 0 ? device.clientData({ challenge: randomBuffer(random, 8).toString("base64url") }) : randomBuffer(random, Math.floor(random() * 120));
      const signature = randomBuffer(random, Math.floor(random() * 90));
      let outcome;
      try { outcome = verifyAssertion({ clientDataJSON: client, authenticatorData: data, signature, credential: device.credential(), expected }); } catch (error) { outcome = error; }
      expect(outcome).toBeInstanceOf(Error);
    }
  });

  it("parses only what a header can hold, and only an object as client data", () => {
    expect(() => parseAuthenticatorData(Buffer.alloc(36))).toThrow(/too short/);
    expect(() => parseAuthenticatorData("not a buffer")).toThrow(/too short/);
    expect(parseAuthenticatorData(Buffer.concat([Buffer.alloc(32), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff])]))).toMatchObject({ signCount: 0xffffffff, flags: { userPresent: true, userVerified: true, attestedCredentialData: true, extensionData: true } });
    for (const bad of ["", "null", "42", "\"text\"", "{", "﻿{}"]) expect(() => decodeClientData(Buffer.from(bad)), JSON.stringify(bad)).toThrow();
  });
});

describe("OIDC authorization code with PKCE (RFC 6749, RFC 7636)", () => {
  const issuer = "https://boxpilot.lan:8443";
  let dir; let store; let owner; let oidc; let clock; let client;
  const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "boxpilot-oidc-conformance-"));
    store = createStateStore({ databasePath: path.join(dir, "state.sqlite3") });
    owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "alex", passwordHash: "scrypt$1$1$1$x$y" });
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    clock = 1_800_000_000_000;
    oidc = createOidcService({ store, keys: { privateKey: pair.privateKey, publicKey: createPublicKey(pair.privateKey), kid: "kid" }, now: () => clock });
    client = oidc.registerClient({ name: "Grafana", redirectUris: ["https://grafana.lan/login/generic_oauth"], ownerId: owner.id });
  });
  afterEach(() => { oidc?.close(); store?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  const grant = (overrides = {}) => {
    const { verifier, challenge } = pkce();
    const code = oidc.issueCode({ clientId: client.id, ownerId: owner.id, redirectUri: client.redirectUris[0], codeChallenge: challenge, scope: "openid profile", nonce: "n-1", ...overrides });
    return { code, verifier };
  };
  const exchange = ({ code, verifier }, overrides = {}) => oidc.exchangeCode({ code, codeVerifier: verifier, clientId: client.id, redirectUri: client.redirectUris[0], issuer, ...overrides });
  const invalid = (code) => expect.objectContaining({ code });

  it("matches the redirect URI exactly, never by prefix, path or query", () => {
    const authorize = (redirect) => () => oidc.validateAuthorization({ client_id: client.id, redirect_uri: redirect, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256" });
    expect(authorize(client.redirectUris[0])).not.toThrow();
    for (const other of [`${client.redirectUris[0]}/`, `${client.redirectUris[0]}?next=/`, `${client.redirectUris[0]}/../../evil`, "https://grafana.lan/login/generic_oauth#x", "https://GRAFANA.lan/login/generic_oauth", "https://user@grafana.lan/login/generic_oauth", "http://grafana.lan/login/generic_oauth"]) {
      expect(authorize(other), other).toThrow(/redirect_uri/);
    }
  });

  it("accepts only S256 and a 43-character challenge, and a verifier of 43 to 128 unreserved characters", () => {
    const authorize = (fields) => () => oidc.validateAuthorization({ client_id: client.id, redirect_uri: client.redirectUris[0], response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", ...fields });
    expect(authorize({ code_challenge_method: "plain" })).toThrow(/S256/);
    expect(authorize({ code_challenge_method: undefined })).toThrow(/S256/);
    expect(authorize({ code_challenge: "a".repeat(42) })).toThrow(/code_challenge/);
    expect(authorize({ code_challenge: "a".repeat(44) })).toThrow(/code_challenge/);
    for (const verifier of ["a".repeat(42), "a".repeat(129), `${"a".repeat(42)}+`, `${"a".repeat(42)} `]) {
      const issued = grant({ codeChallenge: createHash("sha256").update(verifier).digest("base64url") });
      expect(() => exchange({ ...issued, verifier }), verifier).toThrow(invalid("invalid_grant"));
    }
    const longest = "~".repeat(128);
    expect(exchange({ ...grant({ codeChallenge: createHash("sha256").update(longest).digest("base64url") }), verifier: longest })).toMatchObject({ token_type: "Bearer" });
  });

  it("spends a code once, even when the first attempt fails, and lets it expire after a minute", () => {
    const issued = grant();
    expect(() => exchange({ ...issued, verifier: pkce().verifier })).toThrow(invalid("invalid_grant"));
    expect(() => exchange(issued)).toThrow(invalid("invalid_grant"));
    const late = grant();
    clock += 60_000;
    expect(() => exchange(late)).toThrow(/expired/);
  });

  it("keeps an ID token out of userinfo, and an access token out of another issuer or audience", () => {
    const tokens = exchange(grant());
    expect(oidc.userinfo(tokens.access_token, issuer)).toMatchObject({ sub: owner.id, preferred_username: "alex" });
    expect(() => oidc.userinfo(tokens.id_token, issuer)).toThrow(invalid("invalid_token"));
    expect(() => oidc.userinfo(tokens.access_token, "https://other.lan")).toThrow(invalid("invalid_token"));
    const claims = verifyJwt(tokens.id_token, { publicKey: oidc.internals.publicKey, now: Math.floor(clock / 1000) });
    expect(claims).toMatchObject({ iss: issuer, aud: client.id, sub: owner.id, nonce: "n-1" });
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it("refuses userinfo once the access token has expired, and a code or token once its account is disabled", () => {
    const tokens = exchange(grant());
    clock += (3600 + 61) * 1000;
    expect(() => oidc.userinfo(tokens.access_token, issuer)).toThrow(invalid("invalid_token"));
    clock -= (3600 + 61) * 1000;
    const viewer = store.createOwnerAccount({ username: "sam", passwordHash: "scrypt$1$1$1$x$y", role: "viewer", createdBy: owner.id });
    const theirs = exchange(grant({ ownerId: viewer.id }));
    const pending = grant({ ownerId: viewer.id });
    store.disableOwner(viewer.id, { actorId: owner.id });
    expect(() => oidc.userinfo(theirs.access_token, issuer)).toThrow(invalid("invalid_token"));
    expect(() => exchange(pending)).toThrow(invalid("invalid_grant"));
  });
});
