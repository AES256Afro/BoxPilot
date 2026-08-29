import { describe, expect, it, vi } from "vitest";
import { assertNotProtected, parseManagedFstab, removeManagedEntry, storageFormat, storageLvmExtend, storageLvmSnapshotCreate, storageLvmSnapshotDelete, storageLvmSnapshotRollback, storageMount, storageUnmount, swapFileSet } from "./storage.mjs";

const BASE_FSTAB = "# /etc/fstab\nUUID=root-uuid / ext4 defaults 0 1\n";

function fakeFiles(fstab = BASE_FSTAB) {
  const state = { fstab };
  return {
    state,
    readFile: vi.fn(async (path) => { if (path === "/etc/fstab") return state.fstab; throw new Error("ENOENT"); }),
    writeFile: vi.fn(async (path, content) => { if (path === "/etc/fstab") state.fstab = content; }),
    mkdir: vi.fn(async () => {}),
  };
}

function fakeRun({ uuidDevice = "/dev/sdb1", mountFails = false, mountNoStick = false, detectedType = null, verifyFails = false, mountedAt = {}, lsblkNodes = null } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("blkid") && args[0] === "-U") return uuidDevice ? { ok: true, stdout: uuidDevice, stderr: "" } : { ok: false, stdout: "", stderr: "" };
    if (binary.endsWith("blkid") && args.includes("TYPE")) return { ok: true, stdout: detectedType ?? "", stderr: "" };
    if (binary.endsWith("blkid")) return { ok: true, stdout: "new-uuid-1234", stderr: "" };
    if (binary.endsWith("findmnt") && args[0] === "--verify") return verifyFails ? { ok: false, stdout: "", stderr: "/etc/fstab parse error" } : { ok: true, stdout: "", stderr: "" };
    if (binary.endsWith("findmnt")) { const target = args.at(-1); return mountedAt[target] ? { ok: true, stdout: mountedAt[target], stderr: "" } : { ok: false, stdout: "", stderr: "" }; }
    if (binary.endsWith("mount") && !binary.endsWith("umount")) { if (mountFails) return { ok: false, stdout: "", stderr: "wrong fs type" }; if (!mountNoStick) mountedAt[args[0]] = "mounted"; return { ok: true, stdout: "", stderr: "" }; }
    if (binary.endsWith("umount")) { delete mountedAt[args[0]]; return { ok: true, stdout: "", stderr: "" }; }
    // Without explicit nodes, lsblk describes the asked-for device as a plain, unmounted partition.
    if (binary.endsWith("lsblk")) return { ok: true, stdout: JSON.stringify({ blockdevices: lsblkNodes ?? [{ path: args.at(-1), type: "part", fstype: "ext4", ro: false, mountpoints: [null] }] }), stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}

describe("root storage tasks", () => {
  it("pairs marker lines with their entries and removes them cleanly", () => {
    const content = `${BASE_FSTAB}# boxpilot:media\nUUID=x /mnt/media ext4 defaults,nofail 0 2\n`;
    expect(parseManagedFstab(content)).toEqual([{ name: "media", line: "UUID=x /mnt/media ext4 defaults,nofail 0 2", markerIndex: 2 }]);
    expect(removeManagedEntry(content, "media")).toBe(BASE_FSTAB);
    expect(removeManagedEntry(content, "other")).toBeNull();
  });

  it("mounts by UUID with a verified nofail fstab entry", async () => {
    const files = fakeFiles();
    const run = fakeRun();
    const result = await storageMount({ uuid: "abcd-1234", name: "media", fstype: "ext4" }, { run, files });
    expect(result).toMatchObject({ mounted: true, mountpoint: "/mnt/media", persistent: true });
    expect(files.state.fstab).toContain("# boxpilot:media\nUUID=abcd-1234 /mnt/media ext4 defaults,nofail 0 2");
    expect(run).toHaveBeenCalledWith(expect.stringContaining("findmnt"), ["--verify"], expect.anything());
    expect(run).toHaveBeenCalledWith(expect.stringContaining("systemctl"), ["daemon-reload"], expect.anything());
  });

  it("restores fstab when verification or the mount itself fails", async () => {
    const verifyFiles = fakeFiles();
    await expect(storageMount({ uuid: "abcd-1234", name: "media" }, { run: fakeRun({ verifyFails: true }), files: verifyFiles })).rejects.toThrow("fstab was restored");
    expect(verifyFiles.state.fstab).toBe(BASE_FSTAB);

    const mountFiles = fakeFiles();
    await expect(storageMount({ uuid: "abcd-1234", name: "media" }, { run: fakeRun({ mountFails: true }), files: mountFiles })).rejects.toThrow("fstab entry was removed");
    expect(mountFiles.state.fstab).toBe(BASE_FSTAB);

    await expect(storageMount({ uuid: "abcd-1234", name: "media" }, { run: fakeRun({ uuidDevice: null }), files: fakeFiles() })).rejects.toThrow("No filesystem with UUID");
    await expect(storageMount({ uuid: "abcd-1234", name: "Bad Name" }, { run: fakeRun(), files: fakeFiles() })).rejects.toThrow("Name");
  });

  it("rolls the entry back when mount exits 0 but nothing actually mounted", async () => {
    // A `nofail` entry mount can succeed-and-skip, and an unclean exFAT/NTFS volume can leave nothing
    // mounted: trusting the exit code once left a live fstab entry that blocked every retry.
    const files = fakeFiles();
    await expect(storageMount({ uuid: "0023-7927", name: "the-dump", fstype: "exfat" }, { run: fakeRun({ mountNoStick: true }), files })).rejects.toThrow("nothing is mounted there");
    expect(files.state.fstab).toBe(BASE_FSTAB);
  });

  it("gives a removable exFAT filesystem passno 0, and pins an auto-detected type into the entry", async () => {
    const exfatFiles = fakeFiles();
    await storageMount({ uuid: "0023-7927", name: "dump", fstype: "exfat" }, { run: fakeRun(), files: exfatFiles });
    expect(exfatFiles.state.fstab).toContain("# boxpilot:dump\nUUID=0023-7927 /mnt/dump exfat defaults,nofail 0 0");

    const autoFiles = fakeFiles();
    await storageMount({ uuid: "aaaa-bbbb", name: "photos" }, { run: fakeRun({ detectedType: "exfat" }), files: autoFiles });
    expect(autoFiles.state.fstab).toContain("UUID=aaaa-bbbb /mnt/photos exfat defaults,nofail 0 0");
  });

  it("hands a permission-less drive to the apps user via uid/gid mount options", async () => {
    const files = fakeFiles();
    const run = fakeRun();
    const result = await storageMount({ uuid: "0023-7927", name: "dump", fstype: "exfat", appWritable: true }, { run, files });
    expect(files.state.fstab).toContain("UUID=0023-7927 /mnt/dump exfat rw,nofail,uid=1000,gid=1000 0 0");
    expect(result.owner).toBe("1000:1000");
    // exFAT ownership is a mount option, so no chown is issued.
    expect(run).not.toHaveBeenCalledWith(expect.stringContaining("chown"), expect.anything(), expect.anything());
  });

  it("chowns the mountpoint of a Linux filesystem instead of touching its fstab options", async () => {
    const files = fakeFiles();
    const run = fakeRun();
    await storageMount({ uuid: "abcd-1234", name: "data", fstype: "ext4", appWritable: true }, { run, files });
    expect(files.state.fstab).toContain("UUID=abcd-1234 /mnt/data ext4 defaults,nofail 0 2");
    expect(run).toHaveBeenCalledWith(expect.stringContaining("chown"), ["1000:1000", "/mnt/data"], expect.anything());
  });

  it("ignores appWritable when the mount is read-only", async () => {
    const files = fakeFiles();
    await storageMount({ uuid: "0023-7927", name: "dump", fstype: "exfat", appWritable: true, readOnly: true }, { run: fakeRun(), files });
    expect(files.state.fstab).toContain("UUID=0023-7927 /mnt/dump exfat ro,nofail 0 0");
  });

  it("unmounts only BoxPilot-managed entries", async () => {
    const files = fakeFiles(`${BASE_FSTAB}# boxpilot:media\nUUID=x /mnt/media ext4 defaults,nofail 0 2\n`);
    const run = fakeRun({ mountedAt: { "/mnt/media": "/dev/sdb1" } });
    await expect(storageUnmount({ name: "media" }, { run, files })).resolves.toMatchObject({ unmounted: true, directoryKept: true });
    expect(files.state.fstab).toBe(BASE_FSTAB);
    await expect(storageUnmount({ name: "media" }, { run, files })).rejects.toThrow("not a BoxPilot-managed mount");
  });

  it("formats only unmounted writable devices", async () => {
    const busy = fakeRun({ lsblkNodes: [{ path: "/dev/sdb", type: "disk", ro: false, mountpoints: [null], children: [{ path: "/dev/sdb1", type: "part", ro: false, mountpoints: ["/mnt/media"] }] }] });
    await expect(storageFormat({ device: "/dev/sdb" }, { run: busy })).rejects.toThrow("in use");

    const readOnly = fakeRun({ lsblkNodes: [{ path: "/dev/sr0", type: "rom", ro: true, mountpoints: [null] }] });
    await expect(storageFormat({ device: "/dev/sr0" }, { run: readOnly })).rejects.toThrow("read-only");

    const clean = fakeRun({ lsblkNodes: [{ path: "/dev/sdb", type: "disk", ro: false, mountpoints: [null] }] });
    await expect(storageFormat({ device: "/dev/sdb", label: "data" }, { run: clean })).resolves.toMatchObject({ formatted: true, fstype: "ext4", uuid: "new-uuid-1234" });
    expect(clean).toHaveBeenCalledWith(expect.stringContaining("wipefs"), ["-a", "/dev/sdb"], expect.anything());
    expect(clean).toHaveBeenCalledWith(expect.stringContaining("mkfs.ext4"), ["-F", "-L", "data", "/dev/sdb"], expect.anything());
    await expect(storageFormat({ device: "/dev/sdb; rm -rf /" }, { run: clean })).rejects.toThrow("Device path");
  });

  it("never formats or mounts the system disk or an LVM physical volume", async () => {
    const systemDisk = [{ path: "/dev/nvme0n1", type: "disk", fstype: null, ro: false, mountpoints: [null], children: [
      { path: "/dev/nvme0n1p2", type: "part", fstype: "ext4", ro: false, mountpoints: ["/boot"] },
      { path: "/dev/nvme0n1p3", type: "part", fstype: "LVM2_member", ro: false, mountpoints: [null], children: [{ path: "/dev/mapper/ubuntu--vg-ubuntu--lv", type: "lvm", fstype: "ext4", ro: false, mountpoints: ["/"] }] },
    ] }];
    const run = fakeRun({ lsblkNodes: systemDisk });
    await expect(storageFormat({ device: "/dev/nvme0n1" }, { run })).rejects.toThrow("system disk");
    expect(run.mock.calls.some(([binary]) => binary.includes("wipefs"))).toBe(false);

    const pvOnly = fakeRun({ lsblkNodes: [{ path: "/dev/sdb1", type: "part", fstype: "LVM2_member", ro: false, mountpoints: [null], children: [{ path: "/dev/mapper/data-media", type: "lvm", fstype: "ext4", ro: false, mountpoints: [null] }] }] });
    await expect(storageFormat({ device: "/dev/sdb1" }, { run: pvOnly })).rejects.toThrow("LVM physical volume holding /dev/mapper/data-media");
    const luks = fakeRun({ lsblkNodes: [{ path: "/dev/sdc1", type: "part", fstype: "crypto_LUKS", ro: false, mountpoints: [null] }] });
    await expect(storageFormat({ device: "/dev/sdc1" }, { run: luks })).rejects.toThrow("encrypted container");

    // Mount by UUID goes through the same guard (blkid can resolve a PV UUID).
    const files = fakeFiles();
    const mountPv = fakeRun({ uuidDevice: "/dev/sdb1", lsblkNodes: [{ path: "/dev/sdb1", type: "part", fstype: "LVM2_member", ro: false, mountpoints: [null] }] });
    await expect(storageMount({ uuid: "abcd-1234", name: "oops" }, { run: mountPv, files })).rejects.toThrow("LVM physical volume");
    expect(files.state.fstab).toBe(BASE_FSTAB);
    expect(() => assertNotProtected("/dev/sdd", [{ path: "/dev/sdd", type: "disk", fstype: null, mountpoints: [] }])).not.toThrow();
  });

  it("grows a mounted logical volume into the free space of its group, keeping a snapshot reserve", async () => {
    const lv = [{ path: "/dev/mapper/ubuntu--vg-ubuntu--lv", type: "lvm", fstype: "ext4", ro: false, mountpoints: ["/"] }];
    const GiB = 1024 ** 3;
    let grown = false;
    const run = vi.fn(async (binary) => {
      if (binary.endsWith("lsblk")) return { ok: true, stdout: JSON.stringify({ blockdevices: lv }), stderr: "" };
      if (binary.endsWith("findmnt")) return { ok: true, stdout: grown ? "1000 900" : "100 20", stderr: "" };
      if (binary.endsWith("/lvs")) return { ok: true, stdout: "  ubuntu-vg ubuntu-lv\n", stderr: "" };
      if (binary.endsWith("/vgs")) return { ok: true, stdout: `  ${850 * GiB}\n`, stderr: "" };
      if (binary.endsWith("lvextend")) { grown = true; return { ok: true, stdout: "Size of logical volume changed", stderr: "" }; }
      return { ok: true, stdout: "", stderr: "" };
    });
    const result = await storageLvmExtend({ path: "/dev/mapper/ubuntu--vg-ubuntu--lv" }, { run });
    expect(result).toEqual({ extended: true, path: "/dev/mapper/ubuntu--vg-ubuntu--lv", mountpoint: "/", before: { sizeBytes: 100, availableBytes: 20 }, after: { sizeBytes: 1000, availableBytes: 900 } });
    expect(run).toHaveBeenCalledWith("/usr/sbin/lvextend", ["-r", "-L", `+${(850 - 32) * GiB}B`, "/dev/mapper/ubuntu--vg-ubuntu--lv"], expect.anything());
    await storageLvmExtend({ path: "/dev/mapper/ubuntu--vg-ubuntu--lv", reserveGiB: 0 }, { run });
    expect(run).toHaveBeenCalledWith("/usr/sbin/lvextend", ["-r", "-l", "+100%FREE", "/dev/mapper/ubuntu--vg-ubuntu--lv"], expect.anything());

    const tight = vi.fn(async (binary) => (binary.endsWith("lsblk") ? { ok: true, stdout: JSON.stringify({ blockdevices: lv }), stderr: "" } : binary.endsWith("/lvs") ? { ok: true, stdout: "  ubuntu-vg ubuntu-lv\n", stderr: "" } : binary.endsWith("/vgs") ? { ok: true, stdout: `  ${20 * GiB}\n`, stderr: "" } : { ok: true, stdout: "100 20", stderr: "" }));
    await expect(storageLvmExtend({ path: "/dev/mapper/ubuntu--vg-ubuntu--lv" }, { run: tight })).resolves.toMatchObject({ extended: false, reason: expect.stringContaining("kept for snapshots") });
    // Without a reserve, lvextend reporting "matches existing size" is not an error.
    const full = vi.fn(async (binary) => (binary.endsWith("lsblk") ? { ok: true, stdout: JSON.stringify({ blockdevices: lv }), stderr: "" } : binary.endsWith("lvextend") ? { ok: false, stdout: "", stderr: "New size (25599 extents) matches existing size (25599 extents)." } : { ok: true, stdout: "100 20", stderr: "" }));
    await expect(storageLvmExtend({ path: "/dev/mapper/ubuntu--vg-ubuntu--lv", reserveGiB: 0 }, { run: full })).resolves.toMatchObject({ extended: false, reason: expect.stringContaining("no free space") });

    await expect(storageLvmExtend({ path: "/dev/sda1" }, { run })).rejects.toThrow("path is invalid");
    const swapLv = vi.fn(async () => ({ ok: true, stdout: JSON.stringify({ blockdevices: [{ path: "/dev/mapper/vg-swap", type: "lvm", fstype: "swap", mountpoints: [null] }] }), stderr: "" }));
    await expect(storageLvmExtend({ path: "/dev/mapper/vg-swap" }, { run: swapLv })).rejects.toThrow("only ext4 and xfs");
  });

  it("creates, removes, and rolls back to BoxPilot snapshots with prefixed names only", async () => {
    const GiB = 1024 ** 3;
    const run = vi.fn(async (binary) => (binary.endsWith("/lvs") ? { ok: true, stdout: "  ubuntu-vg ubuntu-lv\n", stderr: "" } : binary.endsWith("/vgs") ? { ok: true, stdout: `  ${100 * GiB}\n`, stderr: "" } : { ok: true, stdout: "Logical volume created", stderr: "" }));
    const created = await storageLvmSnapshotCreate({ path: "/dev/mapper/ubuntu--vg-ubuntu--lv", sizeGiB: 10, suffix: "before-upgrade" }, { run, now: () => new Date("2026-08-21T20:05:00Z") });
    expect(created).toEqual({ created: true, name: "boxpilot-snap-20260821-2005-before-upgrade", path: "/dev/mapper/ubuntu--vg-boxpilot--snap--20260821--2005--before--upgrade", origin: "/dev/mapper/ubuntu--vg-ubuntu--lv", volumeGroup: "ubuntu-vg", sizeGiB: 10, createdAt: "2026-08-21T20:05:00.000Z" });
    expect(run).toHaveBeenCalledWith("/usr/sbin/lvcreate", ["-s", "-L", "10G", "-n", "boxpilot-snap-20260821-2005-before-upgrade", "/dev/mapper/ubuntu--vg-ubuntu--lv"], expect.anything());
    await expect(storageLvmSnapshotCreate({ path: "/dev/mapper/ubuntu--vg-ubuntu--lv", sizeGiB: 500 }, { run })).rejects.toThrow("only 100.0 GiB free");
    await expect(storageLvmSnapshotDelete({ path: "/dev/mapper/ubuntu--vg-ubuntu--lv" }, { run })).rejects.toThrow("Only BoxPilot snapshots");
    await expect(storageLvmSnapshotDelete({ path: created.path }, { run })).resolves.toEqual({ removed: true, path: created.path });
    expect(run).toHaveBeenCalledWith("/usr/sbin/lvremove", ["-f", created.path], expect.anything());
    await expect(storageLvmSnapshotRollback({ path: created.path }, { run })).resolves.toMatchObject({ rollbackScheduled: true, rebootRequired: true });
    expect(run).toHaveBeenCalledWith("/usr/sbin/lvconvert", ["--merge", created.path], expect.anything());
    expect(() => assertNotProtected(created.path, [])).toThrow("LVM snapshot");
    expect(() => assertNotProtected("/dev/mapper/ubuntu--vg-ubuntu--lv-real", [])).toThrow("LVM snapshot");
  });

  it("creates and removes the managed swap file", async () => {
    const files = fakeFiles();
    const run = fakeRun();
    await expect(swapFileSet({ sizeGiB: 4 }, { run, files })).resolves.toMatchObject({ created: true, path: "/swap.boxpilot", sizeGiB: 4 });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("fallocate"), ["-l", "4G", "/swap.boxpilot"], expect.anything());
    expect(files.state.fstab).toContain("# boxpilot:swap\n/swap.boxpilot none swap sw,nofail 0 0");
    await expect(swapFileSet({ sizeGiB: 4 }, { run, files })).rejects.toThrow("already exists");
    await expect(swapFileSet({ remove: true }, { run, files })).resolves.toMatchObject({ removed: true });
    expect(files.state.fstab).toBe(BASE_FSTAB);
    await expect(swapFileSet({ sizeGiB: 999 }, { run, files })).rejects.toThrow("between 1 and 64");
  });
});
