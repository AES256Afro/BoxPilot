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
      expect(body.unavailableChecks).toEqual(["Drives and mounts", "Applications", "File sharing", "USB history", "Unclean unmounts", "Drive filesystems", "App backups"]);
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

describe("Repair's memory: fixes tried and findings set aside (M35)", () => {
  /** A settings store and job list in memory, the few calls the route makes of the real one. */
  function fakeState(jobs = []) {
    const settings = new Map();
    const audit = [];
    return {
      audit,
      getSetting: (key, fallback) => (settings.has(key) ? structuredClone(settings.get(key)) : fallback),
      updateSetting: (key, fallback, transform) => { const { value } = transform(settings.has(key) ? structuredClone(settings.get(key)) : fallback); settings.set(key, value); },
      getJob: (id) => jobs.find((job) => job.id === id) ?? null,
      listJobs: (_limit, { createdBy = null } = {}) => jobs.filter((job) => !createdBy || job.createdBy === createdBy),
      listSchedules: () => [],
      recordAudit: (event, details) => audit.push({ event, ...details }),
    };
  }
  const as = (role, id = `${role}-1`) => (request, _response, next) => { request.boxpilotSession = { owner: { id, role } }; next(); };
  const helper = { request: async (operation) => {
    if (operation === "app.inspect") return { applications: [{ id: "homepage", installed: true, container: { exists: false, running: false, status: "absent" }, state: { installedAt: "2026-08-01T00:00:00.000Z", values: {} }, missingContainer: { record: "/var/lib/boxpilot-managed/catalog/homepage/boxpilot.json", project: "/var/lib/boxpilot-managed/catalog/homepage/compose.yaml", projectPresent: true, container: "bp-homepage" }, folderProblems: [] }] };
    if (operation === "app.backup.protection") return { available: true, apps: [] };
    return { available: true, ports: [], events: [], drives: [] };
  } };
  async function serve(state, role = "owner", id) {
    const app = express();
    app.use(express.json());
    app.use(as(role, id));
    app.use(createHostRouter({
      state, helper, catalogService: { all: async () => ({ manifests: [{ id: "homepage", name: "Homepage", volumes: [] }] }) },
      auth: { requireCsrf: (_req, _res, next) => next(), requireRole: () => (_req, _res, next) => next() }, notifications: { describe: () => ({ configured: true }) },
      collect: async () => ({ devices: [], mounts: [], fstab: [], availability: { devices: true, mounts: true, fstab: true } }),
    }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
      const response = await fetch(`${base}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    return { call, close: async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } };
  }

  it("gives each fix its registry tier, and shows a failed try on the finding it was started from", async () => {
    const refused = { id: "job-7", type: "op:app.reinstall", title: "Rebuild an application's container", state: "failed", error: "compose up failed", parameters: { id: "homepage" }, createdBy: "owner-1", createdAt: "2026-09-29T10:00:00.000Z" };
    const state = fakeState([refused]);
    const { call, close } = await serve(state);
    try {
      expect((await call("POST", "/remediations/attempts", { findingId: "app-missing:homepage", jobId: "job-7" })).status).toBe(201);
      const { body } = await call("GET", "/remediations");
      const found = body.findings.find((finding) => finding.id === "app-missing:homepage");
      expect(found.fixes.map((fix) => [fix.operationId, fix.risk])).toEqual([["app.reinstall", "medium"], ["app.uninstall", "medium"]]);
      expect(found.fix.risk).toBe("medium");
      expect(found.lastAttempt).toMatchObject({ jobId: "job-7", state: "failed", error: "compose up failed" });
      expect(found.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(body.jobs.attached).toEqual(["job-7"]);
    } finally { await close(); }
  });

  it("sets a finding aside with its reason until it changes, and brings it back on request", async () => {
    const state = fakeState();
    const { call, close } = await serve(state);
    try {
      const { body: before } = await call("GET", "/remediations");
      const found = before.findings.find((finding) => finding.id === "app-missing:homepage");
      expect((await call("POST", "/remediations/dismissals", { id: found.id, fingerprint: found.fingerprint, severity: found.severity, reason: "Moving it to another server" })).status).toBe(201);
      const { body: after } = await call("GET", "/remediations");
      expect(after.findings.some((finding) => finding.id === found.id)).toBe(false);
      expect(after.dismissed).toMatchObject([{ id: found.id, dismissal: { reason: "Moving it to another server", by: "owner-1" } }]);
      expect(after.counts.warning).toBe(before.counts.warning - 1);
      expect(state.audit.map((entry) => entry.event)).toContain("repair.dismissed");
      expect((await call("DELETE", `/remediations/dismissals/${encodeURIComponent(found.id)}`)).status).toBe(200);
      expect((await call("GET", "/remediations")).body.findings.some((finding) => finding.id === found.id)).toBe(true);
      expect((await call("DELETE", "/remediations/dismissals/nothing-here")).status).toBe(404);
    } finally { await close(); }
  });

  it("refuses a dismissal without a reason or of a critical finding, and a failed job nobody may see", async () => {
    const theirs = { id: "job-9", type: "op:app.update", title: "Update", state: "failed", error: "x", createdBy: "owner-1" };
    const state = fakeState([theirs]);
    const { call, close } = await serve(state, "operator", "operator-1");
    try {
      expect((await call("POST", "/remediations/dismissals", { id: "stale-mount:media", fingerprint: "0123456789abcdef", severity: "critical", reason: "later" })).status).toBe(400);
      expect((await call("POST", "/remediations/dismissals", { id: "split-data-folders", fingerprint: "0123456789abcdef", severity: "info", reason: "" })).status).toBe(400);
      // The owner's job is not the operator's to set aside, or to record as a fix attempt.
      expect((await call("POST", "/remediations/dismissals", { jobId: "job-9", reason: "done" })).status).toBe(404);
      expect((await call("POST", "/remediations/attempts", { findingId: "x", jobId: "job-9" })).status).toBe(404);
    } finally { await close(); }
  });
});
