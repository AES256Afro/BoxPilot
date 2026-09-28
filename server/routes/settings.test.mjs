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
      "schedule.overdue:s1": { title: "not yet announced", notified: false }, // live, but never sent anywhere
    });
    const body = await (await fetch(`${base}/api/v1/settings/watch`)).json();
    expect(body.targetConfigured).toBe(true);
    // All three are live conditions. The unannounced one used to be hidden here too, which meant a
    // condition BoxPilot knew about was shown to nobody until the owner stumbled on its effect.
    expect(body.activeCount).toBe(3);
    const byKey = Object.fromEntries(body.conditions.map((condition) => [condition.key, condition]));
    expect(byKey["storage.smart"].active).toBe(true);
    expect(byKey["storage.smart"].details[0].announced).toBe(true);
    expect(byKey["smart.errors"].active).toBe(true);
    expect(byKey["schedule.overdue"].active).toBe(true);
    expect(byKey["schedule.overdue"].details[0].announced).toBe(false); // live, and the page can say it was never sent
    expect(byKey["docker.unhealthy"].active).toBe(false); // nothing wrong
    expect(byKey["storage.smart"].details[0].title).toContain("/dev/sda");
    // Every condition family from the watcher is present.
    expect(body.conditions.length).toBeGreaterThanOrEqual(12);
    expect(body.unannouncedCount).toBe(1);
  });

  it("counts failed schedules, automations and unsaved results that reached no one (M27.2)", async () => {
    settings.set("healthAlertsState", {
      "schedule.failed:s1": { title: "Scheduled task failed: Back up application data (jellyfin)", since: "2026-09-27T03:00:00Z", message: "disk full", notified: false },
      "flow.failed:f1": { title: "Automation stopped: Nightly", since: "2026-09-27T03:10:00Z", notified: true },
      "record.failed:vm.export.create:lab": { title: "Result not saved: Export a stopped VM (lab)", since: "2026-09-27T03:20:00Z", message: "UNIQUE constraint failed", notified: false },
      "system.reboot": { title: "A reboot is required", since: "2026-09-26T00:00:00Z", notified: false },
    });
    const body = await (await fetch(`${base}/api/v1/settings/watch`)).json();
    expect(body.activeCount).toBe(4);
    expect(body.unannouncedCount).toBe(3);
    const byKey = Object.fromEntries(body.conditions.map((condition) => [condition.key, condition]));
    expect(byKey["schedule.failed"].details).toEqual([{ title: "Scheduled task failed: Back up application data (jellyfin)", since: "2026-09-27T03:00:00Z", announced: false }]);
    expect(byKey["flow.failed"].details[0].announced).toBe(true);
    expect(byKey["record.failed"].active).toBe(true);
    // The words kept for a later send are not handed to every signed-in viewer; the title is enough here.
    expect(JSON.stringify(body)).not.toContain("UNIQUE constraint");
  });
});

describe("GET /settings/vpn-profile role gate", () => {
  it("serves the owner but refuses viewer and operator (it names the VPN account and exempted LAN ranges)", async () => {
    settings.set("vpnProfile", { configured: true, provider: "protonvpn", openvpnUser: "acct-9931", outboundSubnets: "192.168.1.0/24" });
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
