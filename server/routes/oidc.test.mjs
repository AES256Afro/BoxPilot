/**
 * The OIDC endpoints end to end over a real socket: discovery, JWKS, the consent screen, the token
 * exchange with PKCE, and userinfo — the way an app would drive them.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, createPublicKey, createHash, randomBytes } from "node:crypto";
import { createStateStore } from "../state.mjs";
import { createAuthService, hashPassword } from "../security.mjs";
import { createOidcService } from "../oidc.mjs";
import { createOidcRouter, createOidcAdminRouter } from "./oidc.mjs";
import { verifyJwt } from "../jwt.mjs";

const password = "correct horse battery";
const redirectUri = "http://localhost:9999/cb";
let directory; let server; let base; let state; let oidc; let publicKey; let client;

async function signIn() {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "alex", password }) });
  const body = await response.json();
  return { cookie: String(response.headers.getSetCookie()[0]).split(";")[0], csrfToken: body.csrfToken };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-oidc-routes-"));
  state = createStateStore({ stateDirectory: directory });
  state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: await hashPassword(password) });
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  publicKey = createPublicKey(pair.privateKey);
  oidc = createOidcService({ store: state, keys: { privateKey: pair.privateKey, publicKey, kid: "k1" } });
  client = oidc.registerClient({ name: "Grafana", redirectUris: [redirectUri] });
  const auth = createAuthService(state);
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.post("/api/v1/auth/login", auth.login);
  app.use("/api/v1", auth.requireSession);
  app.use("/api/v1", createOidcAdminRouter({ oidc, auth }));
  app.use(createOidcRouter({ oidc, auth, store: state }));
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => { oidc?.close(); server?.close(); state?.close?.(); await rm(directory, { recursive: true, force: true }); });

describe("OIDC endpoints", () => {
  it("serves discovery and JWKS at the site root", async () => {
    const discovery = await (await fetch(`${base}/.well-known/openid-configuration`)).json();
    expect(discovery.issuer).toBe(base);
    expect(discovery.authorization_endpoint).toBe(`${base}/oidc/authorize`);
    const jwks = await (await fetch(`${base}/oidc/jwks`)).json();
    expect(jwks.keys[0].kid).toBe("k1");
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("sends an unauthenticated visitor to sign in, preserving the return URL", async () => {
    const authorizeUrl = `/oidc/authorize?client_id=${client.id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid&code_challenge=abc&code_challenge_method=S256`;
    const response = await fetch(`${base}${authorizeUrl}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/?next=");
    expect(decodeURIComponent(response.headers.get("location"))).toContain("/oidc/authorize");
  });

  it("lets the browser follow the post-consent redirect to the client (form-action names its origin)", async () => {
    // Chrome checks form-action against the redirect a form POST ends in, not only the form's own
    // action. With 'self' alone, approving consent left the person stuck on the consent page.
    const session = await signIn();
    const params = new URLSearchParams({ client_id: client.id, redirect_uri: redirectUri, response_type: "code", scope: "openid", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
    const consent = await fetch(`${base}/oidc/authorize?${params}`, { headers: { Cookie: session.cookie } });
    expect(consent.status).toBe(200);
    const csp = consent.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`form-action 'self' ${new URL(redirectUri).origin}`);
    // And nothing else has crept in: the client origin is the only addition.
    expect(csp).not.toContain("'unsafe-inline'; form-action 'self';");
  });

  it("runs the full consent -> code -> token -> userinfo flow with PKCE", async () => {
    const session = await signIn();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({ client_id: client.id, redirect_uri: redirectUri, response_type: "code", scope: "openid profile groups", code_challenge: challenge, code_challenge_method: "S256", state: "st-1", nonce: "n-1" });

    // The consent screen renders with the client name.
    const consent = await fetch(`${base}/oidc/authorize?${params}`, { headers: { Cookie: session.cookie } });
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain("Grafana");
    expect(html).toContain("see your role");

    // Approving redirects back to the app with a code and the original state.
    const form = new URLSearchParams(params);
    form.set("csrf", session.csrfToken);
    form.set("decision", "approve");
    const approved = await fetch(`${base}/oidc/authorize`, { method: "POST", headers: { Cookie: session.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(), redirect: "manual" });
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location"));
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get("state")).toBe("st-1");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    // The app's backend exchanges the code with its PKCE verifier.
    const tokenBody = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.id, code_verifier: verifier });
    const tokenResponse = await fetch(`${base}/oidc/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tokenBody.toString() });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json();
    const idClaims = verifyJwt(tokens.id_token, { publicKey, now: Math.floor(Date.now() / 1000) });
    expect(idClaims).toMatchObject({ iss: base, aud: client.id, nonce: "n-1", preferred_username: "alex", groups: ["owner"] });

    // userinfo with the access token returns the identity.
    const info = await (await fetch(`${base}/oidc/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).json();
    expect(info).toMatchObject({ sub: idClaims.sub, preferred_username: "alex" });
  });

  it("denying redirects back with access_denied", async () => {
    const session = await signIn();
    const form = new URLSearchParams({ client_id: client.id, redirect_uri: redirectUri, response_type: "code", scope: "openid", code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "st-2", csrf: session.csrfToken, decision: "deny" });
    const denied = await fetch(`${base}/oidc/authorize`, { method: "POST", headers: { Cookie: session.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(), redirect: "manual" });
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.get("location"));
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("st-2");
  });

  it("lists registered clients for the owner", async () => {
    const session = await signIn();
    const listed = await (await fetch(`${base}/api/v1/oidc/clients`, { headers: { Cookie: session.cookie, "X-BoxPilot-CSRF": session.csrfToken } })).json();
    expect(listed.discovery).toBe(`${base}/.well-known/openid-configuration`);
    expect(listed.clients.some((entry) => entry.id === client.id)).toBe(true);
  });
});

const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
const form = (fields) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(fields.cookie ? { Cookie: fields.cookie } : {}) }, body: new URLSearchParams(Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "cookie"))).toString(), redirect: "manual" });
const request = (challenge, extra = {}) => ({ client_id: client.id, redirect_uri: redirectUri, response_type: "code", scope: "openid", code_challenge: challenge, code_challenge_method: "S256", ...extra });

async function approvedCode(challenge) {
  const session = await signIn();
  const response = await fetch(`${base}/oidc/authorize`, form({ ...request(challenge), csrf: session.csrfToken, decision: "approve", cookie: session.cookie }));
  return new URL(response.headers.get("location")).searchParams.get("code");
}

describe("what the OIDC endpoints refuse", () => {
  it("issues no code without a session or without the session's CSRF token", async () => {
    const session = await signIn();
    const { challenge } = pkce();
    const anonymous = await fetch(`${base}/oidc/authorize`, form({ ...request(challenge), csrf: session.csrfToken, decision: "approve" }));
    expect(anonymous.status).toBe(401);
    for (const csrf of [undefined, "", "x".repeat(session.csrfToken.length)]) {
      const response = await fetch(`${base}/oidc/authorize`, form({ ...request(challenge), ...(csrf === undefined ? {} : { csrf }), decision: "approve", cookie: session.cookie }));
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("never redirects to an address the client did not register, and bounces later errors back to the client", async () => {
    const session = await signIn();
    const { challenge } = pkce();
    for (const params of [request(challenge, { redirect_uri: "https://elsewhere.example/cb" }), request(challenge, { client_id: "unknown" })]) {
      const viewed = await fetch(`${base}/oidc/authorize?${new URLSearchParams(params)}`, { headers: { Cookie: session.cookie }, redirect: "manual" });
      expect(viewed.status).toBe(400);
      expect(viewed.headers.get("location")).toBeNull();
      const posted = await fetch(`${base}/oidc/authorize`, form({ ...params, csrf: session.csrfToken, decision: "approve", cookie: session.cookie }));
      expect(posted.status).toBe(400);
      expect(posted.headers.get("location")).toBeNull();
    }
    const noOpenid = await fetch(`${base}/oidc/authorize?${new URLSearchParams(request(challenge, { scope: "profile", state: "st-3" }))}`, { headers: { Cookie: session.cookie }, redirect: "manual" });
    expect(noOpenid.status).toBe(302);
    const location = new URL(noOpenid.headers.get("location"));
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({ error: "invalid_scope", state: "st-3" });
  });

  it("escapes what the request carries on the consent page", async () => {
    const session = await signIn();
    const { challenge } = pkce();
    const html = await (await fetch(`${base}/oidc/authorize?${new URLSearchParams(request(challenge, { state: "\"><script>alert(1)</script>", scope: "openid <img>" }))}`, { headers: { Cookie: session.cookie } })).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img>");
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it("exchanges a code once, only with its verifier (a wrong one spends it), and only for authorization_code", async () => {
    expect(await (await fetch(`${base}/oidc/token`, form({ grant_type: "password", username: "alex", password }))).json()).toMatchObject({ error: "unsupported_grant_type" });
    const { verifier, challenge } = pkce();
    const code = await approvedCode(challenge);
    const exchange = (codeVerifier) => fetch(`${base}/oidc/token`, form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.id, code_verifier: codeVerifier }));
    const wrong = await exchange(pkce().verifier);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    // A wrong verifier spends the code: guessing again with the right one gets nothing.
    expect((await exchange(verifier)).status).toBe(400);
    const { challenge: second, verifier: secondVerifier } = pkce();
    const fresh = await approvedCode(second);
    const once = (value) => fetch(`${base}/oidc/token`, form({ grant_type: "authorization_code", code: fresh, redirect_uri: redirectUri, client_id: client.id, code_verifier: value }));
    expect((await once(secondVerifier)).status).toBe(200);
    expect(await (await once(secondVerifier)).json()).toMatchObject({ error: "invalid_grant" });
  });

  it("answers userinfo only for a Bearer access token", async () => {
    const none = await fetch(`${base}/oidc/userinfo`);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    const bad = await fetch(`${base}/oidc/userinfo`, { headers: { Authorization: "Bearer not.a.token" } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    const { verifier, challenge } = pkce();
    const code = await approvedCode(challenge);
    const tokens = await (await fetch(`${base}/oidc/token`, form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.id, code_verifier: verifier }))).json();
    expect((await fetch(`${base}/oidc/userinfo`, { headers: { Authorization: `Bearer ${tokens.id_token}` } })).status).toBe(401);
  });

  it("registers and removes clients only with the CSRF token, and says what was wrong", async () => {
    const session = await signIn();
    const headers = { Cookie: session.cookie, "Content-Type": "application/json" };
    expect((await fetch(`${base}/api/v1/oidc/clients`, { method: "POST", headers, body: JSON.stringify({ name: "Wiki", redirectUris: [redirectUri] }) })).status).toBe(403);
    const invalid = await fetch(`${base}/api/v1/oidc/clients`, { method: "POST", headers: { ...headers, "X-BoxPilot-CSRF": session.csrfToken }, body: JSON.stringify({ name: "Wiki", redirectUris: [] }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_client" });
    const made = await (await fetch(`${base}/api/v1/oidc/clients`, { method: "POST", headers: { ...headers, "X-BoxPilot-CSRF": session.csrfToken }, body: JSON.stringify({ name: "Wiki", redirectUris: [redirectUri] }) })).json();
    expect((await fetch(`${base}/api/v1/oidc/clients/${made.id}`, { method: "DELETE", headers })).status).toBe(403);
    expect((await fetch(`${base}/api/v1/oidc/clients/${made.id}`, { method: "DELETE", headers: { ...headers, "X-BoxPilot-CSRF": session.csrfToken } })).status).toBe(200);
    expect(await (await fetch(`${base}/api/v1/oidc/clients/${made.id}`, { method: "DELETE", headers: { ...headers, "X-BoxPilot-CSRF": session.csrfToken } })).json()).toMatchObject({ code: "client_not_found" });
  });

  it("says single sign-on is unavailable while the signing key is not ready", async () => {
    const app = express();
    app.use(createOidcRouter({ oidc: { status: () => ({ ready: false }) }, auth: {}, store: {} }));
    const closed = app.listen(0);
    await new Promise((resolve) => closed.once("listening", resolve));
    try {
      const at = `http://127.0.0.1:${closed.address().port}`;
      for (const url of ["/.well-known/openid-configuration", "/oidc/jwks", "/oidc/token"]) {
        const response = await fetch(`${at}${url}`, { method: url === "/oidc/token" ? "POST" : "GET" });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
      }
    } finally { closed.close(); }
  });
});
