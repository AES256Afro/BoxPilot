import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStateStore } from "./state.mjs";
import { createAuthService, hashPassword } from "./security.mjs";

// Password hashing runs at production scrypt cost; CI runners need more than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

/*
 * The account flows end to end, over HTTP against a real state store: claiming the server with a
 * bootstrap token, changing a password, and the guards every other route stands behind.
 */

const opened = [];
afterEach(async () => {
  for (const { server, state, directory } of opened.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    state.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});

async function boot({ owner = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-auth-flows-"));
  const state = createStateStore({ stateDirectory: directory });
  if (owner) state.consumeBootstrapToken(state.createBootstrapToken().token, { username: owner.username, passwordHash: await hashPassword(owner.password) });
  const auth = createAuthService(state);
  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  app.post("/auth/bootstrap", auth.bootstrap);
  app.post("/auth/login", auth.login);
  app.post("/auth/password", auth.requireSession, auth.requireCsrf, auth.changePassword);
  app.get("/owner-only", auth.requireSession, auth.requireRole("owner"), (_request, response) => response.json({ ok: true }));
  app.get("/no-session-guard", auth.requireRole("owner"), (_request, response) => response.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  opened.push({ server, state, directory });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, cookie, csrf } = {}) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-BoxPilot-CSRF": csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const cookies = response.headers.getSetCookie().map((line) => line.split(";")[0]);
    return { status: response.status, body: text ? JSON.parse(text) : null, cookie: cookies.find((entry) => entry.startsWith("boxpilot_session=")) ?? null };
  };
  const signIn = async (username, password) => {
    const result = await call("POST", "/auth/login", { body: { username, password } });
    return { ...result, csrf: result.body?.csrfToken ?? null };
  };
  return { state, call, signIn };
}

describe("claiming a new server", () => {
  it("takes a valid bootstrap token once, and signs the new owner in", async () => {
    const { state, call } = await boot();
    const { token } = state.createBootstrapToken();
    const made = await call("POST", "/auth/bootstrap", { body: { username: "alex", password: "correct horse battery", bootstrapToken: token } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ authenticated: true, owner: { username: "alex", role: "owner" } });
    expect(made.cookie).toMatch(/^boxpilot_session=.+/);
    // Claimed: a second set-up is refused whatever it carries, the same token included.
    const again = await call("POST", "/auth/bootstrap", { body: { username: "mallory", password: "correct horse battery", bootstrapToken: token } });
    expect(again).toMatchObject({ status: 409, body: { code: "already_bootstrapped" } });
    expect(state.ownerCount()).toBe(1);
  });

  it("refuses a missing, short or unknown token, and bad credentials, before making anyone", async () => {
    const { state, call } = await boot();
    const short = await call("POST", "/auth/bootstrap", { body: { username: "alex", password: "correct horse battery", bootstrapToken: "short" } });
    expect(short).toMatchObject({ status: 400, body: { code: "invalid_bootstrap" } });
    const weak = await call("POST", "/auth/bootstrap", { body: { username: "a", password: "short", bootstrapToken: "x".repeat(40) } });
    expect(weak.status).toBe(400);
    const unknown = await call("POST", "/auth/bootstrap", { body: { username: "alex", password: "correct horse battery", bootstrapToken: "y".repeat(40) } });
    expect(unknown).toMatchObject({ status: 401, body: { code: "bootstrap_rejected" } });
    expect(state.ownerCount()).toBe(0);
  });

  it("caps set-up attempts from one address at twenty a minute", async () => {
    const { call } = await boot();
    const statuses = [];
    for (let attempt = 0; attempt < 21; attempt += 1) statuses.push((await call("POST", "/auth/bootstrap", { body: { username: "alex", password: "correct horse battery", bootstrapToken: "z".repeat(40) } })).status);
    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe("changing a password", () => {
  const owner = { username: "alex", password: "correct horse battery" };

  it("needs the current password, a new one of 12 to 256 characters, and a different one", async () => {
    const { call, signIn } = await boot({ owner });
    const { cookie, csrf } = await signIn(owner.username, owner.password);
    const change = (body) => call("POST", "/auth/password", { body, cookie, csrf });
    expect(await change({ currentPassword: "not my password!", newPassword: "a brand new password" })).toMatchObject({ status: 401, body: { code: "invalid_credentials" } });
    expect(await change({ currentPassword: owner.password, newPassword: "too short" })).toMatchObject({ status: 400, body: { code: "invalid_password" } });
    expect(await change({ currentPassword: owner.password, newPassword: "x".repeat(257) })).toMatchObject({ status: 400, body: { code: "invalid_password" } });
    expect(await change({ currentPassword: owner.password, newPassword: owner.password })).toMatchObject({ status: 400, body: { error: "Choose a different password" } });
  });

  it("keeps this session, ends every other, and only the new password signs in after", async () => {
    const { call, signIn } = await boot({ owner });
    const here = await signIn(owner.username, owner.password);
    const elsewhere = await signIn(owner.username, owner.password);
    expect((await call("GET", "/owner-only", { cookie: elsewhere.cookie })).status).toBe(200);
    const changed = await call("POST", "/auth/password", { body: { currentPassword: owner.password, newPassword: "a brand new password" }, cookie: here.cookie, csrf: here.csrf });
    expect(changed).toMatchObject({ status: 200, body: { changed: true } });
    expect((await call("GET", "/owner-only", { cookie: here.cookie })).status).toBe(200);
    expect((await call("GET", "/owner-only", { cookie: elsewhere.cookie })).status).toBe(401);
    expect((await signIn(owner.username, owner.password)).status).toBe(401);
    expect((await signIn(owner.username, "a brand new password")).status).toBe(200);
  });

  it("is refused without the session's CSRF token", async () => {
    const { call, signIn } = await boot({ owner });
    const { cookie } = await signIn(owner.username, owner.password);
    expect(await call("POST", "/auth/password", { body: { currentPassword: owner.password, newPassword: "a brand new password" }, cookie })).toMatchObject({ status: 403, body: { code: "csrf_required" } });
    expect(await call("POST", "/auth/password", { body: { currentPassword: owner.password, newPassword: "a brand new password" }, cookie, csrf: "not-the-token" })).toMatchObject({ status: 403, body: { code: "csrf_required" } });
  });
});

describe("the role guard", () => {
  it("lets the role through, turns another role away, and never defaults an absent session to a role", async () => {
    const owner = { username: "alex", password: "correct horse battery" };
    const { state, call, signIn } = await boot({ owner });
    state.createOwnerAccount({ username: "vic", passwordHash: await hashPassword("viewer password!"), role: "viewer", createdBy: null });
    const alex = await signIn(owner.username, owner.password);
    const vic = await signIn("vic", "viewer password!");
    expect((await call("GET", "/owner-only", { cookie: alex.cookie })).status).toBe(200);
    expect(await call("GET", "/owner-only", { cookie: vic.cookie })).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect((await call("GET", "/owner-only")).status).toBe(401);
    // Mounted without requireSession ahead of it, the guard refuses rather than granting anything.
    expect(await call("GET", "/no-session-guard", { cookie: alex.cookie })).toMatchObject({ status: 401, body: { code: "unauthenticated" } });
  });
});
