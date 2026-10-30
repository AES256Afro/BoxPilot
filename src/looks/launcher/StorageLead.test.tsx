import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoReconnectControl } from "../../AutoReconnect";
import { stubFetch } from "../../home/testData";
import type { StorageReport } from "../../pages/storage/types";
import { TopBarSlotProvider } from "../../shell/TopBarSlot";
import { PageHeader } from "../../ui";
import { DrawnLookProvider } from "../drawnLook";
import StorageLead from "./StorageLead";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const GiB = 1024 ** 3;
const device = (path: string, extra: Partial<StorageReport["devices"][number]>): StorageReport["devices"][number] => ({
  path, type: "part", sizeBytes: 100 * GiB, fstype: null, uuid: null, label: null, model: null, transport: null, mountpoints: [], readOnly: false, removable: false, depth: 1,
  protected: false, protectedReason: null, volumeGroup: null, logicalVolume: null, holdsVolumeGroups: [], mountedBelow: [], ...extra,
});

const report: StorageReport = {
  devices: [
    device("/dev/nvme0n1", { type: "disk", depth: 0, sizeBytes: 954 * GiB, transport: "nvme", protected: true, protectedReason: "system disk" }),
    device("/dev/nvme0n1p3", { fstype: "LVM2_member", protected: true, protectedReason: "system disk", holdsVolumeGroups: ["ubuntu-vg"] }),
    device("/dev/mapper/ubuntu--vg-ubuntu--lv", { type: "lvm", depth: 2, sizeBytes: 700 * GiB, fstype: "ext4", mountpoints: ["/"], protected: true, protectedReason: "system disk", volumeGroup: "ubuntu-vg", logicalVolume: "ubuntu-lv" }),
    device("/dev/sda", { type: "disk", depth: 0, sizeBytes: 4000 * GiB, transport: "usb", removable: true, protected: true }),
    device("/dev/sda1", { sizeBytes: 4000 * GiB, fstype: "ext4", uuid: "media-uuid", label: "media", mountpoints: ["/mnt/media"], removable: true }),
    device("/dev/sdb", { type: "disk", depth: 0, sizeBytes: 2000 * GiB, transport: "usb", removable: true }),
    device("/dev/sdb1", { sizeBytes: 2000 * GiB, fstype: "exfat", uuid: "backup-uuid", label: "Backup", removable: true }),
  ],
  mounts: [
    { target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv", fstype: "ext4", sizeBytes: 700 * GiB, usedBytes: 212 * GiB, availableBytes: 488 * GiB },
    { target: "/mnt/media", source: "/dev/sda1", fstype: "ext4", sizeBytes: 4000 * GiB, usedBytes: 2720 * GiB, availableBytes: 1280 * GiB },
  ],
  fstab: [{ device: "UUID=media-uuid", mountpoint: "/mnt/media", fstype: "ext4", options: "defaults,nofail", managedName: "media" }],
  volumeGroups: [{ name: "ubuntu-vg", physicalVolumes: ["/dev/nvme0n1p3"], sizeBytes: 1000 * GiB, usedBytes: 700 * GiB, freeBytes: 300 * GiB, logicalVolumes: [
    { path: "/dev/mapper/ubuntu--vg-ubuntu--lv", name: "ubuntu-lv", sizeBytes: 700 * GiB, fstype: "ext4", mountpoints: ["/"], growable: true },
  ] }],
  snapshots: [{ path: "/dev/mapper/ubuntu--vg-snap", name: "boxpilot-snap-20260821-0900-before-upgrade", volumeGroup: "ubuntu-vg", sizeBytes: 20 * GiB, sizeGiB: 20, createdAt: "2026-08-21T09:00:00Z", suffix: "before-upgrade" }],
  shares: [{ name: "nas-public", kind: "smb", source: "//nas.local/Public", mountpoint: "/mnt/nas-public", readOnly: false, automount: true, mounted: true, sizeBytes: null, usedBytes: null, availableBytes: null }],
  tools: { cifs: true, nfs: true, smbclient: true, showmount: true },
};

function control(): AutoReconnectControl {
  return { status: { limits: { cooldownMinutes: 30, maxAttempts: 3, windowHours: 24 }, drives: {} }, pending: null, error: null, arm: vi.fn(async () => {}), disarm: vi.fn(async () => {}), refresh: vi.fn(async () => {}) };
}

describe("the Launcher's top of Storage", () => {
  it("names each drive plainly, data first, with how full and one thing about it", () => {
    vi.stubGlobal("fetch", stubFetch());
    const onTab = vi.fn();
    const reconnect = control();
    render(<StorageLead csrfToken="csrf" role="owner" report={report} loading={false} forecasts={[{ target: "/mnt/media", daysToFull: 11, availableBytes: null, totalBytes: null, samples: 14 }]}
      fsSnapshots={null} sambaShares={[{ name: "media", path: "/mnt/media" }]} shareHost={null} autoReconnect={reconnect} onTab={onTab} onChanged={vi.fn()} />);
    const drives = screen.getByRole("region", { name: "Drives" });
    expect([...drives.querySelectorAll(".launcher-drive__name b")].map((name) => name.textContent)).toEqual(["Media drive", "System disk", "Backup drive"]);
    expect(within(drives).getByText("/mnt/media · ext4 · USB 3.9 TB")).toBeTruthy();
    expect(within(drives).getByRole("meter", { name: "Media drive: 68% used" })).toBeTruthy();
    // Filling within two weeks draws its bar in the warning's colour, with its mark.
    expect(within(drives).getByText("Media drive").closest("li")?.getAttribute("data-status")).toBe("warning");

    // The Drives tab's own switch, armed straight away as it is there.
    fireEvent.click(within(drives).getByRole("switch", { name: /Reconnect if it drops/ }));
    expect(reconnect.arm).toHaveBeenCalledWith("media");
    fireEvent.click(within(drives).getByRole("button", { name: /^Mount \/dev\/sdb1/ }));
    expect(onTab).toHaveBeenLastCalledWith("drives");

    expect(within(screen.getByRole("region", { name: "Shared folders" })).getByText("nas-public")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Snapshots" })).getByText("Before upgrade")).toBeTruthy();
  });

  it("offers the unused space as the Drives tab does, through the approval dialog at its tier", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<StorageLead csrfToken="csrf" role="owner" report={report} loading={false} forecasts={[]} fsSnapshots={null} sambaShares={[]} shareHost={null} autoReconnect={control()} onTab={vi.fn()} onChanged={vi.fn()} />);
    const needs = screen.getByRole("region", { name: "What needs you" });
    expect(within(needs).getByText("300 GB of the system disk is not in use")).toBeTruthy();
    const claim = within(needs).getByRole("button", { name: "Use the rest of the disk" });
    expect(claim.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(claim);
    expect(await screen.findByRole("dialog", { name: /^Grow \/ by/ })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/storage.lvm.extend/jobs", expect.objectContaining({ method: "POST" }));
  });

  it("offers a viewer the facts and no fix", () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<StorageLead csrfToken="csrf" role="viewer" report={report} loading={false} forecasts={[]} fsSnapshots={null} sambaShares={[]} shareHost={null} autoReconnect={control()} onTab={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Use the rest of the disk" })).toBeNull();
    expect(screen.getByRole("switch", { name: /Reconnect if it drops/ }).hasAttribute("disabled")).toBe(true);
  });
});

describe("a page's header in the Launcher", () => {
  it("puts the page's one h1 at the top of the page and names the server in the bar", () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    render(
      <DrawnLookProvider value="launcher">
        <TopBarSlotProvider value={slot}>
          <PageHeader title="Storage" status={{ status: "warning", label: "Fills in ~11 days" }} actions={<button type="button">Read again</button>} />
        </TopBarSlotProvider>
      </DrawnLookProvider>,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Storage" });
    expect(slot.contains(heading)).toBe(false);
    expect(heading.closest(".ui-page-header--titled")).not.toBeNull();
    expect(slot.querySelector("h1")).toBeNull();
    expect(slot.querySelector(".cc-crumb__host")?.textContent).toBe("boxpilot");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    cleanup();
    slot.remove();
  });
});
