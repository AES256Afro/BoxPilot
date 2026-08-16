import { describe, expect, it, vi } from "vitest";
import { createControllerRetentionHelper, validateControllerRetentionInput } from "./controller-retention-helper.mjs";

const destination = { ready: true, repositoryId: "a".repeat(64), destinationRevision: "b".repeat(64), blockers: [] };
const snapshots = [
  { id: "c".repeat(64), time: "2026-01-01T00:00:00Z", tags: ["boxpilot-controller", "boxpilot-controller-backup-one"] },
  { id: "d".repeat(64), time: "2026-02-01T00:00:00Z", tags: ["boxpilot-controller", "boxpilot-controller-backup-two"] },
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

describe("controller retention helper", () => {
  it("rejects secrets, paths, selectors, duplicate ids, and unsorted ids", () => {
    expect(validateControllerRetentionInput(input())).toEqual([]);
    expect(validateControllerRetentionInput(input({ repository: "/tmp" }))).toContain("Controller retention accepts only fixed typed evidence fields");
    expect(validateControllerRetentionInput(input({ forgetSnapshotIds: ["latest"] }))).toContain("Every forgotten snapshot id must be an exact SHA-256 id");
    expect(validateControllerRetentionInput(input({ forgetSnapshotIds: [snapshots[0].id, snapshots[0].id] }))).toContain("Forgotten snapshot ids must be unique");
    expect(validateControllerRetentionInput(input({ forgetSnapshotIds: [snapshots[1].id, snapshots[0].id] }))).toContain("Forgotten snapshot ids must be sorted");
    expect(() => createControllerRetentionHelper({ mountRoot: "/", inspectDestination: async () => destination })).toThrow("dedicated path");
  });

  it("inspects only the fixed controller-tagged snapshot inventory", async () => {
    const run = vi.fn(async (_binary, args) => {
      expect(args).toContain("--tag");
      expect(args).toContain("boxpilot-controller");
      return { stdout: JSON.stringify(snapshots), stderr: "" };
    });
    const helper = createControllerRetentionHelper({ inspectDestination: async () => destination, run });
    const result = await helper.inspect();
    expect(result).toMatchObject({ ready: true, repositoryId: destination.repositoryId, snapshots });
    expect(result.snapshotSetRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("forgets exact reviewed ids, skips prune, reads all data, and proves every kept snapshot remains", async () => {
    let inspection = 0;
    const run = vi.fn(async (_binary, args) => {
      if (args.includes("snapshots")) {
        inspection += 1;
        return { stdout: JSON.stringify(inspection <= 2 ? snapshots : [snapshots[1]]), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const helper = createControllerRetentionHelper({ inspectDestination: async () => destination, run });
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

  it("refuses execution when the snapshot set changed after approval", async () => {
    const helper = createControllerRetentionHelper({ inspectDestination: async () => destination, run: async () => ({ stdout: JSON.stringify(snapshots), stderr: "" }) });
    await expect(helper.apply(input())).rejects.toThrow("changed after approval");
  });

  it("returns confirmed partial removal evidence after a post-forget verification failure", async () => {
    let snapshotCall = 0;
    const run = vi.fn(async (_binary, args) => {
      if (args.includes("snapshots")) {
        snapshotCall += 1;
        if (snapshotCall <= 2) return { stdout: JSON.stringify(snapshots), stderr: "" };
        throw new Error("inventory unavailable");
      }
      if (args.includes("check")) throw new Error("repository read failed");
      return { stdout: "", stderr: "" };
    });
    const helper = createControllerRetentionHelper({ inspectDestination: async () => destination, run });
    const preview = await helper.inspect();
    const result = await helper.apply(input({ expectedSnapshotSetRevision: preview.snapshotSetRevision }));
    expect(result).toMatchObject({ applied: true, complete: true, repositoryVerified: false, forgottenSnapshotIds: [snapshots[0].id], afterCount: null, prunePerformed: false });
    expect(result.verification).toEqual(expect.arrayContaining(["repository-check-failed", "post-inspection-failed", "noncandidate-presence-unverified"]));
  });

  it("does not infer removal from an unavailable post-inspection after forget fails", async () => {
    let destinationCall = 0;
    const inspectDestination = vi.fn(async () => {
      destinationCall += 1;
      return destinationCall <= 2 ? destination : { ready: false, repositoryId: null, destinationRevision: null, blockers: ["mount unavailable"] };
    });
    const run = vi.fn(async (_binary, args) => {
      if (args.includes("snapshots")) return { stdout: JSON.stringify(snapshots), stderr: "" };
      if (args.includes("forget")) throw new Error("forget failed");
      return { stdout: "", stderr: "" };
    });
    const helper = createControllerRetentionHelper({ inspectDestination, run });
    const preview = await helper.inspect();
    await expect(helper.apply(input({ expectedSnapshotSetRevision: preview.snapshotSetRevision }))).rejects.toThrow("before any reviewed snapshot removal was confirmed");
  });
});
