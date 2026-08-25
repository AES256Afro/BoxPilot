import { describe, it, expect, vi } from "vitest";
import { housekeepingRemoveTrees } from "./housekeeping.mjs";

/**
 * This task exists because the helper runs with /opt read-only on purpose — a root process that
 * is compromised must not be able to rewrite the application it is part of. The paths therefore
 * arrive from another process and are re-checked here rather than trusted.
 */
function files(present = []) {
  const removed = [];
  return {
    removed,
    rm: vi.fn(async (target) => { removed.push(target); }),
    stat: vi.fn(async (target) => {
      if (!present.includes(target)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isDirectory: () => true, isSymbolicLink: () => false };
    }),
  };
}

describe("removing previous release trees", () => {
  const root = "/opt";
  const good = ["/opt/boxpilot.prev.20260825T170951Z", "/opt/boxpilot-prev-0.40.0", "/opt/boxpilot.rollback-0.60.0-d6562ba"];

  it("removes the leftovers it is given", async () => {
    const f = files(good);
    const result = await housekeepingRemoveTrees({ paths: good, installRoot: root, currentTree: "/opt/boxpilot" }, { files: f });
    expect(result.removed).toEqual(good);
    expect(result.refused).toEqual([]);
  });

  it("refuses anything that is not a leftover directly inside the install root", async () => {
    const bad = [
      "/opt/boxpilot",                       // the running install
      "/opt/something-else",                 // not a name an update leaves
      "/opt/nested/boxpilot.prev.x",         // not directly in the root
      "/etc/passwd",                         // elsewhere entirely
      "/opt/../etc/boxpilot.prev.x",         // traversal
    ];
    const f = files([...bad, "/etc/boxpilot.prev.x"]);
    const result = await housekeepingRemoveTrees({ paths: bad, installRoot: root, currentTree: "/opt/boxpilot" }, { files: f });
    expect(result.removed).toEqual([]);
    expect(f.rm).not.toHaveBeenCalled();
    expect(result.refused.map((entry) => entry.reason)).toEqual([
      "this is the running install",
      "not a name a BoxPilot update leaves behind",
      "not directly in the install root",
      "not directly in the install root",
      "not directly in the install root",
    ]);
  });

  it("reports a tree it could not remove rather than abandoning the rest", async () => {
    const f = files(good);
    f.rm = vi.fn(async (target) => { if (target === good[1]) throw new Error("EROFS: read-only file system"); f.removed.push(target); });
    const result = await housekeepingRemoveTrees({ paths: good, installRoot: root, currentTree: "/opt/boxpilot" }, { files: f });
    expect(result.removed).toEqual([good[0], good[2]]);
    expect(result.refused).toEqual([{ path: good[1], reason: "EROFS: read-only file system" }]);
  });

  it("refuses an unreasonable number of paths in one request", async () => {
    await expect(housekeepingRemoveTrees({ paths: Array.from({ length: 501 }, (_, i) => `/opt/boxpilot.prev.${i}`) }, { files: files() }))
      .rejects.toThrow("too many paths");
  });
});
