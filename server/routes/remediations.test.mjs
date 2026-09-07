import express from "express";
import { describe, expect, it, vi } from "vitest";
import { collectStorage } from "../storage-inventory.mjs";
import { createHostRouter } from "./host.mjs";

vi.mock("../storage-inventory.mjs", () => ({ collectStorage: vi.fn(async () => { throw new Error("storage timeout"); }) }));

describe("remediation source availability", () => {
  it("keeps failed collectors visible rather than presenting an empty healthy scan", async () => {
    const app = express();
    app.use(createHostRouter({
      state: { getSetting: (_key, fallback) => fallback },
      helper: { request: async () => { throw new Error("helper unavailable"); } },
      catalogService: { all: async () => ({ manifests: [] }) },
      auth: { requireCsrf: (_request, _response, next) => next(), requireRole: () => (_request, _response, next) => next() },
      notifications: { describe: () => ({ configured: true }) },
    }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/remediations`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.sourceStatus).toBe("partial");
      expect(body.unavailableChecks).toEqual(["Drives and mounts", "Applications", "File sharing", "USB history"]);
      expect(Array.isArray(body.findings)).toBe(true);
    } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  });
});

it("names unavailable mount and catalog sources even when other checks succeed", async () => {
  vi.mocked(collectStorage).mockResolvedValueOnce({ devices: [], mounts: [], fstab: [], availability: { mounts: false, fstab: false } });
  const app = express();
  app.use(createHostRouter({ state: { getSetting: (_key, fallback) => fallback }, helper: { request: async () => ({}) }, catalogService: { all: async () => { throw new Error("catalog unavailable"); } }, auth: { requireCsrf: (_req, _res, next) => next(), requireRole: () => (_req, _res, next) => next() }, notifications: { describe: () => ({ configured: true }) } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/remediations`)).json();
    expect(body.sourceStatus).toBe("partial");
    expect(body.unavailableChecks).toEqual(["Current mounts", "Saved mount configuration", "Application definitions"]);
  } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});
