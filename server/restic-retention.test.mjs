import { describe, expect, it } from "vitest";
import { parseSnapshotInventory, resticRepositoryUnder, restoreEvidenceErrors, retentionEvidenceHolds, snapshotSetRevision, validateRetentionInput } from "./restic-retention.mjs";
import { validateVmRestoreDrillInput } from "./vm-restore-drill-helper.mjs";
import { validateVmRecoveryInput } from "./vm-recovery-helper.mjs";
import { validateControllerRetentionInput } from "./controller-retention-helper.mjs";
import { validateVmRetentionInput } from "./vm-retention-helper.mjs";

/**
 * What the controller and VM retention paths share (M53.3). They were the same code twice, and the
 * reason this file exists is that they had already drifted: both checked restic's snapshot evidence
 * with the same line, and only the controller side rejected a `time` that is a string but not a
 * date. The tests that matter here are the ones that hold both paths to the same answer.
 */

const sha = (character) => character.repeat(64);
const retentionId = "6f0c2e9a-4b1d-4c7e-9a3f-2d5b8e1c0a47";
const request = (overrides = {}) => ({
  expectedDestinationRevision: sha("a"),
  expectedSnapshotSetRevision: sha("b"),
  forgetSnapshotIds: [sha("1"), sha("2")],
  repositoryId: sha("c"),
  retentionId,
  ...overrides,
});

describe("a retention request", () => {
  it("passes when every field is exact, sorted and unique", () => {
    expect(validateRetentionInput(request(), { subject: "VM" })).toEqual([]);
    expect(validateControllerRetentionInput(request())).toEqual([]);
    expect(validateVmRetentionInput(request())).toEqual([]);
  });

  it("is refused for the same reasons on both paths", () => {
    const bad = [
      [{ repository: "/tmp" }, "accepts only fixed typed evidence fields"],
      [{ retentionId: "not-a-uuid" }, "Retention id must be a UUID"],
      [{ repositoryId: "/mnt/backups" }, "Repository id is invalid"],
      [{ forgetSnapshotIds: ["latest"] }, "Every forgotten snapshot id must be an exact SHA-256 id"],
      [{ forgetSnapshotIds: [sha("1"), sha("1")] }, "Forgotten snapshot ids must be unique"],
      [{ forgetSnapshotIds: [sha("2"), sha("1")] }, "Forgotten snapshot ids must be sorted"],
      [{ forgetSnapshotIds: [] }, "One to 100 exact snapshot ids are required"],
    ];
    for (const [overrides, reason] of bad) {
      expect(validateControllerRetentionInput(request(overrides)).join(" | ")).toContain(reason);
      expect(validateVmRetentionInput(request(overrides)).join(" | ")).toContain(reason);
    }
  });

  it("names the path in the words, so an owner knows which backups are meant", () => {
    expect(validateControllerRetentionInput(null)).toEqual(["A controller retention request is required"]);
    expect(validateVmRetentionInput(null)).toEqual(["A VM retention request is required"]);
    expect(validateControllerRetentionInput(request({ repository: "/tmp" }))).toContain("Controller retention accepts only fixed typed evidence fields");
    expect(validateVmRetentionInput(request({ repository: "/tmp" }))).toContain("VM retention accepts only fixed typed evidence fields");
  });
});

describe("restic's snapshot inventory", () => {
  const snapshot = (overrides = {}) => ({ id: sha("1"), time: "2026-10-19T08:00:00.000Z", tags: ["boxpilot-vm"], ...overrides });

  it("comes back sorted by id, with the tags sorted too", () => {
    const read = parseSnapshotInventory(JSON.stringify([snapshot({ id: sha("2"), tags: ["b", "a"] }), snapshot()]), { label: "VM" });
    expect(read.map((entry) => entry.id)).toEqual([sha("1"), sha("2")]);
    expect(read[1].tags).toEqual(["a", "b"]);
  });

  it("refuses a time that is a string but not a date — the clause one path used to be missing", () => {
    const bad = JSON.stringify([snapshot({ time: "whenever" })]);
    expect(() => parseSnapshotInventory(bad, { label: "VM" })).toThrow("invalid VM snapshot evidence");
    expect(() => parseSnapshotInventory(bad, { label: "controller" })).toThrow("invalid controller snapshot evidence");
  });

  it("refuses an id that is not restic's, a missing tag list, an oversized tag and a duplicate id", () => {
    expect(() => parseSnapshotInventory(JSON.stringify([snapshot({ id: "latest" })]), { label: "VM" })).toThrow("invalid VM snapshot evidence");
    expect(() => parseSnapshotInventory(JSON.stringify([snapshot({ tags: "boxpilot-vm" })]), { label: "VM" })).toThrow("invalid VM snapshot evidence");
    expect(() => parseSnapshotInventory(JSON.stringify([snapshot({ tags: ["x".repeat(129)] })]), { label: "VM" })).toThrow("invalid VM snapshot evidence");
    expect(() => parseSnapshotInventory(JSON.stringify([snapshot(), snapshot()]), { label: "VM" })).toThrow("duplicate VM snapshot ids");
  });

  it("refuses anything that is not a bounded list", () => {
    expect(() => parseSnapshotInventory('{"snapshots":[]}', { label: "VM" })).toThrow("invalid VM snapshot inventory");
    expect(() => parseSnapshotInventory(JSON.stringify(Array.from({ length: 10001 }, () => snapshot())), { label: "VM" })).toThrow("invalid VM snapshot inventory");
    expect(parseSnapshotInventory("", { label: "VM" })).toEqual([]);
  });

  it("digests a set the same way whatever order it arrived in", () => {
    const one = parseSnapshotInventory(JSON.stringify([snapshot(), snapshot({ id: sha("2") })]), { label: "VM" });
    const other = parseSnapshotInventory(JSON.stringify([snapshot({ id: sha("2") }), snapshot()]), { label: "VM" });
    expect(snapshotSetRevision(one)).toBe(snapshotSetRevision(other));
    expect(snapshotSetRevision(one)).not.toBe(snapshotSetRevision([]));
  });
});

describe("the repository under the backup mount", () => {
  it("must be a dedicated path below /mnt or /media", () => {
    expect(resticRepositoryUnder("/mnt/backups", { directory: "restic-vm", subject: "VM" }).repository).toBe("/mnt/backups/restic-vm");
    for (const root of ["/mnt", "/media", "/", "/var/lib/boxpilot", "/tmp/backups"]) {
      expect(() => resticRepositoryUnder(root, { directory: "restic-vm", subject: "VM" })).toThrow("dedicated path below /mnt or /media");
    }
  });

  it("refuses a mount that would put the repository somewhere else", () => {
    expect(() => resticRepositoryUnder("/mnt/backups", { directory: "../escape", subject: "VM" })).toThrow("escaped the configured mount");
    expect(() => resticRepositoryUnder("/mnt/backups", { directory: "nested/deep", subject: "controller" })).toThrow("escaped the configured mount");
  });
});

/**
 * The restic evidence a restore carries (M55.3), shared by the VM restore drill and the VM
 * recovery. They validated these five fields in the same five lines each; the fields around them
 * differ, so those stay with their own validators — and both are held to the same answers here.
 */
describe("the restic evidence a restore carries", () => {
  const evidence = (overrides = {}) => ({
    repositoryId: sha("c"),
    snapshotId: sha("d"),
    expectedManifestChecksumSha256: sha("e"),
    expectedSizeBytes: 4096,
    expectedDestinationRevision: sha("f"),
    ...overrides,
  });

  it("passes when every field is exact", () => {
    expect(restoreEvidenceErrors(evidence())).toEqual([]);
  });

  it("refuses an id that is not restic's, a size that is not a positive whole number, and a missing field", () => {
    expect(restoreEvidenceErrors(evidence({ repositoryId: "latest" }))).toContain("Repository id is invalid");
    expect(restoreEvidenceErrors(evidence({ snapshotId: sha("d").toUpperCase() }))).toContain("Snapshot id is invalid");
    expect(restoreEvidenceErrors(evidence({ expectedManifestChecksumSha256: "" }))).toContain("Manifest checksum is invalid");
    expect(restoreEvidenceErrors(evidence({ expectedDestinationRevision: undefined }))).toContain("Destination revision is invalid");
    for (const size of [0, -1, 1.5, "4096", Number.MAX_SAFE_INTEGER + 2, null]) {
      expect(restoreEvidenceErrors(evidence({ expectedSizeBytes: size })), String(size)).toContain("Expected backup size is invalid");
    }
  });

  it("answers for a request that is not an object at all, rather than throwing", () => {
    expect(restoreEvidenceErrors(null)).toHaveLength(5);
    expect(restoreEvidenceErrors(undefined)).toHaveLength(5);
  });

  it("is what both VM restore validators use, so neither can drift from the other", () => {
    const drill = { drillId: retentionId, backupId: retentionId, exportId: retentionId, domainName: "web", domainUuid: retentionId, ...evidence() };
    const recovery = { restoreId: retentionId, backupId: retentionId, exportId: retentionId, sourceDomainName: "web", sourceDomainUuid: retentionId, targetDomainName: "web-recovered", restoreDrillId: retentionId, ...evidence() };
    expect(validateVmRestoreDrillInput(drill)).toEqual([]);
    expect(validateVmRecoveryInput(recovery)).toEqual([]);
    // The same bad evidence is refused for the same reason on both paths.
    for (const bad of [{ repositoryId: "x" }, { snapshotId: "x" }, { expectedManifestChecksumSha256: "x" }, { expectedSizeBytes: 0 }, { expectedDestinationRevision: "x" }]) {
      const reason = restoreEvidenceErrors(evidence(bad))[0];
      expect(validateVmRestoreDrillInput({ ...drill, ...bad })).toContain(reason);
      expect(validateVmRecoveryInput({ ...recovery, ...bad })).toContain(reason);
    }
  });
});

/**
 * Whether a forget did exactly what was approved (M55.4). Both retention paths carried this
 * compound condition byte for byte; sweep 2 had already caught them computing `complete`
 * differently one level down, which is why it is shared rather than left in two places.
 */
describe("the evidence a forget leaves", () => {
  const input = { retentionId, repositoryId: sha("c"), expectedSnapshotSetRevision: sha("b"), expectedBeforeCount: 5, forgetSnapshotIds: [sha("1"), sha("2")] };
  const result = (overrides = {}) => ({
    applied: true,
    retentionId,
    repositoryId: sha("c"),
    beforeSnapshotSetRevision: sha("b"),
    beforeCount: 5,
    forgottenSnapshotIds: [sha("1"), sha("2")],
    prunePerformed: false,
    spaceReclaimed: false,
    repositoryVerified: true,
    complete: true,
    afterCount: 3,
    afterSnapshotSetRevision: sha("9"),
    ...overrides,
  });
  const holds = (overrides, forgottenCount = 2) => retentionEvidenceHolds({ input, result: overrides === null ? null : result(overrides), forgottenCount });

  it("holds when the run is the approved one and did exactly what it said", () => {
    expect(holds({})).toBe(true);
  });

  it("refuses a run that is not the approved one, or not against the approved repository or snapshot set", () => {
    expect(holds({ applied: false })).toBe(false);
    expect(holds({ retentionId: "6f0c2e9a-4b1d-4c7e-9a3f-2d5b8e1c0a48" })).toBe(false);
    expect(holds({ repositoryId: sha("0") })).toBe(false);
    expect(holds({ beforeSnapshotSetRevision: sha("0") })).toBe(false);
    expect(holds({ beforeCount: 4 })).toBe(false);
    expect(holds(null)).toBe(false);
  });

  it("refuses ids that were not approved, reported twice, or none at all", () => {
    expect(holds({ forgottenSnapshotIds: [sha("3")] })).toBe(false);
    expect(holds({ forgottenSnapshotIds: [sha("1"), sha("1")] })).toBe(false);
    expect(holds({ forgottenSnapshotIds: [] })).toBe(false);
    expect(holds({ forgottenSnapshotIds: "not a list" })).toBe(false);
  });

  it("refuses a run that pruned or reclaimed, which this release never does", () => {
    expect(holds({ prunePerformed: true })).toBe(false);
    expect(holds({ spaceReclaimed: true })).toBe(false);
  });

  it("refuses a count of the caller's own records that does not match what was forgotten", () => {
    expect(holds({}, 1)).toBe(false);
    expect(holds({}, 3)).toBe(false);
  });

  it("holds a verified repository to what is left in it, and does not ask that of an unverified one", () => {
    // Verified: the ids must match exactly, in order, and the count must have fallen by them.
    expect(holds({ complete: false })).toBe(false);
    expect(holds({ forgottenSnapshotIds: [sha("2"), sha("1")] })).toBe(false);
    expect(holds({ afterCount: 4 })).toBe(false);
    expect(holds({ afterSnapshotSetRevision: null })).toBe(false);
    // Unverified: the repository could not be read again, so there is nothing to hold it to. The
    // helper's own code refuses that case for its own reasons; this predicate does not double-guess it.
    expect(holds({ repositoryVerified: false, complete: false, afterCount: 99, afterSnapshotSetRevision: null })).toBe(true);
  });
});
