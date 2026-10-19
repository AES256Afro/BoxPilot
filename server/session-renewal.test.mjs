import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStateStore } from "./state.mjs";
import { createAuthService, hashPassword, sessionMaxAgeMs } from "./security.mjs";

// Password hashing runs at production scrypt cost; CI runners need more than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

/*
 * A session in use stays alive: past half its twelve hours, a request gives it a fresh twelve,
 * up to three days from the sign-in. The store and the auth service share one clock here.
 */

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

async function boot() {
  let clock = Date.parse("2026-10-19T08:00:00.000Z");
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-renewal-"));
  const state = createStateStore({ stateDirectory: directory, now: () => new Date(clock) });
  state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: await hashPassword("owner password 1") });
  const auth = createAuthService(state, { now: () => clock });
  const app = express();
  app.use(express.json());
  app.post("/auth/login", auth.login);
  app.get("/auth/status", auth.status);
  app.get("/ping", auth.requireSession, (request, response) => response.json({ expiresAt: request.boxpilotSession.expiresAt }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  opened.push({ server, state, directory });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "alex", password: "owner password 1" }) });
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const signedInAt = clock;
  const ping = async () => {
    const response = await fetch(`${base}/ping`, { headers: { Cookie: cookie } });
    return { status: response.status, body: response.status === 200 ? await response.json() : null, setCookie: response.headers.getSetCookie(), expiresHeader: response.headers.get("x-boxpilot-session-expires") };
  };
  return { ping, signedInAt, advance: (ms) => { clock += ms; }, now: () => clock, status: async () => (await fetch(`${base}/auth/status`, { headers: { Cookie: cookie } })).json() };
}

describe("keeping a session in use alive", () => {
  it("leaves the end alone for the first half, then gives a fresh twelve hours and a matching cookie", async () => {
    const { ping, signedInAt, advance, now, status } = await boot();
    advance(5 * hour);
    const early = await ping();
    expect(Date.parse(early.body.expiresAt)).toBe(signedInAt + 12 * hour);
    expect(early.setCookie).toEqual([]);
    expect(early.expiresHeader).toBeNull();
    advance(2 * hour);
    const renewed = await ping();
    expect(Date.parse(renewed.body.expiresAt)).toBe(now() + 12 * hour);
    expect(renewed.setCookie[0]).toMatch(new RegExp(`Max-Age=${12 * 60 * 60}`));
    // The page hears the new end too, so its sign-out timer and notice move with it.
    expect(renewed.expiresHeader).toBe(renewed.body.expiresAt);
    expect(Date.parse((await status()).expiresAt)).toBe(now() + 12 * hour);
    // A request right after does not renew again.
    advance(60_000);
    expect((await ping()).setCookie).toEqual([]);
  });

  it("never keeps a session past three days from the sign-in, however busy", async () => {
    const { ping, signedInAt, advance } = await boot();
    for (let elapsed = 0; elapsed < sessionMaxAgeMs - 7 * hour; elapsed += 7 * hour) {
      advance(7 * hour);
      expect((await ping()).status).toBe(200);
    }
    const last = await ping();
    expect(Date.parse(last.body.expiresAt)).toBeLessThanOrEqual(signedInAt + sessionMaxAgeMs);
    advance(sessionMaxAgeMs);
    expect((await ping()).status).toBe(401);
  });

  it("lets a session nobody used run out as before", async () => {
    const { ping, advance } = await boot();
    advance(12 * hour + 1);
    expect((await ping()).status).toBe(401);
  });
});
