/**
 * The watch-status endpoint groups the health watcher's live state back to its condition families,
 * so Settings can show what BoxPilot is watching and what is currently active.
 */
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSettingsRouter } from "./settings.mjs";

let server; let base; const settings = new Map();
const auth = { requireRole: () => (_request, _response, next) => next(), requireCsrf: (_request, _response, next) => next() };
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
