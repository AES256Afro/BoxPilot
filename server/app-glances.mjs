/**
 * Apps Today reads (M51): one card per installed catalog app that has a reader, and the same
 * reader behind an agent tool. Keyed off the catalog, as ADR-001 asks: an app that is not
 * installed has no card and no tool answer; one whose container is stopped has a card that says
 * so; one whose API does not answer has a card that says that, never figures. The readers are a
 * registry, one module per app (server/baselinewatch.mjs is the first), and nothing about an app
 * lives outside its module: this file only finds the app and the address to read it at.
 *
 * The address comes from the app's own record (app.inspect: the port Docker published and the
 * address it bound), never from a request: the web port on loopback when the port is bound to
 * every address, otherwise the address it was bound to. The helper cannot make the request itself
 * (PrivateNetwork=true), so the web service does, as it reads SearXNG for the agents.
 */
import { baselinewatchAppId, createBaselineWatchReader, describeDigest } from "./baselinewatch.mjs";

/** Every app with a reader: the card's title, the window its figures cover, and how to read it. */
export const appReaders = Object.freeze({
  [baselinewatchAppId]: Object.freeze({ title: "Baselines and threats", window: "since yesterday", create: createBaselineWatchReader }),
});

const everyAddress = new Set(["", "*", "0.0.0.0", "::", "[::]"]);
const bindPattern = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9a-f:]+\]?)$/i;

/**
 * Where this server reaches an installed app's web UI: `http://<bind>:<port>`, with loopback for a
 * port bound to every address. Null for an app with no published web port, or one on a tailnet or
 * LAN address that is not an address at all (a record this cannot trust is a record it will not
 * follow).
 */
export function reachableUrl(application) {
  if (!application?.installed) return null;
  const web = (application.urls ?? []).find((entry) => Number.isInteger(entry?.host) && entry.host > 0 && entry.host < 65536) ?? null;
  if (!web) return null;
  const published = (application.published ?? []).find((entry) => entry?.host === web.host && (entry.protocol ?? "tcp") === "tcp") ?? null;
  const bind = String(published?.bind ?? "").trim();
  if (everyAddress.has(bind) || web.exposure === "loopback") return `http://127.0.0.1:${web.host}`;
  if (!bindPattern.test(bind)) return null;
  const host = bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind;
  return `http://${host}:${web.host}`;
}

export function createAppGlances({ helper = null, fetcher = fetch, now = () => new Date(), helperTimeoutMs = 30_000 } = {}) {
  const readers = Object.fromEntries(Object.entries(appReaders).map(([id, entry]) => [id, { ...entry, reader: entry.create({ fetcher, now }) }]));

  /** The installed apps that have a reader, from the helper's own record; none when it cannot say. */
  async function installed() {
    if (!helper) throw new Error("The helper is not available");
    const listed = await helper.request("app.inspect", {}, { timeoutMs: helperTimeoutMs });
    return (Array.isArray(listed?.applications) ? listed.applications : []).filter((application) => application?.installed && readers[application.id]);
  }

  /** What the Today page draws: one glance per installed app with a reader, in the registry's order. */
  async function list() {
    const applications = await installed().catch(() => null);
    if (!applications) return { glances: [], liveKnown: false };
    const glances = await Promise.all(applications.map(async (application) => {
      const { title, window, reader } = readers[application.id];
      const running = application.container?.running === true && application.container?.status !== "paused";
      const base = { app: application.id, name: application.name ?? application.id, title, window, url: application.urls?.[0] ?? null, running };
      const url = reachableUrl(application);
      if (!running) return { ...base, available: false, reason: `${base.name} is not running.`, since: null, readAt: now().toISOString(), metrics: [], digest: null };
      if (!url) return { ...base, available: false, reason: `${base.name} publishes no web port this server can reach.`, since: null, readAt: now().toISOString(), metrics: [], digest: null };
      const read = await reader.glance({ baseUrl: url }).catch((error) => ({ available: false, reason: `${base.name} could not be read: ${error.message}.`, since: null, readAt: now().toISOString(), metrics: [], digest: null }));
      return { ...base, ...read };
    }));
    return { glances, liveKnown: true };
  }

  /** The app's latest digest as an agent reads it, or why there is none. */
  async function digest(appId) {
    const entry = readers[appId];
    if (!entry) throw new Error(`${appId} has no reader`);
    const applications = await installed().catch(() => null);
    const name = appId === baselinewatchAppId ? "BaselineWatch" : appId;
    if (!applications) return describeDigest({ available: false, reason: "whether it is installed could not be read." }, { name });
    const application = applications.find((candidate) => candidate.id === appId) ?? null;
    if (!application) return describeDigest({ available: false, reason: "not installed on this server (install it from the App catalog)." }, { name: application?.name ?? name });
    if (application.container?.running !== true) return describeDigest({ available: false, reason: "installed but not running." }, { name: application.name ?? name });
    const url = reachableUrl(application);
    if (!url) return describeDigest({ available: false, reason: "publishes no web port this server can reach." }, { name: application.name ?? name });
    return describeDigest(await entry.reader.digest({ baseUrl: url }), { name: application.name ?? name });
  }

  return { list, digest, has: (appId) => Object.hasOwn(readers, appId) };
}
