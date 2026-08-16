import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecoveryKitService } from "./recovery-kit.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup({ installed = true, domains = [{ name: "notes-vm", state: "shut off", autostart: false }] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-recovery-kit-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory, now: () => new Date("2026-08-16T04:00:00.000Z") });
  const token = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(token.token, { username: "private-owner", passwordHash: "secret-password-hash" });
  const service = createRecoveryKitService({
    store,
    prerequisites: { inspect: vi.fn(async () => ({ checks: [{ id: "helper.boundary", group: "BoxPilot", name: "Restricted helper", status: "ready", summary: "Typed protocol ready", repair: null }] })) },
    applications: { list: vi.fn(async () => ({ applications: [{ id: "uptime-kuma", name: "Uptime Kuma", execution: "enabled", live: { installed, state: installed ? "healthy" : "not-installed", backup: { state: installed ? "required" : "not-applicable" } } }] })) },
    libvirt: { listDomains: vi.fn(async () => ({ connected: true, domains })) },
    now: () => new Date("2026-08-16T04:05:00.000Z"),
    version: "0.26.0-test",
  });
  return { owner, service, store };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("secret-free disaster recovery kit", () => {
  it("fails open evidence claims closed and gives an ordered operator runbook", async () => {
    const { service, store } = await setup();
    const kit = await service.inspect();
    expect(kit).toMatchObject({
      schemaVersion: 1,
      product: { version: "0.26.0-test" },
      mode: "secret-free-readiness-and-runbook",
      summary: { status: "action-required", total: 8 },
      boundary: { mutationsPerformed: false, databaseCopied: false, backupDataIncluded: false, credentialsIncluded: false },
    });
    expect(kit.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "applications.backup", state: "action-required" }),
      expect.objectContaining({ id: "virtualization.backup", state: "action-required" }),
      expect.objectContaining({ id: "router.checkpoint", state: "action-required" }),
    ]));
    expect(kit.recoveryOrder.map((item) => item.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(kit.runbookMarkdown).toContain("It is evidence and guidance, not a backup");
    store.close();
  });

  it("reports exact restore evidence without exporting secrets or sensitive state fields", async () => {
    const { owner, service, store } = await setup();
    store.recordBackup({ id: "55555555-5555-4555-8555-555555555555", applicationId: "boxpilot-controller", destination: "local-managed", artifactPath: "/secret/controller/boxpilot.sqlite3", checksumSha256: "e".repeat(64), sizeBytes: 8192, downtimeMs: 0, restoreDrill: { passed: true, integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true, manifestChecksumSha256: "f".repeat(64), privateField: "do-not-export" }, createdBy: owner.id });
    store.recordBackup({ id: "11111111-1111-4111-8111-111111111111", applicationId: "uptime-kuma", destination: "local-managed", artifactPath: "/secret/application/archive.tar.gz", checksumSha256: "a".repeat(64), sizeBytes: 1024, downtimeMs: 25, restoreDrill: { passed: true, secret: "do-not-export" }, createdBy: owner.id });
    store.recordVmExport({ id: "33333333-3333-4333-8333-333333333333", domainName: "notes-vm", domainUuid: "44444444-4444-4444-8444-444444444444", destination: "local-managed", artifactPath: "/secret/vm/export", manifestChecksumSha256: "d".repeat(64), sizeBytes: 2048, protected: false, encrypted: false, restoreDrill: { passed: false }, createdBy: owner.id });
    store.recordVmBackup({ id: "22222222-2222-4222-8222-222222222222", exportId: "33333333-3333-4333-8333-333333333333", domainName: "notes-vm", domainUuid: "44444444-4444-4444-8444-444444444444", destination: "mounted-restic", repositoryId: "repository-safe-reference", snapshotId: "b".repeat(64), sizeBytes: 2048, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true, password: "do-not-export" }, createdBy: owner.id });
    store.recordRouterCheckpoint({ modelId: "glinet-flint2", firmwareVersion: "4.8.2", checksumSha256: "c".repeat(64), sizeBytes: 4096, hashOrigin: "operator-browser-reported-sha256", configurationUploaded: false, fileRetainedByOperator: true, createdBy: owner.id });
    const kit = await service.inspect();
    expect(kit.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "controller.database", state: "operator-check", evidence: expect.stringContaining("WAL-aware local controller snapshot") }),
      expect.objectContaining({ id: "applications.backup", state: "verified" }),
      expect.objectContaining({ id: "virtualization.backup", state: "verified" }),
      expect.objectContaining({ id: "router.checkpoint", state: "verified" }),
    ]));
    const serialized = JSON.stringify(kit);
    expect(serialized).not.toContain("private-owner");
    expect(serialized).not.toContain("secret-password-hash");
    expect(serialized).not.toContain("/secret/application/archive.tar.gz");
    expect(serialized).not.toContain("/secret/controller/boxpilot.sqlite3");
    expect(serialized).not.toContain("do-not-export");
    expect(serialized).toContain("repository-safe-reference");
    expect(kit.evidence.controllerBackups).toEqual([expect.objectContaining({ checksumSha256: "e".repeat(64), manifestChecksumSha256: "f".repeat(64), restorePassed: true, schemaVerified: true })]);
    expect(kit.evidence.applicationBackups).toHaveLength(1);
    store.close();
  });

  it("uses explicit unavailable states when live collectors fail", async () => {
    const { store } = await setup();
    const failed = createRecoveryKitService({
      store,
      prerequisites: { inspect: vi.fn(async () => { throw new Error("offline"); }) },
      applications: { list: vi.fn(async () => { throw new Error("offline"); }) },
      libvirt: { listDomains: vi.fn(async () => { throw new Error("offline"); }) },
      version: "0.26.0-test",
    });
    const kit = await failed.inspect();
    expect(kit.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "applications.backup", state: "unavailable" }),
      expect.objectContaining({ id: "virtualization.backup", state: "unavailable" }),
      expect.objectContaining({ id: "host.prerequisites", state: "unavailable" }),
    ]));
    expect(kit.evidence.virtualMachines.inventoryAvailable).toBe(false);
    store.close();
  });

  it("reports controller recovery verified only after encrypted independent exact-snapshot restore evidence", async () => {
    const { owner, service, store } = await setup({ installed: false, domains: [] });
    const backupId = "55555555-5555-4555-8555-555555555555";
    store.recordBackup({ id: backupId, applicationId: "boxpilot-controller", destination: "local-managed", artifactPath: "/secret/controller/boxpilot.sqlite3", checksumSha256: "e".repeat(64), sizeBytes: 8192, downtimeMs: 0, restoreDrill: { passed: true, mode: "isolated-copy-open", integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true, manifestChecksumSha256: "f".repeat(64) }, createdBy: owner.id });
    store.recordControllerBackupProtection({ id: "66666666-6666-4666-8666-666666666666", backupId, destination: "mounted-restic-controller", repositoryId: "a".repeat(64), snapshotId: "b".repeat(64), sizeBytes: 8192, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true, mode: "exact-snapshot-isolated-copy-open", network: "none", workspaceRemoved: true }, createdBy: owner.id });

    const kit = await service.inspect();
    expect(kit.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "controller.database", state: "verified", evidence: expect.stringContaining("complete repository read") })]));
    expect(kit.evidence.controllerProtections).toEqual([expect.objectContaining({ backupId, encrypted: true, independent: true, repositoryVerified: true, protected: true, restorePassed: true })]);
    expect(kit.runbookMarkdown).toContain("Protected controller snapshots: 1");
    const serialized = JSON.stringify(kit);
    expect(serialized).not.toContain("/secret/controller/boxpilot.sqlite3");
    store.close();
  });
});
