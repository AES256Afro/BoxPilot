import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStateStore } from "../state.mjs";
import { createAuthService, hashPassword, verifyPassword } from "../security.mjs";
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

/** @param {{ now?: () => number }} [options] `now` is the store's clock and the sign-in service's, for the elevated window. */
async function boot({ now = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-people-"));
  const state = createStateStore({ stateDirectory: directory, ...(now ? { now: () => new Date(now()) } : {}) });
  state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: await hashPassword(ownerPassword) });
  const auth = createAuthService(state, now ? { now } : {});
  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  app.post("/auth/login", auth.login);
  app.use(auth.requireSession);
  app.get("/whoami", (request, response) => response.json({ role: request.boxpilotSession.owner.role }));
  app.post("/auth/elevate", auth.requireCsrf, auth.elevate);
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

describe("inside the window a password already opened", () => {
  const start = Date.parse("2026-03-01T10:00:00Z");

  it("takes a change without the password again, on that session only, and only until the window ends", async () => {
    let at = start;
    const { state, call, signIn, owner, add } = await boot({ now: () => at });
    const { body: { account } } = await add("olly", "operator");
    const elsewhere = await signIn("alex", ownerPassword);
    // Nothing unlocked: no password is no change.
    expect(await call("PUT", `/people/${account.id}`, { as: owner, body: { role: "viewer" } })).toMatchObject({ status: 401, body: { code: "reauthentication_required" } });
    expect((await call("POST", "/auth/elevate", { as: owner, body: { password: ownerPassword } })).status).toBe(200);
    expect(await call("PUT", `/people/${account.id}`, { as: owner, body: { role: "viewer" } })).toMatchObject({ status: 200, body: { account: { role: "viewer" } } });
    expect((await call("POST", "/people", { as: owner, body: { username: "vic", newPassword: "vic password 1", role: "viewer" } })).status).toBe(201);
    // The same account's other session unlocked nothing.
    expect((await call("PUT", `/people/${account.id}`, { as: elsewhere, body: { role: "operator" } })).status).toBe(401);
    // A password that is sent is still checked, window or not.
    expect((await call("PUT", `/people/${account.id}`, { as: owner, body: { password: "wrong password", role: "operator" } })).status).toBe(401);
    at += 10 * 60_000 + 1;
    expect((await call("PUT", `/people/${account.id}`, { as: owner, body: { role: "operator" } })).status).toBe(401);
    expect(state.findOwnerById(account.id).role).toBe("viewer");
  });

  it("asks for the password all the same when every approval does", async () => {
    const { state, call, owner, add } = await boot({ now: () => start });
    const { body: { account } } = await add("olly", "operator");
    await call("POST", "/auth/elevate", { as: owner, body: { password: ownerPassword } });
    state.setSetting("approvalMode", "always-password");
    expect((await call("DELETE", `/people/${account.id}`, { as: owner, body: {} })).status).toBe(401);
    expect((await call("DELETE", `/people/${account.id}`, { as: owner, body: { password: ownerPassword } })).status).toBe(200);
  });

  it("does not count a change sent without a password as a wrong one", async () => {
    const { state, call, owner, add } = await boot({ now: () => start });
    const { body: { account } } = await add("olly", "operator");
    for (let attempt = 0; attempt < 8; attempt += 1) expect((await call("DELETE", `/people/${account.id}`, { as: owner, body: {} })).status).toBe(401);
    expect(state.listAudit(50).filter((event) => event.type === "auth.failed")).toEqual([]);
    expect((await call("DELETE", `/people/${account.id}`, { as: owner, body: { password: ownerPassword } })).status).toBe(200);
  });
});

describe("setting a member's password", () => {
  it("gives them a new one, ends their sessions and says who did it", async () => {
    const { state, call, signIn, owner, add } = await boot();
    const { body: { account } } = await add("olly", "operator");
    const olly = await signIn("olly", "olly password");
    expect(await call("POST", `/people/${account.id}/password`, { as: owner, body: { password: ownerPassword, newPassword: "a fresh password" } }))
      .toEqual({ status: 200, body: { account: { id: account.id, username: "olly", role: "operator" }, sessionsEnded: 1 } });
    expect((await call("GET", "/whoami", { as: olly })).status).toBe(401);
    expect((await signIn("olly", "olly password")).cookie).toBeNull();
    expect((await call("GET", "/whoami", { as: await signIn("olly", "a fresh password") })).body).toEqual({ role: "operator" });
    expect(state.listAudit(20).find((event) => event.type === "people.password.set")).toMatchObject({ actorId: state.listOwners()[0].id, subjectId: account.id, details: { username: "olly" } });
    // The owner's own session is untouched.
    expect((await call("GET", "/whoami", { as: owner })).status).toBe(200);
  });

  it("needs the owner, the CSRF token, and the password or the unlocked window", async () => {
    const { state, call, signIn, owner, add } = await boot();
    const { body: { account } } = await add("olly", "operator");
    const { body: { account: vic } } = await add("vic", "viewer");
    const before = state.findOwnerById(vic.id).passwordHash;
    const body = { password: ownerPassword, newPassword: "a fresh password" };
    expect((await call("POST", `/people/${vic.id}/password`, { as: owner, csrf: false, body })).status).toBe(403);
    expect((await call("POST", `/people/${vic.id}/password`, { as: owner, body: { newPassword: body.newPassword } })).status).toBe(401);
    expect((await call("POST", `/people/${vic.id}/password`, { as: owner, body: { ...body, password: "wrong password" } })).status).toBe(401);
    // Not an operator, with their own password or anyone's, for themselves or another.
    const olly = await signIn("olly", "olly password");
    for (const id of [vic.id, account.id]) expect((await call("POST", `/people/${id}/password`, { as: olly, body: { password: "olly password", newPassword: body.newPassword } })).status).toBe(403);
    expect((await call("POST", `/people/${vic.id}/password`, { body })).status).toBe(401);
    expect(state.findOwnerById(vic.id).passwordHash).toBe(before);
    await call("POST", "/auth/elevate", { as: owner, body: { password: ownerPassword } });
    expect((await call("POST", `/people/${vic.id}/password`, { as: owner, body: { newPassword: body.newPassword } })).status).toBe(200);
  });

  it("refuses the owner's own account, a short or over-long password, a disabled account and one that is not there", async () => {
    const { state, call, owner, add } = await boot();
    const self = state.listOwners()[0].id;
    const { body: { account } } = await add("olly", "operator");
    expect(await call("POST", `/people/${self}/password`, { as: owner, body: { password: ownerPassword, newPassword: "a fresh password" } })).toMatchObject({ status: 400, body: { code: "people_rejected" } });
    for (const newPassword of ["short", "x".repeat(257), 123456789012, null, ["a fresh password"], { length: 20 }]) {
      expect(await call("POST", `/people/${account.id}/password`, { as: owner, body: { password: ownerPassword, newPassword } })).toMatchObject({ status: 400, body: { code: "invalid_password" } });
    }
    expect((await call("POST", "/people/nobody/password", { as: owner, body: { password: ownerPassword, newPassword: "a fresh password" } })).status).toBe(404);
    await call("DELETE", `/people/${account.id}`, { as: owner, body: { password: ownerPassword } });
    expect((await call("POST", `/people/${account.id}/password`, { as: owner, body: { password: ownerPassword, newPassword: "a fresh password" } })).status).toBe(400);
    expect(await verifyPassword(ownerPassword, state.findOwnerById(self).passwordHash)).toBe(true);
  });
});
