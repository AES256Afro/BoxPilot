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
