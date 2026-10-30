// @vitest-environment node
/**
 * Apps Today reads (M51): a glance only for an installed app that has a reader, read at the address
 * the app's own record says Docker bound its web port to, and the same reader's digest for the
 * agents. Nothing about an app outside its module: this file only finds the app and its address.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appReaders, createAppGlances, reachableUrl } from "./app-glances.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../test/fixtures/baselinewatch/${name}.json`, import.meta.url), "utf8"));
const answers = { "/api/v1/items": fixture("items-kev"), "/api/v1/vulns": fixture("vulns-watch"), "/api/v1/changes": fixture("changes"), "/api/v1/triage": fixture("triage-affects"), "/api/v1/digest": fixture("digest") };
const now = new Date("2026-10-15T00:45:00Z");

const app = (overrides = {}) => ({
  id: "baselinewatch", name: "BaselineWatch", installed: true,
  container: { exists: true, running: true, status: "running", health: "healthy" },
  urls: [{ id: "web", label: "Web UI", host: 8790, exposure: "lan", path: "/login" }],
  published: [{ id: "web", host: 8790, protocol: "tcp", bind: "0.0.0.0", fixed: false, web: true }],
  ...overrides,
});
const jellyfin = { id: "jellyfin", name: "Jellyfin", installed: true, container: { running: true, status: "running" }, urls: [{ id: "web", host: 8096, exposure: "lan" }], published: [{ host: 8096, protocol: "tcp", bind: "0.0.0.0" }] };

function harness(applications, { helperFails = false } = {}) {
  const asked = [];
  const helper = { request: async (operation) => { if (helperFails) throw new Error("helper down"); if (operation !== "app.inspect") throw new Error(`no stub for ${operation}`); return { applications }; } };
  const fetcher = async (url, options) => {
    const parsed = new URL(String(url));
    asked.push({ origin: parsed.origin, path: parsed.pathname, options });
    return new Response(JSON.stringify(answers[parsed.pathname] ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { glances: createAppGlances({ helper, fetcher, now: () => now }), asked };
}

describe("where an app is reached", () => {
  it("is loopback for a web port bound to every address, else the address Docker bound it to", () => {
    expect(reachableUrl(app())).toBe("http://127.0.0.1:8790");
    expect(reachableUrl(app({ published: [{ host: 8790, protocol: "tcp", bind: "" }] }))).toBe("http://127.0.0.1:8790");
    expect(reachableUrl(app({ published: [{ host: 8790, protocol: "tcp", bind: "*" }] }))).toBe("http://127.0.0.1:8790");
    expect(reachableUrl(app({ published: [{ host: 8790, protocol: "tcp", bind: "192.0.2.10" }] }))).toBe("http://192.0.2.10:8790");
    expect(reachableUrl(app({ published: [{ host: 8790, protocol: "tcp", bind: "fd7a:115c:a1e0::1" }] }))).toBe("http://[fd7a:115c:a1e0::1]:8790");
    expect(reachableUrl(app({ urls: [{ host: 8790, exposure: "loopback" }], published: [{ host: 8790, protocol: "tcp", bind: "127.0.0.1" }] }))).toBe("http://127.0.0.1:8790");
  });

  it("is nowhere for an app not installed, with no web port, or with a bind that is not an address", () => {
    expect(reachableUrl(app({ installed: false }))).toBeNull();
    expect(reachableUrl(app({ urls: [] }))).toBeNull();
    expect(reachableUrl(app({ urls: [{ host: 70_000, exposure: "lan" }] }))).toBeNull();
    expect(reachableUrl(app({ published: [{ host: 8790, protocol: "tcp", bind: "attacker.example" }] }))).toBeNull();
    expect(reachableUrl(null)).toBeNull();
  });
});

describe("the glances", () => {
  it("are one per installed app with a reader, read over loopback, in the registry's words", async () => {
    const { glances, asked } = harness([jellyfin, app()]);
    const result = await glances.list();
    expect(result.liveKnown).toBe(true);
    expect(result.glances).toHaveLength(1);
    expect(result.glances[0]).toMatchObject({
      app: "baselinewatch", name: "BaselineWatch", title: appReaders.baselinewatch.title, window: "since yesterday",
      url: { host: 8790, exposure: "lan", path: "/login" }, running: true, available: true, reason: null, since: "2026-10-14T00:00:00.000Z",
    });
    expect(result.glances[0].metrics.map((metric) => [metric.id, metric.value])).toEqual([["kev", 4], ["watched", 30], ["releases", 1], ["affects", 2]]);
    expect(new Set(asked.map((entry) => entry.origin))).toEqual(new Set(["http://127.0.0.1:8790"]));
    expect(asked).toHaveLength(5);
  });

  it("read at the address the port was bound to, and say when the app is stopped or unreachable rather than show figures", async () => {
    const bound = harness([app({ published: [{ host: 8790, protocol: "tcp", bind: "192.0.2.10" }] })]);
    await bound.glances.list();
    expect(bound.asked[0].origin).toBe("http://192.0.2.10:8790");

    const stopped = harness([app({ container: { exists: true, running: false, status: "exited" } })]);
    expect((await stopped.glances.list()).glances[0]).toMatchObject({ running: false, available: false, reason: "BaselineWatch is not running.", metrics: [] });
    expect(stopped.asked).toHaveLength(0);

    const paused = harness([app({ container: { exists: true, running: true, status: "paused" } })]);
    expect((await paused.glances.list()).glances[0]).toMatchObject({ running: false, available: false });

    const unreachable = harness([app({ urls: [] })]);
    expect((await unreachable.glances.list()).glances[0]).toMatchObject({ available: false, reason: "BaselineWatch publishes no web port this server can reach." });
  });

  it("are none, and say the live state is not known, when the helper cannot say what is installed", async () => {
    expect(await harness([app()], { helperFails: true }).glances.list()).toEqual({ glances: [], liveKnown: false });
    expect(await createAppGlances({ helper: null }).list()).toEqual({ glances: [], liveKnown: false });
    expect(await harness([jellyfin]).glances.list()).toEqual({ glances: [], liveKnown: true });
  });
});

describe("the digest for the agents", () => {
  it("is the app's latest digest when it is installed and running", async () => {
    const { glances, asked } = harness([app()]);
    const text = await glances.digest("baselinewatch");
    expect(text).toMatch(/^BaselineWatch's daily digest, written 2026-10-15T00:45:36\.729Z\./);
    expect(text).toContain("Known exploited (CISA KEV): 15 added");
    expect(asked.map((entry) => entry.path)).toEqual(["/api/v1/digest"]);
  });

  it("says when the app is not installed, not running, or not known, and refuses an app with no reader", async () => {
    expect(await harness([jellyfin]).glances.digest("baselinewatch")).toBe("BaselineWatch: not installed on this server (install it from the App catalog).");
    expect(await harness([app({ container: { running: false, status: "exited" } })]).glances.digest("baselinewatch")).toBe("BaselineWatch: installed but not running.");
    expect(await harness([app()], { helperFails: true }).glances.digest("baselinewatch")).toBe("BaselineWatch: whether it is installed could not be read.");
    await expect(harness([app()]).glances.digest("jellyfin")).rejects.toThrow(/no reader/);
    expect(createAppGlances({}).has("baselinewatch")).toBe(true);
    expect(createAppGlances({}).has("jellyfin")).toBe(false);
  });
});
