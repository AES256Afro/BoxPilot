import express from "express";
import { describe, expect, it } from "vitest";
import { jsonGzip } from "./compress.mjs";

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
