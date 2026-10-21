import { describe, expect, it } from "vitest";
import worker from "./worker.js";

/*
 * The hosted demo (antifascist.work and getnerp.com, the same Worker on both): open to anyone with
 * the link since 2026-10-12, when the password that had gated it since v1.155.0 came off at the
 * owner's word. Search engines and AI crawlers are still asked to keep out, by robots.txt and on
 * every answer; nothing here belongs to anybody.
 */

const files = {
  "/index.html": "<!doctype html><html><body><div id=\"root\"></div></body></html>",
  "/demo-data.json": JSON.stringify({ scenarios: { default: { rest: { "/health": { status: "ok" } }, operations: { "server.facts": { hostname: "homebox" } }, switcher: "<div id=\"demo-worlds\"></div>" }, broken: { rest: { "/health": { status: "degraded" } }, operations: {}, switcher: "<div id=\"demo-worlds\" data-world=\"broken\"></div>" } } }),
  "/mockups/index.html": "<!doctype html><title>Looks</title>",
  "/assets/index-abc.js": "console.log('app')",
};
const ASSETS = {
  fetch: async (request) => {
    const { pathname } = new URL(typeof request === "string" ? request : request.url);
    return pathname in files ? new Response(files[pathname], { status: 200 }) : new Response("missing", { status: 404 });
  },
};
const env = { ASSETS };
const at = (path, init) => new Request(`https://antifascist.work${path}`, init);
const atOther = (path, init) => new Request(`https://getnerp.com${path}`, init);

describe("the hosted demo", () => {
  it("serves the page, its scripts, the frozen API and the mockups to anyone, with no password", async () => {
    const page = await worker.fetch(at("/?view=storage"), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="demo-worlds"></div></body>');
    expect(page.headers.get("cache-control")).toBe("no-store");
    const script = await worker.fetch(at("/assets/index-abc.js"), env);
    expect(script.status).toBe(200);
    expect(await script.text()).toBe("console.log('app')");
    const api = await worker.fetch(at("/api/v1/health"), env);
    expect(await api.json()).toEqual({ status: "ok" });
    const mockups = await worker.fetch(at("/mockups/"), env);
    expect(await mockups.text()).toContain("<title>Looks</title>");
    const bare = await worker.fetch(at("/mockups"), env);
    expect(bare.status).toBe(308);
    expect(bare.headers.get("location")).toBe("https://antifascist.work/mockups/");
    // The password's unlock form, bookmarked or still open in a tab, lands on the demo.
    const unlock = await worker.fetch(at("/__unlock", { method: "POST", body: new URLSearchParams({ password: "whatever", next: "/" }) }), env);
    expect(unlock.status).toBe(303);
    expect(unlock.headers.get("location")).toBe("https://antifascist.work/");
  });

  it("asks every crawler to keep out, on robots.txt and on every answer", async () => {
    const robots = await worker.fetch(at("/robots.txt"), env);
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
    for (const path of ["/", "/robots.txt", "/api/v1/health", "/mockups/", "/assets/index-abc.js"]) {
      const response = await worker.fetch(at(path), env);
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex, nofollow, noarchive, nosnippet, noai, noimageai");
    }
  });

  it("answers each world from the page asking, and stages jobs that never run", async () => {
    const broken = await worker.fetch(at("/api/v1/health", { headers: { referer: "https://antifascist.work/?scenario=broken" } }), env);
    expect(await broken.json()).toEqual({ status: "degraded" });
    const unknown = await worker.fetch(at("/api/v1/health", { headers: { referer: "https://antifascist.work/?scenario=nope" } }), env);
    expect(await unknown.json()).toEqual({ status: "ok" });
    const shell = await worker.fetch(at("/?scenario=broken"), env);
    expect(await shell.text()).toContain('data-world="broken"');
    const inspect = await worker.fetch(at("/api/v1/operations/server.facts/inspect"), env);
    expect(await inspect.json()).toEqual({ operation: "server.facts", result: { hostname: "homebox" } });
    const staged = await worker.fetch(at("/api/v1/operations/app.backup/jobs", { method: "POST" }), env);
    expect(staged.status).toBe(201);
    expect((await staged.json()).approval.reason).toBe("demo: jobs never run here");
  });

  it("serves the same demo on either domain, sending nobody to the other one", async () => {
    const page = await worker.fetch(atOther("/?scenario=broken"), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-world="broken"');
    const api = await worker.fetch(atOther("/api/v1/health"), env);
    expect(await api.json()).toEqual({ status: "ok" });
    const mockups = await worker.fetch(atOther("/mockups/"), env);
    expect(await mockups.text()).toContain("<title>Looks</title>");
    // Both redirects are resolved against the request, so a visitor is never moved to the domain
    // the Worker happens to have been written for.
    const bare = await worker.fetch(atOther("/mockups"), env);
    expect(bare.headers.get("location")).toBe("https://getnerp.com/mockups/");
    const unlock = await worker.fetch(atOther("/__unlock", { method: "POST", body: new URLSearchParams({ password: "whatever", next: "/" }) }), env);
    expect(unlock.headers.get("location")).toBe("https://getnerp.com/");
  });

  it("mirrors the demo's 404 for what is not part of it, prototype names included", async () => {
    for (const path of ["/api/v1/operations/__proto__/inspect", "/api/v1/operations/constructor/inspect", "/api/v1/nothing"]) {
      const response = await worker.fetch(at(path), env);
      expect(response.status, path).toBe(404);
    }
    // A path with no asset behind it is a view of the single-page app, as the demo serves it.
    const missing = await worker.fetch(at("/assets/gone.js"), env);
    expect(missing.status).toBe(200);
    expect(await missing.text()).toContain("demo-worlds");
  });
});
