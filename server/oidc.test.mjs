import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, createHash, randomBytes, createPublicKey } from "node:crypto";
import { createStateStore } from "./state.mjs";
import { createOidcService, isValidRedirectUri, OidcError } from "./oidc.mjs";
import { verifyJwt } from "./jwt.mjs";

const issuer = "https://boxpilot.lan:8443";
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };

describe("redirect URI validation", () => {
  it("accepts http/https absolute URLs without a fragment", () => {
    expect(isValidRedirectUri("https://grafana.example/login/generic_oauth")).toBe(true);
    expect(isValidRedirectUri("http://localhost:3000/callback")).toBe(true);
    expect(isValidRedirectUri("https://app/cb#frag")).toBe(false);
    expect(isValidRedirectUri("not a url")).toBe(false);
  });
});

describe("OIDC provider", () => {
  let dir; let store; let owner; let oidc; let keys; let publicKey;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "boxpilot-oidc-"));
    store = createStateStore({ databasePath: path.join(dir, "state.sqlite3") });
    owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "alex", passwordHash: "scrypt$1$1$1$x$y" });
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    publicKey = createPublicKey(pair.privateKey);
    keys = { privateKey: pair.privateKey, publicKey, kid: "test-kid" };
    oidc = createOidcService({ store, keys });
  });
  // Tolerate a setup that never got as far as assigning these. Teardown that assumes it did
  // throws its own error over the real one: an EACCES from beforeEach surfaced for a whole
  // afternoon as "Cannot read properties of undefined (reading 'close')".
  afterEach(() => { store?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("publishes discovery and a JWKS with only the public key", () => {
    const meta = oidc.metadata(issuer);
    expect(meta.issuer).toBe(issuer);
    expect(meta.authorization_endpoint).toBe(`${issuer}/oidc/authorize`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
    const jwks = oidc.jwks();
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", use: "sig", alg: "ES256", kid: "test-kid" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("registers a client and runs a full PKCE authorization-code flow", () => {
    const client = oidc.registerClient({ name: "Grafana", redirectUris: ["https://grafana.example/login/generic_oauth"], ownerId: owner.id });
    expect(client.id).toMatch(/^grafana-[0-9a-f]{12}$/);

    const { verifier, challenge } = pkce();
    const validated = oidc.validateAuthorization({ client_id: client.id, redirect_uri: client.redirectUris[0], response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "openid profile groups", state: "xyz", nonce: "n-1" });
    expect(validated.client.id).toBe(client.id);

    const code = oidc.issueCode({ clientId: client.id, ownerId: owner.id, redirectUri: client.redirectUris[0], codeChallenge: challenge, scope: validated.scope, nonce: "n-1" });
    const tokens = oidc.exchangeCode({ code, codeVerifier: verifier, clientId: client.id, redirectUri: client.redirectUris[0], issuer });
    expect(tokens.token_type).toBe("Bearer");

    // The ID token verifies against the published key and carries the identity + role.
    const idClaims = verifyJwt(tokens.id_token, { publicKey, now: Math.floor(Date.now() / 1000) });
    expect(idClaims).toMatchObject({ iss: issuer, sub: owner.id, aud: client.id, nonce: "n-1", preferred_username: "alex", name: "alex", groups: ["owner"] });

    // userinfo returns the same identity from the access token.
    const info = oidc.userinfo(tokens.access_token, issuer);
    expect(info).toMatchObject({ sub: owner.id, preferred_username: "alex", groups: ["owner"] });
  });

  it("honours scopes: without profile/groups, only sub is returned", () => {
    const client = oidc.registerClient({ name: "Minimal", redirectUris: ["https://app/cb"], ownerId: owner.id });
    const { verifier, challenge } = pkce();
    const code = oidc.issueCode({ clientId: client.id, ownerId: owner.id, redirectUri: "https://app/cb", codeChallenge: challenge, scope: "openid" });
    const tokens = oidc.exchangeCode({ code, codeVerifier: verifier, clientId: client.id, redirectUri: "https://app/cb", issuer });
    const claims = verifyJwt(tokens.id_token, { publicKey, now: Math.floor(Date.now() / 1000) });
    expect(claims.sub).toBe(owner.id);
    expect(claims).not.toHaveProperty("preferred_username");
    expect(oidc.userinfo(tokens.access_token, issuer)).toEqual({ sub: owner.id });
  });

  it("rejects PKCE mismatch, code reuse, wrong client, and a bad redirect", () => {
    const client = oidc.registerClient({ name: "App", redirectUris: ["https://app/cb"], ownerId: owner.id });
    const { challenge } = pkce();
    const code = oidc.issueCode({ clientId: client.id, ownerId: owner.id, redirectUri: "https://app/cb", codeChallenge: challenge, scope: "openid" });
    // Wrong verifier -> PKCE fails.
    expect(() => oidc.exchangeCode({ code, codeVerifier: "wrong-verifier", clientId: client.id, redirectUri: "https://app/cb", issuer })).toThrow(/PKCE/);
    // The code was consumed by the failed attempt, so a retry with the right verifier still fails.
    const { verifier: v2, challenge: c2 } = pkce();
    const code2 = oidc.issueCode({ clientId: client.id, ownerId: owner.id, redirectUri: "https://app/cb", codeChallenge: c2, scope: "openid" });
    oidc.exchangeCode({ code: code2, codeVerifier: v2, clientId: client.id, redirectUri: "https://app/cb", issuer });
    expect(() => oidc.exchangeCode({ code: code2, codeVerifier: v2, clientId: client.id, redirectUri: "https://app/cb", issuer })).toThrow(/invalid or expired/);
  });

  it("refuses an unknown client and an unregistered redirect URI", () => {
    expect(() => oidc.validateAuthorization({ client_id: "nope", redirect_uri: "https://app/cb", response_type: "code", code_challenge: "x" })).toThrow(OidcError);
    const client = oidc.registerClient({ name: "App", redirectUris: ["https://app/cb"], ownerId: owner.id });
    expect(() => oidc.validateAuthorization({ client_id: client.id, redirect_uri: "https://evil/cb", response_type: "code", code_challenge: "x" })).toThrow(/redirect_uri/);
  });

  it("bounces PKCE-missing and bad-response-type errors back to a valid redirect", () => {
    const client = oidc.registerClient({ name: "App", redirectUris: ["https://app/cb"], ownerId: owner.id });
    try {
      oidc.validateAuthorization({ client_id: client.id, redirect_uri: "https://app/cb", response_type: "token", code_challenge: "x", state: "s1" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(OidcError);
      expect(error.code).toBe("unsupported_response_type");
      expect(error.redirectUri).toBe("https://app/cb");
      expect(error.state).toBe("s1");
    }
  });
});
