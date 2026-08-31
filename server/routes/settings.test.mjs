/**
 * The watch-status endpoint groups the health watcher's live state back to its condition families,
 * so Settings can show what BoxPilot is watching and what is currently active.
 */
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSettingsRouter } from "./settings.mjs";

let server; let base; const settings = new Map();
// Role-aware stub: a request carries its role in x-test-role; owner satisfies any requireRole.
const auth = {
  requireRole: (role) => (request, response, next) => ((request.headers["x-test-role"] === role || request.headers["x-test-role"] === "owner") ? next() : response.status(403).json({ error: "forbidden" })),
  requireCsrf: (_request, _response, next) => next(),
};
const notifications = { describe: () => ({ configured: true, kind: "ntfy" }) };
const state = { getSetting: (key, fallback) => settings.get(key) ?? fallback };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createSettingsRouter({ state, notifications, auth }));
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

describe("GET /settings/watch", () => {
  it("reports every watched condition, marking the active ones from the watcher's state", async () => {
    settings.set("healthAlertsState", {
      "storage.smart:/dev/sda": { title: "Disk /dev/sda reports SMART problems", since: "2026-08-27T00:00:00Z", notified: true },
      "smart.errors:/dev/sda": { title: "/dev/sda is developing errors", since: "2026-08-28T00:00:00Z", notified: true },
      "schedule.overdue:s1": { title: "not yet announced", notified: false }, // recorded but unannounced: not shown active
    });
    const body = await (await fetch(`${base}/api/v1/settings/watch`)).json();
    expect(body.targetConfigured).toBe(true);
    expect(body.activeCount).toBe(2); // the two announced ones
    const byKey = Object.fromEntries(body.conditions.map((condition) => [condition.key, condition]));
    expect(byKey["storage.smart"].active).toBe(true);
    expect(byKey["smart.errors"].active).toBe(true);
    expect(byKey["schedule.overdue"].active).toBe(false); // unannounced does not count
    expect(byKey["docker.unhealthy"].active).toBe(false); // nothing wrong
    expect(byKey["storage.smart"].details[0].title).toContain("/dev/sda");
    // Every condition family from the watcher is present.
    expect(body.conditions.length).toBeGreaterThanOrEqual(12);
  });
});

describe("GET /settings/vpn-profile role gate", () => {
  it("serves the owner but refuses viewer and operator (it names the VPN account and exempted LAN ranges)", async () => {
    settings.set("vpnProfile", { configured: true, provider: "protonvpn", openvpnUser: "acct-9931", outboundSubnets: "192.168.8.0/24" });
    const at = (role) => fetch(`${base}/api/v1/settings/vpn-profile`, { headers: { "x-test-role": role } });
    expect((await at("viewer")).status).toBe(403);
    expect((await at("operator")).status).toBe(403);
    const ownerResponse = await at("owner");
    expect(ownerResponse.status).toBe(200);
    expect((await ownerResponse.json()).profile.openvpnUser).toBe("acct-9931");
    // A sibling GET with no per-route gate stays open to lower roles, proving the gate is specific.
    expect((await fetch(`${base}/api/v1/settings/cloud-destination`, { headers: { "x-test-role": "viewer" } })).status).toBe(200);
  });
});
