// @vitest-environment node
import { describe, expect, it } from "vitest";
import rules from "./swRules.js?raw";
import worker from "./sw.js?raw";
import { serviceWorkerSource } from "./serviceWorkerSource";
import { cacheable, routeFor } from "./swRules";

/*
 * The service worker's caching rules (M25.1): it keeps the app - the shell, the hashed bundles, the
 * fonts, the icons - and never an answer from the API, which holds this server's state and the
 * signed-in person's. The rules are tested one by one, and then the worker exactly as the build
 * writes it is run against a stand-in network and cache, to show what it keeps and what it leaves.
 */

const origin = "https://homebox.tail0a1b.ts.net";
const html = (body = "<!doctype html><title>BoxPilot</title>") => new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const script = (body = "console.log(1)", headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000, immutable", ...headers } });

describe("which requests the worker answers", () => {
  const route = (path: string, init: { method?: string; mode?: string } = {}) => routeFor({ url: new URL(path, origin).href, ...init }, origin);

  it("leaves the API alone, whatever the casing and however it is asked for", () => {
    expect(route("/api/v1/jobs")).toBe("network");
    expect(route("/API/v1/jobs")).toBe("network");
    expect(route("/api/v1/events")).toBe("network");
    expect(route("/api/v1/jobs?limit=200", { mode: "navigate" })).toBe("network");
    expect(route("/api/v1/jobs/1/approve", { method: "POST" })).toBe("network");
  });

  it("leaves sign-in with BoxPilot, discovery, the CA certificate and itself alone", () => {
    for (const path of ["/oidc/authorize", "/.well-known/openid-configuration", "/ca.crt", "/sw.js"]) {
      expect(route(path, { mode: "navigate" }), path).toBe("network");
      expect(route(path), path).toBe("network");
    }
  });

  it("answers page loads with the shell, hashed files from its cache, and the icons and manifest", () => {
    expect(route("/", { mode: "navigate" })).toBe("shell");
    expect(route("/?view=today", { mode: "navigate" })).toBe("shell");
    expect(route("/assets/index-abc123.js")).toBe("asset");
    expect(route("/assets/figtree-latin-wght-normal-D_ZTVpCC.woff2")).toBe("asset");
    expect(route("/manifest.webmanifest")).toBe("static");
    expect(route("/icons/icon-192.png")).toBe("static");
  });

  it("leaves other origins, other methods and everything else to the network", () => {
    expect(routeFor({ url: "https://ntfy.example/topic" }, origin)).toBe("network");
    expect(route("/assets/index-abc123.js", { method: "POST" })).toBe("network");
    expect(route("/anything-else.txt")).toBe("network");
    expect(routeFor({ url: "not a url" }, origin)).toBe("network");
  });
});

describe("which answers may be kept", () => {
  it("keeps a whole, same-origin, immutable file", () => {
    expect(cacheable(script())).toBe(true);
    expect(cacheable(html())).toBe(true);
  });

  it("never keeps JSON, an event stream, no-store, private, a partial or a failed answer", () => {
    expect(cacheable(json({ jobs: [] }))).toBe(false);
    expect(cacheable(json({ jobs: [] }, { "Cache-Control": "public, max-age=60" }))).toBe(false);
    expect(cacheable(new Response("data: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }))).toBe(false);
    expect(cacheable(script("x", { "Cache-Control": "no-store" }))).toBe(false);
    expect(cacheable(script("x", { "Cache-Control": "private, max-age=60" }))).toBe(false);
    expect(cacheable(new Response("x", { status: 206 }))).toBe(false);
    expect(cacheable(new Response("x", { status: 404 }))).toBe(false);
    expect(cacheable({ status: 200, ok: true, type: "opaque", headers: new Headers() })).toBe(false);
    expect(cacheable(null)).toBe(false);
  });
});

/** The built worker, run with a stand-in network and cache storage, and what it did. */
function runWorker(network: (url: string) => Response | Error, precache = ["/", "/assets/index-abc.js", "/icons/icon-192.png"]) {
  const source = serviceWorkerSource({ rules, worker, precache, version: "9.9.9" });
  const listeners: Record<string, (event: unknown) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const asked: string[] = [];
  const keyOf = (input: string | { url: string }) => new URL(typeof input === "string" ? input : input.url, origin).href;
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        put: async (input: string | { url: string }, response: Response) => { store.set(keyOf(input), response); },
        match: async (input: string | { url: string }) => store.get(keyOf(input))?.clone(),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const fetchStandIn = async (input: string | { url: string }) => {
    const url = keyOf(input);
    asked.push(url);
    const answer = network(url);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const shown: Array<{ title: string; options: { body: string; tag: string; data: { url: string } } }> = [];
  const windows: Array<{ url: string; messages: unknown[]; focused: boolean; postMessage: (message: unknown) => void; focus: () => Promise<void> }> = [];
  const opened: string[] = [];
  const self = {
    location: { origin },
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; },
    skipWaiting: async () => undefined,
    registration: { showNotification: async (title: string, options: { body: string; tag: string; data: { url: string } }) => { shown.push({ title, options }); } },
    clients: { claim: async () => undefined, matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url); } },
  };
  const openWindow = (url: string) => {
    const client = { url, messages: [] as unknown[], focused: false, postMessage(message: unknown) { client.messages.push(message); }, async focus() { client.focused = true; } };
    windows.push(client);
    return client;
  };
  new Function("self", "caches", "fetch", source)(self, caches, fetchStandIn);

  async function lifecycle(type: "install" | "activate") {
    let waited: Promise<unknown> = Promise.resolve();
    listeners[type]({ waitUntil: (promise: Promise<unknown>) => { waited = promise; } });
    await waited;
  }
  /** A request through the worker: its answer, or null when it was left to the browser. */
  async function request(path: string, init: { method?: string; mode?: string } = {}): Promise<Response | null> {
    let answered: Promise<Response> | null = null;
    listeners.fetch({ request: { url: new URL(path, origin).href, method: init.method ?? "GET", mode: init.mode ?? "cors" }, respondWith: (promise: Promise<Response>) => { answered = promise; } });
    return answered ? await answered : null;
  }
  const kept = () => [...stores.values()].flatMap((store) => [...store.keys()].map((url) => new URL(url).pathname + new URL(url).search));
  /** A push arriving, with this body (or none). */
  async function push(body: unknown) {
    let waited: Promise<unknown> = Promise.resolve();
    const data = body === undefined ? null : { json: () => (typeof body === "string" ? JSON.parse(body) : body) };
    listeners.push({ data, waitUntil: (promise: Promise<unknown>) => { waited = promise; } });
    await waited;
  }
  /** The last notification shown, tapped. */
  async function tap() {
    let waited: Promise<unknown> = Promise.resolve();
    const note = shown.at(-1)!;
    listeners.notificationclick({ notification: { data: note.options.data, close: () => undefined }, waitUntil: (promise: Promise<unknown>) => { waited = promise; } });
    await waited;
  }
  return { source, lifecycle, request, kept, stores, asked, push, tap, shown, opened, openWindow };
}

describe("the worker as built", () => {
  it("is one classic script that starts with its version and the files to keep", () => {
    const { source } = runWorker(() => html());
    expect(source).toMatch(/^\/\* BoxPilot's service worker, 9\.9\.9-[0-9a-f]{8}\./);
    expect(source).toContain('const PRECACHE = ["/","/assets/index-abc.js","/icons/icon-192.png"];');
    expect(source).not.toMatch(/^\s*(import|export)\b/m);
  });

  it("refuses to be built to keep anything from the API", () => {
    for (const path of ["/api/v1/jobs", "/API/v1/auth/status", "/oidc/jwks", "/ca.crt"]) {
      expect(() => serviceWorkerSource({ rules, worker, precache: ["/", path], version: "1" }), path).toThrow(/may not keep/);
    }
  });

  it("keeps the shell and the app's files when it installs, and skips one that will not come", async () => {
    const worker = runWorker((url) => (url.endsWith("/") ? html() : url.includes("/icons/") ? new Error("offline") : script()));
    await worker.lifecycle("install");
    expect(worker.kept().sort()).toEqual(["/", "/assets/index-abc.js"]);
  });

  it("never reads, answers or keeps an API request, even when the API answers", async () => {
    const worker = runWorker((url) => (url.includes("/api/") ? json({ owner: "alex", jobs: [{ id: "secret-job" }] }, { "Cache-Control": "public, max-age=600" }) : html()));
    await worker.lifecycle("install");
    for (const path of ["/api/v1/auth/status", "/api/v1/jobs?limit=200", "/api/v1/notifications", "/API/v1/settings/notifications", "/api/v1/events"]) {
      expect(await worker.request(path), path).toBeNull();
      expect(await worker.request(path, { mode: "navigate" }), path).toBeNull();
    }
    expect(worker.kept().some((path) => /api/i.test(path))).toBe(false);
    expect(worker.asked.some((url) => /api/i.test(url))).toBe(false); // the browser fetched them, not the worker
    expect(JSON.stringify([...worker.stores.keys()])).not.toContain("secret");
  });

  it("serves a hashed file from its cache once it has it, even with the network gone", async () => {
    let online = true;
    const worker = runWorker((url) => (online ? (url.endsWith("/") ? html() : script(`// ${url}`)) : new Error("offline")));
    const first = await worker.request("/assets/SettingsPage-abc.js");
    expect(await first!.text()).toContain("SettingsPage-abc.js");
    online = false;
    expect(await (await worker.request("/assets/SettingsPage-abc.js"))!.text()).toContain("SettingsPage-abc.js");
    await expect(worker.request("/assets/NeverSeen-abc.js")).rejects.toThrow("offline");
  });

  it("does not keep a hashed file that says no-store", async () => {
    const worker = runWorker(() => script("x", { "Cache-Control": "no-store" }));
    await worker.request("/assets/odd-abc.js");
    expect(worker.kept()).toEqual([]);
  });

  it("loads pages from the network, keeps the newest shell, and opens that shell offline", async () => {
    let online = true;
    const worker = runWorker(() => (online ? html("<!doctype html><title>newest</title>") : new Error("offline")));
    expect(await (await worker.request("/?view=ops", { mode: "navigate" }))!.text()).toContain("newest");
    expect(worker.kept()).toEqual(["/"]);
    online = false;
    const offline = await worker.request("/?approve=0f8b3c1e-1111-4222-8333-444455556666", { mode: "navigate" });
    expect(await offline!.text()).toContain("newest");
  });

  it("does not keep a page load that was answered with something other than the shell", async () => {
    const worker = runWorker(() => new Response(JSON.stringify({ error: "BoxPilot is restarting" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await worker.request("/", { mode: "navigate" });
    expect(worker.kept()).toEqual([]);
  });

  it("shows a push as a notification that opens the approval it names (M25.2)", async () => {
    const worker = runWorker(() => html());
    const id = "0f8b3c1e-1111-4222-8333-444455556666";
    await worker.push({ web_push: 8030, notification: { title: "Update an app (Jellyfin): approve?", body: "Medium risk. Tap to review it in BoxPilot; nothing runs until you approve it there.", navigate: `${origin}/?approve=${id}`, tag: "approval-0f8b3c1e", silent: false } });
    expect(worker.shown).toEqual([{ title: "Update an app (Jellyfin): approve?", options: expect.objectContaining({ body: "Medium risk. Tap to review it in BoxPilot; nothing runs until you approve it there.", tag: "approval-0f8b3c1e", data: { url: `${origin}/?approve=${id}` } }) }]);
    // Not open: tapping opens the app at the approval.
    await worker.tap();
    expect(worker.opened).toEqual([`${origin}/?approve=${id}`]);
    // Open already: the page is told which approval, and brought forward; nothing reloads.
    const page = worker.openWindow(`${origin}/?view=ops`);
    await worker.tap();
    expect(page.messages).toEqual([{ type: "boxpilot:open", url: `${origin}/?approve=${id}` }]);
    expect(page.focused).toBe(true);
    // The worker reads no job and calls no API for a push.
    expect(worker.asked).toEqual([]);
  });

  it("opens only this app, at an approval or at Today, whatever a push names", async () => {
    const worker = runWorker(() => html());
    for (const navigate of ["https://evil.example/?approve=0f8b3c1e-1111-4222-8333-444455556666", `${origin}/api/v1/jobs/x/approve`, `${origin}/?approve=../../x`, `${origin}/?approve=0f8b3c1e-1111-4222-8333-444455556666&password=x`, "javascript:alert(1)", 42]) {
      await worker.push({ notification: { title: "x", navigate } });
      expect(worker.shown.at(-1)!.options.data.url, String(navigate)).toBe(`${origin}/?view=today`);
    }
  });

  it("still shows something for a push it cannot read, so the permission is never lost", async () => {
    const worker = runWorker(() => html());
    await worker.push(undefined);
    await worker.push("{not json");
    expect(worker.shown.map((note) => note.title)).toEqual(["BoxPilot", "BoxPilot"]);
    expect(worker.shown[0].options.body).toBe("Something needs a look in BoxPilot.");
  });

  it("drops an older build's cache when it takes over, and leaves caches that are not its own", async () => {
    const worker = runWorker(() => html());
    worker.stores.set("boxpilot-1.0.0-00000000", new Map());
    worker.stores.set("someone-else", new Map());
    await worker.lifecycle("install");
    await worker.lifecycle("activate");
    expect([...worker.stores.keys()].filter((name) => name.startsWith("boxpilot-"))).toHaveLength(1);
    expect([...worker.stores.keys()]).toContain("someone-else");
  });
});
