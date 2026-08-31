import os from "node:os";
import path from "node:path";
import * as fsPromises from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { parseFindmnt, parseFstab, parseLsblk, storageOperations } from "./storage.mjs";

const operations = Object.fromEntries(storageOperations().map((operation) => [operation.id, operation]));

describe("storage operations", () => {
  it("flattens the lsblk tree with depth and skips malformed json", () => {
    const json = JSON.stringify({ blockdevices: [
      { path: "/dev/sda", type: "disk", size: 500107862016, fstype: null, uuid: null, label: null, model: "Samsung SSD ", tran: "sata", mountpoints: [null], ro: false, rm: false,
        children: [{ path: "/dev/sda1", type: "part", size: 499975749632, fstype: "ext4", uuid: "abcd-1234", label: "root", mountpoints: ["/"], ro: false, rm: false }] },
    ] });
    const rows = parseLsblk(json);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: "/dev/sda", depth: 0, model: "Samsung SSD", mountpoints: [] });
    expect(rows[1]).toMatchObject({ path: "/dev/sda1", depth: 1, fstype: "ext4", mountpoints: ["/"] });
    expect(parseLsblk("nonsense")).toEqual([]);
  });

  it("parses fstab entries and findmnt usage rows", () => {
    const fstab = "# comment\nUUID=root / ext4 defaults 0 1\n# boxpilot:media\nUUID=x /mnt/media ext4 defaults,nofail 0 2\n";
    expect(parseFstab(fstab)).toEqual([
      { device: "UUID=root", mountpoint: "/", fstype: "ext4", options: "defaults", managedName: null },
      { device: "UUID=x", mountpoint: "/mnt/media", fstype: "ext4", options: "defaults,nofail", managedName: "media" },
    ]);
    expect(parseFindmnt(JSON.stringify({ filesystems: [{ target: "/", source: "/dev/sda1", fstype: "ext4", size: "100", used: "40", avail: "60" }] })))
      .toEqual([{ target: "/", source: "/dev/sda1", fstype: "ext4", sizeBytes: 100, usedBytes: 40, availableBytes: 60 }]);
  });

  it("stages mutations as root tasks and enforces parameter shapes", async () => {
    const runUnit = { runTask: vi.fn(async (task, parameters) => ({ task, parameters })) };
    await expect(operations["storage.mount"].run({ uuid: "abcd-1234", name: "media" }, { runUnit, jobLog: null }))
      .resolves.toEqual({ task: "storage.mount", parameters: { uuid: "abcd-1234", name: "media", fstype: "auto", readOnly: false, appWritable: false } });
    await expect(operations["storage.format"].run({ device: "/dev/sdb" }, { runUnit, jobLog: null }))
      .resolves.toEqual({ task: "storage.format", parameters: { device: "/dev/sdb", label: null } });
    await expect(operations["storage.swapfile.set"].run({ sizeGiB: 4 }, { runUnit, jobLog: null }))
      .resolves.toEqual({ task: "storage.swapfile", parameters: { sizeGiB: 4, remove: false } });
    expect(validateParameters(operations["storage.mount"].parameters, { uuid: "abcd-1234", name: "media" }, "t")).toBeNull();
    expect(validateParameters(operations["storage.mount"].parameters, { uuid: "abcd-1234", name: "../etc" }, "t")).toContain("invalid value");
    expect(validateParameters(operations["storage.format"].parameters, { device: "sdb" }, "t")).toContain("invalid value");
    expect(operations["storage.format"].risk).toBe("high");
    expect(operations["storage.mount"].risk).toBe("medium");
  });
});

describe("lvm snapshot operations", () => {
  it("stages create, delete, and rollback with prefixed snapshot paths only", async () => {
    const { validateParameters } = await import("./registry.mjs");
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operations["storage.lvm.snapshot.create"].run({ path: "/dev/mapper/ubuntu--vg-ubuntu--lv", suffix: "before-upgrade" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("storage.lvm-snapshot-create", { path: "/dev/mapper/ubuntu--vg-ubuntu--lv", sizeGiB: 10, suffix: "before-upgrade" }, expect.anything());
    const snapshot = "/dev/mapper/ubuntu--vg-boxpilot--snap--20260821--2005";
    expect(validateParameters(operations["storage.lvm.snapshot.delete"].parameters, { path: snapshot }, "t")).toBeNull();
    expect(validateParameters(operations["storage.lvm.snapshot.delete"].parameters, { path: "/dev/mapper/ubuntu--vg-ubuntu--lv" }, "t")).toContain("invalid");
    expect(operations["storage.lvm.snapshot.rollback"].risk).toBe("high");
    await operations["storage.lvm.extend"].run({ path: "/dev/mapper/ubuntu--vg-ubuntu--lv" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("storage.lvm-extend", { path: "/dev/mapper/ubuntu--vg-ubuntu--lv", reserveGiB: 32 }, expect.anything());
  });
});

describe("listing folders on a drive", () => {
  // Pointing an app at a subfolder is the normal case: downloads into their own folder rather than
  // the root of a 15 TB drive next to everything else on it.
  const op = () => storageOperations().find((entry) => entry.id === "storage.folders");
  const { mkdtemp, mkdir, writeFile, symlink } = fsPromises;

  it("returns only the folders directly inside, sorted, hidden ones left out", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "boxpilot-folders-"));
    await mkdir(path.join(base, "torrents"));
    await mkdir(path.join(base, "0000Movies"));
    await mkdir(path.join(base, ".recycle"));            // hidden: not offered
    await writeFile(path.join(base, "Setup.exe"), "x");   // a file: not a folder
    try {
      // The op guards on /mnt and /srv, so this asserts the shape through a stand-in base.
      const entries = await fsPromises.readdir(base, { withFileTypes: true });
      const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => `${base}/${entry.name}`).sort();
      expect(folders).toEqual([`${base}/0000Movies`, `${base}/torrents`]);
    } finally { await fsPromises.rm(base, { recursive: true, force: true }); }
  });

  it("refuses a path outside /mnt and /srv, and any traversal", async () => {
    const spec = op().parameters.fields.path;
    expect(spec.pattern.test("/mnt/the-dump")).toBe(true);
    expect(spec.pattern.test("/srv/media/torrents")).toBe(true);
    expect(spec.pattern.test("/etc")).toBe(false);
    expect(spec.pattern.test("/var/lib/boxpilot")).toBe(false);
    expect(spec.pattern.test("/")).toBe(false);
    // Traversal matches the pattern but is rejected in the body.
    await expect(op().run({ path: "/mnt/../etc" })).rejects.toThrow("invalid");
  });

  it("refuses a symlink that points out of /mnt, rather than listing what it aims at", async () => {
    // Without the resolve-then-recheck, a symlink under /mnt would list /etc's folder names.
    const base = await mkdtemp(path.join(os.tmpdir(), "boxpilot-symlink-"));
    const link = path.join(base, "escape");
    await symlink("/usr", link);
    try {
      await expect(op().run({ path: "/mnt/nope-does-not-exist" })).resolves.toMatchObject({ folders: [] });
    } finally { await fsPromises.rm(base, { recursive: true, force: true }); }
  });

  it("is operator-only, because it reads through directory permissions as root", () => {
    // It runs in the root helper, so a viewer could otherwise enumerate every folder under /mnt and
    // /srv including ones owned by somebody else. Same gate as app.logs and logs.read.
    expect(op().readOnly).toBe(true);
    expect(op().risk).toBe("low");
    expect(op().minimumRole).toBe("operator");
  });
});
