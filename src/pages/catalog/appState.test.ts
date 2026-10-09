import { describe, expect, it } from "vitest";
import { appStatus, compactValues, installTier, offlineFor } from "./appState";
import type { LiveState, Manifest, ManifestEnv } from "./types";

/**
 * Backing an app up stops it. Whether that matters depends on the app and on how long, and the
 * number has been in every backup record from the start without ever being shown.
 */
describe("how long an app was offline for a backup", () => {
  it("does not make a fuss about a fraction of a second", () => {
    expect(offlineFor(191)).toBe("under a second");
    expect(offlineFor(999)).toBe("under a second");
  });

  it("is precise where the difference is worth seeing", () => {
    expect(offlineFor(1000)).toBe("1.0 seconds");
    expect(offlineFor(10268)).toBe("10 seconds");
  });

  it("switches to minutes once seconds stop being useful", () => {
    expect(offlineFor(180_000)).toBe("3 minutes");
  });

  it("says nothing rather than zero when the record does not have it", () => {
    // An older backup that never recorded downtime must not read as "no downtime".
    expect(offlineFor(null)).toBe("—");
  });
});

const live = (overrides: Partial<LiveState> = {}): LiveState => ({
  id: "app", installed: true, dataPresent: true, state: null,
  container: { exists: true, running: true, status: "running", health: "healthy", restarts: 0, image: null },
  urls: [],
  ...overrides,
});

describe("an app's state, as the tile, the sheet and the verdict all say it", () => {
  it("is never green about an app it could not read", () => {
    expect(appStatus(null)).toEqual({ status: "unknown", label: "Unknown" });
  });

  it("says a paused app is paused, though Docker calls it running", () => {
    expect(appStatus(live({ container: { exists: true, running: true, status: "paused", health: "none", restarts: 0, image: null } }))).toEqual({ status: "warning", label: "Paused" });
  });

  it("says an installed app with no container has none, as Home does, and a stopped one is stopped", () => {
    expect(appStatus(live({ container: { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null } }))).toEqual({ status: "warning", label: "No container" });
    expect(appStatus(live({ container: { exists: true, running: false, status: "exited", health: "none", restarts: 0, image: null } }))).toEqual({ status: "warning", label: "Stopped" });
  });

  it("puts a leak outside the VPN and a folder it cannot write to above looking alive", () => {
    expect(appStatus(live({ killSwitchDrill: { held: false, leaked: true, downForMs: 3000, at: "x" } })).status).toBe("danger");
    expect(appStatus(live({ folderProblems: [{ path: "/mnt/x", volume: "data", reason: "read-only" }] })).label).toBe("Cannot write to its folder");
  });

  it("says a helper container is down, and a stopped app is stopped", () => {
    expect(appStatus(live({ sidecars: [{ id: "vpn", running: false, status: "exited", restarts: 0 }] })).label).toBe("Running · vpn is down");
    expect(appStatus(live({ container: { exists: true, running: false, status: "exited", health: "none", restarts: 0, image: null } }))).toEqual({ status: "warning", label: "Stopped" });
    expect(appStatus(live({ installed: false, dataPresent: true }))).toEqual({ status: "neutral", label: "Not installed · data kept" });
  });
});

describe("the tier installing an app asks for", () => {
  it("is the manifest's own when it is higher than app.install's, as the server stages it, and never lower", () => {
    // Pi-hole, AdGuard Home, Technitium and wg-easy say high (server/catalog installRiskLookup).
    expect(installTier({ risk: "high" })).toBe("high");
    expect(installTier({ risk: "medium" })).toBe("medium");
    expect(installTier({ risk: "low" })).toBe("medium");
  });
});

describe("what a settings change sends", () => {
  const entry = (name: string, extra: Partial<ManifestEnv> = {}): ManifestEnv => ({ name, label: name, description: null, type: "string", default: null, required: false, secret: false, generate: false, options: null, fixed: false, ...extra });
  const manifest = { ports: [], volumes: [], env: [entry("SERVER_URL"), entry("TZ", { default: "UTC" }), entry("ADMIN_TOKEN", { secret: true }), entry("DB_PASSWORD", { type: "password" }), entry("UNSET")] } as unknown as Manifest;

  it("sends a setting cleared to empty, so the server does not keep the old value", () => {
    // The server merges the request over what it stored ({...stored, ...request}): leaving the
    // empty setting out kept the old address in place.
    const stored = { ports: {}, env: { SERVER_URL: "https://old.example", TZ: "Europe/Berlin" }, volumes: {} };
    const values = { ports: {}, env: { SERVER_URL: "", TZ: "", ADMIN_TOKEN: "", DB_PASSWORD: "", UNSET: "" }, volumes: {} };
    expect(compactValues(manifest, values, stored).env).toEqual({ SERVER_URL: "", TZ: "" });
  });

  it("leaves an empty secret or password out: empty there means unchanged", () => {
    const stored = { ports: {}, env: { ADMIN_TOKEN: "kept", DB_PASSWORD: "kept" }, volumes: {} };
    expect(compactValues(manifest, { ports: {}, env: { ADMIN_TOKEN: "", DB_PASSWORD: "" }, volumes: {} }, stored).env).toEqual({});
  });

  it("sends nothing empty on install, where there is nothing stored to clear", () => {
    expect(compactValues(manifest, { ports: {}, env: { SERVER_URL: "", TZ: "", ADMIN_TOKEN: "" }, volumes: {} }).env).toEqual({});
  });
});
