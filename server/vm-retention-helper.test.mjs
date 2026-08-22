import { describe, expect, it, vi } from "vitest";
import { createVmRetentionHelper, validateVmRetentionInput } from "./vm-retention-helper.mjs";

const destination = { ready: true, repositoryId: "a".repeat(64), destinationRevision: "b".repeat(64), blockers: [] };
const snapshots = [
  { id: "c".repeat(64), time: "2026-01-01T00:00:00Z", tags: ["boxpilot-vm", "boxpilot-backup-one"] },
  { id: "d".repeat(64), time: "2026-02-01T00:00:00Z", tags: ["boxpilot-vm", "boxpilot-backup-two"] },
];

function input(overrides = {}) {
  return {
    retentionId: "11111111-1111-4111-8111-111111111111",
    repositoryId: destination.repositoryId,
    expectedDestinationRevision: destination.destinationRevision,
    expectedSnapshotSetRevision: "e".repeat(64),
    forgetSnapshotIds: [snapshots[0].id],
    ...overrides,
  };
}

describe("VM retention helper", () => {
  it("rejects secrets, paths, duplicate ids, unsorted ids, and broad selectors", () => {
    expect(validateVmRetentionInput(input())).toEqual([]);
    expect(validateVmRetentionInput(input({ repository: "/tmp" }))).toContain("Retention accepts only fixed typed evidence fields");
    expect(validateVmRetentionInput(input({ forgetSnapshotIds: ["latest"] }))).toContain("Every forgotten snapshot id must be an exact SHA-256 id");
    expect(validateVmRetentionInput(input({ forgetSnapshotIds: [snapshots[0].id, snapshots[0].id] }))).toContain("Forgotten snapshot ids must be unique");
    expect(validateVmRetentionInput(input({ forgetSnapshotIds: [snapshots[1].id, snapshots[0].id] }))).toContain("Forgotten snapshot ids must be sorted");
    expect(() => createVmRetentionHelper({ mountRoot: "/", inspectDestination: async () => destination })).toThrow("dedicated path");
  });

  it("inspects only the fixed tagged snapshot inventory", async () => {
    const run = vi.fn(async (_binary, args) => {
      expect(args).toContain("--tag");
      expect(args).toContain("boxpilot-vm");
      return { stdout: JSON.stringify(snapshots), stderr: "" };
    });
    const helper = createVmRetentionHelper({ inspectDestination: async () => destination, run });
    const result = await helper.inspect();
    expect(result).toMatchObject({
      ready: true,
      repositoryId: destination.repositoryId,
      snapshots: [
        { ...snapshots[0], tags: ["boxpilot-backup-one", "boxpilot-vm"] },
        { ...snapshots[1], tags: ["boxpilot-backup-two", "boxpilot-vm"] },
      ],
    });
    expect(result.snapshotSetRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("forgets exact reviewed ids, skips prune, reads repository data, and proves every kept snapshot remains", async () => {
    let inspection = 0;
    const run = vi.fn(async (_binary, args) => {
      if (args.includes("snapshots")) {
        inspection += 1;
        return { stdout: JSON.stringify(inspection <= 2 ? snapshots : [snapshots[1]]), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const helper = createVmRetentionHelper({ inspectDestination: async () => destination, run });
    const preview = await helper.inspect();
    const result = await helper.apply(input({ expectedSnapshotSetRevision: preview.snapshotSetRevision }));
    expect(result).toMatchObject({ applied: true, complete: true, beforeCount: 2, afterCount: 1, repositoryVerified: true, prunePerformed: false, spaceReclaimed: false, verification: [] });
    const calls = run.mock.calls.map(([, args]) => args);
    expect(calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(["forget", snapshots[0].id]),
      expect.arrayContaining(["check", "--read-data", "--quiet"]),
    ]));
    expect(calls.some((args) => args.includes("prune"))).toBe(false);
  });

  it("refuses execution if the snapshot set changed after approval", async () => {
    const helper = createVmRetentionHelper({
      inspectDestination: async () => destination,
      run: async () => ({ stdout: JSON.stringify(snapshots), stderr: "" }),
    });
    await expect(helper.apply(input())).rejects.toThrow("changed after approval");
  });

  it("returns durable mutation evidence when forget succeeds but repository verification fails", async () => {
    let inspection = 0;
    const run = vi.fn(async (_binary, args) => {
      if (args.includes("snapshots")) {
        inspection += 1;
        return { stdout: JSON.stringify(inspection <= 2 ? snapshots : [snapshots[1]]), stderr: "" };
      }
      if (args.includes("check")) throw new Error("fixture repository read failure");
      return { stdout: "", stderr: "" };
    });
    const helper = createVmRetentionHelper({ inspectDestination: async () => destination, run });
    const preview = await helper.inspect();
    const result = await helper.apply(input({ expectedSnapshotSetRevision: preview.snapshotSetRevision }));
    expect(result).toMatchObject({
      applied: true,
      complete: true,
      forgottenSnapshotIds: [snapshots[0].id],
      repositoryVerified: false,
      prunePerformed: false,
      verification: ["repository-check-failed"],
    });
  });
});

describe("forgetting a snapshot with no local record", () => {
  const orphan = "f".repeat(64);
  const recorded = "a".repeat(64);
  const revision = "b".repeat(64);
  const ready = { ready: true, repositoryId: revision, destinationRevision: revision, blockers: [] };

  function helper(present) {
    let snapshots = present.map((id) => ({ id, time: "2026-01-01T00:00:00Z", tags: ["boxpilot-vm"], paths: ["/x"] }));
    const forgotten = [];
    const run = vi.fn(async (_binary, args) => {
      if (args.includes("snapshots")) return { stdout: JSON.stringify(snapshots), stderr: "" };
      if (args.includes("forget")) {
        const target = args[args.length - 1];
        forgotten.push(target);
        snapshots = snapshots.filter((snapshot) => snapshot.id !== target);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    return { service: createVmRetentionHelper({ run, inspectDestination: async () => ready }), forgotten, run };
  }

  it("removes only a snapshot BoxPilot has no record of", async () => {
    const { service, forgotten } = helper([orphan, recorded]);
    await expect(service.forgetUnrecorded({ snapshotId: orphan, knownSnapshotIds: [recorded] })).resolves.toMatchObject({ forgotten: true, snapshotId: orphan, prunePerformed: false });
    expect(forgotten).toEqual([orphan]);
  });

  it("refuses a snapshot that has a local backup record", async () => {
    const { service, forgotten } = helper([orphan, recorded]);
    await expect(service.forgetUnrecorded({ snapshotId: recorded, knownSnapshotIds: [recorded] })).rejects.toThrow(/local backup record/);
    expect(forgotten).toEqual([]);
  });

  it("refuses an id the repository does not hold", async () => {
    const { service, forgotten } = helper([recorded]);
    await expect(service.forgetUnrecorded({ snapshotId: orphan, knownSnapshotIds: [recorded] })).rejects.toThrow(/not in the repository/);
    expect(forgotten).toEqual([]);
  });
});
