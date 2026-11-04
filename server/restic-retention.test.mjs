import { describe, expect, it } from "vitest";
import { parseSnapshotInventory, resticRepositoryUnder, snapshotSetRevision, validateRetentionInput } from "./restic-retention.mjs";
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
