import { describe, expect, it, vi } from "vitest";
import { createVmRetentionService, vmRetentionInternals } from "./vm-retention.mjs";

const now = new Date("2026-08-15T00:00:00Z");

function backup(number, overrides = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    domainName: "ubuntu-lab",
    domainUuid: "11111111-1111-4111-8111-111111111111",
    repositoryId: "a".repeat(64),
    snapshotId: number.toString(16).padStart(64, "0"),
    sizeBytes: 8192,
    protected: true,
    restoreDrill: { passed: true },
    retained: true,
    createdAt: new Date(now.getTime() - number * 15 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function fixture() {
  const backups = [backup(1), backup(2), backup(3), backup(4), backup(5)];
  const inspection = {
    ready: true,
    repositoryId: "a".repeat(64),
    destinationRevision: "b".repeat(64),
    snapshotSetRevision: "c".repeat(64),
    snapshots: backups.map((item) => ({ id: item.snapshotId, time: item.createdAt, tags: ["boxpilot-vm"] })),
    blockers: [],
  };
  const plans = new Map();
  const store = {
    listAllVmBackups: vi.fn(() => backups),
    listAllVmRecoveries: vi.fn(() => []),
    listActiveJobs: vi.fn(() => []),
    listVmRetentionRuns: vi.fn(() => []),
    createPlan: vi.fn((value) => { const plan = { id: "plan-one", revision: "rev-one", status: "draft", ...value }; plans.set(plan.id, plan); return plan; }),
    getPlan: vi.fn((id) => plans.get(id)),
    stagePlan: vi.fn((id) => { plans.get(id).status = "staged"; }),
    createJob: vi.fn((value) => ({ id: "job-one", state: "awaiting_approval", ...value })),
    recordVmRetention: vi.fn((value) => value),
  };
  const helper = { request: vi.fn(async () => inspection) };
  return { backups, inspection, store, helper, service: createVmRetentionService({ store, helper, now: () => now }) };
}

describe("VM backup retention service", () => {
  it("keeps three newest copies and only selects restore-tested backups at least 30 days old", () => {
    const backups = [backup(1), backup(2), backup(3), backup(4), backup(5, { protected: false, restoreDrill: { passed: false } })];
    const selection = vmRetentionInternals.selectRetentionCandidates({ backups, recoveries: [], now });
    expect(selection.candidates.map((item) => item.backupId)).toEqual([backup(4).id]);
    expect(selection.kept.find((item) => item.backupId === backup(5).id)?.reasons).toContain("not-restore-tested");
  });

  it("preserves every backup referenced by a recovery clone", () => {
    const backups = [backup(1), backup(2), backup(3), backup(4)];
    const selection = vmRetentionInternals.selectRetentionCandidates({ backups, recoveries: [{ backupId: backup(4).id }], now });
    expect(selection.candidates).toHaveLength(0);
    expect(selection.kept.find((item) => item.backupId === backup(4).id)?.reasons).toContain("recovery-source");
  });

  it("preserves backups consumed by an active restore or recovery job", async () => {
    const { service, store, backups } = fixture();
    store.listActiveJobs.mockReturnValue([{
      type: "virtualization.export.backup.restore-drill",
      state: "applying",
      parameters: { input: { backupId: backups[4].id } },
    }]);
    const status = await service.inspect();
    expect(status.candidates.map((item) => item.backupId)).not.toContain(backups[4].id);
    expect(status.kept.find((item) => item.backupId === backups[4].id)?.reasons).toContain("active-restore-or-recovery");
  });

  it("pins the exact eligible candidate set and repository revisions without prune", async () => {
    const { service } = fixture();
    const parameters = await service.prepareOperation();
    expect(parameters.candidates).toHaveLength(2);
    expect(parameters.forgetSnapshotIds).toEqual(parameters.candidates.map((item) => item.snapshotId).sort());
    expect(parameters).toMatchObject({ repositoryId: "a".repeat(64), expectedSnapshotSetRevision: "c".repeat(64), expectedBeforeCount: 5 });
  });

  it("blocks when repository snapshots are unattributed or local evidence is missing", async () => {
    const { service, inspection } = fixture();
    inspection.snapshots.push({ id: "f".repeat(64), time: now.toISOString(), tags: ["boxpilot-vm"] });
    const result = await service.inspect();
    expect(result.executable).toBe(false);
    // The blocker names the snapshots and the way out, because there is one now.
    const blocked = result.blockers.join(" ");
    expect(blocked).toContain("have no local record");
    expect(blocked).toContain("Forget an unrecorded snapshot");
  });

  it("records only exact helper evidence after execution", async () => {
    const { service, store } = fixture();
    const parameters = await service.prepareOperation();
    const job = { parameters, createdBy: "owner-one" };
    const result = {
      applied: true,
      complete: true,
      retentionId: parameters.retentionId,
      repositoryId: parameters.repositoryId,
      forgottenSnapshotIds: parameters.forgetSnapshotIds,
      keptSnapshotIds: [],
      beforeCount: parameters.expectedBeforeCount,
      afterCount: parameters.expectedBeforeCount - parameters.candidates.length,
      beforeSnapshotSetRevision: parameters.expectedSnapshotSetRevision,
      afterSnapshotSetRevision: "d".repeat(64),
      repositoryVerified: true,
      prunePerformed: false,
      spaceReclaimed: false,
    };
    service.recordOperation(job, result);
    expect(store.recordVmRetention).toHaveBeenCalledWith(expect.objectContaining({ id: parameters.retentionId, prunePerformed: false, forgotten: expect.any(Array) }));
  });

  it("records a confirmed partial forget as unusable even when repository verification is incomplete", async () => {
    const { service, store } = fixture();
    const parameters = await service.prepareOperation();
    const job = { parameters, createdBy: "owner-one" };
    const forgottenSnapshotId = parameters.forgetSnapshotIds[0];
    service.recordOperation(job, {
      applied: true,
      complete: false,
      retentionId: parameters.retentionId,
      repositoryId: parameters.repositoryId,
      forgottenSnapshotIds: [forgottenSnapshotId],
      keptSnapshotIds: [],
      beforeCount: parameters.expectedBeforeCount,
      afterCount: null,
      beforeSnapshotSetRevision: parameters.expectedSnapshotSetRevision,
      afterSnapshotSetRevision: null,
      repositoryVerified: false,
      prunePerformed: false,
      spaceReclaimed: false,
      verification: ["post-inspection-failed"],
    });
    expect(store.recordVmRetention).toHaveBeenCalledWith(expect.objectContaining({
      repositoryVerified: false,
      complete: false,
      verification: ["post-inspection-failed"],
      forgotten: [expect.objectContaining({ snapshotId: forgottenSnapshotId })],
    }));
  });
});
