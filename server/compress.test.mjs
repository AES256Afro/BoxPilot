import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import express from "express";
import { describe, expect, it } from "vitest";
import { jsonGzip, precompressedAssets } from "./compress.mjs";

/** A server with the middleware in front, returning whatever the route hands it. */
async function serve(routes, options) {
  const app = express();
  app.use(jsonGzip(options));
  for (const [path, body] of Object.entries(routes)) app.get(path, (_request, response) => response.json(body));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const big = { items: Array.from({ length: 4000 }, (_value, index) => ({ index, name: `entry-${index}` })) };

describe("gzipping JSON responses", () => {
  it("compresses a large body and it still parses", async () => {
    const { base, close } = await serve({ "/big": big });
    try {
      const response = await fetch(`${base}/big`, { headers: { "accept-encoding": "gzip" } });
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(response.headers.get("vary")).toBe("Accept-Encoding");
      expect((await response.json()).items).toHaveLength(4000);
    } finally { close(); }
  });

  it("leaves a small body alone, because packing it costs more than it saves", async () => {
    const { base, close } = await serve({ "/small": { ok: true } });
    try {
      const response = await fetch(`${base}/small`, { headers: { "accept-encoding": "gzip" } });
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.json()).toEqual({ ok: true });
    } finally { close(); }
  });

  it("leaves everything alone for a client that did not ask for gzip", async () => {
    const { base, close } = await serve({ "/big": big });
    try {
      const response = await fetch(`${base}/big`, { headers: { "accept-encoding": "identity" } });
      expect(response.headers.get("content-encoding")).toBeNull();
      expect((await response.json()).items).toHaveLength(4000);
    } finally { close(); }
  });

  it("still answers when compression itself fails", async () => {
    // A response that never arrives is worse than one that arrives uncompressed.
    const { base, close } = await serve({ "/big": big }, { compress: async () => { throw new Error("no"); } });
    try {
      const response = await fetch(`${base}/big`, { headers: { "accept-encoding": "gzip" } });
      expect(response.headers.get("content-encoding")).toBeNull();
      expect((await response.json()).items).toHaveLength(4000);
    } finally { close(); }
  });

  it("reports the compressed length, not the original", async () => {
    const { base, close } = await serve({ "/big": big });
    try {
      const response = await fetch(`${base}/big`, { headers: { "accept-encoding": "gzip" } });
      const declared = Number(response.headers.get("content-length"));
      expect(declared).toBeGreaterThan(0);
      expect(declared).toBeLessThan(Buffer.byteLength(JSON.stringify(big)) / 2);
    } finally { close(); }
  });
});

/** A built assets directory, with the .gz twins the build step would have written. */
function builtAssets() {
  const root = mkdtempSync(nodePath.join(tmpdir(), "boxpilot-assets-"));
  const dir = nodePath.join(root, "assets");
  mkdirSync(dir);
  const script = `console.log(${JSON.stringify("x".repeat(4000))});`;
  writeFileSync(nodePath.join(dir, "index-abc123.js"), script);
  writeFileSync(nodePath.join(dir, "index-abc123.js.gz"), gzipSync(script));
  writeFileSync(nodePath.join(dir, "logo-def456.svg"), "<svg/>"); // no .gz twin: too small to bother
  writeFileSync(nodePath.join(root, "secret.js.gz"), gzipSync("outside the assets directory"));
  return { root, dir, script };
}

async function serveAssets() {
  const { root, dir, script } = builtAssets();
  const app = express();
  app.use("/assets", precompressedAssets(dir));
  app.use("/assets", express.static(dir, { index: false, maxAge: "365d", immutable: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, script, close: () => { server.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("serving the build's precompressed assets", () => {
  it("sends the gzipped twin, correctly typed, and it decodes to the original", async () => {
    const { base, script, close } = await serveAssets();
    try {
      const response = await fetch(`${base}/assets/index-abc123.js`, { headers: { "accept-encoding": "gzip" } });
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(Number(response.headers.get("content-length"))).toBeLessThan(script.length / 2);
      expect(await response.text()).toBe(script);
    } finally { close(); }
  });

  it("sends the original to a client that cannot take gzip", async () => {
    const { base, script, close } = await serveAssets();
    try {
      const response = await fetch(`${base}/assets/index-abc123.js`, { headers: { "accept-encoding": "identity" } });
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toBe(script);
    } finally { close(); }
  });

  it("always says the response varies by encoding, so a cache cannot mix the two up", async () => {
    const { base, close } = await serveAssets();
    try {
      for (const encoding of ["gzip", "identity"]) {
        const response = await fetch(`${base}/assets/index-abc123.js`, { headers: { "accept-encoding": encoding } });
        expect(response.headers.get("vary")).toBe("Accept-Encoding");
      }
    } finally { close(); }
  });

  it("falls through for a file the build did not compress", async () => {
    const { base, close } = await serveAssets();
    try {
      const response = await fetch(`${base}/assets/logo-def456.svg`, { headers: { "accept-encoding": "gzip" } });
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toBe("<svg/>");
    } finally { close(); }
  });

  it("will not walk out of the assets directory to find a .gz", async () => {
    const { base, close } = await serveAssets();
    try {
      for (const attempt of ["/assets/../secret.js", "/assets/%2e%2e/secret.js", "/assets/..%2fsecret.js"]) {
        const response = await fetch(`${base}${attempt}`, { headers: { "accept-encoding": "gzip" }, redirect: "manual" });
        expect(await response.text()).not.toContain("outside the assets directory");
      }
    } finally { close(); }
  });

  it("keeps the immutable caching the static handler was configured with", async () => {
    const { base, close } = await serveAssets();
    try {
      const response = await fetch(`${base}/assets/index-abc123.js`, { headers: { "accept-encoding": "gzip" } });
      expect(response.headers.get("cache-control")).toContain("immutable");
    } finally { close(); }
  });
});
