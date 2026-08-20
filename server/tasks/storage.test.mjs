import { describe, expect, it, vi } from "vitest";
import { parseManagedFstab, removeManagedEntry, storageFormat, storageMount, storageUnmount, swapFileSet } from "./storage.mjs";

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

function fakeRun({ uuidDevice = "/dev/sdb1", mountFails = false, verifyFails = false, mountedAt = {}, lsblkNodes = null } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("blkid") && args[0] === "-U") return uuidDevice ? { ok: true, stdout: uuidDevice, stderr: "" } : { ok: false, stdout: "", stderr: "" };
    if (binary.endsWith("blkid")) return { ok: true, stdout: "new-uuid-1234", stderr: "" };
    if (binary.endsWith("findmnt") && args[0] === "--verify") return verifyFails ? { ok: false, stdout: "", stderr: "/etc/fstab parse error" } : { ok: true, stdout: "", stderr: "" };
    if (binary.endsWith("findmnt")) { const target = args.at(-1); return mountedAt[target] ? { ok: true, stdout: mountedAt[target], stderr: "" } : { ok: false, stdout: "", stderr: "" }; }
    if (binary.endsWith("mount") && !binary.endsWith("umount")) { if (mountFails) return { ok: false, stdout: "", stderr: "wrong fs type" }; mountedAt[args[0]] = "mounted"; return { ok: true, stdout: "", stderr: "" }; }
    if (binary.endsWith("umount")) { delete mountedAt[args[0]]; return { ok: true, stdout: "", stderr: "" }; }
    if (binary.endsWith("lsblk")) return lsblkNodes ? { ok: true, stdout: JSON.stringify({ blockdevices: lsblkNodes }), stderr: "" } : { ok: false, stdout: "", stderr: "not found" };
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
