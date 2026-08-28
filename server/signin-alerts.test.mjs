/**
 * New sign-in alerts (M19.4): the owner is notified the first time their account signs in from an
 * address, after the first address is baselined silently. Driven over a real socket, with the client
 * address controlled through X-Forwarded-For (which the display descriptor reads) and a captured
 * notify.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStateStore } from "./state.mjs";
import { createAuthService, hashPassword } from "./security.mjs";

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
  const auth = createAuthService(state, { notify: async (payload) => { notified.push(payload); } });
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

    expect(await login("100.64.0.20")).toBe(200); // now known -> no further alert
    expect(notified).toHaveLength(1);
  });

  it("does not alert on a loopback sign-in", async () => {
    const before = notified.length;
    expect(await login(undefined)).toBe(200); // socket is 127.0.0.1, no forwarded address
    expect(notified).toHaveLength(before);
  });
});
