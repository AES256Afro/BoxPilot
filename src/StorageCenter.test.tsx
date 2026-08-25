import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StorageCenter from "./StorageCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const GiB = 1024 ** 3;
const base = { protected: false, protectedReason: null, volumeGroup: null, logicalVolume: null, holdsVolumeGroups: [], mountedBelow: [] };

const report = {
  devices: [
    { ...base, path: "/dev/nvme0n1", type: "disk", sizeBytes: 953 * GiB, fstype: null, uuid: null, label: null, model: "Inland TN320", transport: "nvme", mountpoints: [], readOnly: false, removable: false, depth: 0, protected: true, protectedReason: "system disk", mountedBelow: ["/boot", "/"] },
    { ...base, path: "/dev/nvme0n1p2", type: "part", sizeBytes: 2 * GiB, fstype: "ext4", uuid: "boot-uuid", label: null, model: null, transport: null, mountpoints: ["/boot"], readOnly: false, removable: false, depth: 1, protected: true, protectedReason: "system disk" },
    { ...base, path: "/dev/nvme0n1p3", type: "part", sizeBytes: 950 * GiB, fstype: "LVM2_member", uuid: "pv-uuid", label: null, model: null, transport: null, mountpoints: [], readOnly: false, removable: false, depth: 1, protected: true, protectedReason: "system disk", holdsVolumeGroups: ["ubuntu-vg"], mountedBelow: ["/"] },
    { ...base, path: "/dev/mapper/ubuntu--vg-ubuntu--lv", type: "lvm", sizeBytes: 100 * GiB, fstype: "ext4", uuid: "root-uuid", label: null, model: null, transport: null, mountpoints: ["/"], readOnly: false, removable: false, depth: 2, protected: true, protectedReason: "system disk", volumeGroup: "ubuntu-vg", logicalVolume: "ubuntu-lv" },
    { ...base, path: "/dev/sdb", type: "disk", sizeBytes: 4000 * GiB, fstype: null, uuid: null, label: null, model: "WD Elements", transport: "usb", mountpoints: [], readOnly: false, removable: true, depth: 0 },
    { ...base, path: "/dev/sdb1", type: "part", sizeBytes: 4000 * GiB, fstype: "ext4", uuid: "data-uuid", label: "media", model: null, transport: null, mountpoints: [], readOnly: false, removable: true, depth: 1 },
  ],
  mounts: [
    { target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv", fstype: "ext4", sizeBytes: 100, usedBytes: 40, availableBytes: 60 },
    { target: "/mnt/olddata", source: "/dev/sdc1", fstype: "ext4", sizeBytes: 100, usedBytes: 95, availableBytes: 5 },
  ],
  fstab: [
    { device: "UUID=root-uuid", mountpoint: "/", fstype: "ext4", options: "defaults", managedName: null },
    { device: "UUID=old-uuid", mountpoint: "/mnt/olddata", fstype: "ext4", options: "defaults,nofail", managedName: "olddata" },
  ],
  volumeGroups: [{ name: "ubuntu-vg", physicalVolumes: ["/dev/nvme0n1p3"], sizeBytes: 950 * GiB, usedBytes: 100 * GiB, freeBytes: 850 * GiB, logicalVolumes: [{ path: "/dev/mapper/ubuntu--vg-ubuntu--lv", name: "ubuntu-lv", sizeBytes: 100 * GiB, fstype: "ext4", mountpoints: ["/"], growable: true }] }],
  shares: [],
  tools: { cifs: true, nfs: true, smbclient: true, showmount: true },
};
const job = (type: string, risk: string) => ({ job: { id: `job-${type}`, type: `op:${type}`, title: type, state: "awaiting_approval", risk, error: null, result: null, steps: [], approvals: [] }, approval: { tier: risk, passwordRequired: risk === "high", elevated: false, mode: "tiered", reason: `${risk} risk` } });

function mockFetch(overview: unknown, staged: Record<string, string>, extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "/api/v1/storage/overview") return json(overview);
    const handled = extra(url, init);
    if (handled) return handled;
    const match = url.match(/\/operations\/([a-z.]+)\/jobs$/);
    if (match) { staged[match[1]] = init?.body as string; return json(job(match[1], match[1] === "storage.format" ? "high" : "medium"), 201); }
    return json({ error: `unexpected ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Storage center", () => {
  it("offers Mount for unmounted filesystems and stages it with the fstab preview", async () => {
    const staged: Record<string, string> = {};
    mockFetch(report, staged);
    render(<StorageCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("WD Elements")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mount" })); // /dev/sdb1, prefilled from its label
    fireEvent.change(screen.getByLabelText("Mount name"), { target: { value: "media" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Mount" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.getByText(/UUID=data-uuid \/mnt\/media ext4 defaults,nofail 0 2/)).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged["storage.mount"] ?? "{}")).toEqual({ parameters: { uuid: "data-uuid", name: "media" } }));
  });

  it("never offers Mount or Format on the system disk, its LVM physical volume, or the root volume", async () => {
    mockFetch(report, {});
    render(<StorageCenter csrfToken="csrf-token" />);
    await screen.findByText("WD Elements");
    const rows = screen.getAllByRole("row");
    const row = (path: string) => rows.find((candidate) => candidate.textContent?.includes(path))?.textContent ?? "";
    for (const path of ["/dev/nvme0n1p3", "/dev/nvme0n1p2", "/dev/mapper/ubuntu--vg-ubuntu--lv"]) {
      expect(row(path)).not.toContain("Mount");
      expect(row(path)).not.toContain("Format");
    }
    expect(row("/dev/nvme0n1p3")).toContain("LVM physical volume");
    expect(row("/dev/nvme0n1p3")).toContain("ubuntu-vg");
    expect(row("/dev/mapper/ubuntu--vg-ubuntu--lv")).toContain("LVM volume");
    // Format is offered only on the empty external disk and its partition.
    expect(screen.getAllByRole("button", { name: "Format" })).toHaveLength(2);
  });

  it("offers to claim unallocated LVM space with an online resize", async () => {
    const staged: Record<string, string> = {};
    mockFetch(report, staged);
    render(<StorageCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("850.0 GiB of ubuntu-vg is not in use")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use the rest of the disk" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.getByText(/keeping/)).toBeTruthy();
    expect(screen.getByText("32 GiB")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged["storage.lvm.extend"] ?? "{}")).toEqual({ parameters: { path: "/dev/mapper/ubuntu--vg-ubuntu--lv" } }));
  });

  it("takes snapshots of the root volume and requires the snapshot name to roll back", async () => {
    const staged: Record<string, string> = {};
    mockFetch({ ...report, snapshots: [{ path: "/dev/mapper/ubuntu--vg-boxpilot--snap--20260821--2005--before--upgrade", name: "boxpilot-snap-20260821-2005-before-upgrade", volumeGroup: "ubuntu-vg", sizeBytes: 100 * GiB, origin: "/dev/mapper/ubuntu--vg-ubuntu--lv", sizeGiB: 10, createdAt: "2026-08-21T20:05:00.000Z", suffix: "before-upgrade" }] }, staged, (url) => (url.match(/\/operations\/storage\.lvm\.snapshot\.rollback\/jobs$/) ? json(job("storage.lvm.snapshot.rollback", "high"), 201) : null));
    render(<StorageCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("boxpilot-snap-20260821-2005-before-upgrade", { exact: false })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Snapshot size"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Snapshot label"), { target: { value: "test-run" } });
    fireEvent.click(screen.getByRole("button", { name: "Take a snapshot" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged["storage.lvm.snapshot.create"] ?? "{}")).toEqual({ parameters: { path: "/dev/mapper/ubuntu--vg-ubuntu--lv", sizeGiB: 20, suffix: "test-run" } }));
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    expect(await screen.findByText("High risk")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Approval password"), { target: { value: "correct horse battery" } });
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Typed confirmation"), { target: { value: "boxpilot-snap-20260821-2005-before-upgrade" } });
    expect(approve.disabled).toBe(false);
  });

  it("requires typing the device name before a format can be approved", async () => {
    mockFetch(report, {});
    render(<StorageCenter csrfToken="csrf-token" />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Format" }))[0]);
    expect(await screen.findByText("High risk")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Approval password"), { target: { value: "correct horse battery" } });
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Typed confirmation"), { target: { value: "/dev/sdb" } });
    expect(approve.disabled).toBe(false);
  });

  it("offers Unmount only for BoxPilot-managed mounts", async () => {
    mockFetch(report, {});
    render(<StorageCenter csrfToken="csrf-token" />);
    expect(await screen.findByRole("button", { name: "Unmount" })).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows.find((row) => row.textContent?.includes("ubuntu--vg-ubuntu--lv") && row.textContent?.includes("40"))?.textContent).not.toContain("Unmount");
    expect(screen.getByText(/95%/)).toBeTruthy();
  });

  it("discovers a NAS, lists its shares, and stages the mount with credentials", async () => {
    const staged: Record<string, string> = {};
    let listBody: string | undefined;
    mockFetch(report, staged, (url, init) => {
      if (url === "/api/v1/storage/shares/discover") return json({ devices: [{ address: "192.168.1.50", name: "mycloud", smb: true, nfs: false, mac: null, interface: "eno1" }], scanned: 253, interfaces: [] });
      if (url === "/api/v1/storage/shares/list") { listBody = init?.body as string; return json({ shares: [{ name: "Public", comment: "Public Share" }, { name: "jamie", comment: null }] }); }
      return null;
    });
    render(<StorageCenter csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Find devices on my network" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use this device" }));
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("mycloud");
    fireEvent.change(screen.getByLabelText("Share username"), { target: { value: "jamie" } });
    fireEvent.change(screen.getByLabelText("Share password"), { target: { value: "hunter2 hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "List shares" }));
    fireEvent.click(await screen.findByRole("button", { name: "jamie" }));
    expect(JSON.parse(listBody ?? "{}")).toEqual({ kind: "smb", host: "mycloud", username: "jamie", password: "hunter2 hunter2", domain: null });
    expect((screen.getByLabelText("Share mount name") as HTMLInputElement).value).toBe("jamie");
    fireEvent.change(screen.getByLabelText("Share mount name"), { target: { value: "nas-jamie" } });
    fireEvent.click(screen.getByRole("button", { name: "Mount share" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.getByText(/share-nas-jamie\.cred/)).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged["share.mount"] ?? "{}")).toEqual({ parameters: { kind: "smb", host: "mycloud", share: "jamie", name: "nas-jamie", username: "jamie", password: "hunter2 hunter2" } }));
  });

  it("says why Mount share will not respond, instead of sitting there disabled", async () => {
    // A disabled primary button that explains nothing is a dead end, and placeholders read like
    // filled-in values — so an empty share name looks exactly like a share name.
    mockFetch(report, {}, (url) => {
      if (url === "/api/v1/storage/shares/list") return json({ shares: [{ name: "Public", comment: null }, { name: "jamie", comment: null }] });
      return null;
    });
    render(<StorageCenter csrfToken="csrf-token" />);
    fireEvent.change(await screen.findByLabelText("Host"), { target: { value: "192.168.1.50" } });
    expect(screen.getByRole("button", { name: "Mount share" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Pick a share below, or type its name.")).toBeTruthy();

    // Picking a share fills both fields, and the button comes alive.
    fireEvent.click(screen.getByRole("button", { name: "List shares" }));
    fireEvent.click(await screen.findByRole("button", { name: "jamie" }));
    expect(screen.queryByText("Pick a share below, or type its name.")).toBeNull();
    expect(screen.getByRole("button", { name: "Mount share" })).toHaveProperty("disabled", false);

    // Clearing the mount name blocks it again, with the reason that applies now.
    fireEvent.change(screen.getByLabelText("Share mount name"), { target: { value: "" } });
    expect(screen.getByText("Give it a folder name under /mnt (lower case, no spaces).")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mount share" })).toHaveProperty("disabled", true);
  });

  it("lists mounted shares and explains the empty scan; offers the missing client tools", async () => {
    const staged: Record<string, string> = {};
    mockFetch({ ...report, tools: { cifs: false, nfs: true, smbclient: false, showmount: true }, shares: [{ name: "nas-media", kind: "smb", source: "//mycloud/Public", mountpoint: "/mnt/nas-media", readOnly: true, automount: true, mounted: false, sizeBytes: null, usedBytes: null, availableBytes: null }] }, staged, (url) => (url === "/api/v1/storage/shares/discover" ? json({ devices: [], scanned: 253, interfaces: [] }) : null));
    render(<StorageCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("Connects on first use")).toBeTruthy();
    expect(screen.getByText("//mycloud/Public")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Mount share" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Find devices on my network" }));
    expect(await screen.findByText(/Nothing answered on ports 445 or 2049 across 253 addresses/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install cifs-utils" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged["apt.install"] ?? "{}")).toEqual({ parameters: { packages: ["cifs-utils"] } }));
  });
});
