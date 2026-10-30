/**
 * A server laid out like the one the owner asked about (M40), in placeholders: the root filesystem
 * on an NVMe drive through LVM (528 GB, 31% used), and a 16 TB USB drive with one exFAT partition
 * mounted as a data folder. The shapes are the inventory's own (server/inventory.mjs): lsblk's
 * devices with their parents, the root scan's mounts, statfs of /, and SMART.
 *
 * lsblk as the web service runs it (PrivateDevices=yes) lists no device-mapper volume: the root's
 * LVM volume is missing and its partition shows as LVM2_member. `{ mapperListed: true }` lists it,
 * as lsblk outside the sandbox does.
 */
const GB = 1e9;
const rootVolume = { name: "/dev/mapper/ubuntu--vg-ubuntu--lv", parent: "/dev/nvme0n1p3", type: "lvm", filesystem: "ext4", sizeBytes: 536.9 * GB, mountTargets: ["/"], rotational: false, readOnly: false, transport: null, model: null };

export function ownerLikeStorage({ mapperListed = false } = {}) {
  return {
    root: { totalBytes: 528 * GB, freeBytes: 366 * GB, usedBytes: 162 * GB, usedPercent: 31 },
    filesystems: {
      available: true, namespace: "host-pid1",
      mounts: [
        { target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv", filesystem: "ext4", totalBytes: 528 * GB, usedBytes: 162 * GB, availableBytes: 366 * GB, usedPercent: 31, capacityState: "healthy", readOnly: false },
        { target: "/boot", source: "/dev/nvme0n1p2", filesystem: "ext4", totalBytes: 2.1 * GB, usedBytes: 0.2 * GB, availableBytes: 1.8 * GB, usedPercent: 10, capacityState: "healthy", readOnly: false },
        { target: "/boot/efi", source: "/dev/nvme0n1p1", filesystem: "vfat", totalBytes: 1.1 * GB, usedBytes: 0.006 * GB, availableBytes: 1.1 * GB, usedPercent: 1, capacityState: "healthy", readOnly: false },
        { target: "/mnt/archive", source: "/dev/sda1", filesystem: "exfat", totalBytes: 16_000 * GB, usedBytes: 2_400 * GB, availableBytes: 13_600 * GB, usedPercent: 15, capacityState: "healthy", readOnly: false },
        { target: "/run", source: "tmpfs", filesystem: "tmpfs", totalBytes: 3 * GB, usedBytes: 0.002 * GB, availableBytes: 3 * GB, usedPercent: 1, capacityState: "healthy", readOnly: false },
      ],
    },
    blockDevices: {
      available: true,
      devices: [
        { name: "/dev/loop0", parent: null, type: "loop", filesystem: "squashfs", sizeBytes: 0.07 * GB, mountTargets: ["/snap/core22/1"], rotational: false, readOnly: true, transport: null, model: null },
        { name: "/dev/sda", parent: null, type: "disk", filesystem: null, sizeBytes: 16_000.9 * GB, mountTargets: [], rotational: true, readOnly: false, transport: "usb", model: "Example USB HDD 16TB" },
        { name: "/dev/sda1", parent: "/dev/sda", type: "part", filesystem: "exfat", sizeBytes: 16_000.9 * GB, mountTargets: ["/mnt/archive"], rotational: true, readOnly: false, transport: null, model: null },
        { name: "/dev/nvme0n1", parent: null, type: "disk", filesystem: null, sizeBytes: 1_024.2 * GB, mountTargets: [], rotational: false, readOnly: false, transport: "nvme", model: "Example NVMe SSD 1TB" },
        { name: "/dev/nvme0n1p1", parent: "/dev/nvme0n1", type: "part", filesystem: "vfat", sizeBytes: 1.1 * GB, mountTargets: ["/boot/efi"], rotational: false, readOnly: false, transport: "nvme", model: null },
        { name: "/dev/nvme0n1p2", parent: "/dev/nvme0n1", type: "part", filesystem: "ext4", sizeBytes: 2.1 * GB, mountTargets: ["/boot"], rotational: false, readOnly: false, transport: "nvme", model: null },
        { name: "/dev/nvme0n1p3", parent: "/dev/nvme0n1", type: "part", filesystem: "LVM2_member", sizeBytes: 1_021 * GB, mountTargets: [], rotational: false, readOnly: false, transport: "nvme", model: null },
        ...(mapperListed ? [rootVolume] : []),
      ],
    },
    smart: {
      available: true, status: "healthy", reason: "fixed-root-scan", generatedAt: "2026-09-29T03:00:00.000Z", stale: false,
      summary: { healthy: 1, warning: 0, critical: 0, unavailable: 1 },
      disks: [
        { device: "/dev/nvme0n1", health: "healthy", passed: true, temperatureCelsius: 41, powerOnHours: 6120, percentageUsed: 3, mediaErrors: 0, unsafeShutdowns: 2, reason: "ok", transport: "nvme" },
        { device: "/dev/sda", health: "unavailable", passed: null, temperatureCelsius: null, powerOnHours: null, percentageUsed: null, mediaErrors: null, unsafeShutdowns: null, reason: "usb-bridge-unsupported", transport: "usb" },
      ],
    },
  };
}

/** The answer the owner got, word for word: the wrong device named the primary drive, with the root's numbers. */
export const ownersWrongAnswer = "Two drives are connected to BoxPilot:\n\n- **/dev/sda** (primary drive): 528 GB total, 31% used [T1]\n- /mnt/archive: 15% used [T1]";
