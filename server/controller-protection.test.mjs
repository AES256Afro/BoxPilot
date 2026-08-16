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
  it("fails closed with exact setup guidance when no independent destination exists", async () => {
    const { service } = fixture({ ready: false });
    const plan = await service.plan(backupId, "owner-one");
    expect(plan.output).toMatchObject({ executable: false, destination: "mounted-restic-controller", blockers: ["Mount independent storage"], protected: false });
    expect(plan.output.changes.join(" ")).toContain("Read every restic data pack");
    expect(plan.output.recovery).toContain("live controller database");
  });

  it("creates and stages an immutable executable plan without accepting a path or password", async () => {
    const { service, store } = fixture();
    const plan = await service.plan(backupId, "owner-one");
    expect(plan.input).toMatchObject({ backupId, expectedArtifactChecksumSha256: "a".repeat(64), expectedManifestChecksumSha256: "b".repeat(64), expectedDestinationRevision: "d".repeat(64) });
    expect(Object.keys(plan.input).sort()).toEqual(["backupId", "expectedArtifactChecksumSha256", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "protectionId"]);
    store.getPlan.mockReturnValue(plan);
    const job = await service.stage(plan.id, plan.revision, "owner-one");
    expect(job).toMatchObject({ type: "controller.database.backup.protect", risk: "medium", parameters: { input: plan.input } });
    expect(store.stagePlan).toHaveBeenCalledWith(plan.id, "owner-one");
  });

  it("records only complete encrypted independent repository and restored database evidence", () => {
    const { service, store } = fixture();
    const input = { protectionId, backupId, expectedArtifactChecksumSha256: "a".repeat(64), expectedManifestChecksumSha256: "b".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "d".repeat(64) };
    const job = { type: "controller.database.backup.protect", parameters: { input }, createdBy: "owner-one" };
    service.recordResult(job, result(input));
    expect(store.recordControllerBackupProtection).toHaveBeenCalledWith(expect.objectContaining({ id: protectionId, backupId, protected: true, encrypted: true, independent: true }));
    expect(() => service.recordResult(job, { ...result(input), protected: false })).toThrow("evidence validation");
    expect(() => service.recordResult(job, { ...result(input), boundary: { ...result(input).boundary, browserPasswordAccepted: true } })).toThrow("evidence validation");
  });
});
