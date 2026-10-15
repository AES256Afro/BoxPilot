// @vitest-environment node
/**
 * BaselineWatch's reader (M51.1): the card's figures from the app's own API, replayed from
 * responses recorded from BaselineWatch 0.10.0 (test/fixtures/baselinewatch: the KEV items, the
 * watched CVEs, the 800-53 5.2.0 release's changes, the triage marks and a digest), the window drawn
 * in UTC, every answer checked field by field, and the digest as an agent reads it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { baselinewatchLimits, createBaselineWatchReader, describeDigest, releasesIn, sinceYesterday, summarizeGlance } from "./baselinewatch.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../test/fixtures/baselinewatch/${name}.json`, import.meta.url), "utf8"));
const recorded = { items: fixture("items-kev"), vulns: fixture("vulns-watch"), changes: fixture("changes"), triage: fixture("triage-affects"), digest: fixture("digest") };
const quiet = { items: fixture("items-kev-none"), vulns: { total: 0, vulns: [] }, changes: fixture("changes-none"), triage: { triage: [] }, digest: { digest: null } };
const now = new Date("2026-10-15T00:45:00Z");
const since = "2026-10-14T00:00:00.000Z";
const base = "http://127.0.0.1:8790";

/** A fetch that answers from the recorded responses by path and remembers what it was asked. */
function replay(answers = recorded, { fail = () => null } = {}) {
  const asked = [];
  const fetcher = async (url, options) => {
    const path = new URL(String(url)).pathname;
    asked.push({ url: String(url), path, options });
    const failure = fail(path);
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    const key = { "/api/v1/items": "items", "/api/v1/vulns": "vulns", "/api/v1/changes": "changes", "/api/v1/triage": "triage", "/api/v1/digest": "digest" }[path];
    return new Response(JSON.stringify(answers[key] ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetcher, asked };
}
const refused = () => Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });

describe("the window", () => {
  it("is since yesterday, drawn at midnight UTC where the feeds date what they carry", () => {
    expect(sinceYesterday(now)).toBe(since);
    expect(sinceYesterday(new Date("2026-10-14T23:59:59Z"))).toBe("2026-10-13T00:00:00.000Z");
    expect(sinceYesterday(new Date("2026-03-01T05:00:00Z"))).toBe("2026-02-28T00:00:00.000Z");
  });
});

describe("the card's figures", () => {
  it("are the KEV additions, the watched CVEs that changed, the releases with their controls, and the marks, from the recorded answers", () => {
    const summary = summarizeGlance(recorded, { since, now });
    expect(summary).toMatchObject({ since, readAt: now.toISOString(), digest: { period: "daily", generatedAt: "2026-10-15T00:45:36.729Z" } });
    expect(summary.metrics.map((metric) => [metric.id, metric.value, metric.status, metric.caption])).toEqual([
      ["kev", 4, "danger", "known exploited"],
      ["watched", 30, "warning", "on your watchlist"],
      ["releases", 1, "warning", "9 controls changed"],
      ["affects", 2, "warning", "open in triage"],
    ]);
    // Each figure says where in the app it came from.
    expect(summary.metrics.map((metric) => metric.path)).toEqual(["/wire?kind=kev", "/vulns?watch=1", "/", "/triage?state=affects"]);
  });

  it("are plain figures, not green, when nothing happened", () => {
    const summary = summarizeGlance(quiet, { since, now });
    expect(summary.metrics.map((metric) => [metric.value, metric.status])).toEqual([[0, "neutral"], [0, "neutral"], [0, "neutral"], [0, "neutral"]]);
    expect(summary.metrics[2].caption).toBe("0 controls changed");
    expect(summary.digest).toBeNull();
  });

  it("leave a figure unknown, never zero, when that one answer could not be read", () => {
    const summary = summarizeGlance({ ...recorded, vulns: null, changes: { changes: "not a list" } }, { since, now });
    expect(summary.metrics.map((metric) => [metric.id, metric.value, metric.status, metric.caption])).toEqual([
      ["kev", 4, "danger", "known exploited"],
      ["watched", null, "unknown", "not read"],
      ["releases", null, "unknown", "not read"],
      ["affects", 2, "warning", "open in triage"],
    ]);
  });

  it("count a release once however many controls it changed, and take the list's total over its page", () => {
    expect(releasesIn(recorded.changes.changes)).toBe(1);
    expect(releasesIn([...recorded.changes.changes, { source: "disa-stigs", document: "windows-11", version: "V2R3" }, null, "junk"])).toBe(2);
    expect(summarizeGlance({ ...quiet, vulns: { total: 12, vulns: [{ cve: "CVE-2026-1" }] } }, { since, now }).metrics[1].value).toBe(12);
    expect(summarizeGlance({ ...quiet, vulns: { vulns: [{ cve: "CVE-2026-1" }] } }, { since, now }).metrics[1].value).toBe(1);
  });
});

describe("the reader", () => {
  it("asks the five reads since yesterday, with no redirects and a timeout, and answers the card", async () => {
    const { fetcher, asked } = replay();
    const reader = createBaselineWatchReader({ fetcher, now: () => now });
    const glance = await reader.glance({ baseUrl: base });
    expect(glance).toMatchObject({ available: true, reason: null, since });
    expect(glance.metrics.map((metric) => metric.value)).toEqual([4, 30, 1, 2]);
    expect(asked.map((entry) => entry.url).sort()).toEqual([
      `${base}/api/v1/changes?since=${encodeURIComponent(since)}&limit=200`,
      `${base}/api/v1/digest`,
      `${base}/api/v1/items?kind=kev&since=${encodeURIComponent(since)}&limit=200`,
      `${base}/api/v1/triage?state=affects&limit=200`,
      `${base}/api/v1/vulns?watch=1&since=${encodeURIComponent(since)}&limit=200`,
    ]);
    for (const { options } of asked) {
      expect(options.redirect).toBe("error");
      expect(options.headers.Accept).toBe("application/json");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("says the app did not answer when nothing is listening, and which figure when one read failed", async () => {
    const down = createBaselineWatchReader({ fetcher: replay(recorded, { fail: () => refused() }).fetcher, now: () => now });
    expect(await down.glance({ baseUrl: base })).toMatchObject({ available: false, reason: "BaselineWatch did not answer: nothing is listening on its port.", metrics: [] });
    const partly = createBaselineWatchReader({ fetcher: replay(recorded, { fail: (path) => (path === "/api/v1/vulns" ? new Response("", { status: 500 }) : null) }).fetcher, now: () => now });
    const glance = await partly.glance({ baseUrl: base });
    expect(glance.available).toBe(true);
    expect(glance.metrics.map((metric) => metric.value)).toEqual([4, null, 1, 2]);
  });

  it("says when the app wants a sign-in, and when its answer is not what was asked for", async () => {
    const closed = createBaselineWatchReader({ fetcher: replay(recorded, { fail: () => new Response("Sign in first.", { status: 401 }) }).fetcher, now: () => now });
    expect((await closed.glance({ baseUrl: base })).reason).toMatch(/asks for a sign-in to read: turn on "Anyone on the network can read"/);
    const html = createBaselineWatchReader({ fetcher: replay(recorded, { fail: () => new Response("<html>", { status: 200 }) }).fetcher, now: () => now });
    expect(await html.digest({ baseUrl: base })).toMatchObject({ available: false, reason: "BaselineWatch did not answer: its answer was not JSON." });
    const list = createBaselineWatchReader({ fetcher: replay(recorded, { fail: () => new Response("[]", { status: 200 }) }).fetcher, now: () => now });
    expect((await list.digest({ baseUrl: base })).reason).toMatch(/not the shape expected/);
  });

  it("reads the digest whole, with when it was written and what it covers", async () => {
    const reader = createBaselineWatchReader({ fetcher: replay().fetcher, now: () => now });
    const result = await reader.digest({ baseUrl: base });
    expect(result).toMatchObject({ available: true, digest: { period: "daily", generatedAt: "2026-10-15T00:45:36.729Z", coversFrom: "2026-10-14T00:45:36.729Z", coversTo: "2026-10-15T00:45:36.729Z" } });
    expect(result.digest.text).toMatch(/^BaselineWatch daily digest, 2026-10-14 to 2026-10-15\n\nKnown exploited \(CISA KEV\): 15 added/);
    const none = createBaselineWatchReader({ fetcher: replay(quiet).fetcher, now: () => now });
    expect(await none.digest({ baseUrl: base })).toEqual({ available: true, reason: null, digest: null });
  });
});

describe("the digest as an agent reads it", () => {
  it("leads with when it was written and what it covers, then the words, bounded", async () => {
    const reader = createBaselineWatchReader({ fetcher: replay().fetcher, now: () => now });
    const text = describeDigest(await reader.digest({ baseUrl: base }));
    expect(text).toMatch(/^BaselineWatch's daily digest, written 2026-10-15T00:45:36\.729Z\. It covers 2026-10-14T00:45:36\.729Z to 2026-10-15T00:45:36\.729Z\.\n\nBaselineWatch daily digest/);
    expect(text).toContain("Triage: 2 affects us");
    const long = describeDigest({ available: true, digest: { period: "weekly", generatedAt: "2026-10-15T07:00:00.000Z", coversFrom: null, coversTo: null, text: "x".repeat(20_000) } });
    expect(long.length).toBeLessThan(baselinewatchLimits.digestChars + 100);
    expect(long).toMatch(/…$/);
    expect(long).not.toMatch(/It covers/);
  });

  it("says plainly when there is no digest yet, and when the app could not be read", () => {
    expect(describeDigest({ available: true, digest: null })).toMatch(/^BaselineWatch has no digest yet: it writes one at its digest hour/);
    expect(describeDigest({ available: false, reason: "BaselineWatch did not answer: nothing is listening on its port." })).toBe("BaselineWatch: BaselineWatch did not answer: nothing is listening on its port.");
    expect(describeDigest(null)).toBe("BaselineWatch could not be read.");
  });
});
