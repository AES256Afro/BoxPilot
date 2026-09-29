import { describe, expect, it, vi } from "vitest";
import { assessDriveChecks, detectDriveTools, gatherDriveChecks, managedUsbDisks, usbSmartState } from "./drive-checks.mjs";
import { collectStorage } from "./storage-inventory.mjs";

/**
 * A small server as lsblk, findmnt and /etc/fstab describe it: a SATA system disk, two USB drives
 * BoxPilot mounted (one exFAT, one ext4 on a second partition), a USB stick nobody mounted through
 * BoxPilot, a network share and the swap file. Placeholder names and UUIDs throughout.
 */
const lsblk = {
  blockdevices: [
    { path: "/dev/sda", kname: "sda", pkname: null, type: "disk", size: 256e9, fstype: null, uuid: null, label: null, model: "EXAMPLE SSD", tran: "sata", mountpoints: [null], ro: false, rm: false, children: [
      { path: "/dev/sda1", kname: "sda1", pkname: "sda", type: "part", size: 1e9, fstype: "vfat", uuid: "AAAA-0001", label: null, model: null, tran: null, mountpoints: ["/boot/efi"], ro: false, rm: false },
      { path: "/dev/sda2", kname: "sda2", pkname: "sda", type: "part", size: 255e9, fstype: "ext4", uuid: "00000000-0000-4000-8000-000000000002", label: null, model: null, tran: null, mountpoints: ["/"], ro: false, rm: false },
    ] },
    { path: "/dev/sdb", kname: "sdb", pkname: null, type: "disk", size: 4e12, fstype: null, uuid: null, label: null, model: "EXAMPLE HDD 4TB", tran: "usb", mountpoints: [null], ro: false, rm: false, children: [
      { path: "/dev/sdb1", kname: "sdb1", pkname: "sdb", type: "part", size: 4e12, fstype: "exfat", uuid: "1234-ABCD", label: "MEDIA", model: null, tran: null, mountpoints: ["/mnt/media"], ro: false, rm: false },
    ] },
    { path: "/dev/sdc", kname: "sdc", pkname: null, type: "disk", size: 2e12, fstype: null, uuid: null, label: null, model: "Example USB Enclosure", tran: "usb", mountpoints: [null], ro: false, rm: false, children: [
      { path: "/dev/sdc1", kname: "sdc1", pkname: "sdc", type: "part", size: 1e9, fstype: "vfat", uuid: "BBBB-0001", label: null, model: null, tran: null, mountpoints: [null], ro: false, rm: false },
      { path: "/dev/sdc2", kname: "sdc2", pkname: "sdc", type: "part", size: 1.9e12, fstype: "ext4", uuid: "00000000-0000-4000-8000-00000000000c", label: null, model: null, tran: null, mountpoints: ["/mnt/backup"], ro: false, rm: false },
    ] },
    { path: "/dev/sdd", kname: "sdd", pkname: null, type: "disk", size: 32e9, fstype: "vfat", uuid: "CCCC-0001", label: "STICK", model: "Example Stick", tran: "usb", mountpoints: ["/media/stick"], ro: false, rm: true },
  ],
};
const findmnt = { filesystems: [{ target: "/", source: "/dev/sda2", fstype: "ext4", size: 255e9, used: 1e9, avail: 254e9, options: "rw,relatime", children: [
  { target: "/boot/efi", source: "/dev/sda1", fstype: "vfat", size: 1e9, used: 1e6, avail: 1e9, options: "rw" },
  { target: "/mnt/media", source: "/dev/sdb1", fstype: "exfat", size: 4e12, used: 1e12, avail: 3e12, options: "rw,uid=1000,gid=1000" },
  { target: "/mnt/backup", source: "/dev/sdc2", fstype: "ext4", size: 1.9e12, used: 1e11, avail: 1.8e12, options: "rw,relatime" },
  { target: "/media/stick", source: "/dev/sdd", fstype: "vfat", size: 32e9, used: 1e9, avail: 31e9, options: "rw" },
] }] };
const fstab = [
  "UUID=00000000-0000-4000-8000-000000000002 / ext4 defaults 0 1",
  "# boxpilot:media",
  "UUID=1234-ABCD /mnt/media exfat defaults,nofail,uid=1000,gid=1000 0 0",
  "# boxpilot:backup",
  "UUID=00000000-0000-4000-8000-00000000000c /mnt/backup ext4 defaults,nofail 0 2",
  "# boxpilot:share-nas",
  "//nas.example/share /mnt/share-nas cifs credentials=/etc/boxpilot/nas,nofail 0 0",
  "# boxpilot:swap",
  "/swap.img none swap sw 0 0",
  "",
].join("\n");

async function storage() {
  const run = vi.fn(async (binary) => ({ ok: true, stdout: JSON.stringify(binary.endsWith("lsblk") ? lsblk : findmnt), stderr: "" }));
  return collectStorage({ run, readFile: async () => fstab, exists: async () => false });
}

const reading = (disks, { stale = false } = {}) => ({ available: true, status: "healthy", stale, disks });

describe("the USB drives BoxPilot mounts", () => {
  it("follows each managed mount by its UUID up to its disk, and keeps only USB ones", async () => {
    expect(managedUsbDisks(await storage())).toEqual([
      { device: "/dev/sdb", model: "EXAMPLE HDD 4TB", targets: ["/mnt/media"] },
      { device: "/dev/sdc", model: "Example USB Enclosure", targets: ["/mnt/backup"] },
    ]);
  });

  it("still finds a drive whose fstab line names a device path, and skips one that is not plugged in", async () => {
    const listed = await storage();
    const byPath = { ...listed, fstab: [{ device: "/dev/sdb1", mountpoint: "/mnt/media", fstype: "exfat", options: "defaults", managedName: "media" }, { device: "UUID=9999-GONE", mountpoint: "/mnt/away", fstype: "exfat", options: "defaults", managedName: "away" }] };
    expect(managedUsbDisks(byPath)).toEqual([{ device: "/dev/sdb", model: "EXAMPLE HDD 4TB", targets: ["/mnt/media"] }]);
    expect(managedUsbDisks(null)).toEqual([]);
  });
});

describe("how a USB disk answered SMART", () => {
  it("reads the scan's verdict for the disk, and treats no current reading as unread", () => {
    const smart = reading([
      { device: "/dev/sdb", health: "healthy", reason: "ok", deviceType: "sat" },
      { device: "/dev/sdc", health: "unavailable", reason: "usb-bridge-unsupported", deviceType: "sat" },
      { device: "/dev/sdd", health: "warning", reason: "ok", deviceType: "auto" },
      { device: "/dev/sde", health: "unavailable", reason: "smartctl-read-failed", deviceType: "sat" },
      // Written before the scanner asked through the bridge: no verdict about the bridge yet.
      { device: "/dev/sdf", health: "unavailable", reason: "unsupported-device", deviceType: null },
    ]);
    expect(usbSmartState("/dev/sdb", smart)).toBe("answers-through-bridge");
    expect(usbSmartState("/dev/sdc", smart)).toBe("bridge-unsupported");
    expect(usbSmartState("/dev/sdd", smart)).toBe("answers");
    expect(usbSmartState("/dev/sde", smart)).toBe("unread");
    expect(usbSmartState("/dev/sdf", smart)).toBe("unread");
    expect(usbSmartState("/dev/sdz", smart)).toBe("unread");
    expect(usbSmartState("/dev/sdb", reading(smart.disks, { stale: true }))).toBe("unread");
    expect(usbSmartState("/dev/sdb", null)).toBe("unread");
  });

  it("counts a disk left asleep as answering when it answered the time before (M36)", () => {
    const smart = reading([
      { device: "/dev/sdb", health: "unavailable", reason: "asleep", deviceType: "sat", lastHealth: "healthy", lastReadAt: "2026-09-28T06:00:00.000Z" },
      { device: "/dev/sdc", health: "unavailable", reason: "asleep", deviceType: "auto", lastHealth: null },
    ]);
    expect(usbSmartState("/dev/sdb", smart)).toBe("answers-through-bridge");
    expect(usbSmartState("/dev/sdc", smart)).toBe("unread");
  });

  it("assesses tools and drives together", async () => {
    const smart = reading([{ device: "/dev/sdb", health: "healthy", reason: "ok", deviceType: "sat" }, { device: "/dev/sdc", health: "unavailable", reason: "usb-bridge-unsupported", deviceType: "sat" }]);
    expect(assessDriveChecks({ tools: { smartctl: true, fsckExfat: false }, storage: await storage(), smart })).toEqual({
      tools: { smartctl: true, fsckExfat: false },
      missingPackages: ["exfatprogs"],
      disksKnown: true,
      disks: [
        { device: "/dev/sdb", model: "EXAMPLE HDD 4TB", targets: ["/mnt/media"], smart: "answers-through-bridge" },
        { device: "/dev/sdc", model: "Example USB Enclosure", targets: ["/mnt/backup"], smart: "bridge-unsupported" },
      ],
    });
    expect(assessDriveChecks({ tools: { smartctl: false, fsckExfat: false }, storage: null })).toMatchObject({ missingPackages: ["exfatprogs", "smartmontools"], disksKnown: false, disks: [] });
    expect(assessDriveChecks({ tools: null })).toBeNull();
  });
});

describe("gathering the drive evidence", () => {
  it("looks for each tool where Ubuntu puts it", async () => {
    const present = new Set(["/usr/sbin/smartctl", "/sbin/fsck.exfat"]);
    await expect(detectDriveTools({ exists: async (file) => present.has(file) })).resolves.toEqual({ smartctl: true, fsckExfat: true });
    await expect(detectDriveTools({ exists: async (file) => file === "/usr/sbin/smartctl" })).resolves.toEqual({ smartctl: true, fsckExfat: false });
  });

  it("waits for the SMART reading it is handed, and survives each read failing", async () => {
    const smart = Promise.resolve(reading([{ device: "/dev/sdb", health: "healthy", reason: "ok", deviceType: "auto" }]));
    const listed = await storage();
    const result = await gatherDriveChecks({ smart, collect: async () => listed, detect: async () => ({ smartctl: true, fsckExfat: true }) });
    expect(result.disks.map((disk) => [disk.device, disk.smart])).toEqual([["/dev/sdb", "answers"], ["/dev/sdc", "unread"]]);
    await expect(gatherDriveChecks({ smart: Promise.reject(new Error("inventory down")), collect: async () => { throw new Error("lsblk failed"); }, detect: async () => ({ smartctl: true, fsckExfat: true }) }))
      .resolves.toMatchObject({ missingPackages: [], disksKnown: false, disks: [] });
    await expect(gatherDriveChecks({ collect: async () => listed, detect: async () => { throw new Error("no"); } })).resolves.toBeNull();
  });
});
