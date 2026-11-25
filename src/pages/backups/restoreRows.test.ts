import { describe, expect, it } from "vitest";
import { alsoOnWords, restoreOptions } from "./restoreRows";
import type { SnapshotSources } from "./types";

// M91 (Design #4): after a sync, every snapshot was listed twice, on this server and the backup drive.
describe("the rows of the Restore list", () => {
  const snapshot = (artifact: string, checksumSha256: string | null, withData: number | null = 2) => ({ artifact, sizeBytes: 1, createdAt: "2026-11-20T02:00:00.000Z", checksumSha256, apps: 3, withData });
  const sources = (local: unknown[], mirror: unknown[]) => ({ sources: [
    { source: "local", root: "/l", available: true, snapshots: local },
    { source: "mirror", root: "/m", available: true, snapshots: mirror },
  ], mount: { mounted: true, blocker: null } }) as SnapshotSources;

  it("lists one snapshot once, from this server, also on the backup drive, with how many apps come back with their data", () => {
    const rows = restoreOptions(sources([snapshot("a.tar.gz", "1".repeat(64))], [snapshot("a.tar.gz", "1".repeat(64)), snapshot("b.tar.gz", "2".repeat(64))]), null);
    expect(rows.map((row) => [row.snapshot.artifact, row.source, alsoOnWords(row), row.snapshot.withData])).toEqual([
      ["a.tar.gz", "local", "also on the backup drive", 2],
      ["b.tar.gz", "mirror", null, 2],
    ]);
  });

  it("keeps two files of one name apart when their checksums differ or are not known", () => {
    expect(restoreOptions(sources([snapshot("a.tar.gz", "1".repeat(64))], [snapshot("a.tar.gz", "9".repeat(64))]), null)).toHaveLength(2);
    expect(restoreOptions(sources([snapshot("a.tar.gz", null)], [snapshot("a.tar.gz", null)]), null)).toHaveLength(2);
  });

  it("names a drive found mounted where the same snapshot also is", () => {
    const rows = restoreOptions(sources([], [snapshot("a.tar.gz", "1".repeat(64))]), { locations: [{ root: "/mnt/nas", mount: { target: "/mnt/nas", source: "//nas/backups", filesystem: "cifs" }, snapshots: [snapshot("a.tar.gz", "1".repeat(64))] }] });
    expect(rows.map((row) => [row.source, alsoOnWords(row)])).toEqual([["mirror", "also on //nas/backups (cifs)"]]);
  });
});
