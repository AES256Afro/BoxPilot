import { describe, expect, it } from "vitest";
import { annotateDevices, collectStorage, parseLsblkTree, sharesFrom, splitDmName, volumeGroupsFrom } from "./storage-inventory.mjs";

const GiB = 1024 ** 3;
const lsblkJson = JSON.stringify({ blockdevices: [
  { path: "/dev/nvme0n1", type: "disk", size: 1024209543168, fstype: null, uuid: null, label: null, model: "Inland TN320 NVMe SSD", tran: "nvme", mountpoints: [null], ro: false, rm: false, children: [
    { path: "/dev/nvme0n1p1", type: "part", size: GiB, fstype: "vfat", uuid: "AAAA-1111", label: null, model: null, tran: "nvme", mountpoints: ["/boot/efi"], ro: false, rm: false },
    { path: "/dev/nvme0n1p2", type: "part", size: 2 * GiB, fstype: "ext4", uuid: "boot-uuid", label: null, model: null, tran: "nvme", mountpoints: ["/boot"], ro: false, rm: false },
    { path: "/dev/nvme0n1p3", type: "part", size: 1020 * GiB, fstype: "LVM2_member", uuid: "pv-uuid", label: null, model: null, tran: "nvme", mountpoints: [null], ro: false, rm: false, children: [
      { path: "/dev/mapper/ubuntu--vg-ubuntu--lv", type: "lvm", size: 100 * GiB, fstype: "ext4", uuid: "root-uuid", label: null, model: null, tran: null, mountpoints: ["/"], ro: false, rm: false },
    ] },
  ] },
  { path: "/dev/sdb", type: "disk", size: 4000 * GiB, fstype: null, uuid: null, label: null, model: "WD Elements", tran: "usb", mountpoints: [null], ro: false, rm: true, children: [
    { path: "/dev/sdb1", type: "part", size: 4000 * GiB, fstype: "ext4", uuid: "data-uuid", label: "media", model: null, tran: null, mountpoints: [null], ro: false, rm: true },
  ] },
] });

describe("storage inventory", () => {
  it("decodes device-mapper names", () => {
    expect(splitDmName("ubuntu--vg-ubuntu--lv")).toEqual({ vg: "ubuntu-vg", lv: "ubuntu-lv" });
    expect(splitDmName("data-media")).toEqual({ vg: "data", lv: "media" });
    expect(splitDmName("plain")).toEqual({ vg: null, lv: "plain" });
  });

  it("marks the system disk, LVM members, and anything with mounted children as protected", async () => {
    const report = await collectStorage({
      run: async (binary) => (binary.endsWith("lsblk") ? { ok: true, stdout: lsblkJson, stderr: "" } : { ok: true, stdout: JSON.stringify({ filesystems: [{ target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv", fstype: "ext4", size: 100 * GiB, used: 27 * GiB, avail: 68 * GiB }] }), stderr: "" }),
      readFile: async () => "UUID=root-uuid / ext4 defaults 0 1\n# boxpilot:share-nas\n//mycloud/Public /mnt/nas cifs credentials=/etc/boxpilot/secrets/share-nas.cred,x-systemd.automount,ro,nofail 0 0\n",
      exists: async (file) => file.endsWith("mount.nfs"),
    });
    const byPath = Object.fromEntries(report.devices.map((device) => [device.path, device]));
    expect(byPath["/dev/nvme0n1"]).toMatchObject({ protected: true, protectedReason: "system disk" });
    expect(byPath["/dev/nvme0n1p3"]).toMatchObject({ protected: true, protectedReason: "system disk", holdsVolumeGroups: ["ubuntu-vg"] });
    expect(byPath["/dev/mapper/ubuntu--vg-ubuntu--lv"]).toMatchObject({ protected: true, volumeGroup: "ubuntu-vg", logicalVolume: "ubuntu-lv", depth: 2 });
    expect(byPath["/dev/sdb"]).toMatchObject({ protected: false, protectedReason: null });
    expect(byPath["/dev/sdb1"]).toMatchObject({ protected: false });

    expect(report.volumeGroups).toEqual([expect.objectContaining({ name: "ubuntu-vg", physicalVolumes: ["/dev/nvme0n1p3"], sizeBytes: 1020 * GiB, usedBytes: 100 * GiB, freeBytes: 920 * GiB })]);
    expect(report.volumeGroups[0].logicalVolumes[0]).toMatchObject({ path: "/dev/mapper/ubuntu--vg-ubuntu--lv", name: "ubuntu-lv", fstype: "ext4", mountpoints: ["/"], growable: true });

    expect(report.shares).toEqual([{ name: "nas", kind: "smb", source: "//mycloud/Public", mountpoint: "/mnt/nas", readOnly: true, automount: true, mounted: false, sizeBytes: null, usedBytes: null, availableBytes: null }]);
    expect(report.tools).toEqual({ cifs: false, nfs: true, smbclient: false, showmount: false });
  });

  it("rebuilds the hierarchy from PKNAME when lsblk prints a flat list (no NAME column)", () => {
    // Exactly what an unprivileged `lsblk -J -o PATH,...` printed on a real Ubuntu host: flat, LV first.
    const flat = JSON.stringify({ blockdevices: [
      { path: "/dev/mapper/ubuntu--vg-ubuntu--lv", kname: "dm-0", pkname: "nvme0n1p3", type: "lvm", size: 100 * GiB, fstype: "ext4", mountpoints: ["/"], ro: false, rm: false },
      { path: "/dev/nvme0n1", kname: "nvme0n1", pkname: null, type: "disk", size: 1000 * GiB, fstype: null, mountpoints: [null], ro: false, rm: false, model: "Inland TN320 NVMe SSD" },
      { path: "/dev/nvme0n1p1", kname: "nvme0n1p1", pkname: "nvme0n1", type: "part", size: GiB, fstype: "vfat", mountpoints: ["/boot/efi"], ro: false, rm: false },
      { path: "/dev/nvme0n1p2", kname: "nvme0n1p2", pkname: "nvme0n1", type: "part", size: 2 * GiB, fstype: "ext4", mountpoints: ["/boot"], ro: false, rm: false },
      { path: "/dev/nvme0n1p3", kname: "nvme0n1p3", pkname: "nvme0n1", type: "part", size: 950 * GiB, fstype: "LVM2_member", mountpoints: [null], ro: false, rm: false },
    ] });
    const rows = parseLsblkTree(flat);
    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.path}`)).toEqual(["/dev/nvme0n1", "  /dev/nvme0n1p1", "  /dev/nvme0n1p2", "  /dev/nvme0n1p3", "    /dev/mapper/ubuntu--vg-ubuntu--lv"]);
    expect(rows[0]).not.toHaveProperty("pkname");
    const devices = annotateDevices(rows);
    expect(devices[0]).toMatchObject({ path: "/dev/nvme0n1", protected: true, protectedReason: "system disk" });
    expect(devices[3]).toMatchObject({ path: "/dev/nvme0n1p3", holdsVolumeGroups: ["ubuntu-vg"] });
    expect(volumeGroupsFrom(devices)).toEqual([expect.objectContaining({ name: "ubuntu-vg", freeBytes: 850 * GiB })]);
    // Nested output without PKNAME (older fixtures) still works through the visit order.
    expect(parseLsblkTree(lsblkJson).map((row) => row.depth)).toEqual([0, 1, 1, 1, 2, 0, 1]);
  });

  it("protects a plain partition whose sibling holds a mounted filesystem only through its parent", () => {
    const devices = annotateDevices([
      { path: "/dev/sdc", type: "disk", fstype: null, mountpoints: [], depth: 0 },
      { path: "/dev/sdc1", type: "part", fstype: "ext4", mountpoints: ["/mnt/old"], depth: 1 },
      { path: "/dev/sdc2", type: "part", fstype: "ext4", mountpoints: [], depth: 1 },
    ]);
    expect(devices[0]).toMatchObject({ protected: true, protectedReason: "holds mounted filesystems (/mnt/old)" });
    expect(devices[1]).toMatchObject({ protected: false });
    expect(devices[2]).toMatchObject({ protected: false });
    expect(volumeGroupsFrom(devices)).toEqual([]);
  });

  it("reports mounted shares with usage", () => {
    const shares = sharesFrom(
      [{ device: "nas:/volume1/media", mountpoint: "/mnt/media", fstype: "nfs", options: "rw,nofail,_netdev", managedName: "share-media" }, { device: "UUID=x", mountpoint: "/mnt/disk", fstype: "ext4", options: "defaults", managedName: "disk" }],
      [{ target: "/mnt/media", source: "nas:/volume1/media", fstype: "nfs", sizeBytes: 10, usedBytes: 4, availableBytes: 6 }],
    );
    expect(shares).toEqual([{ name: "media", kind: "nfs", source: "nas:/volume1/media", mountpoint: "/mnt/media", readOnly: false, automount: false, mounted: true, sizeBytes: 10, usedBytes: 4, availableBytes: 6 }]);
  });
});
