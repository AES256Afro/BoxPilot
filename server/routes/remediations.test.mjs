import express from "express";
import { describe, expect, it, vi } from "vitest";
import { collectStorage } from "../storage-inventory.mjs";
import { createHostRouter } from "./host.mjs";

vi.mock("../storage-inventory.mjs", () => ({ collectStorage: vi.fn(async () => { throw new Error("storage timeout"); }) }));

// Repair's File sharing and USB history checks are operator reads; these tests are about sources failing, not roles.
const asOwner = (request, _response, next) => { request.boxpilotSession = { owner: { id: "owner-1", role: "owner" } }; next(); };

describe("remediation source availability", () => {
  it("keeps failed collectors visible rather than presenting an empty healthy scan", async () => {
    const app = express();
    app.use(asOwner);
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
  app.use(asOwner);
  app.use(createHostRouter({ state: { getSetting: (_key, fallback) => fallback }, helper: { request: async () => ({}) }, catalogService: { all: async () => { throw new Error("catalog unavailable"); } }, auth: { requireCsrf: (_req, _res, next) => next(), requireRole: () => (_req, _res, next) => next() }, notifications: { describe: () => ({ configured: true }) } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/remediations`)).json();
    expect(body.sourceStatus).toBe("partial");
    expect(body.unavailableChecks).toEqual(["Current mounts", "Saved mount configuration", "Application definitions"]);
  } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});

it("asks the helper what the drive-tools fix installs only when a finding offers that fix", async () => {
  const asked = [];
  const helper = { request: async (operation) => {
    asked.push(operation);
    return operation === "prerequisite.drive-tools.inspect" ? { installed: false, missing: ["exfatprogs"], broken: [], candidatePackages: { exfatprogs: "1.2.2-1" }, repairAvailable: true } : {};
  } };
  async function scan({ fstype, checker }) {
    asked.length = 0;
    const app = express();
    app.use(asOwner);
    app.use(createHostRouter({
      state: { getSetting: (_key, fallback) => fallback }, helper, catalogService: { all: async () => ({ manifests: [] }) },
      auth: { requireCsrf: (_req, _res, next) => next(), requireRole: () => (_req, _res, next) => next() }, notifications: { describe: () => ({ configured: true }) },
      collect: async () => ({ devices: [{ path: "/dev/sda2", transport: "usb" }], mounts: [{ target: "/mnt/the-dump", source: "/dev/sda2", fstype, readOnly: false }], fstab: [{ mountpoint: "/mnt/the-dump", managedName: "the-dump", options: "defaults,nofail" }], availability: { devices: true, mounts: true, fstab: true } }),
      fileExists: async () => checker,
    }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      return await (await fetch(`http://127.0.0.1:${server.address().port}/remediations`)).json();
    } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  }
  // fsck.exfat is here, or there is no exFAT drive: nothing offers the install, so nothing asks apt.
  await scan({ fstype: "exfat", checker: true });
  expect(asked).not.toContain("prerequisite.drive-tools.inspect");
  await scan({ fstype: "ext4", checker: false });
  expect(asked).not.toContain("prerequisite.drive-tools.inspect");
  // An exFAT drive and no checker: the fix names the exact versions on offer.
  const body = await scan({ fstype: "exfat", checker: false });
  expect(asked.filter((operation) => operation === "prerequisite.drive-tools.inspect")).toHaveLength(1);
  expect(body.findings.find((finding) => finding.id === "exfat-checker-missing")?.fix).toMatchObject({ operationId: "prerequisite.drive-tools.install", parameters: { expectedPackages: { exfatprogs: "1.2.2-1" } } });
});
