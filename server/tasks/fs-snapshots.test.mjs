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
    if (binary.endsWith("/btrfs") && args[1] === "list") return { ok: true, stdout: "ID 258 gen 10 top level 5 path .boxpilot-snapshots/before-move\nID 259 gen 11 top level 5 path .boxpilot-snapshots/before-upgrade\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}
const folder = { isDirectory: () => true, isSymbolicLink: () => false };
const files = { access: vi.fn(async () => undefined), mkdir: vi.fn(async () => undefined), lstat: vi.fn(async () => folder) };
const resolve = async (value) => value;

describe("filesystem snapshots", () => {
  it("inspects btrfs mounts and zfs datasets with their snapshots", async () => {
    const run = fakeRun();
    const result = await fsSnapshotsInspect({}, { run, files });
    expect(result.supported).toBe(true);
    expect(result.btrfs.filesystems).toEqual([{ target: "/mnt/pool", source: "/dev/sdb1", snapshots: [{ id: "258", path: ".boxpilot-snapshots/before-move", name: "before-move" }, { id: "259", path: ".boxpilot-snapshots/before-upgrade", name: "before-upgrade" }] }]);
    expect(result.zfs.datasets[1]).toMatchObject({ name: "tank/media", snapshots: [{ path: "tank/media@nightly", name: "nightly", used: "1M" }] });
  });

  it("creates snapshots only for targets the system itself reports", async () => {
    const run = fakeRun();
    const created = await fsSnapshotCreate({ kind: "btrfs", target: "/mnt/pool", name: "before-upgrade" }, { run, files, resolve });
    expect(created.path).toBe("/mnt/pool/.boxpilot-snapshots/before-upgrade");
    expect(run).toHaveBeenCalledWith(expect.stringContaining("btrfs"), ["subvolume", "snapshot", "-r", "/mnt/pool", "/mnt/pool/.boxpilot-snapshots/before-upgrade"], expect.anything());

    const zfsCreated = await fsSnapshotCreate({ kind: "zfs", target: "tank/media", name: "pre-clean" }, { run, files });
    expect(zfsCreated.path).toBe("tank/media@pre-clean");

    // A link where the snapshot folder should be would write the drive's snapshot wherever it points.
    const linkedRun = fakeRun();
    const elsewhere = async (value) => value.replace("/mnt/pool/.boxpilot-snapshots", "/mnt/pool/apps/www");
    await expect(fsSnapshotCreate({ kind: "btrfs", target: "/mnt/pool", name: "x" }, { run: linkedRun, files, resolve: elsewhere })).rejects.toThrow(/leads to \/mnt\/pool\/apps\/www.*no snapshot was taken/);
    await expect(fsSnapshotCreate({ kind: "btrfs", target: "/mnt/pool", name: "x" }, { run: linkedRun, files: { ...files, lstat: async () => ({ isDirectory: () => false, isSymbolicLink: () => true }) }, resolve })).rejects.toThrow(/no snapshot was taken/);
    expect(linkedRun).not.toHaveBeenCalledWith(expect.stringContaining("btrfs"), expect.arrayContaining(["snapshot"]), expect.anything());

    await expect(fsSnapshotCreate({ kind: "btrfs", target: "/etc", name: "x" }, { run, files })).rejects.toThrow("not a mounted btrfs filesystem");
    await expect(fsSnapshotCreate({ kind: "zfs", target: "tank/../evil", name: "x" }, { run, files })).rejects.toThrow("not a ZFS dataset");
    await expect(fsSnapshotCreate({ kind: "btrfs", target: "/mnt/pool", name: "../escape" }, { run, files })).rejects.toThrow("Snapshot name");
  });

  it("deletes only managed btrfs snapshots and @-suffixed zfs snapshots", async () => {
    const run = fakeRun();
    await fsSnapshotDelete({ kind: "btrfs", target: "/mnt/pool", name: "before-upgrade" }, { run, resolve });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("btrfs"), ["subvolume", "delete", "--subvolid", "259", "/mnt/pool"], expect.anything());
    await fsSnapshotDelete({ kind: "zfs", target: "tank/media", name: "nightly" }, { run });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("zfs"), ["destroy", "tank/media@nightly"], expect.anything());
    // The snapshot folder of a drive the apps write to can be swapped for a link to the drive's top:
    // the same name would then delete a live subvolume.
    const linked = fakeRun();
    const swapped = async (value) => value.replace("/.boxpilot-snapshots/", "/");
    await expect(fsSnapshotDelete({ kind: "btrfs", target: "/mnt/pool", name: "photos" }, { run: linked, resolve: swapped })).rejects.toThrow(/leads to \/mnt\/pool\/photos.*nothing was deleted/);
    expect(linked).not.toHaveBeenCalledWith(expect.stringContaining("btrfs"), expect.arrayContaining(["delete"]), expect.anything());
    // A name btrfs does not list as a snapshot here is not deleted, whatever is at the path.
    const unlisted = fakeRun();
    await expect(fsSnapshotDelete({ kind: "btrfs", target: "/mnt/pool", name: "photos" }, { run: unlisted, resolve })).rejects.toThrow(/lists no snapshot.*nothing was deleted/);
    expect(unlisted).not.toHaveBeenCalledWith(expect.stringContaining("btrfs"), expect.arrayContaining(["delete"]), expect.anything());
    // A bare dataset can never be destroyed from here: the @name is always appended.
    expect(run.mock.calls.some(([binary, args]) => binary.endsWith("/zfs") && args[0] === "destroy" && !args[1].includes("@"))).toBe(false);
  });
});


describe("finding btrfs mounts in findmnt's tree", () => {
  it("sees a subvolume nested under its volume", async () => {
    const { fsSnapshotsInspect } = await import("./fs-snapshots.mjs");
    const run = async (binary) => {
      if (binary.endsWith("findmnt")) return { ok: true, stdout: JSON.stringify({ filesystems: [{ target: "/mnt/pool", source: "/dev/sdc1", children: [{ target: "/mnt/pool/photos", source: "/dev/sdc1[/photos]" }] }] }), stderr: "" };
      if (binary.endsWith("zfs")) return { ok: false, stdout: "", stderr: "not installed" };
      if (binary.endsWith("btrfs")) return { ok: true, stdout: "", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    };
    const result = await fsSnapshotsInspect({}, { run, files: { access: async () => undefined } });   // btrfs tool counts as present
    const targets = JSON.stringify(result);
    expect(targets).toContain("/mnt/pool/photos");
  });
});
