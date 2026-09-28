// @vitest-environment node
/**
 * The runbook routes (M34.4): an operator may generate it, only the owner may download the full
 * copy, and a failure is an honest 503 rather than a half-written document. The same gating is
 * driven through the real session and role policy in route-matrix.test.mjs.
 */
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRunbookRouter } from "./runbook.mjs";

let server;
let base;
let failing = false;
const runbook = {
  status: vi.fn(async ({ role }) => { if (failing) throw new Error("helper down"); return { audience: role === "owner" ? "owner" : "operator", canDownload: role === "owner" }; }),
  preview: vi.fn(async ({ role }) => { if (failing) throw new Error("helper down"); return { audience: role === "owner" ? "owner" : "operator", markdown: "# Runbook: homeserver\n" }; }),
  download: vi.fn(async () => { if (failing) throw new Error("helper down"); return { markdown: "# Runbook: homeserver\n", filename: "boxpilot-runbook-homeserver-2026-09-28.md", fingerprint: "0123456789abcdef" }; }),
};
// Role-aware stub: the request's role and account come from test headers.
const auth = { requireRole: (...roles) => (request, response, next) => (roles.includes(request.boxpilotSession.owner.role) ? next() : response.status(403).json({ error: "forbidden", code: "forbidden" })) };

beforeAll(async () => {
  const app = express();
  app.use((request, _response, next) => { request.boxpilotSession = { owner: { id: `${request.headers["x-test-role"]}-1`, role: request.headers["x-test-role"] } }; next(); });
  app.use("/api/v1", createRunbookRouter({ runbook, auth }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const get = (url, role) => fetch(`${base}${url}`, { headers: { "x-test-role": role } });

describe("the runbook routes", () => {
  it("let an operator or the owner generate it, and only the owner download it", async () => {
    const expected = {
      "/api/v1/runbook": { viewer: 403, operator: 200, owner: 200 },
      "/api/v1/runbook/status": { viewer: 403, operator: 200, owner: 200 },
      "/api/v1/runbook/download": { viewer: 403, operator: 403, owner: 200 },
    };
    for (const [url, statuses] of Object.entries(expected)) {
      for (const [role, status] of Object.entries(statuses)) expect((await get(url, role)).status, `${role} ${url}`).toBe(status);
    }
  });

  it("hands the service who is asking, so an operator gets an operator's copy", async () => {
    runbook.preview.mockClear();
    const body = await (await get("/api/v1/runbook", "operator")).json();
    expect(runbook.preview).toHaveBeenCalledWith({ role: "operator", callerId: "operator-1" });
    expect(body.audience).toBe("operator");
    runbook.download.mockClear();
    await get("/api/v1/runbook/download", "owner");
    expect(runbook.download).toHaveBeenCalledWith({ callerId: "owner-1" });
  });

  it("downloads as a Markdown file", async () => {
    const response = await get("/api/v1/runbook/download", "owner");
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="boxpilot-runbook-homeserver-2026-09-28.md"');
    expect(response.headers.get("x-boxpilot-runbook-fingerprint")).toBe("0123456789abcdef");
    expect(await response.text()).toBe("# Runbook: homeserver\n");
  });

  it("answers 503 when the document cannot be put together, without passing on why", async () => {
    failing = true;
    try {
      for (const url of ["/api/v1/runbook", "/api/v1/runbook/status", "/api/v1/runbook/download"]) {
        const response = await get(url, "owner");
        expect(response.status, url).toBe(503);
        const body = await response.json();
        expect(body.code).toBe("runbook_unavailable");
        expect(JSON.stringify(body)).not.toContain("helper down");
      }
    } finally {
      failing = false;
    }
  });
});
