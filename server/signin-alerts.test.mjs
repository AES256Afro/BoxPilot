/**
 * New sign-in alerts (M19.4): the owner is notified the first time their account signs in from an
 * address, after the first address is baselined silently. Driven over a real socket, with the client
 * address controlled through X-Forwarded-For as Tailscale Serve sets it (the resolver below stands
 * in for identity.clientAddress with Serve in front) and a captured notify.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStateStore } from "./state.mjs";
import { createAuthService, hashPassword } from "./security.mjs";
import { tailnetClientAddress } from "./identity.mjs";

const password = "correct horse battery";
let directory; let server; let base; let state; let notified;

async function login(forwardedFor) {
  const response = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Test/1.0", ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}) },
    body: JSON.stringify({ username: "alex", password }),
  });
  return response.status;
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-signin-"));
  state = createStateStore({ stateDirectory: directory });
  state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "alex", passwordHash: await hashPassword(password) });
  notified = [];
  const auth = createAuthService(state, { notify: async (payload) => { notified.push(payload); }, resolveClientAddress: async (request) => tailnetClientAddress(request, { trustForwarded: true }) });
  const app = express();
  app.use(express.json({ limit: "256kb", strict: true }));
  app.post("/api/v1/auth/login", auth.login);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => { server?.close(); state?.close?.(); await rm(directory, { recursive: true, force: true }); });

describe("new sign-in alerts", () => {
  it("baselines the first address silently, then alerts on a genuinely new one", async () => {
    expect(await login("100.64.0.10")).toBe(200); // first ever -> baseline, no alert
    expect(notified).toHaveLength(0);

    expect(await login("100.64.0.10")).toBe(200); // same address -> known, no alert
    expect(notified).toHaveLength(0);

    expect(await login("100.64.0.20")).toBe(200); // a new address -> alert
    expect(notified).toHaveLength(1);
    expect(notified[0].title).toMatch(/New sign-in/);
    expect(notified[0].message).toContain("100.64.0.20");
    expect(notified[0].priority).toBe("high");
    // A passkey or recovery codes made from a stolen session outlast a new password and a signed-out
    // session, so the advice names all of it (sweep 3).
    expect(notified[0].message).toMatch(/If this wasn't you, change your password, then in Settings, Account & sign-in, review Where you're signed in and Passkeys, and make new recovery codes: .+ still works after the password changes\.$/);
    // One ledger entry per account and address if the push reaches no one (M27.2).
    expect(notified[0].key).toMatch(/^signin\.new:.+:100\.64\.0\.20$/);

    expect(await login("100.64.0.20")).toBe(200); // now known -> no further alert
    expect(notified).toHaveLength(1);
  });

  it("does not alert on a loopback sign-in", async () => {
    const before = notified.length;
    expect(await login(undefined)).toBe(200); // socket is 127.0.0.1, no forwarded address
    expect(notified).toHaveLength(before);
  });
});

describe("where a sign-in came from", () => {
  // X-Forwarded-For was read from anyone: a caller on the LAN sending "127.0.0.1" suppressed the
  // alert (loopback is ignored) and put a false address on the session row and in the audit log.
  function direct(auth, remoteAddress, headers = {}) {
    const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    const request = { socket: { remoteAddress }, headers: lower, body: { username: "alex", password }, get: (name) => lower[name.toLowerCase()] };
    const sent = {};
    const response = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { sent.body = body; return this; }, getHeader(name) { return this.headers[name]; }, setHeader(name, value) { this.headers[name] = value; } };
    return auth.login(request, response).then(() => ({ status: response.statusCode, body: sent.body }));
  }

  it("ignores a forwarded address that no trusted proxy vouched for", async () => {
    const auth = createAuthService(state, { notify: async (payload) => { notified.push(payload); } });
    const before = notified.length;
    expect((await direct(auth, "192.168.1.50", { "X-Forwarded-For": "127.0.0.1" })).status).toBe(200);
    expect(notified).toHaveLength(before + 1);
    expect(notified.at(-1).message).toContain("192.168.1.50");
    expect(state.listSessions(state.findOwnerByUsername("alex").id).map((session) => session.address)).toContain("192.168.1.50");
  });

  it("takes the tailnet peer from the resolver that knows Serve is in front", async () => {
    const auth = createAuthService(state, { notify: async (payload) => { notified.push(payload); }, resolveClientAddress: async () => "100.64.0.30" });
    const before = notified.length;
    expect((await direct(auth, "127.0.0.1", { "X-Forwarded-For": "100.64.0.30" })).status).toBe(200);
    expect(notified).toHaveLength(before + 1);
    expect(notified.at(-1).message).toContain("100.64.0.30");
  });
});
