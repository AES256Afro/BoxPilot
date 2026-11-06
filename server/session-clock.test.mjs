/**
 * The auth service answers to the clock it is given (M53.1).
 *
 * `createAuthService` has taken a `now` since sessions could be renewed, and honoured it there and
 * nowhere else: the elevation window, the "signed out because the address changed" memory, a
 * trusted device's `createdAt` and the time inside the new-sign-in push all read the wall clock.
 * Both numbers are the same in production, so nothing was wrong; what was missing is this file.
 * The elevation window is the deadline behind every high-risk approval and every revealed secret,
 * and until the clock reached it there was no way to test that it ends.
 *
 * A trusted device's `createdAt` is not here: `rememberDevice` is only reachable through identity
 * sign-in, and the test written for it asserted on a record the test itself had written, so it
 * passed against the wall-clock code too. A test that cannot fail is worse than none; that field is
 * covered by reading it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStateStore } from "./state.mjs";
import { createAuthService, hashPassword } from "./security.mjs";
import { approvalRequirement, elevationTtlMs } from "./ops/risk.mjs";

// Password hashing runs at production scrypt cost.
vi.setConfig({ testTimeout: 60_000 });

const password = "correct horse battery";
const hour = 60 * 60 * 1000;
const opened = [];

afterEach(async () => {
  for (const { server, state, directory } of opened.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    state.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * An auth service and the store behind it on one movable clock, mounted over a real socket the way
 * index.mjs does. `addressIs` sets what the client address resolves to, so a session can be
 * presented from somewhere else without touching the socket.
 */
async function boot({ notify = null } = {}) {
  let clock = Date.parse("2026-10-19T08:00:00.000Z");
  let address = "100.64.0.10";
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-session-clock-"));
  const state = createStateStore({ stateDirectory: directory, now: () => new Date(clock) });
  const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: await hashPassword(password) });
  const auth = createAuthService(state, { now: () => clock, resolveClientAddress: async () => address, notify });
  const app = express();
  app.use(express.json());
  app.post("/auth/login", auth.login);
  app.get("/auth/status", auth.status);
  app.use("/api", auth.requireSession);
  app.post("/api/elevate", auth.requireCsrf, auth.elevate);
  app.get("/api/ping", (_request, response) => response.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  opened.push({ server, state, directory });
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "alex", password }) });
  const body = await login.json();
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const get = async (urlPath) => {
    const response = await fetch(`${base}${urlPath}`, { headers: { Cookie: cookie } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return {
    owner,
    state,
    advance: (ms) => { clock += ms; },
    now: () => clock,
    addressIs: (value) => { address = value; },
    status: () => get("/auth/status"),
    ping: () => get("/api/ping"),
    elevate: async () => {
      const response = await fetch(`${base}/api/elevate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie, "X-BoxPilot-CSRF": body.csrfToken },
        body: JSON.stringify({ password }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  };
}

describe("the elevated window", () => {
  it("ends ten minutes after the clock says it started, not ten minutes after the wall clock", async () => {
    const { elevate, now, status } = await boot();
    const unlocked = await elevate();
    expect(unlocked.status).toBe(200);
    // The whole point: the deadline is on the service's clock. Read from Date.now() it would be
    // weeks away from this fixture's date.
    expect(Date.parse(unlocked.body.elevatedUntil)).toBe(now() + elevationTtlMs);
    expect(Date.parse((await status()).body.elevatedUntil)).toBe(now() + elevationTtlMs);
  });

  it("stops excusing a high-risk approval from its password once it has passed", async () => {
    const { elevate, advance, now, status } = await boot();
    const { body: unlocked } = await elevate();
    const high = (at) => approvalRequirement({ jobType: "application.pi-hole.deploy", elevatedUntil: unlocked.elevatedUntil, now: () => new Date(at) });

    expect(high(now())).toMatchObject({ tier: "high", passwordRequired: false, elevated: true });
    advance(elevationTtlMs - 1000);
    expect(high(now())).toMatchObject({ passwordRequired: false, elevated: true });
    advance(2000);
    expect(high(now())).toMatchObject({ passwordRequired: true, elevated: false });
    // The session itself is still good; only the unlock has lapsed.
    expect((await status()).body.authenticated).toBe(true);
  });
});

describe("why this browser was signed out", () => {
  it("is remembered for the session's lifetime on the given clock, and no longer", async () => {
    const { ping, status, addressIs, advance } = await boot();
    expect((await ping()).status).toBe(200);

    // The cookie comes back from somewhere else: the session ends, and this browser is told why.
    addressIs("203.0.113.9");
    expect((await ping()).status).toBe(401);
    expect((await status()).body.signedOut).toBe("address-changed");

    // Still within the twelve hours the memory is kept for.
    advance(11 * hour);
    expect((await status()).body.signedOut).toBe("address-changed");

    // Past them it is only "the session ended", which is all a restart could have said anyway.
    advance(2 * hour);
    expect((await status()).body.signedOut).toBeUndefined();
  });
});

describe("the new-sign-in alert", () => {
  it("puts the service's clock in the words, because the push can arrive hours later", async () => {
    const sent = [];
    // The first address on an account is baselined silently, so sign in once, then move.
    const { addressIs, state, owner } = await boot({ notify: (message) => { sent.push(message); } });
    expect(sent).toEqual([]);
    addressIs("203.0.113.9");

    const clock = Date.parse("2026-10-19T08:00:00.000Z");
    const auth = createAuthService(state, { now: () => clock, resolveClientAddress: async () => "203.0.113.9", notify: (message) => { sent.push(message); } });
    const app = express();
    app.use(express.json());
    app.post("/auth/login", auth.login);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    opened.push({ server, state: { close: () => {} }, directory: await mkdtemp(path.join(os.tmpdir(), "boxpilot-session-clock-note-")) });
    await fetch(`http://127.0.0.1:${server.address().port}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "alex", password }) });

    const alert = sent.find((message) => message.key?.startsWith("signin.new:"));
    expect(alert).toBeTruthy();
    expect(alert.message).toContain(new Date(clock).toLocaleString());
    expect(alert.message).toContain("203.0.113.9");
    expect(owner.id).toBeTruthy();
  });
});
