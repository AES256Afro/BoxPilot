import { describe, expect, it, vi } from "vitest";
import { createApplicationRetentionService, applicationRetentionInternals } from "./application-retention.mjs";

const now = new Date("2026-08-16T00:00:00Z");

function protection(number, overrides = {}) {
  const applicationId = overrides.applicationId ?? "uptime-kuma";
  const id = `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
  const backupId = `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
  return {
    id,
    backupId,
    applicationId,
    repositoryId: "a".repeat(64),
    snapshotId: number.toString(16).padStart(64, "0"),
    sizeBytes: 8192,
    protected: true,
    restoreDrill: { passed: true, artifactChecksumMatched: true },
    retained: true,
    createdAt: new Date(now.getTime() - number * 15 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function tags(item) {
  return ["boxpilot-application", `boxpilot-application-${item.applicationId}`, `boxpilot-application-backup-${item.backupId}`, `boxpilot-application-protection-${item.id}`];
}

function fixture() {
  const protections = [protection(1), protection(2), protection(3), protection(4), protection(5)];
  const inspection = {
    ready: true,
    repositoryId: "a".repeat(64),
    destinationRevision: "b".repeat(64),
    snapshotSetRevision: "c".repeat(64),
    snapshots: protections.map((item) => ({ id: item.snapshotId, time: item.createdAt, tags: tags(item) })),
    blockers: [],
  };
  const plans = new Map();
  const store = {
    listAllApplicationBackupProtections: vi.fn(() => protections),
    listApplicationRetentionRuns: vi.fn(() => []),
    listAllApplicationRecoveries: vi.fn(() => []),
    listActiveJobs: vi.fn(() => []),
    createPlan: vi.fn((value) => { const plan = { id: "plan-one", revision: "rev-one", status: "draft", ...value }; plans.set(plan.id, plan); return plan; }),
    getPlan: vi.fn((id) => plans.get(id)),
    stagePlan: vi.fn((id) => { plans.get(id).status = "staged"; }),
    createJob: vi.fn((value) => ({ id: "job-one", state: "awaiting_approval", ...value })),
    recordApplicationRetention: vi.fn((value) => value),
  };
  const helper = { request: vi.fn(async () => inspection) };
  return { protections, inspection, store, helper, service: createApplicationRetentionService({ store, helper, now: () => now }) };
}

describe("application backup retention service", () => {
  it("keeps three newest copies per application and only selects old restore-tested snapshots", () => {
    const protections = [protection(1), protection(2), protection(3), protection(4), protection(5, { protected: false, restoreDrill: { passed: false, artifactChecksumMatched: false } }), protection(6, { applicationId: "pi-hole" })];
    const selection = applicationRetentionInternals.selectRetentionCandidates({ protections, now });
    expect(selection.candidates.map((item) => item.protectionId)).toEqual([protection(4).id]);
    expect(selection.kept.find((item) => item.protectionId === protection(5).id)?.reasons).toContain("not-restore-tested");
    expect(selection.kept.find((item) => item.applicationId === "pi-hole")?.reasons).toContain("minimum-copies-per-application");
  });

  it("preserves backups referenced by a recovery object", async () => {
    const { service, store, protections } = fixture();
    store.listAllApplicationRecoveries.mockReturnValue([{ backupId: protections[4].backupId }]);
    const status = await service.inspect();
    expect(status.candidates.map((item) => item.protectionId)).not.toContain(protections[4].id);
    expect(status.kept.find((item) => item.protectionId === protections[4].id)?.reasons).toContain("recovery-reference");
  });

  it("creates and stages an exact high-risk no-prune plan", async () => {
    const { service, store } = fixture();
    const plan = await service.plan("owner-one");
    expect(plan.output).toMatchObject({ executable: true, prunePerformed: false });
    expect(plan.output.candidates).toHaveLength(2);
    const job = await service.stage(plan.id, plan.revision, "owner-one");
    expect(job).toMatchObject({ type: "application.backup.retention.apply", risk: "high" });
    expect(store.stagePlan).toHaveBeenCalledWith(plan.id, "owner-one");
  });

  it("blocks unattributed or mismatched repository snapshots", async () => {
    const { service, inspection } = fixture();
    inspection.snapshots[0].tags = ["boxpilot-application"];
    const status = await service.inspect();
    expect(status.executable).toBe(false);
    expect(status.blockers.join(" ")).toContain("do not match");
  });

  it("records only the exact complete helper evidence", async () => {
    const { service, store } = fixture();
    const plan = await service.plan("owner-one");
    const job = await service.stage(plan.id, plan.revision, "owner-one");
    service.recordResult(job, {
      applied: true, complete: true, retentionId: plan.input.retentionId, repositoryId: plan.input.repositoryId,
      forgottenSnapshotIds: plan.input.forgetSnapshotIds, keptSnapshotIds: plan.output.kept.map((item) => item.snapshotId),
      beforeCount: plan.output.beforeCount, afterCount: plan.output.beforeCount - plan.output.candidates.length,
      beforeSnapshotSetRevision: plan.input.expectedSnapshotSetRevision, afterSnapshotSetRevision: "d".repeat(64),
      repositoryVerified: true, prunePerformed: false, spaceReclaimed: false,
    });
    expect(store.recordApplicationRetention).toHaveBeenCalledWith(expect.objectContaining({ id: plan.input.retentionId, prunePerformed: false, forgotten: [expect.objectContaining({ applicationId: "uptime-kuma" }), expect.objectContaining({ applicationId: "uptime-kuma" })] }));
  });
});
