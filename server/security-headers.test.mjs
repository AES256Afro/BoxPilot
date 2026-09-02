import { createHash } from "node:crypto";
import express from "express";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, inlineSources, securityHeaders } from "./security-headers.mjs";

const sha = (text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

describe("finding what the shell inlines", () => {
  it("picks out inline scripts and styles and leaves external ones alone", () => {
    const html = `<script>\n  theme();\n</script><script type="module" src="/assets/a.js"></script><style>body{margin:0}</style>`;
    expect(inlineSources(html)).toEqual({ scripts: ["\n  theme();\n"], styles: ["body{margin:0}"] });
  });

  it("keeps the body byte for byte, because the browser hashes exactly that", () => {
    const body = "\n      (function () { const t = 1; })();\n    ";
    expect(inlineSources(`<script>${body}</script>`).scripts[0]).toBe(body);
  });

  it("finds nothing in a shell with nothing inline", () => {
    expect(inlineSources(`<script type="module" src="/x.js"></script>`)).toEqual({ scripts: [], styles: [] });
  });
});

describe("the policy", () => {
  it("allows only this origin plus the listed inline pieces", () => {
    const policy = contentSecurityPolicy({ scripts: ["a()"], styles: ["b{}"] });
    expect(policy).toContain(`script-src 'self' ${sha("a()")}`);
    expect(policy).toContain(`style-src 'self' ${sha("b{}")}`);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("does not allow inline anything when there is nothing to allow", () => {
    expect(contentSecurityPolicy()).toContain("script-src 'self'; style-src 'self';");
  });
});

describe("the middleware", () => {
  it("sets every header, with hashes drawn from the served shell", async () => {
    const shell = `<!doctype html><html><head><script>\n  boot();\n</script></head><body></body></html>`;
    const app = express();
    app.use(securityHeaders({ html: shell }));
    app.get("/", (_request, response) => response.type("html").send(shell));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
      expect(response.headers.get("content-security-policy")).toContain(`script-src 'self' ${sha("\n  boot();\n")}`);
    } finally { server.closeAllConnections?.(); server.close(); }
  });
});
