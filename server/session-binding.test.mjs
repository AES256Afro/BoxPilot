// @vitest-environment node
/**
 * A session answers only to the address it was signed in from (sweep 1, S1-1).
 *
 * The session cookie is scoped to the host, not the port, so the browser also sends it to every app
 * the owner opens on another port of the same server. An app that keeps what it is sent could replay
 * the cookie to BoxPilot; this proves that replay is refused and ends the session. Driven over a real
 * socket the way server/index.mjs mounts the routes, with the client address set as Tailscale Serve
 * sets it (X-Forwarded-For from loopback) and read through the same resolvers production uses.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createStateStore } from "./state.mjs";
import { createAuthService, hashPassword, sameClientAddress } from "./security.mjs";
import { createIdentityService, tailnetClientAddress } from "./identity.mjs";
import { createIdentityRouter } from "./routes/identity.mjs";

vi.setConfig({ testTimeout: 30_000 });

const password = "correct horse battery";
const addressChanged = "You were signed out because this sign-in came from a different network address. Sign in again.";
let directory; let state; let owner;
const servers = [];

/** An app mounted like index.mjs, with the given client-address resolver. */
async function serve(resolveClientAddress, extra = () => {}) {
  const auth = createAuthService(state, { resolveClientAddress });
  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  extra(app, auth);
  app.get("/api/v1/auth/status", auth.status);
  app.post("/api/v1/auth/login", auth.login);
  app.get("/api/v1/auth/sessions", auth.requireSession, auth.listSessions);
  app.use("/api/v1", auth.requireSession);
  app.post("/api/v1/thing", auth.requireCsrf, (_request, response) => response.json({ done: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, auth };
}

async function call(base, method, urlPath, { cookie = null, csrfToken = null, headers = {}, body = undefined } = {}) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...(csrfToken ? { "X-BoxPilot-CSRF": csrfToken } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed, setCookie: response.headers.getSetCookie?.() ?? [] };
}

const cookieFrom = (setCookie, name = "boxpilot_session") => setCookie.map((line) => line.split(";")[0]).find((pair) => pair.startsWith(`${name}=`)) ?? null;

async function signIn(base, headers = {}) {
  const result = await call(base, "POST", "/api/v1/auth/login", { headers, body: { username: "alex", password } });
  expect(result.status).toBe(200);
  return { cookie: cookieFrom(result.setCookie), csrfToken: result.body.csrfToken };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-session-binding-"));
  state = createStateStore({ stateDirectory: directory });
  owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: await hashPassword(password) });
});

afterAll(async () => {
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
  state?.close?.();
  await rm(directory, { recursive: true, force: true });
});

describe("one spelling per address", () => {
  it("compares loopback, IPv4-mapped, zoned and long IPv6 forms as the address they are", () => {
    expect(sameClientAddress("127.0.0.1", "::ffff:127.0.0.1")).toBe(true);
    expect(sameClientAddress("127.0.0.1", "::1")).toBe(true);
    expect(sameClientAddress("::1", "0:0:0:0:0:0:0:1")).toBe(true);
    expect(sameClientAddress("192.0.2.10", "::ffff:192.0.2.10")).toBe(true);
    expect(sameClientAddress("192.0.2.10", "::ffff:c000:20a")).toBe(true);
    expect(sameClientAddress("fe80::1%eth0", "fe80::1")).toBe(true);
    expect(sameClientAddress("2001:DB8::1", "2001:db8:0:0:0:0:0:1")).toBe(true);
    expect(sameClientAddress("192.0.2.10", "192.0.2.11")).toBe(false);
    expect(sameClientAddress("100.64.0.7", "127.0.0.1")).toBe(false);
    expect(sameClientAddress(null, "192.0.2.10")).toBe(false);
    expect(sameClientAddress("192.0.2.10", null)).toBe(false);
  });
});

describe("a session replayed from another address", () => {
  // Tailscale Serve trusted, as the resolver in production decides when Serve proxies this port.
  const throughServe = (address) => ({ "X-Forwarded-For": address });
  let app;
  beforeAll(async () => { app = await serve(async (request) => tailnetClientAddress(request, { trustForwarded: true })); });

  it("is not honoured, is ended, and the browser it belonged to is told why", async () => {
    const browser = await signIn(app.base, throughServe("100.64.0.7"));
    const own = await call(app.base, "GET", "/api/v1/auth/status", { cookie: browser.cookie, headers: throughServe("100.64.0.7") });
    expect(own.body).toMatchObject({ authenticated: true, owner: { username: "alex" } });

    // What the sweep proved: the same cookie from somewhere else came back with the owner and a CSRF token.
    const replayed = await call(app.base, "GET", "/api/v1/auth/status", { cookie: browser.cookie, headers: throughServe("100.64.0.99") });
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ authenticated: false, owner: null, csrfToken: null, signedOut: "address-changed" });

    // Ended, not just refused once: the browser it was issued to is signed out too, and told why.
    const after = await call(app.base, "GET", "/api/v1/auth/sessions", { cookie: browser.cookie, headers: throughServe("100.64.0.7") });
    expect(after.status).toBe(401);
    expect(after.body).toMatchObject({ code: "authentication_required", reason: "address-changed", error: addressChanged });
    const status = await call(app.base, "GET", "/api/v1/auth/status", { cookie: browser.cookie, headers: throughServe("100.64.0.7") });
    expect(status.body).toMatchObject({ authenticated: false, signedOut: "address-changed" });

    const audit = state.listAudit(20).find((event) => event.type === "session.address-changed");
    expect(audit?.details).toMatchObject({ from: "100.64.0.7", to: "100.64.0.99" });
  });

  it("refuses a change made with a replayed cookie and CSRF token, and answers in plain words", async () => {
    const browser = await signIn(app.base, throughServe("100.64.0.7"));
    const replayed = await call(app.base, "POST", "/api/v1/thing", { ...browser, headers: throughServe("100.64.0.42"), body: {} });
    expect(replayed.status).toBe(401);
    expect(replayed.body).toMatchObject({ code: "authentication_required", reason: "address-changed", error: addressChanged });
    expect((await call(app.base, "POST", "/api/v1/thing", { ...browser, headers: throughServe("100.64.0.7"), body: {} })).status).toBe(401);
  });

  it("keeps a browser whose address is written another way", async () => {
    const browser = await signIn(app.base, throughServe("::ffff:100.64.0.8"));
    const result = await call(app.base, "POST", "/api/v1/thing", { ...browser, headers: throughServe("100.64.0.8"), body: {} });
    expect(result.status).toBe(200);
  });

  it("does not let a cookie signed in on loopback be used through Serve, or the other way round", async () => {
    const local = await signIn(app.base);
    expect((await call(app.base, "GET", "/api/v1/auth/sessions", { cookie: local.cookie })).status).toBe(200);
    expect((await call(app.base, "GET", "/api/v1/auth/sessions", { cookie: local.cookie, headers: throughServe("100.64.0.7") })).status).toBe(401);

    const tailnet = await signIn(app.base, throughServe("100.64.0.7"));
    expect((await call(app.base, "GET", "/api/v1/auth/sessions", { cookie: tailnet.cookie })).status).toBe(401);
  });
});

describe("with the identity service deciding what Serve vouches for", () => {
  let app; let identity;
  const serveHeaders = (address, login = "alex@example.com") => ({ "X-Forwarded-For": address, "Tailscale-User-Login": login });

  beforeAll(async () => {
    // The identity service needs the port, which exists only once the app listens: route to it late.
    const late = new Proxy({}, { get: (_target, key) => (...args) => identity[key](...args) });
    app = await serve((request) => identity.clientAddress(request), (router, auth) => {
      router.use("/api/v1", createIdentityRouter({ store: state, auth, identity: late }));
    });
    // Serve proxies this very port, and every tailnet address here belongs to the owner's login.
    const run = async (_binary, args) => {
      if (args[0] === "serve") return { ok: true, stdout: JSON.stringify({ Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${app.port}` } } } } }) };
      if (args[0] === "whois") return { ok: true, stdout: JSON.stringify({ UserProfile: { LoginName: "alex@example.com", DisplayName: "Alex" }, Node: { Name: "laptop.tail1234.ts.net." } }) };
      return { ok: false, stdout: "" };
    };
    identity = createIdentityService({ store: state, run, webPort: app.port });
    identity.linkTailscale(owner.id, "alex@example.com");
  });

  it("refuses the cookie of a Serve sign-in when an app on this server replays it without Serve's labels", async () => {
    const browser = await signIn(app.base, serveHeaders("100.64.0.7"));
    expect((await call(app.base, "GET", "/api/v1/auth/sessions", { cookie: browser.cookie, headers: serveHeaders("100.64.0.7") })).status).toBe(200);
    const replayed = await call(app.base, "GET", "/api/v1/auth/sessions", { cookie: browser.cookie });
    expect(replayed.status).toBe(401);
    expect(replayed.body.reason).toBe("address-changed");
  });

  it("does not let a remembered browser's cookie sign in from another address without the password", async () => {
    const first = await call(app.base, "POST", "/api/v1/auth/tailscale", { headers: serveHeaders("100.64.0.7"), body: { password } });
    expect(first.status).toBe(200);
    const device = cookieFrom(first.setCookie, "boxpilot_device");
    expect(device).toBeTruthy();

    // The same browser, from the same address: the remembered device is enough.
    expect((await call(app.base, "POST", "/api/v1/auth/tailscale", { cookie: device, headers: serveHeaders("100.64.0.7"), body: {} })).status).toBe(200);

    // The device cookie carried off to another address is not: the password is asked for again.
    const elsewhere = await call(app.base, "POST", "/api/v1/auth/tailscale", { cookie: device, headers: serveHeaders("100.64.0.9"), body: {} });
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.body.code).toBe("device_password_required");
  });
});
