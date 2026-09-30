import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoReconnectControl } from "../../AutoReconnect";
import { stubFetch } from "../../home/testData";
import type { StorageLeadProps } from "../StorageLead";
import type { DeviceRow, StorageReport } from "../../pages/storage/types";
import StorageLead, { diskRows, partitionRows } from "./StorageLead";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const GiB = 1024 ** 3;
const device = (path: string, type: string, depth: number, sizeBytes: number, extra: Partial<DeviceRow> = {}): DeviceRow => ({
  path, type, sizeBytes, depth, fstype: null, uuid: null, label: null, model: null, transport: null, mountpoints: [], readOnly: false, removable: false,
  protected: false, protectedReason: null, volumeGroup: null, logicalVolume: null, holdsVolumeGroups: [], mountedBelow: [], ...extra,
});

/** A system disk on LVM with a snapshot and room to claim, a media drive, and a drive not mounted. */
const report: StorageReport = {
  devices: [
    device("/dev/nvme0n1", "disk", 0, 1000 * GiB, { transport: "nvme", protectedReason: "system disk" }),
    device("/dev/nvme0n1p1", "part", 1, 1 * GiB, { fstype: "vfat", mountpoints: ["/boot/efi"] }),
    device("/dev/nvme0n1p2", "part", 1, 999 * GiB, { fstype: "LVM2_member", holdsVolumeGroups: ["ubuntu-vg"] }),
    device("/dev/mapper/ubuntu--vg-ubuntu--lv", "lvm", 2, 600 * GiB, { fstype: "ext4", mountpoints: ["/"], volumeGroup: "ubuntu-vg", logicalVolume: "ubuntu-lv" }),
    device("/dev/sda", "disk", 0, 4000 * GiB, { transport: "usb", removable: true }),
    device("/dev/sda1", "part", 1, 4000 * GiB, { fstype: "ext4", mountpoints: ["/mnt/media"] }),
    device("/dev/sdb", "disk", 0, 2000 * GiB, { transport: "usb", removable: true }),
    device("/dev/sdb1", "part", 1, 2000 * GiB, { fstype: "exfat", label: "Backup" }),
  ],
  mounts: [
    { target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv", fstype: "ext4", sizeBytes: 600 * GiB, usedBytes: 162 * GiB, availableBytes: 438 * GiB },
    { target: "/mnt/media", source: "/dev/sda1", fstype: "ext4", sizeBytes: 4000 * GiB, usedBytes: 2720 * GiB, availableBytes: 1280 * GiB },
  ],
  fstab: [{ device: "UUID=77aa-media", mountpoint: "/mnt/media", fstype: "ext4", options: "defaults,nofail", managedName: "media" }],
  volumeGroups: [{ name: "ubuntu-vg", physicalVolumes: ["/dev/nvme0n1p2"], sizeBytes: 999 * GiB, usedBytes: 620 * GiB, freeBytes: 379 * GiB, logicalVolumes: [
    { path: "/dev/mapper/ubuntu--vg-ubuntu--lv", name: "ubuntu-lv", sizeBytes: 600 * GiB, fstype: "ext4", mountpoints: ["/"], growable: true },
    { path: "/dev/mapper/ubuntu--vg-snap", name: "snap-before-upgrade", sizeBytes: 20 * GiB, fstype: "ext4", mountpoints: [], growable: false, snapshot: true },
  ] }],
  shares: [],
  tools: { cifs: true, nfs: true, smbclient: true, showmount: true },
};

describe("the disk map in Home + Ops", () => {
  it("draws each disk to scale: boot, volumes, snapshots, room to claim, and what is not mounted", () => {
    const rows = diskRows(report);
    expect(rows.map((row) => [row.name, row.plain])).toEqual([
      ["nvme0n1", "System · NVMe 1 TB"],
      ["sda1", "Media drive · USB 4 TB"],
      ["sdb1", "Backup drive · USB 2 TB"],
    ]);
    expect(rows[0].segments.map((segment) => [segment.kind, segment.label])).toEqual([
      ["boot", "/boot/efi"],
      ["used", "/ ubuntu-lv · 600 GiB · 27% used"],
      ["snap", "snapshot"],
      ["free", "379 GiB not in use"],
    ]);
    expect(rows[1].segments.map((segment) => [segment.kind, Math.round(segment.bytes / GiB)])).toEqual([["used", 2720], ["room", 1280]]);
    expect(rows[2].segments.map((segment) => [segment.kind, segment.label])).toEqual([["off", "exFAT · not mounted"]]);
  });

  it("says each bar in words, since the picture alone is not read out", () => {
    renderLead();
    expect(screen.getByRole("heading", { name: "Disk map" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /^sdb1: sdb1, exFAT, not mounted/ })).toBeTruthy();
  });

  it("lists the partitions beside the one fix and the drives that reconnect, as drawn", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const control = renderLead();
    expect(partitionRows(report).map((row) => [row.name, row.tag, row.mountedAt])).toEqual([
      ["nvme0n1p1", "system", "/boot/efi"],
      ["ubuntu-lv", "system", "/"],
      ["sda1", "removable", "/mnt/media"],
      ["sdb1", "removable", "—"],
    ]);
    const table = screen.getByRole("table", { name: "Partitions, volumes and snapshots" });
    expect(within(table).getAllByRole("row")).toHaveLength(5);

    // The fix is Drives' own, at its tier, through the approval dialog.
    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("379 GiB of the system disk is not in use")).toBeTruthy();
    const claim = within(needs).getByRole("button", { name: "Use the rest of the disk: 379 GiB of the system disk is not in use" });
    expect(claim.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(claim);
    expect(await screen.findByRole("dialog", { name: "Grow / by 347 GiB" })).toBeTruthy();

    // The switch is the same control as a drive's row on Drives.
    const drops = screen.getByRole("region", { name: "If a drive drops" });
    const media = within(drops).getByRole("switch", { name: "/mnt/media: reconnect if it drops" });
    expect(media.getAttribute("aria-checked")).toBe("true");
    expect(within(drops).getByText("Reconnects by itself · 1 of 3 tries used in the last day")).toBeTruthy();
    fireEvent.click(media);
    expect(control.disarm).toHaveBeenCalledWith("media");
  });
});

function renderLead() {
  const control: AutoReconnectControl = {
    status: { limits: { cooldownMinutes: 30, maxAttempts: 3, windowHours: 24 }, drives: { media: { flowId: "f1", flowName: "Reconnect media", enabled: true, held: false, heldSince: null, heldBecause: null, attempts: 1, lastAttemptAt: null, lastOutcome: null, lastCheckFoundErrors: false } } },
    pending: null, error: null, arm: vi.fn(async () => undefined), disarm: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined),
  };
  const props = { report, loading: false, csrfToken: "csrf", role: "owner", autoReconnect: control, onChanged: vi.fn() } as unknown as StorageLeadProps;
  render(<StorageLead {...props} />);
  return control;
}
