import { describe, expect, it, vi } from "vitest";
import { createApplicationRetentionHelper, validateApplicationRetentionInput } from "./application-retention-helper.mjs";

const destination = { ready: true, repositoryId: "a".repeat(64), destinationRevision: "b".repeat(64), blockers: [] };
const snapshots = [
  { id: "c".repeat(64), time: "2026-01-01T00:00:00Z", tags: ["boxpilot-application", "boxpilot-application-uptime-kuma"] },
  { id: "d".repeat(64), time: "2026-02-01T00:00:00Z", tags: ["boxpilot-application", "boxpilot-application-pi-hole"] },
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

describe("application retention helper", () => {
  it("rejects browser paths, selectors, duplicate ids, and unsorted ids", () => {
    expect(validateApplicationRetentionInput(input())).toEqual([]);
    expect(validateApplicationRetentionInput(input({ repository: "/tmp" }))).toContain("Application retention accepts only fixed typed evidence fields");
    expect(validateApplicationRetentionInput(input({ forgetSnapshotIds: ["latest"] }))).toContain("Every forgotten snapshot id must be an exact SHA-256 id");
    expect(validateApplicationRetentionInput(input({ forgetSnapshotIds: [snapshots[0].id, snapshots[0].id] }))).toContain("Forgotten snapshot ids must be unique");
    expect(validateApplicationRetentionInput(input({ forgetSnapshotIds: [snapshots[1].id, snapshots[0].id] }))).toContain("Forgotten snapshot ids must be sorted");
    expect(() => createApplicationRetentionHelper({ mountRoot: "/", inspectDestination: async () => destination })).toThrow("dedicated path");
  });

  it("inspects only the fixed application-tagged inventory", async () => {
    const run = vi.fn(async (_binary, args) => {
      expect(args).toContain("--tag");
      expect(args).toContain("boxpilot-application");
      return { stdout: JSON.stringify(snapshots), stderr: "" };
    });
    const helper = createApplicationRetentionHelper({ inspectDestination: async () => destination, run });
    const result = await helper.inspect();
    expect(result).toMatchObject({ ready: true, repositoryId: destination.repositoryId, snapshots });
    expect(result.snapshotSetRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("forgets only reviewed ids, skips prune, reads all data, and proves kept snapshots remain", async () => {
    let inspection = 0;
    const run = vi.fn(async (_binary, args) => {
      if (args.includes("snapshots")) {
        inspection += 1;
        return { stdout: JSON.stringify(inspection <= 2 ? snapshots : [snapshots[1]]), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const helper = createApplicationRetentionHelper({ inspectDestination: async () => destination, run });
    const preview = await helper.inspect();
    const result = await helper.apply(input({ expectedSnapshotSetRevision: preview.snapshotSetRevision }));
    expect(result).toMatchObject({ applied: true, complete: true, beforeCount: 2, afterCount: 1, repositoryVerified: true, prunePerformed: false, spaceReclaimed: false });
    const calls = run.mock.calls.map(([, args]) => args);
    expect(calls).toEqual(expect.arrayContaining([expect.arrayContaining(["forget", snapshots[0].id]), expect.arrayContaining(["check", "--read-data", "--quiet"])]));
    expect(calls.some((args) => args.includes("prune"))).toBe(false);
  });

  it("fails closed when the approved snapshot set changes", async () => {
    const helper = createApplicationRetentionHelper({ inspectDestination: async () => destination, run: async () => ({ stdout: JSON.stringify(snapshots), stderr: "" }) });
    await expect(helper.apply(input())).rejects.toThrow("changed after approval");
  });
});
