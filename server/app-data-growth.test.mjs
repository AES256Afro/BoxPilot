import { describe, expect, it } from "vitest";
import { appendUsageSample, createAppDataSampler, growthByApp, growthOverWindow, measurableFolders, mountFor } from "./app-data-growth.mjs";

const GiB = 1024 ** 3;
const day = (index) => `2026-09-${String(index).padStart(2, "0")}T03:00:00.000Z`;

describe("recording what each app's folders hold", () => {
  it("keeps one reading per folder per day, the last one winning", () => {
    let history = appendUsageSample({}, { at: day(1), entries: [{ key: "qb:/mnt/dump", bytes: 10 * GiB, appId: "qbittorrent", path: "/mnt/dump", mount: "/mnt/dump" }] });
    history = appendUsageSample(history, { at: `2026-09-01T21:00:00.000Z`, entries: [{ key: "qb:/mnt/dump", bytes: 12 * GiB, appId: "qbittorrent", path: "/mnt/dump", mount: "/mnt/dump" }] });
    expect(history["qb:/mnt/dump"]).toHaveLength(1);
    expect(history["qb:/mnt/dump"][0].bytes).toBe(12 * GiB);
  });

  it("skips a folder it could not measure instead of recording it as empty", () => {
    // Recording nothing-measured as zero would draw a cliff that never happened, and on the next
    // day's reading an enormous fictional gain.
    const history = appendUsageSample({}, { at: day(1), entries: [
      { key: "a", bytes: 5 * GiB, appId: "a", path: "/mnt/a", mount: "/mnt/a" },
      { key: "b", bytes: null, appId: "b", path: "/mnt/b", mount: "/mnt/b" },
    ] });
    expect(Object.keys(history)).toEqual(["a"]);
  });

  it("forgets readings older than the window it was told to keep", () => {
    let history = { old: [{ at: "2026-01-01T03:00:00.000Z", bytes: GiB }] };
    history = appendUsageSample(history, { at: day(1), entries: [{ key: "old", bytes: 2 * GiB, appId: "x", path: "/mnt/x", mount: "/mnt/x" }] }, { maxDays: 30 });
    expect(history.old).toHaveLength(1);
    expect(history.old[0].bytes).toBe(2 * GiB);
  });
});

describe("turning readings into growth", () => {
  it("reports a size but no growth from a single reading", () => {
    const growth = growthOverWindow([{ at: day(5), bytes: 3 * GiB }], { now: new Date(day(5)) });
    expect(growth).toMatchObject({ bytes: 3 * GiB, grewBytes: null, days: 0 });
  });

  it("measures newest minus oldest inside the window", () => {
    const samples = [{ at: day(1), bytes: 100 * GiB }, { at: day(4), bytes: 160 * GiB }, { at: day(8), bytes: 340 * GiB }];
    const growth = growthOverWindow(samples, { now: new Date(day(8)), windowDays: 7 });
    expect(growth.grewBytes).toBe(240 * GiB); // from the 1st, which is exactly 7 days back
    expect(growth.bytes).toBe(340 * GiB);
  });

  it("ignores readings from before the window", () => {
    const samples = [{ at: day(1), bytes: 10 * GiB }, { at: day(7), bytes: 50 * GiB }, { at: day(8), bytes: 60 * GiB }];
    const growth = growthOverWindow(samples, { now: new Date(day(8)), windowDays: 2 });
    expect(growth.grewBytes).toBe(10 * GiB);
  });

  it("says nothing at all when every reading has aged out", () => {
    expect(growthOverWindow([{ at: day(1), bytes: GiB }], { now: new Date("2026-12-01T00:00:00.000Z") })).toBeNull();
  });
});

describe("naming what is filling a drive", () => {
  const history = {
    "qbittorrent:/mnt/the-dump/torrents": [
      { at: day(1), bytes: 900 * GiB, appId: "qbittorrent", path: "/mnt/the-dump/torrents", mount: "/mnt/the-dump" },
      { at: day(8), bytes: 1400 * GiB, appId: "qbittorrent", path: "/mnt/the-dump/torrents", mount: "/mnt/the-dump" },
    ],
    "jellyfin:/mnt/the-dump/media": [
      { at: day(1), bytes: 3000 * GiB, appId: "jellyfin", path: "/mnt/the-dump/media", mount: "/mnt/the-dump" },
      { at: day(8), bytes: 3010 * GiB, appId: "jellyfin", path: "/mnt/the-dump/media", mount: "/mnt/the-dump" },
    ],
    "nextcloud:/mnt/other/files": [
      { at: day(1), bytes: 10 * GiB, appId: "nextcloud", path: "/mnt/other/files", mount: "/mnt/other" },
      { at: day(8), bytes: 900 * GiB, appId: "nextcloud", path: "/mnt/other/files", mount: "/mnt/other" },
    ],
  };

  it("puts the biggest grower first, not the biggest folder", () => {
    const rows = growthByApp(history, { now: new Date(day(8)), mount: "/mnt/the-dump" });
    expect(rows.map((row) => row.appId)).toEqual(["qbittorrent", "jellyfin"]);
    expect(rows[0].grewBytes).toBe(500 * GiB);
  });

  it("never blames a folder on a different drive", () => {
    const rows = growthByApp(history, { now: new Date(day(8)), mount: "/mnt/the-dump" });
    expect(rows.some((row) => row.appId === "nextcloud")).toBe(false);
  });

  it("keeps a folder that shrank, because that is worth seeing too", () => {
    const shrinking = { "x:/mnt/a": [{ at: day(1), bytes: 500 * GiB, appId: "x", path: "/mnt/a", mount: "/mnt/a" }, { at: day(8), bytes: 100 * GiB, appId: "x", path: "/mnt/a", mount: "/mnt/a" }] };
    const rows = growthByApp(shrinking, { now: new Date(day(8)), mount: "/mnt/a" });
    expect(rows[0].grewBytes).toBe(-400 * GiB);
  });
});

describe("choosing which folders to measure", () => {
  const manifest = { id: "qbittorrent", volumes: [
    { id: "downloads", label: "Downloads", hostPath: "/mnt/dump/torrents", configurable: true },
    { id: "config", label: "Config", hostPath: "/srv/boxpilot/qbittorrent/config" },
    { id: "media", label: "Media", hostPath: "/mnt/dump/media", readOnly: true },
  ] };

  it("measures the owner's data folders and leaves read-only mounts alone", () => {
    const folders = measurableFolders({ manifest, live: { installed: true, state: { values: { volumes: {} } } } });
    expect(folders.map((folder) => folder.path)).toEqual(["/mnt/dump/torrents", "/srv/boxpilot/qbittorrent/config"]);
  });

  it("follows the folder the owner actually chose, not the manifest default", () => {
    const folders = measurableFolders({ manifest, live: { installed: true, state: { values: { volumes: { downloads: "/mnt/the-dump/torrents" } } } } });
    expect(folders[0].path).toBe("/mnt/the-dump/torrents");
  });

  it("measures nothing for an app that is not installed", () => {
    expect(measurableFolders({ manifest, live: { installed: false } })).toEqual([]);
  });

  it("does not measure the same folder twice when two volumes point at it", () => {
    const shared = { id: "app", volumes: [{ id: "a", hostPath: "/mnt/one" }, { id: "b", hostPath: "/mnt/one" }] };
    expect(measurableFolders({ manifest: shared, live: { installed: true } })).toHaveLength(1);
  });
});

describe("placing a folder on a drive", () => {
  it("picks the most specific mount, not the first that matches", () => {
    expect(mountFor("/mnt/the-dump/torrents/x", ["/", "/mnt", "/mnt/the-dump"])).toBe("/mnt/the-dump");
  });

  it("does not treat a name prefix as a parent folder", () => {
    expect(mountFor("/mnt/the-dump-old/x", ["/mnt/the-dump"])).toBeNull();
  });

  it("matches the mount point itself", () => {
    expect(mountFor("/mnt/the-dump", ["/mnt/the-dump"])).toBe("/mnt/the-dump");
  });
});

describe("the nightly sampler", () => {
  /** A store that behaves like the real settings store for the two keys the sampler touches. */
  function fakeStore(initial = {}) {
    const settings = { ...initial };
    return { settings, getSetting: (key, fallback) => settings[key] ?? fallback, setSetting: (key, value) => { settings[key] = value; } };
  }

  it("records what the helper measured", async () => {
    const store = fakeStore();
    const helper = { request: async () => ({ entries: [{ key: "a:/mnt/a", appId: "a", path: "/mnt/a", mount: "/mnt/a", bytes: 5 * GiB }] }) };
    const sampler = createAppDataSampler({ helper, store, now: () => new Date(day(3)) });
    expect(await sampler.sample()).toEqual({ sampled: 1 });
    expect(store.settings.appDataUsageHistory["a:/mnt/a"][0].bytes).toBe(5 * GiB);
  });

  it("writes nothing at all when the helper measured nothing", async () => {
    // An empty reading must not overwrite a real history with an empty one.
    const store = fakeStore({ appDataUsageHistory: { "a:/mnt/a": [{ at: day(1), bytes: GiB }] } });
    const helper = { request: async () => ({ entries: [] }) };
    await createAppDataSampler({ helper, store, now: () => new Date(day(3)) }).sample();
    expect(store.settings.appDataUsageHistory["a:/mnt/a"]).toHaveLength(1);
  });

  it("does not count a folder it failed to measure as sampled", async () => {
    const store = fakeStore();
    const helper = { request: async () => ({ entries: [
      { key: "a:/mnt/a", appId: "a", path: "/mnt/a", mount: "/mnt/a", bytes: GiB },
      { key: "b:/mnt/b", appId: "b", path: "/mnt/b", mount: "/mnt/b", bytes: null },
    ] }) };
    expect(await createAppDataSampler({ helper, store, now: () => new Date(day(3)) }).sample()).toEqual({ sampled: 1 });
  });

  it("lets a failed run through rather than storing anything", async () => {
    const store = fakeStore({ appDataUsageHistory: { kept: [{ at: day(1), bytes: GiB }] } });
    const helper = { request: async () => { throw new Error("helper is busy"); } };
    await expect(createAppDataSampler({ helper, store, now: () => new Date(day(3)) }).sample()).rejects.toThrow("helper is busy");
    expect(store.settings.appDataUsageHistory.kept).toHaveLength(1);
  });

  it("schedules itself daily and well after boot, and never holds the process open", () => {
    const timers = [];
    const sampler = createAppDataSampler({
      helper: { request: async () => ({ entries: [] }) }, store: fakeStore(),
      setTimeout: (_fn, ms) => { timers.push(["timeout", ms]); return { unref: () => timers.push(["unref"]) }; },
      setInterval: (_fn, ms) => { timers.push(["interval", ms]); return { unref: () => timers.push(["unref"]) }; },
    });
    sampler.start();
    expect(timers).toContainEqual(["interval", 24 * 60 * 60 * 1000]);
    expect(timers).toContainEqual(["timeout", 20 * 60 * 1000]);
    expect(timers.filter(([kind]) => kind === "unref")).toHaveLength(2);
  });
});
