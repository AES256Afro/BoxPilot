import { describe, expect, it, vi } from "vitest";
import { refreshApprovedAptMetadata } from "./boxpilot-apt-refresh.mjs";

const approvedAt = "2026-08-16T06:00:00.000Z";
const previous = "2026-08-01T00:00:00.000Z";
const approval = () => JSON.stringify({ approvedAt, expectedUpdatedAt: previous });

describe("fixed APT metadata refresher", () => {
  it("runs only apt-get update and proves the package database stayed unchanged", async () => {
    let refreshed = false;
    const run = vi.fn(async (binary, args) => {
      expect(binary).toBe("/usr/bin/apt-get");
      expect(args).toEqual(["update", "--error-on=any"]);
      refreshed = true;
      return { ok: true };
    });
    const result = await refreshApprovedAptMetadata({ run, loadApproval: async () => approval(), loadDpkgStatus: async () => Buffer.from("same fixed package database"), readDpkgUpdates: async () => [], getAptListsStat: async () => ({ mtime: new Date(refreshed ? "2026-08-16T06:01:00.000Z" : previous) }), now: () => new Date("2026-08-16T06:01:30.000Z") });
    expect(result).toEqual({ refreshed: true, updatedAt: "2026-08-16T06:01:00.000Z", packageDatabaseUnchanged: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails before APT for stale approval, changed metadata, or interrupted dpkg", async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const base = { run, loadApproval: async () => approval(), loadDpkgStatus: async () => Buffer.from("same"), readDpkgUpdates: async () => [], getAptListsStat: async () => ({ mtime: new Date(previous) }) };
    await expect(refreshApprovedAptMetadata({ ...base, now: () => new Date("2026-08-16T06:06:00.001Z") })).rejects.toThrow("stale");
    await expect(refreshApprovedAptMetadata({ ...base, getAptListsStat: async () => ({ mtime: new Date("2026-08-02T00:00:00.000Z") }), now: () => new Date("2026-08-16T06:01:00.000Z") })).rejects.toThrow("changed after approval");
    await expect(refreshApprovedAptMetadata({ ...base, readDpkgUpdates: async () => ["0000"], now: () => new Date("2026-08-16T06:01:00.000Z") })).rejects.toThrow("pending update fragments");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails if an installed-package record changes", async () => {
    let reads = 0;
    await expect(refreshApprovedAptMetadata({ run: vi.fn(async () => ({ ok: true })), loadApproval: async () => approval(), loadDpkgStatus: async () => Buffer.from(++reads === 1 ? "before" : "after"), readDpkgUpdates: async () => [], getAptListsStat: async () => ({ mtime: new Date(reads ? "2026-08-16T06:01:00.000Z" : previous) }), now: () => new Date("2026-08-16T06:01:30.000Z") })).rejects.toThrow("package database changed");
  });
});
