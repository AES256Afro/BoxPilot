import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsRouter } from "./settings.mjs";

/*
 * The settings that decide where data and alerts leave the box, and how jobs are approved: only
 * the owner changes them, each change asks the owner's password, and a refused change leaves the
 * setting as it was. The store, notifier and auth are small fakes; the session is named by the
 * x-test-session header and the CSRF token is "csrf".
 */

const accounts = {
  alex: { id: "alex", username: "alex", role: "owner" },
  olly: { id: "olly", username: "olly", role: "operator" },
  vic: { id: "vic", username: "vic", role: "viewer" },
};
const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } });

async function serve({ sendFails = false } = {}) {
  const settings = new Map([["backupDestination", { host: "backup.example", port: 22, user: "boxpilot", path: "/srv/backup" }]]);
  const audit = [];
  const sent = [];
  let target = { kind: "ntfy", url: "https://ntfy.example", topic: "secret-topic" };
  const state = {
    findOwnerById: (id) => accounts[id] ?? null,
    getSetting: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
    setSetting: (key, value) => { settings.set(key, value); },
    recordAudit: (action, details) => { audit.push([action, details.actorId, details.details]); },
  };
  const notifications = {
    describe: () => ({ configured: Boolean(target), kind: target?.kind ?? null, url: target?.url ?? null, topic: target?.topic ?? null }),
    setTarget: (next) => { if (next && !/^https:\/\//.test(next.url ?? "")) throw new Error("The URL must start with https://"); target = next; },
    send: async (message) => { if (sendFails) throw new Error("ntfy answered 500"); sent.push(message.title); return { sent: true }; },
  };
  const auth = {
    requireRole: (...roles) => (request, response, next) => (roles.includes(request.boxpilotSession.owner.role) ? next() : response.status(403).json({ code: "forbidden" })),
    requireCsrf: (request, response, next) => (request.get("x-boxpilot-csrf") === "csrf" ? next() : response.status(403).json({ code: "csrf_required" })),
    checkPassword: async (_request, account, password) => ({ ok: Boolean(account) && password === "right password", blocked: password === "throttled" }),
    rejectThrottled: (response) => response.status(429).json({ code: "too_many_attempts" }),
  };
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => { const owner = accounts[request.get("x-test-session") ?? ""]; if (!owner) return response.status(401).end(); request.boxpilotSession = { owner }; return next(); });
  app.use(createSettingsRouter({ state, notifications, notificationHistory: null, auth }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { as = "alex", body, csrf = true } = {}) => {
    const response = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", "x-test-session": as, ...(csrf ? { "x-boxpilot-csrf": "csrf" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { call, settings, audit, sent, target: () => target };
}

const elsewhere = { host: "attacker.example", port: 2222, user: "eve", path: "/loot/" };

describe("the backup destination", () => {
  it("is changed by the owner with the password, normalised and audited", async () => {
    const { call, settings, audit } = await serve();
    expect(await call("PUT", "/settings/backup-destination", { body: { password: "right password", destination: elsewhere } })).toMatchObject({ status: 200, body: { destination: { host: "attacker.example", port: 2222, user: "eve", path: "/loot" } } });
    expect(settings.get("backupDestination")).toEqual({ host: "attacker.example", port: 2222, user: "eve", path: "/loot" });
    expect(audit).toEqual([["settings.backup-destination.changed", "alex", { host: "attacker.example", user: "eve", path: "/loot", port: 2222 }]]);
    expect(await call("PUT", "/settings/backup-destination", { body: { password: "right password", destination: null } })).toEqual({ status: 200, body: { destination: null, lastSync: null } });
  });

  it("stays where it was for anyone else, without the password, without CSRF, or with a bad address", async () => {
    const { call, settings } = await serve();
    const before = settings.get("backupDestination");
    expect((await call("PUT", "/settings/backup-destination", { as: "olly", body: { password: "right password", destination: elsewhere } })).status).toBe(403);
    expect((await call("PUT", "/settings/backup-destination", { as: "vic", body: { password: "right password", destination: null } })).status).toBe(403);
    expect(await call("PUT", "/settings/backup-destination", { body: { password: "wrong password", destination: elsewhere } })).toMatchObject({ status: 401, body: { code: "reauthentication_required" } });
    expect((await call("PUT", "/settings/backup-destination", { body: { password: "throttled", destination: null } })).status).toBe(429);
    expect((await call("PUT", "/settings/backup-destination", { csrf: false, body: { password: "right password", destination: null } })).status).toBe(403);
    for (const destination of [{ ...elsewhere, path: "/srv/../etc" }, { ...elsewhere, host: "-oProxyCommand=sh" }, { ...elsewhere, user: "root;id" }, { ...elsewhere, port: 0 }]) {
      expect(await call("PUT", "/settings/backup-destination", { body: { password: "right password", destination } })).toMatchObject({ status: 400, body: { code: "invalid_setting" } });
    }
    expect(settings.get("backupDestination")).toBe(before);
  });

  it("refuses a change sent with a different path casing from anyone but the owner", async () => {
    const { call, settings } = await serve();
    expect((await call("PUT", "/Settings/Backup-Destination", { as: "olly", body: { password: "right password", destination: null } })).status).not.toBe(200);
    expect(settings.get("backupDestination")).not.toBeNull();
  });
});

describe("the notification target", () => {
  it("is shown in full to the owner only", async () => {
    const { call } = await serve();
    expect((await call("GET", "/settings/notifications")).body).toMatchObject({ url: "https://ntfy.example", topic: "secret-topic" });
    for (const as of ["olly", "vic"]) expect((await call("GET", "/settings/notifications", { as })).body).toEqual({ configured: true, kind: "ntfy", url: null, topic: null });
  });

  it("is changed only by the owner with the password, and a bad target leaves the old one", async () => {
    const { call, target } = await serve();
    const next = { kind: "webhook", url: "https://hooks.example/abc" };
    expect((await call("PUT", "/settings/notifications", { as: "olly", body: { password: "right password", target: next } })).status).toBe(403);
    expect((await call("PUT", "/settings/notifications", { body: { password: "wrong password", target: next } })).status).toBe(401);
    expect(await call("PUT", "/settings/notifications", { body: { password: "right password", target: { kind: "webhook", url: "http://plain.example" } } })).toMatchObject({ status: 400, body: { error: "The URL must start with https://" } });
    expect(target()).toMatchObject({ topic: "secret-topic" });
    expect(await call("PUT", "/settings/notifications", { body: { password: "right password", target: next } })).toMatchObject({ status: 200, body: { kind: "webhook", url: "https://hooks.example/abc" } });
  });

  it("sends a test as the owner, at most twelve a minute, and says when the target refused it", async () => {
    const { call, sent } = await serve();
    expect((await call("POST", "/settings/notifications/test", { as: "olly" })).status).toBe(403);
    for (let index = 0; index < 12; index += 1) expect((await call("POST", "/settings/notifications/test")).status).toBe(200);
    expect((await call("POST", "/settings/notifications/test")).status).toBe(429);
    expect(sent).toHaveLength(12);
    expect(await (await serve({ sendFails: true })).call("POST", "/settings/notifications/test")).toMatchObject({ status: 502, body: { error: "ntfy answered 500" } });
  });
});

describe("the approval mode", () => {
  it("is changed by the owner with the password, audited, and refused for an unknown mode", async () => {
    const { call, settings, audit } = await serve();
    const mode = (await call("GET", "/settings/approval-mode")).body.modes.find((entry) => entry !== settings.get("approvalMode"));
    expect((await call("PUT", "/settings/approval-mode", { body: { password: "right password", approvalMode: "none" } })).status).toBe(400);
    expect((await call("PUT", "/settings/approval-mode", { as: "olly", body: { password: "right password", approvalMode: mode } })).status).toBe(403);
    expect((await call("PUT", "/settings/approval-mode", { body: { password: "wrong password", approvalMode: mode } })).status).toBe(401);
    expect(settings.has("approvalMode")).toBe(false);
    expect(await call("PUT", "/settings/approval-mode", { body: { password: "right password", approvalMode: mode } })).toMatchObject({ status: 200, body: { approvalMode: mode } });
    expect(settings.get("approvalMode")).toBe(mode);
    expect(audit).toEqual([["settings.approval-mode.changed", "alex", { approvalMode: mode }]]);
  });

  it("keeps the shared VPN profile from anyone but the owner", async () => {
    const { call } = await serve();
    expect((await call("GET", "/settings/vpn-profile", { as: "olly" })).status).toBe(403);
    expect((await call("GET", "/settings/vpn-profile")).status).toBe(200);
  });
});
