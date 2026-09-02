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

afterAll(async () => { server?.close(); state?.close?.(); await rm(directory, { recursive: true, force: true }); });

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
    const params = new URLSearchParams({ client_id: client.id, redirect_uri: redirectUri, response_type: "code", scope: "openid", code_challenge: "abc", code_challenge_method: "S256" });
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
    const form = new URLSearchParams({ client_id: client.id, redirect_uri: redirectUri, response_type: "code", scope: "openid", code_challenge: "abc", code_challenge_method: "S256", state: "st-2", csrf: session.csrfToken, decision: "deny" });
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
