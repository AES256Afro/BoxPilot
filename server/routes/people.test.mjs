import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStateStore } from "../state.mjs";
import { createAuthService, hashPassword } from "../security.mjs";
import { createPeopleRouter } from "./people.mjs";

// Password hashing runs at production scrypt cost; CI runners need more than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

/*
 * Managing people over HTTP against a real state store, mounted the way index.mjs mounts it:
 * behind the session wall, with /people owner-only.
 */

const ownerPassword = "owner password 1";
const opened = [];
afterEach(async () => {
  for (const { server, state, directory } of opened.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    state.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});

async function boot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-people-"));
  const state = createStateStore({ stateDirectory: directory });
  state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: await hashPassword(ownerPassword) });
  const auth = createAuthService(state);
  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  app.post("/auth/login", auth.login);
  app.use(auth.requireSession);
  app.get("/whoami", (request, response) => response.json({ role: request.boxpilotSession.owner.role }));
  app.use("/people", auth.requireRole("owner"));
  app.use(createPeopleRouter({ state, auth }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  opened.push({ server, state, directory });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, as = null, csrf = true } = {}) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(as ? { Cookie: as.cookie } : {}), ...(as && csrf ? { "X-BoxPilot-CSRF": as.csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const signIn = async (username, password) => {
    const response = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
    const body = await response.json();
    return { status: response.status, cookie: response.headers.getSetCookie().map((line) => line.split(";")[0]).find((entry) => entry.startsWith("boxpilot_session=")) ?? null, csrf: body?.csrfToken ?? null };
  };
  const owner = await signIn("alex", ownerPassword);
  const add = (username, role, as = owner) => call("POST", "/people", { as, body: { password: ownerPassword, username, newPassword: `${username} password`, role } });
  return { state, call, signIn, owner, add };
}

describe("adding people", () => {
  it("adds an account with the role given, which signs in as that role", async () => {
    const { call, signIn, add } = await boot();
    const added = await add("olly", "operator");
    expect(added).toMatchObject({ status: 201, body: { account: { username: "olly", role: "operator" } } });
    expect(added.body.account).not.toHaveProperty("passwordHash");
    const olly = await signIn("olly", "olly password");
    expect((await call("GET", "/whoami", { as: olly })).body).toEqual({ role: "operator" });
  });

  it("needs the CSRF token and the owner's password, and changes nothing without them", async () => {
    const { state, call, owner } = await boot();
    const body = { username: "olly", newPassword: "olly password", role: "operator" };
    expect((await call("POST", "/people", { as: owner, csrf: false, body: { ...body, password: ownerPassword } })).status).toBe(403);
    expect(await call("POST", "/people", { as: owner, body: { ...body, password: "wrong password" } })).toMatchObject({ status: 401, body: { code: "reauthentication_required" } });
    expect(await call("POST", "/people", { as: owner, body })).toMatchObject({ status: 401 });
    expect(state.listOwners().map((account) => account.username)).toEqual(["alex"]);
  });

  it("refuses a bad user name, a short password, an unknown role and a taken name", async () => {
    const { call, owner, add } = await boot();
    for (const username of ["A", "Olly", "-olly", "o", "x".repeat(33), "olly/../root"]) {
      expect((await call("POST", "/people", { as: owner, body: { password: ownerPassword, username, newPassword: "long enough pass", role: "viewer" } })).body).toMatchObject({ code: "invalid_username" });
    }
    expect((await call("POST", "/people", { as: owner, body: { password: ownerPassword, username: "vic", newPassword: "short", role: "viewer" } })).body).toMatchObject({ code: "invalid_password" });
    expect(await add("vic", "superuser")).toMatchObject({ status: 400, body: { code: "people_rejected" } });
    expect(await add("vic", "disabled")).toMatchObject({ status: 400 });
    expect((await add("vic", "viewer")).status).toBe(201);
    expect(await add("vic", "viewer")).toMatchObject({ status: 400, body: { error: "That user name is already taken" } });
  });

  it("is the owner's alone: an operator or viewer can neither list nor add people", async () => {
    const { call, signIn, add } = await boot();
    await add("olly", "operator");
    await add("vic", "viewer");
    for (const who of [await signIn("olly", "olly password"), await signIn("vic", "vic password")]) {
      expect((await call("GET", "/people", { as: who })).status).toBe(403);
      expect((await add("eve", "owner", who)).status).toBe(403);
    }
    expect((await call("GET", "/people")).status).toBe(401);
  });
});

describe("changing roles and disabling accounts", () => {
  it("ends the account's sessions when its role changes, so the new role applies at once", async () => {
    const { call, signIn, owner, add } = await boot();
    const { body: { account } } = await add("olly", "operator");
    const olly = await signIn("olly", "olly password");
    expect(await call("PUT", `/people/${account.id}`, { as: owner, body: { password: ownerPassword, role: "viewer" } })).toMatchObject({ status: 200, body: { account: { role: "viewer" } } });
    expect((await call("GET", "/whoami", { as: olly })).status).toBe(401);
    expect((await call("GET", "/whoami", { as: await signIn("olly", "olly password") })).body).toEqual({ role: "viewer" });
  });

  it("disables an account: its sessions end and it cannot sign in again", async () => {
    const { call, signIn, owner, add } = await boot();
    const { body: { account } } = await add("olly", "operator");
    const olly = await signIn("olly", "olly password");
    expect(await call("DELETE", `/people/${account.id}`, { as: owner, body: { password: ownerPassword } })).toMatchObject({ status: 200, body: { account: { role: "disabled" } } });
    expect((await call("GET", "/whoami", { as: olly })).status).toBe(401);
    expect((await signIn("olly", "olly password")).cookie).toBeNull();
  });

  it("will not let the owner demote or disable the account they are signed in with, even with another owner", async () => {
    const { state, call, owner, add } = await boot();
    const self = state.listOwners()[0].id;
    // With a second owner the store's last-owner rule would allow both; the route's own check refuses.
    await add("sam", "owner");
    expect(await call("PUT", `/people/${self}`, { as: owner, body: { password: ownerPassword, role: "operator" } })).toMatchObject({ status: 400, body: { code: "people_rejected" } });
    expect(await call("DELETE", `/people/${self}`, { as: owner, body: { password: ownerPassword } })).toMatchObject({ status: 400 });
    expect(state.findOwnerById(self).role).toBe("owner");
  });

  it("asks for the password on every change, and says when the account does not exist", async () => {
    const { state, call, owner, add } = await boot();
    const { body: { account } } = await add("olly", "operator");
    expect((await call("PUT", `/people/${account.id}`, { as: owner, body: { password: "wrong password", role: "owner" } })).status).toBe(401);
    expect((await call("DELETE", `/people/${account.id}`, { as: owner, body: {} })).status).toBe(401);
    expect((await call("PUT", `/people/${account.id}`, { as: owner, csrf: false, body: { password: ownerPassword, role: "owner" } })).status).toBe(403);
    expect(state.findOwnerById(account.id).role).toBe("operator");
    expect((await call("PUT", "/people/nobody", { as: owner, body: { password: ownerPassword, role: "viewer" } })).status).toBe(404);
    expect((await call("DELETE", "/people/nobody", { as: owner, body: { password: ownerPassword } })).status).toBe(404);
    expect((await call("PUT", `/people/${account.id}`, { as: owner, body: { password: ownerPassword, role: "root" } })).status).toBe(400);
  });

  it("lets a second owner be demoted by the first", async () => {
    const { call, owner, add } = await boot();
    const { body: { account } } = await add("sam", "owner");
    expect(await call("PUT", `/people/${account.id}`, { as: owner, body: { password: ownerPassword, role: "operator" } })).toMatchObject({ status: 200, body: { account: { role: "operator" } } });
  });
});
