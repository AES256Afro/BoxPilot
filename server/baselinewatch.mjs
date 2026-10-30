/**
 * The BaselineWatch reader (M51.1): what Today's "Baselines and threats" card and the agents'
 * baselinewatch.digest tool may know about an installed BaselineWatch, read over the app's own
 * read-only JSON API. The web service reads it, not the helper: the helper has no network at all
 * (PrivateNetwork=true), and the app's web port is published on this host, so the read is one
 * request to loopback or to the address Docker bound the port to (server/app-glances.mjs says which).
 *
 * The answer is the shape of the card: four counts since yesterday (additions to CISA's Known
 * Exploited Vulnerabilities list, watched CVEs that changed, standards that published a release
 * with changes, and items the owner marked as affecting this house), each with where in the app it
 * came from, and whether the latest digest exists. Nothing here is a secret and nothing names a
 * device: BaselineWatch holds public feeds and the owner's own marks. Every field is checked as it
 * is read; a body that is not the shape asked for is "could not be read", never figures.
 *
 * The digest's words are a third party's feeds summarised, so an agent reads them as data: the
 * harness boxes every tool output as untrusted and watches it for instructions (guard.mjs).
 */
import { readBounded } from "../packages/harness/src/index.mjs";

export const baselinewatchAppId = "baselinewatch";

export const baselinewatchLimits = Object.freeze({
  /** The most of one answer that is read; the lists are asked for at most 200 entries. */
  bodyBytes: 1024 * 1024,
  listLimit: 200,
  /** The digest as an agent reads it. */
  digestChars: 6_000,
  timeoutMs: 10_000,
});

/**
 * "Since yesterday", for a clock: midnight UTC at the start of the day before. The feeds date
 * what they carry in UTC (CISA's KEV dates are plain dates; NVD's timestamps are UTC), so the
 * window is drawn where they are, the same on every server whatever its time zone.
 */
export function sinceYesterday(now = new Date()) {
  const at = new Date(now.getTime());
  at.setUTCHours(0, 0, 0, 0);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString();
}

const list = (value) => (Array.isArray(value) ? value : null);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const text = (value, max = 400) => (typeof value === "string" ? value.slice(0, max) : null);
const isoTime = (value) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);

/**
 * A release is a standard's document version that published at least one change: the Register
 * counts releases that way too (a version with nothing changed is not news).
 */
export function releasesIn(changes) {
  const seen = new Set();
  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    const key = `${text(change.source, 80) ?? "?"} ${text(change.document, 120) ?? "?"} ${text(change.version, 40) ?? "?"}`;
    seen.add(key);
  }
  return seen.size;
}

/** A count's tone on the card: a figure to act on is amber; nothing is a plain figure, never green about a feed. */
const toneOf = (value, { danger = false } = {}) => (value === null ? "unknown" : value === 0 ? "neutral" : danger ? "danger" : "warning");

/**
 * The card's figures from the five answers, each checked field by field. An answer that could not
 * be read (`null`) leaves its figure unknown rather than zero: zero would read as "nothing
 * happened".
 */
export function summarizeGlance({ items, vulns, changes, triage, digest }, { since, now = new Date() }) {
  const kevItems = list(items?.items);
  const changedVulns = count(vulns?.total) ?? (list(vulns?.vulns)?.length ?? null);
  const changeRows = list(changes?.changes);
  const affectsRows = list(triage?.triage);
  const kev = kevItems ? kevItems.length : null;
  const releases = changeRows ? releasesIn(changeRows) : null;
  const controls = changeRows ? changeRows.length : null;
  const affects = affectsRows ? affectsRows.length : null;
  const latest = digest && typeof digest === "object" && digest.digest && typeof digest.digest === "object" ? digest.digest : null;
  const generatedAt = isoTime(latest?.generatedAt);
  return {
    since,
    readAt: now.toISOString(),
    metrics: [
      { id: "kev", label: "KEV additions", value: kev, caption: kev === null ? "not read" : "known exploited", status: toneOf(kev, { danger: kev !== null && kev > 0 }), path: "/wire?kind=kev" },
      { id: "watched", label: "Watched CVEs changed", value: changedVulns, caption: changedVulns === null ? "not read" : "on your watchlist", status: toneOf(changedVulns), path: "/vulns?watch=1" },
      { id: "releases", label: "Standard releases", value: releases, caption: releases === null ? "not read" : controls === 1 ? "1 control changed" : `${controls} controls changed`, status: toneOf(releases), path: "/" },
      { id: "affects", label: "Marked affects us", value: affects, caption: affects === null ? "not read" : "open in triage", status: toneOf(affects), path: "/triage?state=affects" },
    ],
    digest: latest ? { period: text(latest.period, 20), generatedAt, coversFrom: isoTime(latest.coversFrom), coversTo: isoTime(latest.coversTo) } : null,
  };
}

/** The digest as an agent reads it: when it was written, what it covers, then its words, bounded. */
export function describeDigest(result, { name = "BaselineWatch" } = {}) {
  if (!result) return `${name} could not be read.`;
  if (!result.available) return `${name}: ${result.reason ?? "could not be read."}`;
  const digest = result.digest;
  if (!digest?.text) return `${name} has no digest yet: it writes one at its digest hour (daily by default, 07:00 in its time zone).`;
  const period = digest.period ? `${digest.period} digest` : "digest";
  const covers = digest.coversFrom && digest.coversTo ? ` It covers ${digest.coversFrom} to ${digest.coversTo}.` : "";
  const body = digest.text.length > baselinewatchLimits.digestChars ? `${digest.text.slice(0, baselinewatchLimits.digestChars - 1)}…` : digest.text;
  return `${name}'s ${period}, written ${digest.generatedAt ?? "at an unknown time"}.${covers}\n\n${body}`;
}

/**
 * The reader. `fetcher` is fetch; `now` the injected clock. Every request is one GET to the base
 * address the caller worked out from the app's own record, with a timeout, no redirects (a
 * redirect would be another host's answer) and a bounded body.
 */
export function createBaselineWatchReader({ fetcher = fetch, now = () => new Date(), timeoutMs = baselinewatchLimits.timeoutMs } = {}) {
  async function getJson(baseUrl, path) {
    let response;
    try {
      response = await fetcher(`${baseUrl}${path}`, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const code = error?.cause?.code ?? (error?.name === "TimeoutError" ? "timeout" : null);
      throw new Error(code === "ECONNREFUSED" ? "nothing is listening on its port" : code === "timeout" ? `no answer within ${Math.round(timeoutMs / 1000)}s` : `the request failed${code ? ` (${code})` : ""}`);
    }
    if (response.status === 401 || response.status === 403) throw new Error("it asks for a sign-in to read: turn on \"Anyone on the network can read\" on its card");
    if (!response.ok) throw new Error(`it answered ${response.status}`);
    let body;
    try { body = JSON.parse(await readBounded(response, baselinewatchLimits.bodyBytes)); } catch { throw new Error("its answer was not JSON"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("its answer was not the shape expected");
    return body;
  }

  /** The card: the four counts since yesterday and whether a digest exists. */
  async function glance({ baseUrl }) {
    const readAt = now();
    const since = sinceYesterday(readAt);
    const query = `since=${encodeURIComponent(since)}&limit=${baselinewatchLimits.listLimit}`;
    const asked = await Promise.allSettled([
      getJson(baseUrl, `/api/v1/items?kind=kev&${query}`),
      getJson(baseUrl, `/api/v1/vulns?watch=1&${query}`),
      getJson(baseUrl, `/api/v1/changes?${query}`),
      getJson(baseUrl, `/api/v1/triage?state=affects&limit=${baselinewatchLimits.listLimit}`),
      getJson(baseUrl, "/api/v1/digest"),
    ]);
    const [items, vulns, changes, triage, digest] = asked.map((outcome) => (outcome.status === "fulfilled" ? outcome.value : null));
    // Every read failing the same way is the app not answering; one of five failing is one unknown figure.
    if (asked.every((outcome) => outcome.status === "rejected")) return { available: false, reason: `BaselineWatch did not answer: ${/** @type {PromiseRejectedResult} */ (asked[0]).reason?.message ?? "unknown"}.`, since, readAt: readAt.toISOString(), metrics: [], digest: null };
    return { available: true, reason: null, ...summarizeGlance({ items, vulns, changes, triage, digest }, { since, now: readAt }) };
  }

  /** The latest digest, whole, for the agents. */
  async function digest({ baseUrl }) {
    let body;
    try { body = await getJson(baseUrl, "/api/v1/digest"); } catch (error) { return { available: false, reason: `BaselineWatch did not answer: ${error.message}.`, digest: null }; }
    const latest = body.digest && typeof body.digest === "object" ? body.digest : null;
    if (!latest) return { available: true, reason: null, digest: null };
    return {
      available: true, reason: null,
      digest: { period: text(latest.period, 20), generatedAt: isoTime(latest.generatedAt), coversFrom: isoTime(latest.coversFrom), coversTo: isoTime(latest.coversTo), text: text(latest.text, baselinewatchLimits.digestChars * 4) ?? "" },
    };
  }

  return { glance, digest };
}
