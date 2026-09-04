/**
 * BoxPilot's demo, served without a server.
 *
 * The demo is normally an Express app that reads the catalog off disk and answers three different
 * worlds depending on the page asking. Every one of those answers is fixed, so `demo-bundle.mjs`
 * asks the real demo for all of them and writes them down; this serves what it wrote.
 *
 * It mirrors the demo's behaviour rather than improving on it, including the 404 for anything not
 * part of it, because the interface is built to tolerate exactly that and a friendlier answer here
 * would make the hosted copy behave differently from the one used for review.
 *
 * There is no data here belonging to anybody. Every value is invented.
 */
const API = "/api/v1";
let cached = null;

async function bundle(env) {
  if (cached) return cached;
  const response = await env.ASSETS.fetch(new Request("https://demo.invalid/demo-data.json"));
  cached = await response.json();
  return cached;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/** Which world the page asking belongs to, taken from its own URL exactly as the demo does. */
function scenarioOf(request, worlds) {
  const referer = request.headers.get("referer");
  try {
    const name = new URL(referer ?? "").searchParams.get("scenario");
    return worlds.includes(name) ? name : "default";
  } catch { return "default"; }
}

async function api(request, env, url) {
  const data = await bundle(env);
  const worlds = Object.keys(data.scenarios);
  const world = data.scenarios[scenarioOf(request, worlds)];
  const route = url.pathname.slice(API.length) || "/";

  const operation = route.match(/^\/operations\/([a-z][\w.-]+)\/(inspect|run)$/);
  if (operation) {
    // Own properties only: "__proto__" and "constructor" are not demo operations, however they
    // match the pattern, and looking them up on a plain object would answer 200 with junk.
    const result = Object.hasOwn(world.operations, operation[1]) ? world.operations[operation[1]] : undefined;
    if (result === undefined) return json({ error: "Not in the demo", code: "demo_missing" }, 404);
    return json({ operation: operation[1], result });
  }

  // Staging a job is answered the way the demo answers it: nothing here ever runs.
  const staged = route.match(/^\/operations\/([a-z][\w.-]+)\/jobs$/);
  if (staged && request.method === "POST") {
    return json({
      job: { id: "demo-job", type: `op:${staged[1]}`, title: staged[1], state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [], createdAt: new Date().toISOString() },
      approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "demo: jobs never run here" },
    }, 201);
  }
  if (route === "/auth/logout" && request.method === "POST") return json({ ok: true });
  if (route === "/catalog" || route.startsWith("/catalog/")) {
    if (route.endsWith("/precheck") && request.method === "POST") return json({ ok: true, errors: [], conflicts: [] });
  }

  const body = Object.hasOwn(world.rest, route) ? world.rest[route] : undefined;
  if (body !== undefined) return json(body);
  return json({ error: "Not part of the demo", code: "demo_missing" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === API || url.pathname.startsWith(`${API}/`)) return api(request, env, url);

    // Anything with a file extension is a real asset; everything else is a view of the single-page
    // app, including "/" itself, and has to come back as the shell with the world bar in it.
    const looksLikeAFile = /\.[a-z0-9]+$/i.test(url.pathname);
    if (looksLikeAFile) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }

    const data = await bundle(env);
    const worlds = Object.keys(data.scenarios);
    const name = worlds.includes(url.searchParams.get("scenario")) ? url.searchParams.get("scenario") : "default";
    const shell = await env.ASSETS.fetch(new Request(new URL("/index.html", url).toString()));
    const html = (await shell.text()).replace("</body>", `${data.scenarios[name].switcher}</body>`);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  },
};
