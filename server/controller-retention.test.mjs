import { describe, expect, it, vi } from "vitest";
import { createControllerRetentionService, controllerRetentionInternals } from "./controller-retention.mjs";

const now = new Date("2026-08-16T00:00:00Z");

function protection(number, overrides = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    backupId: `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
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
  const protections = [protection(1), protection(2), protection(3), protection(4), protection(5)];
  const inspection = {
    ready: true,
    repositoryId: "a".repeat(64),
    destinationRevision: "b".repeat(64),
    snapshotSetRevision: "c".repeat(64),
    snapshots: protections.map((item) => ({ id: item.snapshotId, time: item.createdAt, tags: ["boxpilot-controller"] })),
    blockers: [],
  };
  const plans = new Map();
  const store = {
    listAllControllerBackupProtections: vi.fn(() => protections),
    listControllerRetentionRuns: vi.fn(() => []),
    listActiveJobs: vi.fn(() => []),
    createPlan: vi.fn((value) => { const plan = { id: "plan-one", revision: "rev-one", status: "draft", ...value }; plans.set(plan.id, plan); return plan; }),
    getPlan: vi.fn((id) => plans.get(id)),
    stagePlan: vi.fn((id) => { plans.get(id).status = "staged"; }),
    createJob: vi.fn((value) => ({ id: "job-one", state: "awaiting_approval", ...value })),
    recordControllerRetention: vi.fn((value) => value),
  };
  const helper = { request: vi.fn(async () => inspection) };
  return { protections, inspection, store, helper, service: createControllerRetentionService({ store, helper, now: () => now }) };
}

describe("controller backup retention service", () => {
  it("keeps three newest copies and selects only restore-tested snapshots at least 30 days old", () => {
    const protections = [protection(1), protection(2), protection(3), protection(4), protection(5, { protected: false, restoreDrill: { passed: false } })];
    const selection = controllerRetentionInternals.selectRetentionCandidates({ protections, now });
    expect(selection.candidates.map((item) => item.protectionId)).toEqual([protection(4).id]);
    expect(selection.kept.find((item) => item.protectionId === protection(5).id)?.reasons).toContain("not-restore-tested");
  });

  it("preserves protections referenced by an active controller operation", async () => {
    const { service, store, protections } = fixture();
    store.listActiveJobs.mockReturnValue([{ type: "controller.database.backup.retention.apply", parameters: { input: { forgetSnapshotIds: [protections[4].snapshotId] } } }]);
    const status = await service.inspect();
    expect(status.candidates.map((item) => item.protectionId)).not.toContain(protections[4].id);
    expect(status.kept.find((item) => item.protectionId === protections[4].id)?.reasons).toContain("active-controller-operation");
  });

  it("creates and stages an exact high-risk plan without prune", async () => {
    const { service, store } = fixture();
    const plan = await service.plan("owner-one");
    expect(plan.output.executable).toBe(true);
    expect(plan.output.candidates).toHaveLength(2);
    expect(plan.output.prunePerformed).toBe(false);
    const job = await service.stage(plan.id, plan.revision, "owner-one");
    expect(job).toMatchObject({ type: "controller.database.backup.retention.apply", risk: "high" });
    expect(store.stagePlan).toHaveBeenCalledWith(plan.id, "owner-one");
  });

  it("blocks when repository snapshots are unattributed or local evidence is missing", async () => {
    const { service, inspection } = fixture();
    inspection.snapshots.push({ id: "f".repeat(64), time: now.toISOString(), tags: ["boxpilot-controller"] });
    const result = await service.inspect();
    expect(result.executable).toBe(false);
    expect(result.blockers.join(" ")).toContain("not attributable");
  });

  it("records only exact complete helper evidence after execution", async () => {
    const { service, store } = fixture();
    const plan = await service.plan("owner-one");
    const job = await service.stage(plan.id, plan.revision, "owner-one");
    service.recordResult(job, {
      applied: true,
      complete: true,
      retentionId: plan.input.retentionId,
      repositoryId: plan.input.repositoryId,
      forgottenSnapshotIds: plan.input.forgetSnapshotIds,
      keptSnapshotIds: plan.output.kept.map((item) => item.snapshotId),
      beforeCount: plan.output.beforeCount,
      afterCount: plan.output.beforeCount - plan.output.candidates.length,
      beforeSnapshotSetRevision: plan.input.expectedSnapshotSetRevision,
      afterSnapshotSetRevision: "d".repeat(64),
      repositoryVerified: true,
      prunePerformed: false,
      spaceReclaimed: false,
    });
    expect(store.recordControllerRetention).toHaveBeenCalledWith(expect.objectContaining({ id: plan.input.retentionId, prunePerformed: false, forgotten: expect.any(Array) }));
  });

  it("records a confirmed partial forget as unprotected even when verification is incomplete", async () => {
    const { service, store } = fixture();
    const plan = await service.plan("owner-one");
    const job = await service.stage(plan.id, plan.revision, "owner-one");
    const forgottenSnapshotId = plan.input.forgetSnapshotIds[0];
    service.recordResult(job, {
      applied: true,
      complete: false,
      retentionId: plan.input.retentionId,
      repositoryId: plan.input.repositoryId,
      forgottenSnapshotIds: [forgottenSnapshotId],
      keptSnapshotIds: [],
      beforeCount: plan.output.beforeCount,
      afterCount: null,
      beforeSnapshotSetRevision: plan.input.expectedSnapshotSetRevision,
      afterSnapshotSetRevision: null,
      repositoryVerified: false,
      prunePerformed: false,
      spaceReclaimed: false,
      verification: ["post-inspection-failed"],
    });
    expect(store.recordControllerRetention).toHaveBeenCalledWith(expect.objectContaining({
      repositoryVerified: false,
      complete: false,
      verification: ["post-inspection-failed"],
      forgotten: [expect.objectContaining({ snapshotId: forgottenSnapshotId })],
    }));
  });
});
