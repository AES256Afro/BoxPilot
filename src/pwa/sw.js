/*
 * The worker's events (M25.1). Built into dist/sw.js after src/pwa/swRules.js, whose functions it
 * calls, and after the two constants the build writes: VERSION (this build) and PRECACHE (the shell,
 * its entry bundle and stylesheet, the fonts and the icons). Served from the site root, so its scope
 * is the whole app; the page registers it only over HTTPS and never in the demo (src/pwa/register.ts).
 */
/* global VERSION, PRECACHE, routeFor, cacheable, isShell, notificationFrom, safeOpenUrl */

const shellKey = "/";
const cacheName = `boxpilot-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    // One at a time on their own: a file that will not come does not stop the rest, or the worker.
    await Promise.all(PRECACHE.map(async (path) => {
      try {
        const response = await fetch(path, { cache: "no-cache", credentials: "same-origin" });
        if (cacheable(response) && (path !== shellKey || isShell(response))) await cache.put(path, response);
      } catch { /* fetched when it is first used instead */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // An older build's files go with its worker; nothing but BoxPilot's own caches is touched.
    for (const name of await caches.keys()) if (name.startsWith("boxpilot-") && name !== cacheName) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const route = routeFor(event.request, self.location.origin);
  // The API and everything else not the app's own files: not answered, not read, not kept.
  if (route === "network") return;
  event.respondWith(answer(event.request, route));
});

/*
 * Push approvals (M25.2). A push shows a notification and nothing else: it is never an approval,
 * and the worker never reads a job, calls the API or keeps anything for it. Tapping it opens the app
 * at the approval (or Today); the page reads the job as whoever is signed in and asks for the tier's
 * confirmation or password there.
 */
self.addEventListener("push", (event) => {
  let payload = null;
  try { payload = event.data ? event.data.json() : null; } catch { payload = null; }
  const note = notificationFrom(payload, self.location.origin);
  event.waitUntil(self.registration.showNotification(note.title, note.options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeOpenUrl(event.notification.data?.url, self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (open) {
      // The page opens the approval in place (src/App.tsx), keeping whatever it was showing.
      open.postMessage({ type: "boxpilot:open", url });
      await open.focus();
      return;
    }
    await self.clients.openWindow(url);
  })());
});

async function answer(request, route) {
  const cache = await caches.open(cacheName);
  if (route === "asset") {
    const kept = await cache.match(request);
    if (kept) return kept;
    const response = await fetch(request);
    if (cacheable(response)) await cache.put(request, response.clone());
    return response;
  }
  try {
    const response = await fetch(request);
    if (route === "shell") {
      // Every page is the same shell; the newest one is kept for when the network is gone.
      if (cacheable(response) && isShell(response)) await cache.put(shellKey, response.clone());
    } else if (cacheable(response)) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const kept = await cache.match(route === "shell" ? shellKey : request);
    if (kept) return kept;
    throw error;
  }
}
