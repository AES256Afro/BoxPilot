import { describe, expect, it, vi } from "vitest";
import { assertNotProtected, parseManagedFstab, parseSmbstatusShares, processesUsing, removeManagedEntry, sharesOnMount, storageClearMark, storageFormat, storageLvmExtend, storageLvmSnapshotCreate, storageLvmSnapshotDelete, storageLvmSnapshotRollback, storageMount, storageUnmount, swapFileSet, storageRemount, storageCheck } from "./storage.mjs";

const BASE_FSTAB = "# /etc/fstab\nUUID=root-uuid / ext4 defaults 0 1\n";
// Every drive entry is ordered around Docker (M26): mounted before it starts, unmounted after it stops.
const ORDER = "x-systemd.before=docker.service,x-systemd.device-timeout=30s";

function fakeFiles(fstab = BASE_FSTAB) {
  const state = { fstab };
  return {
    state,
    readFile: vi.fn(async (path) => { if (path === "/etc/fstab") return state.fstab; throw new Error("ENOENT"); }),
    writeFile: vi.fn(async (path, content) => { if (path === "/etc/fstab") state.fstab = content; }),
    mkdir: vi.fn(async () => {}),
  };
}

/**
 * PID 1's mount table as mount-agreement.mjs lists it (findmnt --task 1 -rn), with /mnt/the-dump in
 * it while `device` is mounted there. The check's pipeline proves the drive is back from this table
 * before it starts an app again.
 */
const HOST_TABLE = "TARGET,FSTYPE,MAJ:MIN,OPTIONS,SOURCE";
const hostTable = (device, fstype = "exfat") => ({ ok: true, stdout: ["/ ext4 8:1 rw,relatime /dev/mapper/vg-root", ...(device ? [`/mnt/the-dump ${fstype} 8:2 rw,relatime ${device}`] : [])].join("\n"), stderr: "" });

function fakeRun({ uuidDevice = "/dev/sdb1", mountFails = false, mountNoStick = false, detectedType = null, verifyFails = false, mountedAt = {}, lsblkNodes = null } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("blkid") && args[0] === "-U") return uuidDevice ? { ok: true, stdout: uuidDevice, stderr: "" } : { ok: false, stdout: "", stderr: "" };
    if (binary.endsWith("blkid") && args.includes("TYPE")) return { ok: true, stdout: detectedType ?? "", stderr: "" };
    if (binary.endsWith("blkid")) return { ok: true, stdout: "new-uuid-1234", stderr: "" };
    if (binary.endsWith("findmnt") && args[0] === "--verify") return verifyFails ? { ok: false, stdout: "", stderr: "/etc/fstab parse error" } : { ok: true, stdout: "", stderr: "" };
    if (binary.endsWith("findmnt")) { const target = args.at(-1); return mountedAt[target] ? { ok: true, stdout: mountedAt[target], stderr: "" } : { ok: false, stdout: "", stderr: "" }; }
    if (binary.endsWith("mount") && !binary.endsWith("umount")) { if (mountFails) return { ok: false, stdout: "", stderr: "wrong fs type" }; if (!mountNoStick) mountedAt[args.at(-1)] = "mounted"; return { ok: true, stdout: "", stderr: "" }; }
    if (binary.endsWith("umount")) { delete mountedAt[args.at(-1)]; return { ok: true, stdout: "", stderr: "" }; }
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
    expect(files.state.fstab).toContain(`# boxpilot:media\nUUID=abcd-1234 /mnt/media ext4 defaults,nofail,${ORDER} 0 2`);
    expect(run).toHaveBeenCalledWith(expect.stringContaining("findmnt"), ["--verify"], expect.anything());
    expect(run).toHaveBeenCalledWith(expect.stringContaining("systemctl"), ["daemon-reload"], expect.anything());
    // In PID 1's mount namespace: the runner's own (PrivateTmp=) never reaches the host.
    expect(run).toHaveBeenCalledWith("/usr/bin/mount", ["-N", "/proc/1/ns/mnt", "/mnt/media"], expect.anything());
  });

  it("mounts and unmounts in the host's mount namespace, never only the runner's", async () => {
    const run = fakeRun({ mountedAt: { "/mnt/media": "mounted" } });
    await storageUnmount({ name: "media" }, { run, files: fakeFiles(`${BASE_FSTAB}# boxpilot:media\nUUID=x /mnt/media ext4 defaults,nofail 0 2\n`) });
    const mountCalls = run.mock.calls.filter(([binary]) => /\/u?mount$/.test(binary));
    expect(mountCalls.length).toBeGreaterThan(0);
    for (const [, args] of mountCalls) expect(args.slice(0, 2)).toEqual(["-N", "/proc/1/ns/mnt"]);
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
    expect(exfatFiles.state.fstab).toContain(`# boxpilot:dump\nUUID=0023-7927 /mnt/dump exfat defaults,nofail,${ORDER} 0 0`);

    const autoFiles = fakeFiles();
    await storageMount({ uuid: "aaaa-bbbb", name: "photos" }, { run: fakeRun({ detectedType: "exfat" }), files: autoFiles });
    expect(autoFiles.state.fstab).toContain(`UUID=aaaa-bbbb /mnt/photos exfat defaults,nofail,${ORDER} 0 0`);
  });

  it("hands a permission-less drive to the apps user via uid/gid mount options", async () => {
    const files = fakeFiles();
    const run = fakeRun();
    const result = await storageMount({ uuid: "0023-7927", name: "dump", fstype: "exfat", appWritable: true }, { run, files });
    expect(files.state.fstab).toContain(`UUID=0023-7927 /mnt/dump exfat rw,nofail,uid=1000,gid=1000,${ORDER} 0 0`);
    expect(result.owner).toBe("1000:1000");
    // exFAT ownership is a mount option, so no chown is issued.
    expect(run).not.toHaveBeenCalledWith(expect.stringContaining("chown"), expect.anything(), expect.anything());
  });

  it("chowns the mountpoint of a Linux filesystem instead of touching its fstab options", async () => {
    const files = fakeFiles();
    const run = fakeRun();
    await storageMount({ uuid: "abcd-1234", name: "data", fstype: "ext4", appWritable: true }, { run, files });
    expect(files.state.fstab).toContain(`UUID=abcd-1234 /mnt/data ext4 defaults,nofail,${ORDER} 0 2`);
    expect(run).toHaveBeenCalledWith(expect.stringContaining("chown"), ["1000:1000", "/mnt/data"], expect.anything());
  });

  it("ignores appWritable when the mount is read-only", async () => {
    const files = fakeFiles();
    await storageMount({ uuid: "0023-7927", name: "dump", fstype: "exfat", appWritable: true, readOnly: true }, { run: fakeRun(), files });
    expect(files.state.fstab).toContain(`UUID=0023-7927 /mnt/dump exfat ro,nofail,${ORDER} 0 0`);
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
    await expect(storageLvmSnapshotRollback({ path: created.path }, { run })).resolves.toMatchObject({ rollbackScheduled: true });
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

describe("reconnecting a drive through the busy pipeline (M35)", () => {
  // The real events: a USB drive that dropped off at 06:46 and came back two seconds later as sdb,
  // with /mnt/the-dump still mounted from the sda2 that no longer existed; and the reconnect the
  // owner then tried four times, each refused with "target is busy" because Plex had the folder
  // bound and a PC had the Media share mapped.
  const fstab = "# boxpilot:the-dump\nUUID=0023-7927 /mnt/the-dump exfat defaults,nofail,uid=1000,gid=1000 0 0\n";
  const smbConf = "# Managed by BoxPilot\n[global]\n   workgroup = WORKGROUP\n[Media]\n   path = /mnt/the-dump/media\n[Documents]\n   path = /srv/documents\n";

  function rig({ source = "/dev/sda2", deadBefore = false, readsAfter = true, holders = "none", present = true, readOnlyAfter = false, mountFails = false, restartFails = null } = {}) {
    const calls = [];
    const state = { mounted: source, readOnly: false, closed: false, phase: "before" };
    const run = vi.fn(async (binary, args) => {
      const name = binary.split("/").pop(); calls.push(`${name} ${args.join(" ")}`);
      if (name === "findmnt") return state.mounted ? { ok: true, stdout: `${state.mounted} exfat 8:2 ${state.readOnly ? "ro" : "rw"},relatime,uid=1000\n`, stderr: "" } : { ok: false, stdout: "", stderr: "" };
      if (name === "blkid") return present ? { ok: true, stdout: "/dev/sdb2\n", stderr: "" } : { ok: false, stdout: "", stderr: "" };
      if (name === "docker" && args[0] === "ps") return { ok: true, stdout: "aaa\nbbb\nccc\n", stderr: "" };
      if (name === "docker" && args[0] === "inspect") return { ok: true, stdout: "/bp-plex\t/mnt/the-dump\t/srv/plex\t\n/bp-qbittorrent\t/mnt/the-dump/torrents\t\n/bp-backup\t/mnt/the-dump-backup\t\n", stderr: "" };
      if (name === "docker" && args[0] === "start") return restartFails === args[1] ? { ok: false, stdout: "", stderr: "Error response from daemon: cannot start" } : { ok: true, stdout: "", stderr: "" };
      if (name === "smbstatus") return { ok: true, stdout: JSON.stringify({ tcons: { 1: { service: "Media", machine: "192.168.8.23" } } }), stderr: "" };
      if (name === "smbcontrol") { if (holders === "samba") state.closed = true; return { ok: true, stdout: "", stderr: "" }; }
      if (name === "umount") {
        const lazy = args.includes("-l");
        const held = holders === "apps-only" ? false : holders === "samba" ? !state.closed : holders === "forever";
        if (!lazy && held) return { ok: false, stdout: "", stderr: "umount: /mnt/the-dump: target is busy." };
        state.mounted = null; return { ok: true, stdout: "", stderr: "" };
      }
      if (name === "mount") {
        if (mountFails) return { ok: false, stdout: "", stderr: "mount: /mnt/the-dump: can't read superblock on /dev/sdb2." };
        state.mounted = "/dev/sdb2"; state.readOnly = readOnlyAfter; state.phase = "after"; return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const files = { readFile: async (file) => (file === "/etc/samba/smb.conf" ? smbConf : fstab), readable: async () => (state.phase === "before" ? !deadBefore : readsAfter) };
    const processes = { proc: "/proc", fs: { readdir: async (dir) => (dir === "/proc" ? ["4242"] : []), stat: async (target) => ({ dev: target.endsWith("/cwd") ? 8 * 256 + 2 : 1 }) } };
    return { run, calls, files, processes, sleep: async () => {} };
  }
  const reconnect = (fakes) => storageRemount({ name: "the-dump" }, { run: fakes.run, files: fakes.files, sleep: fakes.sleep, processes: fakes.processes, log: fakes.log });

  it("stops the apps holding the drive, unmounts it on the host, mounts it again and starts them", async () => {
    const fakes = rig({ holders: "apps-only" });
    const result = await reconnect(fakes);
    expect(result).toMatchObject({ remounted: true, source: "/dev/sdb2", previousSource: "/dev/sda2", deviceChanged: true, stopped: ["bp-plex", "bp-qbittorrent"], restarted: ["bp-plex", "bp-qbittorrent"], restartFailed: [] });
    const { calls } = fakes;
    expect(calls.indexOf("docker stop bp-plex")).toBeLessThan(calls.indexOf("umount -N /proc/1/ns/mnt /mnt/the-dump"));
    expect(calls.indexOf("umount -N /proc/1/ns/mnt /mnt/the-dump")).toBeLessThan(calls.indexOf("mount -N /proc/1/ns/mnt /mnt/the-dump"));
    expect(calls.indexOf("mount -N /proc/1/ns/mnt /mnt/the-dump")).toBeLessThan(calls.indexOf("docker start bp-plex"));
    expect(calls).not.toContain("docker stop bp-backup");   // /mnt/the-dump-backup is a prefix, not a parent
    // Everything about the mount is asked of PID 1's namespace, never the runner's own.
    expect(calls.filter((call) => call.startsWith("findmnt")).every((call) => call.includes("--task 1"))).toBe(true);
  });

  it("gets file-sharing clients off the drive when they are what holds it, and says whom it disconnected", async () => {
    const fakes = rig({ holders: "samba" });
    fakes.log = vi.fn();
    const result = await reconnect(fakes);
    expect(result).toMatchObject({ remounted: true, sharingClosedFor: ["192.168.8.23"], shares: ["Media"] });
    expect(fakes.calls).toContain("smbcontrol smbd close-share Media");
    expect(fakes.calls).not.toContain("smbcontrol smbd close-share Documents");
    expect(fakes.log).toHaveBeenCalledWith(expect.stringContaining("Closed file-sharing connections from 192.168.8.23 to Media"), "stdout");
  });

  it("detaches a dead mount lazily when nothing lets go of it, then mounts from fstab", async () => {
    const fakes = rig({ deadBefore: true, holders: "forever" });
    const result = await reconnect(fakes);
    expect(result).toMatchObject({ remounted: true, detachedLazily: true, restarted: ["bp-plex", "bp-qbittorrent"] });
    expect(fakes.calls).toContain("umount -N /proc/1/ns/mnt -l /mnt/the-dump");
  });

  it("reconnects a drive that came back under the SAME name but a dead mount", async () => {
    // A USB drive that drops and returns is usually handed the same kernel name, so the node exists
    // again while the old mount is still broken. The mount not reading is what proves it dead.
    const fakes = rig({ source: "/dev/sdb2", deadBefore: true, holders: "forever" });
    expect((await reconnect(fakes)).remounted).toBe(true);
    expect(fakes.calls).toContain("umount -N /proc/1/ns/mnt -l /mnt/the-dump");
  });

  it("leaves a healthy mount something else holds as it was, starts the apps again on it, and names the holder", async () => {
    // Detaching a live mount lazily splits the writers: whoever holds it writes where no path reaches.
    const fakes = rig({ holders: "forever" });
    await expect(reconnect(fakes)).rejects.toThrow(/still in use by .* \(4242\), so it was left mounted as it was/);
    expect(fakes.calls.some((call) => call.includes("-l"))).toBe(false);
    expect(fakes.calls).toContain("docker start bp-plex");
    expect(fakes.calls.some((call) => call.startsWith("mount "))).toBe(false);
  });

  it("refuses before stopping or unmounting anything when the drive is not connected", async () => {
    const fakes = rig({ present: false });
    await expect(reconnect(fakes)).rejects.toThrow("is not connected to this server right now, so nothing was stopped or unmounted");
    expect(fakes.calls.some((call) => call.startsWith("docker stop") || call.startsWith("umount") || call.startsWith("mount "))).toBe(false);
  });

  it("says it is still read-only when the fresh mount is, with the apps started again to read it", async () => {
    const fakes = rig({ holders: "apps-only", readOnlyAfter: true });
    await expect(reconnect(fakes)).rejects.toThrow("still read-only: the kernel found errors on the drive while mounting it");
    expect(fakes.calls).toContain("docker start bp-plex");
  });

  it("leaves the apps stopped when the drive does not mount again, so nothing lands in the empty folder", async () => {
    const fakes = rig({ holders: "apps-only", mountFails: true });
    await expect(reconnect(fakes)).rejects.toThrow(/Could not mount \/mnt\/the-dump again: .*bp-plex and bp-qbittorrent were stopped and left stopped/);
    expect(fakes.calls.some((call) => call.startsWith("docker start"))).toBe(false);
  });

  it("does not call a mount that came back but does not read a success", async () => {
    // findmnt listing it is the same evidence that lied during the incident.
    const fakes = rig({ holders: "apps-only", readsAfter: false });
    await expect(reconnect(fakes)).rejects.toThrow("does not read");
    expect(fakes.calls.some((call) => call.startsWith("docker start"))).toBe(false);
  });

  it("mounts one that is not mounted at all, and restarts the apps bound to the empty folder under it", async () => {
    const fakes = rig({ source: null, holders: "apps-only" });
    const result = await reconnect(fakes);
    expect(result).toMatchObject({ remounted: true, previousSource: null, restarted: ["bp-plex", "bp-qbittorrent"] });
    expect(fakes.calls.some((call) => call.startsWith("umount"))).toBe(false);
  });

  it("reports an app that would not start again rather than failing the reconnect", async () => {
    const fakes = rig({ holders: "apps-only", restartFails: "bp-qbittorrent" });
    const result = await reconnect(fakes);
    expect(result).toMatchObject({ remounted: true, restarted: ["bp-plex"], restartFailed: ["bp-qbittorrent"] });
  });

  it("refuses an entry whose fstab line is not a drive mounted at that path", async () => {
    // `# boxpilot:swap` sits above `/swap.boxpilot none swap sw,nofail 0 0`. The marker name passes
    // the pattern and the membership check, but the entry has nothing to do with /mnt/swap.
    const withSwap = "# boxpilot:swap\n/swap.boxpilot none swap sw,nofail 0 0\n";
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    await expect(storageRemount({ name: "swap" }, { run, files: { readFile: async () => withSwap, readable: async () => true } })).rejects.toThrow("swap is the swap file, not a mount");
    expect(run.mock.calls.some(([binary]) => binary.endsWith("umount"))).toBe(false);
  });

  it("refuses a mount BoxPilot does not manage, and an invalid name", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    await expect(storageRemount({ name: "not-ours" }, { run, files: { readFile: async () => fstab, readable: async () => false } })).rejects.toThrow("not a BoxPilot-managed mount");
    await expect(storageRemount({ name: "../etc" }, { run, files: { readFile: async () => fstab, readable: async () => false } })).rejects.toThrow("Name is invalid");
    expect(run.mock.calls.some(([binary]) => binary.endsWith("umount"))).toBe(false);
  });
});


describe("mount names that belong to other operations", () => {
  const fstab = "UUID=1 / ext4 defaults 0 1\n# boxpilot:share-nas\n//nas/public /mnt/share-nas cifs credentials=/etc/boxpilot/secrets/share-nas.cred,nofail 0 0\n# boxpilot:swap\n/swap.boxpilot none swap sw 0 0\n";
  const files = { readFile: async () => fstab, writeFile: vi.fn(async () => {}), readable: async () => true };
  const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));

  it("refuses to unmount a share by its marker name, so the share's fstab line survives", async () => {
    // It found nothing mounted at /mnt/share-nas, skipped the umount, and deleted the entry anyway.
    await expect(storageUnmount({ name: "share-nas" }, { run, files })).rejects.toThrow(/network share, not a drive; reconnect it with share.reconnect/);
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  it("refuses to create a mount under a reserved name, so the collision cannot be made in the first place", async () => {
    // Unmount and remount refuse these names; creating one would have produced a marker that
    // swapFileSet and shareUnmount then act on as their own.
    for (const name of ["swap", "share-nas"]) {
      await expect(storageMount({ uuid: "12345678-1234-1234-1234-123456789abc", name, fstype: "ext4" }, { run, files })).rejects.toThrow(/swap file|network share/);
    }
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  it("refuses to treat the swap file as a mount", async () => {
    await expect(storageUnmount({ name: "swap" }, { run, files })).rejects.toThrow(/swap file/);
    await expect(storageRemount({ name: "swap" }, { run, files })).rejects.toThrow(/swap file/);
    expect(files.writeFile).not.toHaveBeenCalled();
  });
});



describe("checking a drive without changing it", () => {
  const fstab = "# boxpilot:the-dump\nUUID=0023-7927 /mnt/the-dump exfat defaults,nofail,uid=1000,gid=1000 0 0\n";
  // `comesBack` is what each mount after the check leaves at /mnt/the-dump: a device, or null for a
  // mount that exits 0 with nothing mounted (a nofail entry whose device udev is still re-reading).
  function checkFakes({ fstype = "exfat", exit = 0, umountBusy = false, markedDirty = false, comesBack = [] } = {}) {
    const calls = [];
    let mounted = "/dev/sda2";
    const run = vi.fn(async (binary, args, options) => {
      const name = binary.split("/").pop(); calls.push(`${name} ${args.join(" ")}`);
      if (name === "findmnt" && args.includes(HOST_TABLE)) return hostTable(mounted, fstype);
      if (name === "findmnt") return { ok: true, stdout: `/dev/sda2 ${fstype}\n`, stderr: "" };
      if (name === "docker" && args[0] === "ps") return { ok: true, stdout: "a\nb\n", stderr: "" };
      if (name === "docker" && args[0] === "inspect") return { ok: true, stdout: "/bp-plex\t/mnt/the-dump\t\n/bp-ntfy\t/srv/ntfy\t\n", stderr: "" };
      if (name === "umount") { if (umountBusy) return { ok: false, stdout: "", stderr: "target is busy" }; mounted = null; return { ok: true, stdout: "", stderr: "" }; }
      if (name === "mount") { mounted = comesBack.length ? comesBack.shift() : "/dev/sda2"; return { ok: true, stdout: "", stderr: "" }; }
      if (name === "fsck.exfat" || name === "e2fsck") { options?.onLine?.("checking directory tree", "stdout"); return { ok: exit === 0, code: exit, stdout: exit === 0 ? "the-dump: clean. directories 51, files 1200" : "ERROR: invalid cluster chain\n", stderr: "" }; }
      return { ok: true, stdout: "", stderr: "" };
    });
    const bootSector = vi.fn(async () => { const sector = Buffer.alloc(512); sector.write("EXFAT   ", 3, "latin1"); sector[106] = markedDirty ? 0x02 : 0; return sector; });
    return { run, calls, files: { readFile: async () => fstab, readable: async () => true, exists: async () => true, bootSector } };
  }

  it("says when a consistent exFAT drive still carries the kernel's not-properly-unmounted mark", async () => {
    // fsck.exfat -n calls such a volume clean, and Linux keeps the mark until a repairing check, so
    // the kernel warns at every mount while the check says clean. The check reads the mark itself,
    // with the drive unmounted, and says which it is.
    const dirty = checkFakes({ markedDirty: true });
    const log = vi.fn();
    const result = await storageCheck({ name: "the-dump" }, { run: dirty.run, files: dirty.files, log });
    expect(result).toMatchObject({ clean: true, markedDirty: true });
    expect(dirty.files.bootSector).toHaveBeenCalledWith("/dev/sda2");
    expect(dirty.calls.indexOf("umount -N /proc/1/ns/mnt /mnt/the-dump")).toBeGreaterThanOrEqual(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Linux keeps that mark until a repairing check clears it"), "stderr");
    const tidy = checkFakes();
    expect(await storageCheck({ name: "the-dump" }, { run: tidy.run, files: tidy.files })).toMatchObject({ clean: true, markedDirty: false });
    const ext = checkFakes({ fstype: "ext4" });
    expect(await storageCheck({ name: "the-dump" }, { run: ext.run, files: ext.files })).toMatchObject({ markedDirty: null });
    expect(ext.files.bootSector).not.toHaveBeenCalled();
  });

  it("refuses before stopping or unmounting anything when the checker is not installed", async () => {
    const { run, calls, files } = checkFakes();
    await expect(storageCheck({ name: "the-dump" }, { run, files: { ...files, exists: async (file) => file !== "/usr/sbin/fsck.exfat" } }))
      .rejects.toThrow("fsck.exfat is not installed, so /mnt/the-dump was not checked; nothing was stopped or unmounted");
    expect(calls.some((call) => call.startsWith("docker stop") || call.startsWith("umount"))).toBe(false);
  });

  it("pauses the containers, unmounts, runs the read-only checker, mounts, and starts them again", async () => {
    const { run, calls, files } = checkFakes();
    const result = await storageCheck({ name: "the-dump" }, { run, files });
    expect(result).toMatchObject({ checked: true, clean: true, fstype: "exfat", checker: "fsck.exfat", device: "/dev/sda2", restarted: ["bp-plex"] });
    expect(calls.indexOf("docker stop bp-plex")).toBeLessThan(calls.indexOf("umount -N /proc/1/ns/mnt /mnt/the-dump"));
    expect(calls).toContain("fsck.exfat -n /dev/sda2");   // -n: report, never repair
    expect(calls.indexOf("mount -N /proc/1/ns/mnt /mnt/the-dump")).toBeLessThan(calls.indexOf("docker start bp-plex"));
    expect(calls).not.toContain("docker stop bp-ntfy");    // not on that drive
  });

  it("reports problems as problems, with the checker's own words", async () => {
    const { run, files } = checkFakes({ exit: 1 });
    const result = await storageCheck({ name: "the-dump" }, { run, files });
    expect(result.clean).toBe(false);
    expect(result.summary).toContain("invalid cluster chain");
  });

  it("uses e2fsck for ext4 and refuses a filesystem it has no read-only checker for", async () => {
    const ext = checkFakes({ fstype: "ext4" });
    expect((await storageCheck({ name: "the-dump" }, { run: ext.run, files: ext.files })).checker).toBe("e2fsck");
    expect(ext.calls).toContain("e2fsck -fn /dev/sda2");
    const odd = checkFakes({ fstype: "ntfs" });
    await expect(storageCheck({ name: "the-dump" }, { run: odd.run, files: odd.files })).rejects.toThrow("no read-only checker for ntfs");
  });

  it("starts the containers again and says why when the drive cannot be unmounted", async () => {
    const { run, calls, files } = checkFakes({ umountBusy: true });
    await expect(storageCheck({ name: "the-dump" }, { run, files })).rejects.toThrow("still in use");
    expect(calls).toContain("docker start bp-plex");
    expect(calls.some((call) => call.startsWith("fsck.exfat"))).toBe(false);
  });

  it("starts the apps again only once PID 1's table has the drive back, and tries a mount that left nothing once more", async () => {
    // mount exits 0 having mounted nothing: a nofail entry whose device udev is still re-reading
    // after the checker. The apps used to be started regardless, on the empty folder.
    const { run, calls, files } = checkFakes({ comesBack: [null] });
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const result = await storageCheck({ name: "the-dump" }, { run, files, sleep, log });
    expect(result).toMatchObject({ clean: true, restarted: ["bp-plex"] });
    const mounts = calls.flatMap((call, index) => (call === "mount -N /proc/1/ns/mnt /mnt/the-dump" ? [index] : []));
    expect(mounts).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(calls.indexOf("docker start bp-plex")).toBeGreaterThan(mounts[1]);
    expect(log).toHaveBeenCalledWith("/mnt/the-dump is not mounted (nothing is mounted at /mnt/the-dump); trying once more", "stderr");
  });

  it("leaves the apps stopped, and says so, when the drive does not come back after the check", async () => {
    const { run, calls, files } = checkFakes({ comesBack: [null, null] });
    await expect(storageCheck({ name: "the-dump" }, { run, files, sleep: async () => {} }))
      .rejects.toThrow("/mnt/the-dump did not mount again after it was unmounted for the check: nothing is mounted at /mnt/the-dump. bp-plex was left stopped, so nothing writes into the empty folder under it; reconnect the drive from Repair, then start it again.");
    expect(calls.some((call) => call.startsWith("docker start"))).toBe(false);
  });

  it("does not start the apps on another device mounted where the drive was", async () => {
    const { run, calls, files } = checkFakes({ comesBack: ["/dev/sdc1"] });
    await expect(storageCheck({ name: "the-dump" }, { run, files, sleep: async () => {} })).rejects.toThrow("/mnt/the-dump is mounted from /dev/sdc1, not from /dev/sda2");
    expect(calls.filter((call) => call.startsWith("mount "))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("docker start"))).toBe(false);
  });
});

describe("a drive that is also a file share (M26)", () => {
  // The owner's server: a Windows PC had the share mapped as drive letters, Explorer held
  // directory handles on it, and smbd kept /mnt/the-dump busy. Windows reconnects within about a
  // second of close-share, so the unmount has to follow each close straight away.
  const fstab = "# boxpilot:the-dump\nUUID=0023-7927 /mnt/the-dump exfat defaults,nofail,uid=1000,gid=1000 0 0\n";
  const smbConf = "# Managed by BoxPilot\n[global]\n   workgroup = WORKGROUP\n[Media]\n   path = /mnt/the-dump/media\n[Everything]\n   path = /mnt\n[Documents]\n   path = /srv/documents\n[Dump2]\n   path = /mnt/the-dump-2\n";

  it("knows which shares reach into a drive: from a folder on it, or from one above it", () => {
    expect(sharesOnMount(smbConf, "/mnt/the-dump")).toEqual(["Media", "Everything"]);
    expect(sharesOnMount("", "/mnt/the-dump")).toEqual([]);
  });

  it("reads who is connected to what from smbstatus, as JSON or as its table", () => {
    const json = JSON.stringify({ timestamp: "x", tcons: { 7: { service: "Media", machine: "192.168.8.23", server_id: { pid: "5678" } }, 9: { service: "IPC$", machine: "192.168.8.23" } } });
    expect(parseSmbstatusShares(json)).toEqual([{ service: "Media", machine: "192.168.8.23" }, { service: "IPC$", machine: "192.168.8.23" }]);
    const table = [
      "Service      pid     Machine       Connected at                     Encryption   Signing",
      "---------------------------------------------------------------------------------------------",
      "Media        5678    192.168.8.23  Mon Sep 28 18:00:00 2026 UTC     -            -",
      "My Films     5679    192.168.8.40  Mon Sep 28 18:01:00 2026 UTC     -            -",
    ].join("\n");
    expect(parseSmbstatusShares(table)).toEqual([{ service: "Media", machine: "192.168.8.23" }, { service: "My Films", machine: "192.168.8.40" }]);
  });

  function sharedDrive({ reconnectsForever = false } = {}) {
    const calls = [];
    let closed = false;
    let mounted = "/dev/sda2";
    const run = vi.fn(async (binary, args, options) => {
      const name = binary.split("/").pop(); calls.push(`${name} ${args.join(" ")}`);
      if (name === "findmnt" && args.includes(HOST_TABLE)) return hostTable(mounted);
      if (name === "findmnt") return { ok: true, stdout: "/dev/sda2 exfat 8:2\n", stderr: "" };
      if (name === "docker" && args[0] === "ps") return { ok: true, stdout: "", stderr: "" };
      if (name === "smbstatus") return { ok: true, stdout: JSON.stringify({ tcons: { 1: { service: "Media", machine: "192.168.8.23" } } }), stderr: "" };
      if (name === "smbcontrol") { closed = !reconnectsForever; return { ok: true, stdout: "", stderr: "" }; }
      if (name === "umount") { if (!closed) return { ok: false, stdout: "", stderr: "umount: /mnt/the-dump: target is busy." }; mounted = null; return { ok: true, stdout: "", stderr: "" }; }
      if (name === "mount") { mounted = "/dev/sda2"; return { ok: true, stdout: "", stderr: "" }; }
      if (name === "fsck.exfat") { options?.onLine?.("checking", "stdout"); return { ok: true, code: 0, stdout: "/dev/sda2: clean. directories 51, files 1200", stderr: "" }; }
      return { ok: true, stdout: "", stderr: "" };
    });
    const files = { readFile: async (file) => (file === "/etc/samba/smb.conf" ? smbConf : fstab), readable: async () => true, exists: async () => true, bootSector: async () => null };
    const processes = { proc: "/proc", fs: { readdir: async (dir) => (dir === "/proc" ? ["4242"] : []), stat: async (target) => ({ dev: target.endsWith("/cwd") ? 8 * 256 + 2 : 1 }) } };
    return { run, calls, files, processes };
  }

  it("disconnects the share's clients and unmounts straight after, and says whom it disconnected", async () => {
    const { run, calls, files, processes } = sharedDrive();
    const log = vi.fn();
    const result = await storageCheck({ name: "the-dump" }, { run, files, log, sleep: async () => {}, processes });
    expect(result.clean).toBe(true);
    const close = calls.indexOf("smbcontrol smbd close-share Media");
    expect(close).toBeGreaterThan(calls.indexOf("umount -N /proc/1/ns/mnt /mnt/the-dump"));
    expect(calls[close + 2]).toBe("umount -N /proc/1/ns/mnt /mnt/the-dump");   // Everything, then the unmount at once
    expect(log).toHaveBeenCalledWith("Closed file-sharing connections from 192.168.8.23 to Media, Everything so /mnt/the-dump could be unmounted", "stdout");
    expect(calls.indexOf("fsck.exfat -n /dev/sda2")).toBeGreaterThan(close);
  });

  it("gives up after thirty tries, starts the apps again, and names what holds the drive, from /proc", async () => {
    const { run, calls, files, processes } = sharedDrive({ reconnectsForever: true });
    const sleep = vi.fn(async () => {});
    await expect(storageCheck({ name: "the-dump" }, { run, files, sleep, processes })).rejects.toThrow(/still in use by .* \(4242\), so nothing was done to it/);
    expect(calls.filter((call) => call === "smbcontrol smbd close-share Media")).toHaveLength(30);
    expect(sleep).toHaveBeenCalledWith(300);
    expect(calls.some((call) => call.startsWith("fsck"))).toBe(false);
  });

  it("finds what holds a filesystem by device number, across namespaces, from /proc", async () => {
    // 8:2 as Node reports st_dev (glibc makedev).
    const onDrive = 8 * 256 + 2;
    const entries = { "/proc": ["1", "100", "200", "300", "self"], "/proc/100/fd": ["0", "1", "5"], "/proc/200/fd": ["0"], "/proc/300/fd": [] };
    const devs = { "/proc/100/fd/5": onDrive, "/proc/200/cwd": onDrive, "/proc/300/root": onDrive };
    const fs = { readdir: async (dir) => entries[dir] ?? [], stat: async (target) => ({ dev: devs[target] ?? 2049 }) };
    const found = await processesUsing("8:2", { fs });
    expect(found.map((holder) => holder.pid)).toEqual([100, 200, 300]);
    expect(await processesUsing("not-a-device", { fs })).toEqual([]);
  });
});

describe("clearing the mark Linux keeps on an exFAT drive (M26)", () => {
  const fstab = "# boxpilot:the-dump\nUUID=0023-7927 /mnt/the-dump exfat defaults,nofail,uid=1000,gid=1000 0 0\n";
  function markedDrive({ marked = true, consistent = true, fstype = "exfat", mountFails = false } = {}) {
    const calls = [];
    let dirty = marked;
    let mounted = "/dev/sda2";
    const run = vi.fn(async (binary, args) => {
      const name = binary.split("/").pop(); calls.push(`${name} ${args.join(" ")}`);
      if (name === "findmnt" && args.includes(HOST_TABLE)) return hostTable(mounted, fstype);
      if (name === "findmnt") return { ok: true, stdout: `/dev/sda2 ${fstype} 8:2\n`, stderr: "" };
      if (name === "umount") { mounted = null; return { ok: true, stdout: "", stderr: "" }; }
      if (name === "mount") { if (mountFails) return { ok: false, stdout: "", stderr: "mount: /mnt/the-dump: can't find UUID=0023-7927." }; mounted = "/dev/sda2"; return { ok: true, stdout: "", stderr: "" }; }
      if (name === "docker" && args[0] === "ps") return { ok: true, stdout: "a\n", stderr: "" };
      if (name === "docker" && args[0] === "inspect") return { ok: true, stdout: "/bp-plex\t/mnt/the-dump\t\n", stderr: "" };
      if (name === "fsck.exfat" && args[0] === "-n") return consistent ? { ok: true, code: 0, stdout: "/dev/sda2: clean. directories 51, files 1200", stderr: "" } : { ok: false, code: 1, stdout: "ERROR: invalid cluster chain", stderr: "" };
      if (name === "fsck.exfat" && args[0] === "-y") { dirty = false; return { ok: true, code: 0, stdout: "/dev/sda2: clean", stderr: "" }; }
      return { ok: true, stdout: "", stderr: "" };
    });
    const files = { readFile: async () => fstab, exists: async () => true, bootSector: async () => { const sector = Buffer.alloc(512); sector.write("EXFAT   ", 3, "latin1"); sector[106] = dirty ? 2 : 0; return sector; } };
    return { run, calls, files };
  }

  it("runs the read-only pass first and only then fsck.exfat -y, with the apps paused and the drive unmounted", async () => {
    const { run, calls, files } = markedDrive();
    const log = vi.fn();
    const result = await storageClearMark({ name: "the-dump" }, { run, files, log, sleep: async () => {} });
    expect(result).toMatchObject({ wasMarked: true, cleared: true, restarted: ["bp-plex"] });
    const order = ["docker stop bp-plex", "umount -N /proc/1/ns/mnt /mnt/the-dump", "fsck.exfat -n /dev/sda2", "fsck.exfat -y /dev/sda2", "mount -N /proc/1/ns/mnt /mnt/the-dump", "docker start bp-plex"].map((call) => calls.indexOf(call));
    expect(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("the mark is all that changed"), "stdout");
  });

  it("changes nothing on a drive with real damage, and starts the apps again", async () => {
    const { run, calls, files } = markedDrive({ consistent: false });
    await expect(storageClearMark({ name: "the-dump" }, { run, files, sleep: async () => {} })).rejects.toThrow("the read-only check found problems (exit 1), so the mark was left and nothing was changed");
    expect(calls).not.toContain("fsck.exfat -y /dev/sda2");
    expect(calls).toContain("mount -N /proc/1/ns/mnt /mnt/the-dump");
    expect(calls).toContain("docker start bp-plex");
  });

  it("says both when the clear was refused and the drive then did not mount again, with the apps left stopped", async () => {
    const { run, calls, files } = markedDrive({ consistent: false, mountFails: true });
    await expect(storageClearMark({ name: "the-dump" }, { run, files, sleep: async () => {} }))
      .rejects.toThrow(/^the read-only check found problems \(exit 1\), so the mark was left and nothing was changed: .*\. \/mnt\/the-dump did not mount again after it was unmounted to clear its mark: mount failed: mount: \/mnt\/the-dump: can't find UUID=0023-7927\. bp-plex was left stopped/);
    expect(calls.filter((call) => call.startsWith("mount "))).toHaveLength(2);
    expect(calls).not.toContain("docker start bp-plex");
  });

  it("writes nothing to a drive that is not marked, and refuses anything but exFAT before stopping a thing", async () => {
    const clear = markedDrive({ marked: false });
    expect(await storageClearMark({ name: "the-dump" }, { run: clear.run, files: clear.files, sleep: async () => {} })).toMatchObject({ wasMarked: false, cleared: false });
    expect(clear.calls.some((call) => call.startsWith("fsck.exfat"))).toBe(false);
    const ext = markedDrive({ fstype: "ext4" });
    await expect(storageClearMark({ name: "the-dump" }, { run: ext.run, files: ext.files, sleep: async () => {} })).rejects.toThrow("only exFAT keeps a not-properly-unmounted mark");
    expect(ext.calls.some((call) => call.startsWith("docker stop") || call.startsWith("umount"))).toBe(false);
  });
});

describe("rolling back to an LVM snapshot", () => {
  // `|| true` made every rollback report a reboot, including a merge LVM had already finished.
  const path = "/dev/mapper/ubuntu--vg-boxpilot--snap--20260821--2005";
  const answering = (stdout, stderr = "") => vi.fn(async () => ({ ok: true, stdout, stderr }));

  it("asks for a reboot only when LVM deferred the merge", async () => {
    // A mounted origin such as /: LVM schedules the merge for the next activation.
    for (const deferred of [
      ["  Delaying merge since origin is open.", "  Merging of snapshot ubuntu-vg/boxpilot-snap-20260821-2005 will occur on next activation of ubuntu-vg/ubuntu-lv."],
      ["", "  Can't merge until origin volume is closed."],
    ]) {
      await expect(storageLvmSnapshotRollback({ path }, { run: answering(deferred[0], deferred[1]) })).resolves.toMatchObject({ rollbackScheduled: true, rebootRequired: true });
    }
    // An unmounted data volume merges on the spot.
    const now = answering("  Merging of volume ubuntu-vg/boxpilot-snap-20260821-2005 started.\n  ubuntu-vg/data-lv: Merged: 100.00%");
    await expect(storageLvmSnapshotRollback({ path }, { run: now })).resolves.toMatchObject({ rollbackScheduled: true, rebootRequired: false });
  });
});
