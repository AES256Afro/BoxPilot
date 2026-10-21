import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createPushRouter } from "./push.mjs";

/*
 * The push routes hand the service the caller from the session and the address from the browser's
 * own Origin header, never from the body, and show where pushes link to only to the owner.
 */

const accounts = {
  alex: { id: "alex", role: "owner" },
  olly: { id: "olly", role: "operator" },
  vic: { id: "vic", role: "viewer" },
};
const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } });

async function serve({ keyProblem = null } = {}) {
  const calls = [];
  const push = {
    publicKey: () => { if (keyProblem) throw new Error(keyProblem); return "BPublicKey"; },
    describeSettings: () => ({ tiers: ["medium", "high"], openAt: "https://box.example" }),
    devicesOf: (id) => [{ id: `${id}-phone` }],
    subscribe: (account, details) => { calls.push(["subscribe", account.id, details.origin, details.label]); return { id: "d1" }; },
    unsubscribe: (account, id) => { calls.push(["unsubscribe", account.id, id]); throw Object.assign(new Error("There is no such device"), { status: 404 }); },
    test: async (account) => { calls.push(["test", account.id]); return { devices: 1, delivered: 1 }; },
    saveSettings: (body, context) => { calls.push(["settings", context.actorId, context.origin, body.openAt ?? null]); return { saved: true }; },
  };
  const auth = {
    requireCsrf: (request, response, next) => (request.get("x-boxpilot-csrf") === "csrf" ? next() : response.status(403).json({ code: "csrf_required" })),
    requireRole: (...roles) => (request, response, next) => (roles.includes(request.boxpilotSession.owner.role) ? next() : response.status(403).json({ code: "forbidden" })),
  };
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => { request.boxpilotSession = { owner: accounts[request.get("x-test-session")] }; next(); });
  app.use(createPushRouter({ push, auth }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { as = "alex", body, csrf = true, origin = null } = {}) => {
    const response = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", "x-test-session": as, ...(csrf ? { "x-boxpilot-csrf": "csrf" } : {}), ...(origin ? { Origin: origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { call, calls };
}

describe("push routes", () => {
  it("gives the key and devices to someone who can approve, and the link address only to the owner", async () => {
    const { call } = await serve();
    expect((await call("GET", "/push")).body).toEqual({ canSubscribe: true, publicKey: "BPublicKey", problem: null, devices: [{ id: "alex-phone" }], settings: { tiers: ["medium", "high"], openAt: "https://box.example" } });
    expect((await call("GET", "/push", { as: "olly" })).body).toMatchObject({ canSubscribe: true, devices: [{ id: "olly-phone" }], settings: { openAt: null } });
    expect((await call("GET", "/push", { as: "vic" })).body).toEqual({ canSubscribe: false, publicKey: null, problem: null, devices: [], settings: { tiers: ["medium", "high"], openAt: null } });
    expect((await (await serve({ keyProblem: "The push key could not be read" })).call("GET", "/push")).body).toMatchObject({ publicKey: null, problem: "The push key could not be read" });
  });

  it("takes the address from the browser's Origin header and the account from the session", async () => {
    const { call, calls } = await serve();
    await call("POST", "/push/subscriptions", { as: "olly", origin: "https://box.example", body: { subscription: {}, label: "Phone", origin: "https://evil.example", accountId: "alex" } });
    await call("PUT", "/settings/push", { origin: "https://box.example", body: { openAt: "https://evil.example" } });
    expect(calls).toEqual([["subscribe", "olly", "https://box.example", "Phone"], ["settings", "alex", "https://box.example", "https://evil.example"]]);
  });

  it("needs CSRF for every change, keeps the settings the owner's, and passes on the service's status", async () => {
    const { call, calls } = await serve();
    for (const [method, url] of [["POST", "/push/subscriptions"], ["DELETE", "/push/subscriptions/d1"], ["POST", "/push/test"], ["PUT", "/settings/push"]]) {
      expect((await call(method, url, { csrf: false, body: {} })).status).toBe(403);
    }
    expect((await call("PUT", "/settings/push", { as: "olly", body: {} })).status).toBe(403);
    expect(calls).toEqual([]);
    expect(await call("DELETE", "/push/subscriptions/d1", { as: "olly" })).toEqual({ status: 404, body: { error: "There is no such device", code: "push_failed" } });
    expect(await call("POST", "/push/test", { as: "olly" })).toEqual({ status: 200, body: { devices: 1, delivered: 1 } });
  });
});
