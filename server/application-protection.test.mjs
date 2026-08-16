import { describe, expect, it, vi } from "vitest";
import { createApplicationProtectionService } from "./application-protection.mjs";

const backupId = "11111111-1111-4111-8111-111111111111";
const protectionId = "22222222-2222-4222-8222-222222222222";

function fixture({ ready = true, protectedBackup = null, applicationId = "pi-hole" } = {}) {
  const backup = {
    id: backupId, applicationId, destination: "local-managed",
    artifactPath: `/var/lib/boxpilot-managed/backups/${applicationId}/${backupId}.tar.gz`, checksumSha256: "a".repeat(64), sizeBytes: 8192,
    restoreDrill: applicationId === "pi-hole"
      ? { passed: true, network: "none", publishedPorts: 0, configurationIncluded: true, administratorSecretIncluded: true, routerMutationPerformed: false, dnsCutoverPerformed: false }
      : applicationId === "keel"
        ? { passed: true, mode: "isolated-keel-export-open", network: "none", publishedPorts: 0, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, environmentIncluded: true, treeDigestMatched: true, applicationStarted: false, productionStateReplaced: false }
        : { passed: true, network: "none", publishedPorts: 0 },
  };
  const destination = { adapter: "mounted-restic-applications", ready, encrypted: ready, independent: ready, resticVersion: ready ? "0.18.1" : null, repositoryId: ready ? "c".repeat(64) : null, destinationRevision: ready ? "d".repeat(64) : null, destinationFreeBytes: ready ? 1024 ** 3 : null, blockers: ready ? [] : ["Mount independent storage"], setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-application-restic-setup.sh" };
  const store = {
    listBackups: vi.fn(() => [backup]), listApplicationBackupProtections: vi.fn(() => protectedBackup ? [protectedBackup] : []),
    getApplicationBackupProtectionByBackup: vi.fn(() => protectedBackup),
    createPlan: vi.fn((value) => ({ id: "plan-one", revision: "revision-one", status: "draft", ...value })), getPlan: vi.fn(), stagePlan: vi.fn(),
    createJob: vi.fn((value) => ({ id: "job-one", state: "awaiting_approval", ...value })), recordApplicationBackupProtection: vi.fn((value) => value),
  };
  const helper = { request: vi.fn(async () => destination) };
  return { backup, destination, store, helper, service: createApplicationProtectionService({ store, helper }) };
}

function result(input) {
  return {
    created: true, protectionId: input.protectionId, backupId: input.backupId, applicationId: input.applicationId,
    destination: "mounted-restic-applications", repositoryId: "c".repeat(64), snapshotId: "e".repeat(64), sizeBytes: input.expectedSizeBytes,
    artifactChecksumSha256: input.expectedArtifactChecksumSha256, encrypted: true, independent: true, repositoryVerified: true, protected: true,
    restoreDrill: { passed: true, mode: "exact-snapshot-artifact-restore", network: "none", publishedPorts: 0, artifactChecksumMatched: true, artifactSizeMatched: true, priorApplicationRestoreEvidencePreserved: true, workspaceRemoved: true, applicationStarted: false, productionStateReplaced: false },
    boundary: { browserPathAccepted: false, browserPasswordAccepted: false, repositorySelectorAccepted: false, productionApplicationChanged: false, localBackupChanged: false, networkAccessRequired: false, retentionPerformed: false, prunePerformed: false, routerMutationPerformed: false, dnsCutoverPerformed: false },
  };
}

describe("application backup independent protection service", () => {
  it("fails closed with fixed setup guidance when no independent destination exists", async () => {
    const { service } = fixture({ ready: false });
    const plan = await service.plan(backupId, "owner-one");
    expect(plan.output).toMatchObject({ executable: false, destination: "mounted-restic-applications", blockers: ["Mount independent storage"], protected: false });
    expect(plan.output.changes.join(" ")).toContain("Read every restic data pack");
  });

  it("creates and stages an immutable plan without a path, password, or repository selector", async () => {
    const { service, store } = fixture({ applicationId: "uptime-kuma" });
    const plan = await service.plan(backupId, "owner-one");
    expect(Object.keys(plan.input).sort()).toEqual(["applicationId", "backupId", "expectedArtifactChecksumSha256", "expectedDestinationRevision", "expectedSizeBytes", "protectionId"]);
    store.getPlan.mockReturnValue(plan);
    const job = await service.stage(plan.id, plan.revision, "owner-one");
    expect(job).toMatchObject({ type: "application.backup.protect", risk: "medium", parameters: { input: plan.input } });
  });

  it("accepts a fully restore-verified Keel export and labels its independent protection", async () => {
    const { service, store } = fixture({ applicationId: "keel" });
    const plan = await service.plan(backupId, "owner-one");
    expect(plan.output).toMatchObject({ executable: true, applicationId: "keel", destination: "mounted-restic-applications" });
    expect(plan.output.warnings.join(" ")).toContain("Keel notes");
    store.getPlan.mockReturnValue(plan);
    const job = await service.stage(plan.id, plan.revision, "owner-one");
    expect(job.title).toContain("Keel Notes");
  });

  it("rejects incomplete Keel local restore evidence before creating a protection plan", async () => {
    const { service, backup } = fixture({ applicationId: "keel" });
    backup.restoreDrill.treeDigestMatched = false;
    await expect(service.plan(backupId, "owner-one")).rejects.toThrow("lacks complete no-network restore verification");
  });

  it("records only complete encrypted exact-restore evidence", () => {
    const { service, store } = fixture();
    const input = { protectionId, backupId, applicationId: "pi-hole", expectedArtifactChecksumSha256: "a".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "d".repeat(64) };
    const job = { type: "application.backup.protect", parameters: { input }, createdBy: "owner-one" };
    service.recordResult(job, result(input));
    expect(store.recordApplicationBackupProtection).toHaveBeenCalledWith(expect.objectContaining({ id: protectionId, backupId, applicationId: "pi-hole", protected: true, encrypted: true, independent: true }));
    expect(() => service.recordResult(job, { ...result(input), protected: false })).toThrow("evidence validation");
    expect(() => service.recordResult(job, { ...result(input), boundary: { ...result(input).boundary, routerMutationPerformed: true } })).toThrow("evidence validation");
  });
});
