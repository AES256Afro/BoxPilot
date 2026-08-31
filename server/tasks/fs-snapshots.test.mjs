import { describe, expect, it, vi } from "vitest";
import { fsSnapshotCreate, fsSnapshotDelete, fsSnapshotsInspect } from "./fs-snapshots.mjs";

const FINDMNT_BTRFS = JSON.stringify({ filesystems: [{ target: "/mnt/pool", source: "/dev/sdb1" }] });
const ZFS_LIST = "tank\t/tank\ntank/media\t/tank/media\n";

function fakeRun({ hasZfsSnapshots = true } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("findmnt")) return { ok: true, stdout: FINDMNT_BTRFS, stderr: "" };
    if (binary.endsWith("/zfs") && args[0] === "list" && args.includes("snapshot")) {
      return { ok: true, stdout: hasZfsSnapshots ? "tank/media@nightly\t1M\n" : "", stderr: "" };
    }
    if (binary.endsWith("/zfs") && args[0] === "list") return { ok: true, stdout: ZFS_LIST, stderr: "" };
    if (binary.endsWith("/btrfs") && args[1] === "list") return { ok: true, stdout: "ID 258 gen 10 top level 5 path .boxpilot-snapshots/before-move\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}
const files = { access: vi.fn(async () => undefined), mkdir: vi.fn(async () => undefined) };

describe("filesystem snapshots", () => {
  it("inspects btrfs mounts and zfs datasets with their snapshots", async () => {
    const run = fakeRun();
    const result = await fsSnapshotsInspect({}, { run, files });
    expect(result.supported).toBe(true);
    expect(result.btrfs.filesystems).toEqual([{ target: "/mnt/pool", source: "/dev/sdb1", snapshots: [{ path: ".boxpilot-snapshots/before-move", name: "before-move" }] }]);
    expect(result.zfs.datasets[1]).toMatchObject({ name: "tank/media", snapshots: [{ path: "tank/media@nightly", name: "nightly", used: "1M" }] });
  });

  it("creates snapshots only for targets the system itself reports", async () => {
    const run = fakeRun();
    const created = await fsSnapshotCreate({ kind: "btrfs", target: "/mnt/pool", name: "before-upgrade" }, { run, files });
    expect(created.path).toBe("/mnt/pool/.boxpilot-snapshots/before-upgrade");
    expect(run).toHaveBeenCalledWith(expect.stringContaining("btrfs"), ["subvolume", "snapshot", "-r", "/mnt/pool", "/mnt/pool/.boxpilot-snapshots/before-upgrade"], expect.anything());

    const zfsCreated = await fsSnapshotCreate({ kind: "zfs", target: "tank/media", name: "pre-clean" }, { run, files });
    expect(zfsCreated.path).toBe("tank/media@pre-clean");

    await expect(fsSnapshotCreate({ kind: "btrfs", target: "/etc", name: "x" }, { run, files })).rejects.toThrow("not a mounted btrfs filesystem");
    await expect(fsSnapshotCreate({ kind: "zfs", target: "tank/../evil", name: "x" }, { run, files })).rejects.toThrow("not a ZFS dataset");
    await expect(fsSnapshotCreate({ kind: "btrfs", target: "/mnt/pool", name: "../escape" }, { run, files })).rejects.toThrow("Snapshot name");
  });

  it("deletes only managed btrfs snapshots and @-suffixed zfs snapshots", async () => {
    const run = fakeRun();
    await fsSnapshotDelete({ kind: "btrfs", target: "/mnt/pool", name: "before-upgrade" }, { run });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("btrfs"), ["subvolume", "delete", "/mnt/pool/.boxpilot-snapshots/before-upgrade"], expect.anything());
    await fsSnapshotDelete({ kind: "zfs", target: "tank/media", name: "nightly" }, { run });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("zfs"), ["destroy", "tank/media@nightly"], expect.anything());
    // A bare dataset can never be destroyed from here: the @name is always appended.
    expect(run.mock.calls.some(([binary, args]) => binary.endsWith("/zfs") && args[0] === "destroy" && !args[1].includes("@"))).toBe(false);
  });
});
