import { describe, expect, it, vi } from "vitest";
import { createControllerProtectionService } from "./controller-protection.mjs";

const backupId = "11111111-1111-4111-8111-111111111111";
const protectionId = "22222222-2222-4222-8222-222222222222";

function fixture({ ready = true, protectedBackup = null } = {}) {
  const backup = {
    id: backupId,
    applicationId: "boxpilot-controller",
    destination: "local-managed",
    artifactPath: `/var/lib/boxpilot-managed/backups/boxpilot-controller/${backupId}/boxpilot.sqlite3`,
    checksumSha256: "a".repeat(64),
    sizeBytes: 8192,
    restoreDrill: { passed: true, mode: "isolated-copy-open", integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true, ownerStatePresent: true, workspaceRemoved: true, manifestChecksumSha256: "b".repeat(64) },
  };
  const destination = {
    adapter: "mounted-restic-controller",
    ready,
    encrypted: ready,
    independent: ready,
    resticVersion: ready ? "0.18.1" : null,
    repositoryId: ready ? "c".repeat(64) : null,
    destinationRevision: ready ? "d".repeat(64) : null,
    destinationFreeBytes: ready ? 1024 ** 3 : null,
    blockers: ready ? [] : ["Mount independent storage"],
    setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-controller-restic-setup.sh",
  };
  const store = {
    listBackups: vi.fn(() => [backup]),
    listControllerBackupProtections: vi.fn(() => protectedBackup ? [protectedBackup] : []),
    getControllerBackupProtectionByBackup: vi.fn(() => protectedBackup),
    createPlan: vi.fn((value) => ({ id: "plan-one", revision: "revision-one", status: "draft", ...value })),
    getPlan: vi.fn(),
    stagePlan: vi.fn(),
    createJob: vi.fn((value) => ({ id: "job-one", state: "awaiting_approval", ...value })),
    recordControllerBackupProtection: vi.fn((value) => value),
  };
  const helper = { request: vi.fn(async () => destination) };
  return { backup, destination, store, helper, service: createControllerProtectionService({ store, helper }) };
}

function result(input) {
  return {
    created: true,
    protectionId: input.protectionId,
    backupId: input.backupId,
    destination: "mounted-restic-controller",
    repositoryId: "c".repeat(64),
    snapshotId: "e".repeat(64),
    sizeBytes: input.expectedSizeBytes,
    artifactChecksumSha256: input.expectedArtifactChecksumSha256,
    manifestChecksumSha256: input.expectedManifestChecksumSha256,
    encrypted: true,
    independent: true,
    repositoryVerified: true,
    protected: true,
    restoreDrill: { passed: true, mode: "exact-snapshot-isolated-copy-open", network: "none", publishedPorts: 0, artifactChecksumMatched: true, manifestChecksumMatched: true, integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true, ownerStatePresent: true, workspaceRemoved: true, productionDatabaseReplaced: false, serviceStarted: false },
    boundary: { browserPathAccepted: false, browserPasswordAccepted: false, repositorySelectorAccepted: false, productionDatabaseChanged: false, localBackupChanged: false, networkAccessRequired: false, retentionPerformed: false, prunePerformed: false },
  };
}

describe("controller backup independent protection service", () => {
  it("fails closed when no independent destination exists", async () => {
    const { service } = fixture({ ready: false });
    await expect(service.prepareOperation({ backupId })).rejects.toThrow("Mount independent storage");
  });

  it("pins server-derived evidence for the registry operation", async () => {
    const { service, backup, destination } = fixture();
    const prepared = await service.prepareOperation({ backupId });
    expect(prepared).toEqual({
      protectionId: expect.any(String),
      backupId,
      expectedArtifactChecksumSha256: backup.checksumSha256,
      expectedManifestChecksumSha256: backup.restoreDrill.manifestChecksumSha256,
      expectedSizeBytes: backup.sizeBytes,
      expectedDestinationRevision: destination.destinationRevision,
    });
  });

  it("records only complete encrypted independent repository and restored database evidence", async () => {
    const { service, store } = fixture();
    const prepared = await service.prepareOperation({ backupId });
    const input = { ...prepared, protectionId };
    service.recordOperation({ parameters: input, createdBy: "owner-1" }, result(input));
    expect(store.recordControllerBackupProtection).toHaveBeenCalledWith(expect.objectContaining({ id: protectionId, backupId, encrypted: true, independent: true, protected: true }));
    expect(() => service.recordOperation({ parameters: input, createdBy: "owner-1" }, { ...result(input), repositoryVerified: false })).toThrow("evidence validation failed");
  });
});
