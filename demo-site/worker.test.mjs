// @vitest-environment node
import { describe, expect, it } from "vitest";
import { gate, safeNext } from "./gate.js";
import worker from "./worker.js";

/*
 * The hosted demo's password (antifascist.work): nothing of the demo leaves the Worker until the
 * password is given, the password itself never appears in what is sent, and the cookie that
 * remembers it is the only way past.
 */

const PASSWORD = "correct horse battery staple";
const files = {
  "/index.html": "<!doctype html><html><body><div id=\"root\"></div></body></html>",
  "/demo-data.json": JSON.stringify({ scenarios: { default: { rest: { "/health": { status: "ok" } }, operations: {}, switcher: "<div id=\"demo-worlds\"></div>" } } }),
  "/mockups/index.html": "<!doctype html><title>Looks</title>",
  "/assets/index-abc.js": "console.log('app')",
};
const ASSETS = {
  fetch: async (request) => {
    const { pathname } = new URL(typeof request === "string" ? request : request.url);
    return pathname in files ? new Response(files[pathname], { status: 200 }) : new Response("missing", { status: 404 });
  },
};
const env = { ASSETS, DEMO_PASSWORD: PASSWORD };
const at = (path, init) => new Request(`https://antifascist.work${path}`, init);
const unlock = (password, next = "/") => at("/__unlock", { method: "POST", body: new URLSearchParams({ password, next }) });

async function signedIn() {
  const response = await gate(unlock(PASSWORD), env, { wait: async () => {} });
  return response.headers.get("set-cookie").split(";")[0];
}

describe("the hosted demo's password", () => {
  it("shows only the form, and never the password, until it is given", async () => {
    for (const path of ["/", "/?view=storage", "/mockups/", "/demo-data.json", "/assets/index-abc.js"]) {
      const response = await worker.fetch(at(path), env);
      expect(response.status, path).toBe(401);
      const html = await response.text();
      expect(html, path).toContain('action="/__unlock"');
      expect(html, path).not.toContain(PASSWORD);
      expect(html, path).not.toContain("demo-worlds");
      expect(response.headers.get("x-robots-tag"), path).toContain("noai");
    }
    const api = await worker.fetch(at("/api/v1/health"), env);
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: "The demo needs its password", code: "demo_locked" });
  });

  it("stays closed, rather than open, when no password is set", async () => {
    const response = await worker.fetch(at("/"), { ASSETS });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("wrangler secret put DEMO_PASSWORD");
  });

  it("tells every crawler to keep out, without the password", async () => {
    const response = await worker.fetch(at("/robots.txt"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("refuses a wrong password slowly, and lets the right one in to where it was going", async () => {
    let waited = 0;
    const wrong = await gate(unlock("PassPass", "/?view=backups"), env, { wait: async () => { waited += 1; } });
    expect(wrong.status).toBe(401);
    expect(waited).toBe(1);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const form = await wrong.text();
    expect(form).toContain("That is not the password.");
    expect(form).toContain('value="/?view=backups"');

    const right = await gate(unlock(PASSWORD, "/?view=backups"), env, { wait: async () => {} });
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/?view=backups");
    const cookie = right.headers.get("set-cookie");
    expect(cookie).toMatch(/^boxpilot_demo=[0-9a-f]{64}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
    expect(cookie).not.toContain(PASSWORD);
  });

  it("serves the demo, its API and the mockups to whoever has the cookie", async () => {
    const cookie = await signedIn();
    const page = await worker.fetch(at("/?view=storage", { headers: { cookie } }), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="demo-worlds"></div></body>');
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    const api = await worker.fetch(at("/api/v1/health", { headers: { cookie } }), env);
    expect(await api.json()).toEqual({ status: "ok" });
    const mockups = await worker.fetch(at("/mockups/", { headers: { cookie } }), env);
    expect(await mockups.text()).toContain("<title>Looks</title>");
    const bare = await worker.fetch(at("/mockups", { headers: { cookie } }), env);
    expect(bare.status).toBe(308);
    expect(bare.headers.get("location")).toBe("https://antifascist.work/mockups/");
  });

  it("takes no forged or stale cookie", async () => {
    for (const cookie of ["boxpilot_demo=", `boxpilot_demo=${"0".repeat(64)}`, "boxpilot_demo=true"]) {
      expect((await worker.fetch(at("/", { headers: { cookie } }), env)).status, cookie).toBe(401);
    }
    const cookie = await signedIn();
    const changed = { ASSETS, DEMO_PASSWORD: "a new password" };
    expect((await worker.fetch(at("/", { headers: { cookie } }), changed)).status).toBe(401);
  });

  it("sends a person back only to a page of this site", () => {
    expect(safeNext("/?view=storage")).toBe("/?view=storage");
    expect(safeNext("//evil.example/")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("https://evil.example/")).toBe("/");
  });
});
