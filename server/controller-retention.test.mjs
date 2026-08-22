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
    // The shape jobs.mjs actually stores: "op:<operation id>" with flat parameters. The fixture
    // used to invent an "input" wrapper and the legacy helper name, so it matched a filter that
    // could never match a real job — and the guard it was testing was dead.
    store.listActiveJobs.mockReturnValue([{ type: "op:controller.backup.retention.apply", parameters: { forgetSnapshotIds: [protections[4].snapshotId] } }]);
    const status = await service.inspect();
    expect(status.candidates.map((item) => item.protectionId)).not.toContain(protections[4].id);
    expect(status.kept.find((item) => item.protectionId === protections[4].id)?.reasons).toContain("active-controller-operation");
  });

  it("pins the eligible candidate set for the registry operation", async () => {
    const { service, inspection } = fixture();
    const prepared = await service.prepareOperation();
    expect(prepared).toMatchObject({ repositoryId: inspection.repositoryId, expectedDestinationRevision: inspection.destinationRevision, expectedSnapshotSetRevision: inspection.snapshotSetRevision });
    expect(prepared.forgetSnapshotIds.length).toBeGreaterThan(0);
    expect(prepared.candidates.length).toBe(prepared.forgetSnapshotIds.length);
    expect(prepared.expectedBeforeCount).toBe(5);
  });

  it("records only exact complete helper evidence after execution", async () => {
    const { service, store } = fixture();
    const input = await service.prepareOperation();
    const result = {
      applied: true, retentionId: input.retentionId, repositoryId: input.repositoryId,
      beforeSnapshotSetRevision: input.expectedSnapshotSetRevision, afterSnapshotSetRevision: "e".repeat(64),
      beforeCount: input.expectedBeforeCount, afterCount: input.expectedBeforeCount - input.forgetSnapshotIds.length,
      forgottenSnapshotIds: input.forgetSnapshotIds, keptSnapshotIds: [], repositoryVerified: true, complete: true,
      prunePerformed: false, spaceReclaimed: false,
    };
    service.recordOperation({ parameters: input, createdBy: "owner-1" }, result);
    expect(store.recordControllerRetention).toHaveBeenCalledWith(expect.objectContaining({ id: input.retentionId, repositoryVerified: true }));
    expect(() => service.recordOperation({ parameters: input, createdBy: "owner-1" }, { ...result, prunePerformed: true })).toThrow("evidence validation failed");
  });
});
