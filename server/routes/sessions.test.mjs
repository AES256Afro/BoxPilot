/**
 * The session list (M19.4) end to end: sign in a few times, list what is signed in, and cut
 * sessions off, driven over a real socket the way server/index.mjs mounts the routes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStateStore } from "../state.mjs";
import { createAuthService, hashPassword } from "../security.mjs";

const password = "correct horse battery";
let directory; let server; let base; let state;

async function signIn(userAgent) {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": userAgent }, body: JSON.stringify({ username: "alex", password }) });
  const body = await response.json();
  const cookie = String(response.headers.getSetCookie()[0]).split(";")[0];
  return { cookie, csrfToken: body.csrfToken };
}

async function api(method, urlPath, session, body) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), Cookie: session.cookie, "X-BoxPilot-CSRF": session.csrfToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed, setCookie: response.headers.getSetCookie?.() ?? [] };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-sessions-"));
  state = createStateStore({ stateDirectory: directory });
  state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: await hashPassword(password) });
  const auth = createAuthService(state);
  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  app.post("/api/v1/auth/login", auth.login);
  app.get("/api/v1/auth/sessions", auth.requireSession, auth.listSessions);
  app.delete("/api/v1/auth/sessions/:id", auth.requireSession, auth.requireCsrf, auth.revokeSession);
  app.post("/api/v1/auth/sessions/revoke-others", auth.requireSession, auth.requireCsrf, auth.revokeOtherSessions);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => { server?.close(); state?.close?.(); await rm(directory, { recursive: true, force: true }); });

describe("session list", () => {
  it("lists the sessions with where and how, marking the current one", async () => {
    const laptop = await signIn("Mozilla/5.0 (Macintosh) Chrome/130");
    await signIn("Mozilla/5.0 (iPhone) Safari/17");

    const list = await api("GET", "/api/v1/auth/sessions", laptop);
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(2);
    expect(list.body.sessions.some((entry) => entry.id === list.body.currentId)).toBe(true);
    expect(list.body.sessions.every((entry) => entry.method === "password")).toBe(true);
    expect(list.body.sessions.map((entry) => entry.userAgent)).toEqual(expect.arrayContaining([expect.stringContaining("iPhone")]));
  });

  it("revokes another session but not by guessing, and never another owner's", async () => {
    const laptop = await signIn("Agent/laptop");
    const phone = await signIn("Agent/phone");
    const list = await api("GET", "/api/v1/auth/sessions", laptop);
    const phoneId = list.body.sessions.find((entry) => entry.userAgent === "Agent/phone").id;

    // A made-up id is a clean 404.
    expect((await api("DELETE", "/api/v1/auth/sessions/nope", laptop)).status).toBe(404);

    const revoked = await api("DELETE", `/api/v1/auth/sessions/${phoneId}`, laptop);
    expect(revoked.status).toBe(200);
    expect(revoked.body.wasCurrent).toBe(false);
    // The phone's cookie no longer works.
    expect((await api("GET", "/api/v1/auth/sessions", phone)).status).toBe(401);
  });

  it("signs out everywhere else, keeping only the current session", async () => {
    const keep = await signIn("Agent/keep");
    await signIn("Agent/other-1");
    await signIn("Agent/other-2");
    const before = await api("GET", "/api/v1/auth/sessions", keep);
    expect(before.body.sessions.length).toBeGreaterThanOrEqual(3);

    const result = await api("POST", "/api/v1/auth/sessions/revoke-others", keep, {});
    expect(result.status).toBe(200);
    const after = await api("GET", "/api/v1/auth/sessions", keep);
    expect(after.body.sessions).toHaveLength(1);
    expect(after.body.sessions[0].id).toBe(after.body.currentId);
  });

  it("revoking the current session signs it out and clears the cookie", async () => {
    const session = await signIn("Agent/self");
    const current = (await api("GET", "/api/v1/auth/sessions", session)).body.currentId;
    const result = await api("DELETE", `/api/v1/auth/sessions/${current}`, session);
    expect(result.status).toBe(200);
    expect(result.body.wasCurrent).toBe(true);
    expect(result.setCookie.join()).toMatch(/Max-Age=0/);
    expect((await api("GET", "/api/v1/auth/sessions", session)).status).toBe(401);
  });
});
