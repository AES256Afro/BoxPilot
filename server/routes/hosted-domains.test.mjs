/**
 * The hosted-domains routes (M42.2): the page's read for everyone, the owner's cadence, and the names
 * an operator adds or removes. The service is a stub here; its own test covers the checks.
 */
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHostedDomainsRouter } from "./hosted-domains.mjs";

let server; let base;
const auth = {
  requireRole: (role) => (request, response, next) => ((request.headers["x-test-role"] === role || request.headers["x-test-role"] === "owner") ? next() : response.status(403).json({ error: "forbidden" })),
  requireCsrf: (_request, _response, next) => next(),
};
const hostedDomains = {
  status: vi.fn(async ({ fresh }) => ({ domains: [{ hostname: "share.example.com", state: "up" }], checkedAt: "2026-10-24T12:00:00.000Z", checking: false, intervalMinutes: 15, intervals: [5, 15, 30, 60], manual: [], fresh })),
  setIntervalMinutes: vi.fn((minutes) => { if (minutes !== 30) throw Object.assign(new Error("The interval must be one of 5, 15, 30, 60 minutes"), { code: "invalid_domain" }); return { intervalMinutes: minutes }; }),
  addManual: vi.fn((raw) => { if (!raw.hostname) throw Object.assign(new Error("Say which name to watch"), { code: "invalid_domain" }); return { added: raw.hostname, manual: [{ hostname: raw.hostname }] }; }),
  removeManual: vi.fn(async (hostname) => { if (hostname !== "status.example.com") throw Object.assign(new Error(`${hostname} is not one of the names added by hand`), { code: "not_found" }); return { removed: hostname, manual: [] }; }),
};
const call = (method, path, { role = "owner", body } = {}) => fetch(`${base}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", "x-test-role": role }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.boxpilotSession = { owner: { id: `${request.headers["x-test-role"] ?? "owner"}-1`, role: request.headers["x-test-role"] ?? "owner" } }; next(); });
  app.use("/api/v1", createHostedDomainsRouter({ hostedDomains, auth }));
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

describe("GET /hosted-domains", () => {
  it("gives the last round to anyone, and a fresh one to those who may change the box", async () => {
    const asViewer = await (await call("GET", "/hosted-domains?fresh=1", { role: "viewer" })).json();
    expect(asViewer).toMatchObject({ domains: [{ hostname: "share.example.com" }], fresh: false });
    const asOperator = await (await call("GET", "/hosted-domains?fresh=1", { role: "operator" })).json();
    expect(asOperator.fresh).toBe(true);
    const plain = await (await call("GET", "/hosted-domains")).json();
    expect(plain.fresh).toBe(false);
  });
  it("says when the check could not run", async () => {
    hostedDomains.status.mockRejectedValueOnce(new Error("the helper did not answer"));
    const response = await call("GET", "/hosted-domains");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "hosted_domains_failed", error: expect.stringContaining("the helper did not answer") });
  });
});

describe("PUT /hosted-domains/settings", () => {
  it("is the owner's, takes one of the cadences, and refuses the rest in words", async () => {
    expect((await call("PUT", "/hosted-domains/settings", { role: "operator", body: { intervalMinutes: 30 } })).status).toBe(403);
    const ok = await call("PUT", "/hosted-domains/settings", { body: { intervalMinutes: 30 } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ intervalMinutes: 30 });
    expect(hostedDomains.setIntervalMinutes).toHaveBeenCalledWith(30, { updatedBy: "owner-1" });
    const odd = await call("PUT", "/hosted-domains/settings", { body: { intervalMinutes: 7 } });
    expect(odd.status).toBe(400);
    expect((await odd.json()).error).toContain("one of 5, 15, 30, 60");
    expect((await call("PUT", "/hosted-domains/settings", { body: { intervalMinutes: "30" } })).status).toBe(400);
  });
});

describe("the names added by hand", () => {
  it("adds one as the caller, and refuses an empty one in words", async () => {
    const created = await call("POST", "/hosted-domains/manual", { role: "operator", body: { hostname: "status.example.com", service: "http://127.0.0.1:3001" } });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ added: "status.example.com" });
    expect(hostedDomains.addManual).toHaveBeenCalledWith({ hostname: "status.example.com", service: "http://127.0.0.1:3001" }, { updatedBy: "operator-1" });
    const refused = await call("POST", "/hosted-domains/manual", { body: {} });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Say which name to watch", code: "invalid_domain" });
  });
  it("removes one, and says when it was never there", async () => {
    const removed = await call("DELETE", "/hosted-domains/manual/status.example.com", { role: "operator" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: "status.example.com", manual: [] });
    const missing = await call("DELETE", "/hosted-domains/manual/other.example.com");
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("not_found");
  });
});
