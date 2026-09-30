/*
 * The service worker's rules (M25.1), apart from the worker so they can be tested one by one. The
 * build (vite.config.ts, src/pwa/serviceWorkerSource.ts) puts this file and src/pwa/sw.js into one
 * classic script, dist/sw.js, with every `export` taken off. Plain JavaScript on purpose: the worker
 * is served as written, and src/pwa/swRules.d.ts gives the tests its types.
 *
 * What is kept is the app itself - the shell page, the hashed bundles, the fonts, the icons - which
 * is the same for everyone and holds nothing about this server or who is signed in. Every answer
 * from the API is left to the network: the worker does not even look at it. Offline reads come from
 * the page's own short-lived, per-account "last known state" (src/pwa/lastKnown.ts), which signing
 * out clears; never from here.
 */

/** Never answered from a cache, and never written to one: the API, sign-in with BoxPilot, the CA. */
export const neverCached = [/^\/api\//i, /^\/oidc\//i, /^\/\.well-known\//i, /^\/ca\.crt$/i, /^\/sw\.js$/i];

/**
 * What the worker does with one request:
 * - "network": nothing at all. The browser fetches it as if there were no worker.
 * - "shell": a page load. The network first; the cached shell when it cannot be reached.
 * - "asset": a hashed, immutable bundle or font. The cache first, filled on first use.
 * - "static": the manifest, the icons, the font licences. The network first, the cache offline.
 */
export function routeFor(request, origin) {
  if ((request.method ?? "GET").toUpperCase() !== "GET") return "network";
  let url;
  try { url = new URL(request.url); } catch { return "network"; }
  if (url.origin !== origin) return "network";
  if (neverCached.some((pattern) => pattern.test(url.pathname))) return "network";
  if (request.mode === "navigate") return "shell";
  if (url.pathname.startsWith("/assets/")) return "asset";
  if (url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/") || url.pathname.startsWith("/licenses/")) return "static";
  return "network";
}

/**
 * Whether a response may be kept: a whole 200 from this origin, not marked no-store or private, and
 * not data (JSON, an event stream). The API is never routed here; this is the second lock on it.
 */
export function cacheable(response) {
  if (!response || response.status !== 200 || !response.ok) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  const control = String(response.headers.get("cache-control") ?? "").toLowerCase();
  if (/(^|[,\s])(no-store|private)([,\s]|$)/.test(control)) return false;
  const type = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("json") || type.includes("event-stream")) return false;
  return true;
}

/** The shell is HTML; anything else answering a page load (an error in JSON) is not kept as it. */
export function isShell(response) {
  return String(response?.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");
}
