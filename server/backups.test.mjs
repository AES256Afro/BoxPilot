import { describe, expect, it, vi } from "vitest";
import { createBackupService } from "./backups.mjs";

function fixture({ applicationId = "uptime-kuma", installed = true, healthy = true, backups = [] } = {}) {
  const store = {
    listBackups: vi.fn(() => backups),
    createPlan: vi.fn((value) => ({ id: "plan-one", revision: "rev-one", status: "draft", ...value })),
    getPlan: vi.fn(() => ({ id: "plan-one", type: "application.backup", subjectId: applicationId, revision: "rev-one", status: "draft", output: { executable: true, blockers: [] }, createdBy: "owner-one" })),
    stagePlan: vi.fn(),
    createJob: vi.fn((value) => ({ id: "job-one", state: "awaiting_approval", ...value })),
    recordBackup: vi.fn((value) => value),
  };
  const helper = {
    request: vi.fn(async (operation) => ({
      installed,
      healthy,
      state: installed ? "running" : "not-installed",
      detail: `${operation} fixture`,
    })),
  };
  const prerequisites = { inspect: vi.fn(async () => ({ checks: [
    { id: "storage.state", status: "ready" }, { id: "helper.boundary", status: "ready" }, { id: "containers.docker", status: "ready" },
  ] })) };
  return { store, helper, prerequisites, service: createBackupService({ store, helper, prerequisites }) };
}

function resultFor(applicationId, backupId = "11111111-1111-4111-8111-111111111111") {
  if (applicationId === "boxpilot-controller") return {
    backupId,
    applicationId,
    destination: "local-managed",
    artifactPath: `/managed/backups/boxpilot-controller/${backupId}/boxpilot.sqlite3`,
    manifestPath: `/managed/backups/boxpilot-controller/${backupId}/manifest.json`,
    checksumSha256: "a".repeat(64),
    manifestChecksumSha256: "b".repeat(64),
    sizeBytes: 8192,
    downtimeMs: 0,
    consistentSnapshot: true,
    snapshotMethod: "sqlite-vacuum-into",
    sourceServiceStopped: false,
    restoreDrill: { passed: true, mode: "isolated-copy-open", network: "none", publishedPorts: 0, copyChecksumMatched: true, manifestChecksumSha256: "b".repeat(64), integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true, ownerStatePresent: true, workspaceRemoved: true, productionDatabaseReplaced: false, serviceStarted: false },
    boundary: { databaseContentReturned: false, browserPathAccepted: false, browserCommandAccepted: false, productionDatabaseChanged: false, serviceStopped: false, networkAccessRequired: false, independentCopyCreated: false, retentionPerformed: false },
  };
  const result = {
    backupId,
    applicationId,
    destination: "local-managed",
    artifactPath: `/managed/backups/${applicationId}/${backupId}.tar.gz`,
    checksumSha256: "a".repeat(64),
    sizeBytes: 12,
    downtimeMs: 20,
    sourceRestartVerified: true,
    restoreDrill: { passed: true, network: "none", publishedPorts: 0 },
  };
  if (applicationId === "pi-hole") {
    Object.assign(result, { routerMutationPerformed: false, dnsCutoverPerformed: false });
    Object.assign(result.restoreDrill, {
      configurationIncluded: true,
      administratorSecretIncluded: true,
      routerMutationPerformed: false,
      dnsCutoverPerformed: false,
    });
  }
  return result;
}

describe("application-aware backup service", () => {
  it("lists controller, Uptime Kuma, and Pi-hole coverage independently", async () => {
    const latest = resultFor("pi-hole");
    latest.createdAt = "2026-08-16T00:00:00.000Z";
    const { service, helper } = fixture({ backups: [latest] });
    const inventory = await service.list();
    expect(inventory.coverage).toEqual([
      expect.objectContaining({ applicationId: "boxpilot-controller", name: "BoxPilot controller", sourceKind: "controller-state", state: "unprotected", protected: false }),
      expect.objectContaining({ applicationId: "uptime-kuma", name: "Uptime Kuma", state: "unprotected", protected: false }),
      expect.objectContaining({ applicationId: "pi-hole", name: "Pi-hole", state: "verified", protected: true, latestBackup: latest }),
    ]);
    expect(helper.request).toHaveBeenCalledWith("application.uptime-kuma.inspect", {});
    expect(helper.request).toHaveBeenCalledWith("application.pi-hole.inspect", {});
    expect(inventory.limitations.join(" ")).toContain("3-2-1 protection");
  });

  it.each([
    ["uptime-kuma", "Uptime Kuma"],
    ["pi-hole", "Pi-hole"],
  ])("creates an executable %s plan only for an installed healthy source", async (applicationId, name) => {
    const { service } = fixture({ applicationId });
    const plan = await service.plan(applicationId, "owner-one");
    expect(plan).toMatchObject({ subjectId: applicationId, output: { executable: true, destination: "local-managed", blockers: [] } });
    expect(plan.output.changes.join(" ")).toContain("SHA-256");
    expect(plan.output.changes.join(" ")).toContain("Restart the source container");
    expect(plan.output.recovery).toContain(name);
  });

  it("creates a WAL-aware controller plan without Docker, downtime, or a browser path", async () => {
    const { service, prerequisites } = fixture({ applicationId: "boxpilot-controller" });
    const plan = await service.plan("boxpilot-controller", "owner-one");
    expect(plan).toMatchObject({ subjectId: "boxpilot-controller", output: { executable: true, destination: "local-managed", blockers: [] } });
    expect(plan.output.changes.join(" ")).toContain("VACUUM INTO");
    expect(plan.output.changes.join(" ")).toContain("live database and BoxPilot service unchanged");
    expect(plan.output.warnings.join(" ")).toContain("password hashes");
    expect(plan.output.warnings.join(" ")).toContain("independent storage");
    expect(prerequisites.inspect).toHaveBeenCalledOnce();
  });

  it("blocks backup when the application is absent", async () => {
    const { service } = fixture({ applicationId: "pi-hole", installed: false, healthy: false });
    const plan = await service.plan("pi-hole", "owner-one");
    expect(plan.output.executable).toBe(false);
    expect(plan.output.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "application.pi-hole" })]));
  });

  it.each([
    ["boxpilot-controller", "controller.database.backup", "medium"],
    ["uptime-kuma", "application.uptime-kuma.backup", "medium"],
    ["pi-hole", "application.pi-hole.backup", "network-critical"],
  ])("stages an exact %s revision with a server-generated backup id", async (applicationId, jobType, risk) => {
    const { service, store } = fixture({ applicationId });
    const job = await service.stage("plan-one", "rev-one", "owner-one");
    expect(job).toMatchObject({ type: jobType, risk, parameters: { applicationId } });
    expect(job.parameters.backupId).toMatch(/^[a-f0-9-]{36}$/);
    expect(store.stagePlan).toHaveBeenCalledWith("plan-one", "owner-one");
  });

  it.each([
    ["boxpilot-controller", "controller.database.backup"],
    ["uptime-kuma", "application.uptime-kuma.backup"],
    ["pi-hole", "application.pi-hole.backup"],
  ])("records only restore-verified %s evidence tied to the job", (applicationId, type) => {
    const { service, store } = fixture({ applicationId });
    const job = { type, parameters: { backupId: "11111111-1111-4111-8111-111111111111", applicationId }, createdBy: "owner-one" };
    const result = resultFor(applicationId, job.parameters.backupId);
    service.recordResult(job, result);
    expect(store.recordBackup).toHaveBeenCalledWith(expect.objectContaining({ id: result.backupId, applicationId, createdBy: "owner-one" }));
    if (applicationId === "boxpilot-controller") expect(() => service.recordResult(job, { ...result, consistentSnapshot: false })).toThrow("evidence validation");
    else expect(() => service.recordResult(job, { ...result, sourceRestartVerified: false })).toThrow("evidence validation");
    expect(() => service.recordResult(job, { ...result, artifactPath: "/tmp/other.tar.gz" })).toThrow("evidence validation");
  });

  it("rejects controller evidence that widens the helper boundary or omits the isolated drill", () => {
    const { service } = fixture({ applicationId: "boxpilot-controller" });
    const job = { type: "controller.database.backup", parameters: { backupId: "11111111-1111-4111-8111-111111111111", applicationId: "boxpilot-controller" }, createdBy: "owner-one" };
    const result = resultFor("boxpilot-controller", job.parameters.backupId);
    expect(() => service.recordResult(job, { ...result, boundary: { ...result.boundary, productionDatabaseChanged: true } })).toThrow("evidence validation");
    expect(() => service.recordResult(job, { ...result, restoreDrill: { ...result.restoreDrill, workspaceRemoved: false } })).toThrow("evidence validation");
    expect(() => service.recordResult(job, { ...result, snapshotMethod: "raw-copy" })).toThrow("evidence validation");
  });

  it("rejects Pi-hole evidence that omits the secret, configuration, or no-cutover proof", () => {
    const { service } = fixture({ applicationId: "pi-hole" });
    const job = { type: "application.pi-hole.backup", parameters: { backupId: "11111111-1111-4111-8111-111111111111", applicationId: "pi-hole" }, createdBy: "owner-one" };
    const result = resultFor("pi-hole", job.parameters.backupId);
    expect(() => service.recordResult(job, { ...result, restoreDrill: { ...result.restoreDrill, administratorSecretIncluded: false } })).toThrow("evidence validation");
    expect(() => service.recordResult(job, { ...result, dnsCutoverPerformed: true })).toThrow("evidence validation");
  });
});
