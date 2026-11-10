import { describe, expect, it } from "vitest";
import { appStopClearingOperations, foldAppStop, seedAppStops } from "./app-stops.mjs";

const now = () => new Date("2026-09-28T22:10:20.000Z");
const job = (type, parameters, createdBy = "owner-1") => ({ type: `op:${type}`, parameters, createdBy });

describe("apps stopped on purpose", () => {
  it("records a stop, with when and by whom", () => {
    // The owner stopped Plex from BoxPilot; Home then called it a problem.
    expect(foldAppStop({}, job("app.action", { id: "plex", action: "stop" }), { now })).toEqual({ plex: { at: "2026-09-28T22:10:20.000Z", by: "owner-1" } });
  });

  it("forgets each app a job updated several of", () => {
    const stopped = { plex: { at: "2026-09-28T22:10:20.000Z", by: "owner-1" }, farspace: { at: "2026-09-28T22:02:06.000Z", by: "owner-1" } };
    expect(foldAppStop(stopped, job("app.update.many", { ids: ["plex", "jellyfin"] }))).toEqual({ farspace: stopped.farspace });
    expect(foldAppStop(stopped, job("app.update.many", { ids: ["jellyfin"] }))).toBe(stopped);
    // The nightly update names its apps only in its result: an app stopped on purpose and then updated
    // by it stayed "stopped on purpose" for good.
    const nightly = (apps) => ({ ...job("app.update.available", { exclude: [] }), result: { updated: apps.length > 0, apps } });
    expect(foldAppStop(stopped, nightly(["plex", "jellyfin"]))).toEqual({ farspace: stopped.farspace });
    expect(foldAppStop(stopped, nightly(["jellyfin"]))).toBe(stopped);
    expect(foldAppStop(stopped, nightly([]))).toBe(stopped);
    expect(foldAppStop(stopped, job("app.update.available", { exclude: [] }))).toBe(stopped);
  });

  it("forgets it when the app is brought back or replaced", () => {
    const stopped = { plex: { at: "2026-09-28T22:10:20.000Z", by: "owner-1" }, farspace: { at: "2026-09-28T22:02:06.000Z", by: "owner-1" } };
    for (const action of ["start", "restart", "unpause"]) {
      expect(foldAppStop(stopped, job("app.action", { id: "plex", action }))).toEqual({ farspace: stopped.farspace });
    }
    // Each names its app in `id`, but for the nightly update, which is folded from its result (above).
    for (const operation of appStopClearingOperations.filter((entry) => entry !== "app.update.available")) {
      expect(foldAppStop(stopped, job(operation, { id: "plex" }))).toEqual({ farspace: stopped.farspace });
    }
  });

  it("leaves the record alone for a pause, another app, or a job without an app", () => {
    const stopped = { plex: { at: "2026-09-28T22:10:20.000Z", by: "owner-1" } };
    expect(foldAppStop(stopped, job("app.action", { id: "plex", action: "pause" }))).toBe(stopped);
    expect(foldAppStop(stopped, job("app.action", { id: "jellyfin", action: "start" }))).toBe(stopped);
    expect(foldAppStop(stopped, job("app.backup", { id: "plex" }))).toBe(stopped);
    expect(foldAppStop(stopped, job("app.action", {}))).toBe(stopped);
    expect(foldAppStop(null, job("app.action", { id: "plex", action: "start" }))).toEqual({});
    // Repair's "Recreate (stays stopped)" for an app the prune removed (M35): the stop still stands.
    expect(foldAppStop(stopped, job("app.reinstall", { id: "plex", start: false }))).toBe(stopped);
  });

  it("is rebuilt from recent jobs on an install that stopped apps before it kept a record", () => {
    // Newest first, as listJobs returns them: the owner's server on the evening this shipped.
    const jobs = [
      { ...job("app.action", { id: "qbittorrent", action: "stop" }), state: "completed", createdAt: "2026-09-28T22:11:03.987Z", updatedAt: "2026-09-28T22:11:09.000Z" },
      { ...job("app.action", { id: "plex", action: "stop" }), state: "completed", createdAt: "2026-09-28T22:10:20.991Z", updatedAt: "2026-09-28T22:10:25.000Z" },
      { ...job("app.uninstall", { id: "jellyfin" }), state: "cancelled", createdAt: "2026-09-28T22:10:02.741Z" },
      { ...job("app.action", { id: "farspace", action: "stop" }), state: "completed", createdAt: "2026-09-28T22:02:06.771Z", updatedAt: "2026-09-28T22:02:10.000Z" },
      { ...job("app.action", { id: "jellyfin", action: "stop" }), state: "failed", createdAt: "2026-09-28T21:00:00.000Z" },
      { ...job("app.action", { id: "plex", action: "start" }), state: "completed", createdAt: "2026-09-27T09:00:00.000Z" },
      { ...job("app.action", { id: "ollama", action: "stop" }), state: "completed", createdAt: "2026-09-20T09:00:00.000Z", updatedAt: "2026-09-20T09:00:04.000Z" },
      { ...job("app.update", { id: "ollama" }), state: "completed", createdAt: "2026-09-21T09:00:00.000Z" },
    ];
    expect(seedAppStops(jobs)).toEqual({
      qbittorrent: { at: "2026-09-28T22:11:09.000Z", by: "owner-1" },
      plex: { at: "2026-09-28T22:10:25.000Z", by: "owner-1" },
      farspace: { at: "2026-09-28T22:02:10.000Z", by: "owner-1" },
    });
    expect(seedAppStops([])).toEqual({});
  });
});
