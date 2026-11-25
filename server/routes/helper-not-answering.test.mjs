import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createHelperClient } from "../helper-client.mjs";
import { helperError } from "../helper-errors.mjs";
import { createHostRouter } from "./host.mjs";
import { createOperationsRouter } from "./operations.mjs";

/*
 * M89: when BoxPilot's admin service (the root helper) does not answer, the routes say so in plain
 * words and with a code the page can act on. They used to pass the socket's own text through:
 * "Helper unavailable: connect ENOENT /run/boxpilot/helper.sock".
 */

/** Anything an owner should never read in an error: a socket, a Node error code, the client's own sentences. */
const developerWords = /ENOENT|ECONN|EPIPE|\.sock|Helper |overall deadline|\/run\//;

const opened = [];
afterEach(async () => {
  for (const server of opened.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function serve(mount) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.boxpilotSession = { owner: { id: "owner-1", role: "owner" } }; next(); });
  mount(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  opened.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, url, body) => {
    const response = await fetch(`${base}${url}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
}

const pass = (_request, _response, next) => next();
const auth = { requireCsrf: pass, requireRole: () => pass };
const operations = (helper) => serve((app) => app.use("/api/v1", createOperationsRouter({ state: { recordAudit() {} }, helper, jobs: {}, prerequisites: {}, recoveryKit: {}, actionCenter: {}, auth })));
const failing = (error) => ({ request: async () => { throw error; } });

describe("an operation read when the admin service does not answer", () => {
  it("says it is not answering when there is no socket, without the socket's words", async () => {
    const missing = process.platform === "win32" ? "\\\\?\\pipe\\boxpilot-m89-route" : path.join(tmpdir(), "boxpilot-m89-route.sock");
    const api = await operations(createHelperClient({ socketPath: missing }));
    const read = await api("GET", "/api/v1/operations/service.list/inspect");
    expect(read).toEqual({ status: 503, body: { code: "helper_unavailable", error: "BoxPilot's admin service is not answering, so this could not be read. Repair says how to start it again." } });
    const run = await api("POST", "/api/v1/operations/logs.read/run", { parameters: { kind: "unit", target: "nginx.service" } });
    expect(run.body.code).toBe("helper_unavailable");
    expect(run.body.error).not.toMatch(developerWords);
  });

  it("says it did not answer in time, or stopped partway, by code", async () => {
    const late = await (await operations(failing(helperError("helper_timeout", "Helper request timed out (overall deadline reached)"))))("GET", "/api/v1/operations/service.list/inspect");
    expect(late).toEqual({ status: 503, body: { code: "helper_timeout", error: "BoxPilot's admin service did not answer in time, so this could not be read. Try again in a moment; if it keeps happening, Repair says how to restart it." } });
    const dropped = await (await operations(failing(helperError("helper_closed", "Helper connection closed before sending a result"))))("POST", "/api/v1/operations/logs.read/run", { parameters: { kind: "unit", target: "nginx.service" } });
    expect(dropped).toEqual({ status: 503, body: { code: "helper_closed", error: "BoxPilot's admin service stopped answering partway, so this could not be read. Try again in a moment; if it keeps happening, Repair says how to restart it." } });
  });

  it("keeps an operation's own failure as it was", async () => {
    const api = await operations(failing(Object.assign(new Error("No unit called nginx.service"), { code: "operation_failed" })));
    expect(await api("POST", "/api/v1/operations/logs.read/run", { parameters: { kind: "unit", target: "nginx.service" } })).toEqual({ status: 503, body: { error: "No unit called nginx.service", code: "operation_failed" } });
  });
});

describe("other reads that go through the admin service", () => {
  it("answer the same way (the BoxPilot backups' retention)", async () => {
    const stub = { inspect: async () => ({}), list: async () => [] };
    const controllerRetention = { inspect: async () => { throw helperError("helper_timeout", "Helper request timed out (overall deadline reached)"); } };
    const api = await serve((app) => app.use("/api/v1", createHostRouter({ state: { getSetting: () => null }, helper: failing(new Error("unused")), catalogService: { all: async () => ({ manifests: [], problems: [] }) }, inventory: stub, network: stub, controllerProtection: stub, controllerRetention, githubProvenance: stub, releaseUpdates: stub, setup: stub, supportBundle: stub, audit: stub, auth })));
    expect(await api("GET", "/api/v1/controller-backup-retention")).toEqual({ status: 503, body: { code: "helper_timeout", error: "BoxPilot's admin service did not answer in time, so this could not be read. Try again in a moment; if it keeps happening, Repair says how to restart it." } });
  });
});
