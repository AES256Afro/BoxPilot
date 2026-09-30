import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StoragePage from "./StoragePage";

beforeEach(() => { window.history.replaceState(null, "", "/?view=storage"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const GiB = 1024 ** 3;
const base = { protected: false, protectedReason: null, volumeGroup: null, logicalVolume: null, holdsVolumeGroups: [], mountedBelow: [] };

const report = {
  devices: [
    { ...base, path: "/dev/nvme0n1", type: "disk", sizeBytes: 953 * GiB, fstype: null, uuid: null, label: null, model: "Example NVMe", transport: "nvme", mountpoints: [], readOnly: false, removable: false, depth: 0, protected: true, protectedReason: "system disk", mountedBelow: ["/boot", "/"] },
    { ...base, path: "/dev/nvme0n1p2", type: "part", sizeBytes: 2 * GiB, fstype: "ext4", uuid: "boot-uuid", label: null, model: null, transport: null, mountpoints: ["/boot"], readOnly: false, removable: false, depth: 1, protected: true, protectedReason: "system disk" },
    { ...base, path: "/dev/nvme0n1p3", type: "part", sizeBytes: 950 * GiB, fstype: "LVM2_member", uuid: "pv-uuid", label: null, model: null, transport: null, mountpoints: [], readOnly: false, removable: false, depth: 1, protected: true, protectedReason: "system disk", holdsVolumeGroups: ["ubuntu-vg"], mountedBelow: ["/"] },
    { ...base, path: "/dev/mapper/ubuntu--vg-ubuntu--lv", type: "lvm", sizeBytes: 100 * GiB, fstype: "ext4", uuid: "root-uuid", label: null, model: null, transport: null, mountpoints: ["/"], readOnly: false, removable: false, depth: 2, protected: true, protectedReason: "system disk", volumeGroup: "ubuntu-vg", logicalVolume: "ubuntu-lv" },
    { ...base, path: "/dev/sdb", type: "disk", sizeBytes: 4000 * GiB, fstype: null, uuid: null, label: null, model: "Example USB HDD", transport: "usb", mountpoints: [], readOnly: false, removable: true, depth: 0 },
    { ...base, path: "/dev/sdb1", type: "part", sizeBytes: 4000 * GiB, fstype: "ext4", uuid: "data-uuid", label: "media", model: null, transport: null, mountpoints: [], readOnly: false, removable: true, depth: 1 },
    { ...base, path: "/dev/sdc1", type: "part", sizeBytes: 100, fstype: "ext4", uuid: "old-uuid", label: null, model: null, transport: null, mountpoints: ["/mnt/olddata"], readOnly: false, removable: true, depth: 0 },
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
const samba = { installed: true, running: true, configured: true, error: null, config: { managed: true, workgroup: "WORKGROUP", scope: "tailscale", interfaces: ["lo", "tailscale0"], shares: [{ name: "Media", path: "/mnt/nas-media", comment: "Films", readOnly: true, guest: true, users: [], forceUser: "homebox" }] }, users: ["jamie"], tailscaleDnsName: "homebox.tail1234.ts.net", tailscaleAddress: "100.64.0.5", lanAddress: "192.168.1.10" };
const nfs = { installed: true, running: true, configured: true, error: null, config: { managed: true, scope: "tailscale", exports: [{ path: "/srv/media", readOnly: true, clients: ["100.64.0.0/10"] }] }, tailscaleDnsName: "homebox.tail1234.ts.net", tailscaleAddress: "100.64.0.5", lanAddress: "192.168.1.10" };
const limits = { cooldownMinutes: 30, maxAttempts: 3, windowHours: 24 };
const job = (type: string, risk: string) => ({ job: { id: `job-${type}`, type: `op:${type}`, title: type, state: "awaiting_approval", risk, error: null, result: null, steps: [], approvals: [] }, approval: { tier: risk, passwordRequired: risk === "high", elevated: false, mode: "tiered", reason: `${risk} risk` } });
const highRisk = new Set(["storage.format", "storage.lvm.snapshot.rollback"]);

interface Setup { overview?: unknown; samba?: unknown; nfs?: unknown; extra?: (url: string, init?: RequestInit) => Response | null }

/** Every read the page makes, answered; staged jobs recorded by operation. */
function mockFetch({ overview = report, samba: sambaState = samba, nfs: nfsState = nfs, extra = () => null }: Setup = {}) {
  const staged: Record<string, string> = {};
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const handled = extra(url, init);
    if (handled) return handled;
    if (url === "/api/v1/storage/overview") return json(overview);
    if (url === "/api/v1/storage/samba") return json(sambaState);
    if (url === "/api/v1/storage/nfs") return json(nfsState);
    if (url === "/api/v1/drives/auto-reconnect") return json({ limits, drives: {} });
    if (url === "/api/v1/schedules") return json({ schedules: [] });
    if (url === "/api/v1/storage/forecast") return json({ forecasts: [], usage: [] });
    const match = url.match(/\/operations\/([a-z.-]+)\/jobs$/);
    if (match) { staged[match[1]] = init?.body as string; return json(job(match[1], highRisk.has(match[1]) ? "high" : "medium"), 201); }
    return json({ error: `unexpected ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { staged, fetchMock };
}
const openTab = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));
const rowWith = (text: string) => screen.getAllByRole("row").find((row) => row.textContent?.includes(text)) as HTMLElement;

describe("Storage page", () => {
  it("puts the verdict and the facts first, then the tabs, with what the page is for behind the info toggle", async () => {
    mockFetch();
    render(<StoragePage csrfToken="csrf-token" />);
    expect(await screen.findByText("Example USB HDD")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Storage" })).toBeTruthy();
    // /mnt/olddata is 95% full: the verdict says so, in words and in red.
    expect(screen.getByText("1 nearly full").closest(".ui-chip")?.getAttribute("data-status")).toBe("danger");
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("2 disks · 1 removable · 2 mounted · 0 network shares (0 connected) · 850.0 GiB unallocated");
    expect(screen.getAllByRole("tab").map((tab) => /^[A-Za-z ]+/.exec(tab.textContent ?? "")?.[0].trim())).toEqual(["Drives", "Shares", "File sharing", "Snapshots", "Mounts"]);
    const about = screen.getByRole("button", { name: "About Storage" });
    expect(about.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(about);
    expect(screen.getByText(/Format erases everything on a drive/).closest("[hidden]")).toBeNull();
  });

  it("keeps the open tab in the address", async () => {
    mockFetch();
    render(<StoragePage csrfToken="csrf-token" />);
    await screen.findByText("Example USB HDD");
    openTab(/^Snapshots/);
    expect(window.location.search).toBe("?view=storage&tab=snapshots");
    openTab(/^Drives/);
    expect(window.location.search).toBe("?view=storage");
  });

  it("says it could not read the drives rather than showing an empty, healthy page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "The helper did not answer" }, 503)));
    render(<StoragePage csrfToken="csrf-token" />);
    expect(await screen.findByText("The storage state could not be read")).toBeTruthy();
    expect(screen.getByText("Not read").closest(".ui-chip")?.getAttribute("data-status")).toBe("unknown");
  });

  it("takes an answer without drives or mounts for no reading at all, not an empty healthy server", async () => {
    mockFetch({ overview: {}, samba: {}, nfs: {} });
    render(<StoragePage csrfToken="csrf-token" />);
    expect(await screen.findByText("The storage state could not be read")).toBeTruthy();
    expect(screen.getByText("Not read")).toBeTruthy();
    expect(screen.queryByText("Room to spare")).toBeNull();
    openTab(/^File sharing/);
    expect(await screen.findByText("The file server could not be read")).toBeTruthy();
  });

  describe("Drives", () => {
    it("mounts a drive from a sheet and stages it with the fstab preview", async () => {
      const { staged } = mockFetch();
      render(<StoragePage csrfToken="csrf-token" />);
      const mount = await screen.findByRole("button", { name: "Mount /dev/sdb1" });
      expect(mount.getAttribute("data-risk")).toBe("medium");
      fireEvent.click(mount);
      const sheet = screen.getByRole("dialog", { name: "/dev/sdb1" });
      // Prefilled from the label; ext4 keeps its ownership, so app-writable starts off.
      expect((within(sheet).getByLabelText("Mount name") as HTMLInputElement).value).toBe("media");
      expect((within(sheet).getByLabelText("Writable by my apps") as HTMLInputElement).checked).toBe(false);
      fireEvent.change(within(sheet).getByLabelText("Mount name"), { target: { value: "boxpilot" } });
      expect(within(sheet).getByText("boxpilot is the backup destination's folder.")).toBeTruthy();
      expect(within(sheet).getByRole("button", { name: /^Mount$/ })).toHaveProperty("disabled", true);
      fireEvent.change(within(sheet).getByLabelText("Mount name"), { target: { value: "media" } });
      fireEvent.click(within(sheet).getByRole("button", { name: /^Mount$/ }));
      expect(screen.queryByRole("dialog", { name: "/dev/sdb1" })).toBeNull();
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      expect(screen.getByText(/nofail/)).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["storage.mount"] ?? "{}")).toEqual({ parameters: { uuid: "data-uuid", name: "media" } }));
    });

    it("never offers Mount or Format on the system disk, its LVM physical volume, or the root volume", async () => {
      mockFetch();
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      for (const path of ["/dev/nvme0n1p3", "/dev/nvme0n1p2", "/dev/mapper/ubuntu--vg-ubuntu--lv"]) {
        expect(within(rowWith(path)).queryByRole("button")).toBeNull();
      }
      expect(rowWith("/dev/nvme0n1p3").textContent).toContain("LVM physical volume for ubuntu-vg");
      expect(rowWith("/dev/mapper/ubuntu--vg-ubuntu--lv").textContent).toContain("LVM volume");
      // Format is offered only on the empty external disk and its partition, as a high-risk action.
      const formats = screen.getAllByRole("button", { name: /^Erase and format/ });
      expect(formats.map((button) => button.getAttribute("aria-label"))).toEqual(["Erase and format /dev/sdb", "Erase and format /dev/sdb1"]);
      expect(formats[0].getAttribute("data-risk")).toBe("high");
    });

    it("requires typing the device name before a format can be approved", async () => {
      mockFetch();
      render(<StoragePage csrfToken="csrf-token" />);
      fireEvent.click(await screen.findByRole("button", { name: "Erase and format /dev/sdb" }));
      expect(await screen.findByText("High risk")).toBeTruthy();
      const approve = screen.getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
      fireEvent.change(screen.getByLabelText("Approval password"), { target: { value: "correct horse battery" } });
      expect(approve.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Typed confirmation"), { target: { value: "/dev/sdb" } });
      expect(approve.disabled).toBe(false);
    });

    it("offers to claim unallocated LVM space with an online resize", async () => {
      const { staged } = mockFetch();
      render(<StoragePage csrfToken="csrf-token" />);
      expect(await screen.findByText("850.0 GiB of ubuntu-vg is not in use")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Use the rest of the disk" }));
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      expect(screen.getByText("32 GiB")).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["storage.lvm.extend"] ?? "{}")).toEqual({ parameters: { path: "/dev/mapper/ubuntu--vg-ubuntu--lv" } }));
    });

    it("checks a drive BoxPilot mounted, naming the apps it pauses and the shares it disconnects", async () => {
      const catalog = { applications: [{ manifest: { id: "plex", name: "Plex", volumes: [{ id: "media", hostPath: null }] }, live: { installed: true, state: { values: { volumes: { media: "/mnt/olddata/films" } } } } }] };
      const sambaFilms = { ...samba, config: { ...samba.config, scope: "lan", shares: [{ name: "Films", path: "/mnt/olddata/films", comment: null, readOnly: false, guest: false, users: [] }, { name: "Documents", path: "/srv/documents", comment: null, readOnly: false, guest: false, users: [] }] } };
      const { staged, fetchMock } = mockFetch({ samba: sambaFilms, extra: (url) => (url === "/api/v1/catalog?view=summary" ? json(catalog) : null) });
      render(<StoragePage csrfToken="csrf-token" />);
      const check = await screen.findByRole("button", { name: "Check this drive: /mnt/olddata" });
      expect(check.getAttribute("data-risk")).toBe("medium");
      // Only BoxPilot's own drives: the root filesystem has no check, and no unmount.
      expect(screen.getAllByRole("button", { name: /^Check this drive/ })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /^Unmount/ }).map((button) => button.getAttribute("aria-label"))).toEqual(["Unmount /mnt/olddata"]);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/catalog?view=summary"));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      fireEvent.click(check);
      expect(await screen.findByText(/Pauses Plex while/)).toBeTruthy();
      expect(screen.getByText(/runs e2fsck -fn on it, then mounts it again and starts them\. Computers using the Films share are disconnected for it and reconnect by themselves\. The check only reads/)).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["storage.check"] ?? "{}")).toEqual({ parameters: { name: "olddata" } }));
    });

    it("arms a drive to reconnect by itself with its switch, and states the limits once", async () => {
      let armed = false;
      let request: { method?: string; csrf: string | null } | null = null;
      mockFetch({ extra: (url, init) => {
        if (url === "/api/v1/drives/auto-reconnect") return json({ limits, drives: armed ? { olddata: { flowId: "flow-1", flowName: "Reconnect /mnt/olddata", enabled: true, held: false, heldSince: null, heldBecause: null, attempts: 0, lastAttemptAt: null, lastOutcome: null, lastCheckFoundErrors: false } } : {} });
        if (url === "/api/v1/drives/olddata/auto-reconnect") { request = { method: init?.method, csrf: new Headers(init?.headers).get("X-BoxPilot-CSRF") }; armed = true; return json({ flow: { id: "flow-1" } }, 201); }
        return null;
      } });
      render(<StoragePage csrfToken="csrf-token" />);
      const toggle = await screen.findByRole("switch", { name: "Reconnect if it drops: /mnt/olddata" });
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(toggle);
      await waitFor(() => expect(screen.getByRole("switch", { name: "Reconnect if it drops: /mnt/olddata" }).getAttribute("aria-checked")).toBe("true"));
      expect(request).toEqual({ method: "POST", csrf: "csrf-token" });
      expect(screen.getByText("Reconnects automatically.")).toBeTruthy();
      expect(screen.getAllByText(/at most 3 times a day and 30 minutes apart/)).toHaveLength(1);
      expect(screen.getAllByRole("switch")).toHaveLength(1);
    });

    it("says where to reconnect a held drive by hand, since its row has no Reconnect button", async () => {
      mockFetch({ extra: (url) => (url === "/api/v1/drives/auto-reconnect" ? json({ limits, drives: { olddata: { flowId: "flow-1", flowName: "Reconnect", enabled: true, held: true, heldSince: "2026-09-28T03:00:00Z", heldBecause: "the last automatic reconnect did not work", attempts: 1, lastAttemptAt: "2026-09-28T03:00:00Z", lastOutcome: "failed", lastCheckFoundErrors: false } } }) : null) });
      render(<StoragePage csrfToken="csrf-token" />);
      expect(await screen.findByText("Waiting for you: the last automatic reconnect did not work. Reconnect it from Repair Center to start again.")).toBeTruthy();
    });

    it("shows a viewer the drives and no action", async () => {
      mockFetch();
      render(<StoragePage csrfToken="csrf-token" role="viewer" />);
      await screen.findByText("Example USB HDD");
      expect(screen.queryByRole("button", { name: /^(Mount|Erase|Check|Unmount|Share)/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Use the rest of the disk" })).toBeNull();
      expect(screen.getByRole("switch", { name: "Reconnect if it drops: /mnt/olddata" })).toHaveProperty("disabled", true);
    });
  });

  describe("Shares", () => {
    it("finds a NAS, lists its shares, and stages the mount with credentials", async () => {
      let listBody: string | undefined;
      const { staged } = mockFetch({ extra: (url, init) => {
        if (url === "/api/v1/storage/shares/discover") return json({ devices: [{ address: "192.168.1.50", name: "mycloud", smb: true, nfs: false, mac: null, interface: "eno1" }], scanned: 253, interfaces: [] });
        if (url === "/api/v1/storage/shares/list") { listBody = init?.body as string; return json({ shares: [{ name: "Public", comment: "Public Share" }, { name: "jamie", comment: null }] }); }
        return null;
      } });
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^Shares/);
      expect(screen.getByText("No network share is mounted")).toBeTruthy();
      fireEvent.click(screen.getAllByRole("button", { name: "Mount a share" })[0]);
      const sheet = screen.getByRole("dialog", { name: "Mount a share" });
      fireEvent.click(within(sheet).getByRole("button", { name: "Find devices on my network" }));
      fireEvent.click(await within(sheet).findByRole("button", { name: "Use mycloud" }));
      expect((within(sheet).getByLabelText("NAS address or name") as HTMLInputElement).value).toBe("mycloud");
      fireEvent.change(within(sheet).getByLabelText(/^Username/), { target: { value: "jamie" } });
      fireEvent.change(within(sheet).getByLabelText("Password"), { target: { value: "hunter2 hunter2" } });
      fireEvent.click(within(sheet).getByRole("button", { name: "List shares" }));
      fireEvent.click(await within(sheet).findByRole("button", { name: "jamie" }));
      expect(JSON.parse(listBody ?? "{}")).toEqual({ kind: "smb", host: "mycloud", username: "jamie", password: "hunter2 hunter2", domain: null });
      expect((within(sheet).getByLabelText(/^Mount as/) as HTMLInputElement).value).toBe("jamie");
      fireEvent.change(within(sheet).getByLabelText(/^Mount as/), { target: { value: "nas-jamie" } });
      fireEvent.click(within(sheet).getByRole("button", { name: "Mount share" }));
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      expect(screen.getByText(/share-nas-jamie\.cred/)).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["share.mount"] ?? "{}")).toEqual({ parameters: { kind: "smb", host: "mycloud", share: "jamie", name: "nas-jamie", username: "jamie", password: "hunter2 hunter2" } }));
    });

    it("says why Mount share will not respond, instead of sitting there disabled", async () => {
      mockFetch({ extra: (url) => (url === "/api/v1/storage/shares/list" ? json({ shares: [{ name: "Public", comment: null }, { name: "jamie", comment: null }] }) : null) });
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^Shares/);
      fireEvent.click(screen.getAllByRole("button", { name: "Mount a share" })[0]);
      const sheet = screen.getByRole("dialog", { name: "Mount a share" });
      expect(within(sheet).getByText("Enter the NAS address first.")).toBeTruthy();
      fireEvent.change(within(sheet).getByLabelText("NAS address or name"), { target: { value: "192.168.1.50" } });
      expect(within(sheet).getByRole("button", { name: "Mount share" })).toHaveProperty("disabled", true);
      expect(within(sheet).getByText(/Pick a share below, or type its name/)).toBeTruthy();
      fireEvent.click(within(sheet).getByRole("button", { name: "List shares" }));
      fireEvent.click(await within(sheet).findByRole("button", { name: "jamie" }));
      expect(within(sheet).queryByText(/Pick a share below, or type its name/)).toBeNull();
      expect(within(sheet).getByRole("button", { name: "Mount share" })).toHaveProperty("disabled", false);
      fireEvent.change(within(sheet).getByLabelText(/^Mount as/), { target: { value: "" } });
      expect(within(sheet).getByText("Give it a folder name under /mnt (lower case, no spaces).")).toBeTruthy();
      // The mount point backups look for is one press away.
      fireEvent.click(within(sheet).getByRole("button", { name: "Use this for BoxPilot's backups" }));
      expect(within(sheet).getByText("/mnt/boxpilot/backup")).toBeTruthy();
    });

    it("lists mounted shares, explains an empty scan, and offers the missing client tools", async () => {
      const { staged } = mockFetch({
        overview: { ...report, tools: { cifs: false, nfs: true, smbclient: false, showmount: true }, shares: [{ name: "nas-media", kind: "smb", source: "//mycloud/Public", mountpoint: "/mnt/nas-media", readOnly: true, automount: true, mounted: false, sizeBytes: null, usedBytes: null, availableBytes: null }] },
        extra: (url) => (url === "/api/v1/storage/shares/discover" ? json({ devices: [], scanned: 253, interfaces: [] }) : null),
      });
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^Shares/);
      expect(screen.getByText("Connects on first use")).toBeTruthy();
      expect(screen.getByText("//mycloud/Public")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Unmount nas-media" }).getAttribute("data-risk")).toBe("medium");
      fireEvent.click(screen.getByRole("button", { name: "Mount a share" }));
      const sheet = screen.getByRole("dialog", { name: "Mount a share" });
      expect(within(sheet).getByText("Install cifs-utils first.")).toBeTruthy();
      fireEvent.click(within(sheet).getByRole("button", { name: "Find devices on my network" }));
      expect(await within(sheet).findByText(/Nothing answered on ports 445 or 2049 across 253 addresses/)).toBeTruthy();
      fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
      fireEvent.click(screen.getByRole("button", { name: "Install cifs-utils" }));
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["apt.install"] ?? "{}")).toEqual({ parameters: { packages: ["cifs-utils"] } }));
    });
  });

  describe("File sharing", () => {
    it("offers to install Samba and the NFS server when they are missing", async () => {
      const { staged } = mockFetch({ samba: { ...samba, installed: false, running: null, configured: false, config: { ...samba.config, managed: false, shares: [] }, users: [] }, nfs: { ...nfs, installed: false, running: null, configured: false, config: { managed: false, scope: "tailscale", exports: [] } } });
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^File sharing/);
      expect(screen.getByText("Samba is not installed")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Install NFS server" }));
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["apt.install"] ?? "{}")).toEqual({ parameters: { packages: ["nfs-kernel-server"] } }));
    });

    it("shows the live shares with the address to type, and applies an edited share list", async () => {
      const { staged } = mockFetch();
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^File sharing/);
      expect(await screen.findByText("smb://homebox.tail1234.ts.net/Media")).toBeTruthy();
      const sambaPanel = screen.getByRole("region", { name: "Samba (SMB)" });
      expect(within(sambaPanel).getByText("Everything shown is live.")).toBeTruthy();
      expect(within(sambaPanel).getByRole("button", { name: "Apply changes" })).toHaveProperty("disabled", true);

      fireEvent.click(screen.getByRole("button", { name: "Add a share" }));
      const sheet = screen.getByRole("dialog", { name: "Add a share" });
      fireEvent.change(within(sheet).getByLabelText("Share name"), { target: { value: "Media" } });
      expect(within(sheet).getByText("That name is already used.")).toBeTruthy();
      fireEvent.change(within(sheet).getByLabelText("Share name"), { target: { value: "Private" } });
      fireEvent.change(within(sheet).getByLabelText("Folder on this server"), { target: { value: "/srv/private/" } });
      fireEvent.change(within(sheet).getByLabelText("Who can open it"), { target: { value: "selected" } });
      fireEvent.click(within(sheet).getByLabelText("Allow jamie"));
      fireEvent.click(within(sheet).getByRole("button", { name: "Add share" }));
      expect(within(screen.getByRole("region", { name: "Samba (SMB)" })).getByText("Changes are not live until you apply.")).toBeTruthy();

      // A draft survives a trip to another tab.
      openTab(/^Drives/);
      openTab(/^File sharing/);
      const again = screen.getByRole("region", { name: "Samba (SMB)" });
      expect(within(again).getByText("Changes are not live until you apply.")).toBeTruthy();
      fireEvent.click(within(again).getByRole("button", { name: "Apply changes" }));
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["samba.apply"] ?? "{}")).toEqual({ parameters: { workgroup: "WORKGROUP", scope: "tailscale", shares: [
        { name: "Media", path: "/mnt/nas-media", comment: "Films", readOnly: true, guest: true, users: [], recycle: false },
        { name: "Private", path: "/srv/private", comment: null, readOnly: false, guest: false, users: ["jamie"], recycle: true },
      ] } }));
    });

    it("opens Add a share with a drive's folder when Share is pressed on its row", async () => {
      mockFetch({ overview: { ...report, devices: [...report.devices, { ...base, path: "/dev/sdd1", type: "part", sizeBytes: GiB, fstype: "ext4", uuid: "dump-uuid", label: "the-dump", model: null, transport: null, mountpoints: ["/mnt/the-dump"], readOnly: false, removable: true, depth: 0 }] } });
      render(<StoragePage csrfToken="csrf-token" />);
      fireEvent.click(await screen.findByRole("button", { name: "Share /mnt/the-dump on the network" }));
      const sheet = await screen.findByRole("dialog", { name: "Add a share" });
      expect(window.location.search).toBe("?view=storage&tab=sharing");
      expect((within(sheet).getByLabelText("Share name") as HTMLInputElement).value).toBe("the-dump");
      expect((within(sheet).getByLabelText("Folder on this server") as HTMLInputElement).value).toBe("/mnt/the-dump");
      // Closed, it stays closed when the tab is opened again.
      fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
      openTab(/^Drives/);
      openTab(/^File sharing/);
      expect(screen.queryByRole("dialog", { name: "Add a share" })).toBeNull();
    });

    it("names the folder waiting beside Install Samba when Share is pressed before Samba is installed", async () => {
      mockFetch({
        overview: { ...report, devices: [...report.devices, { ...base, path: "/dev/sdd1", type: "part", sizeBytes: GiB, fstype: "ext4", uuid: "dump-uuid", label: "the-dump", model: null, transport: null, mountpoints: ["/mnt/the-dump"], readOnly: false, removable: true, depth: 0 }] },
        samba: { ...samba, installed: false, running: null, configured: false, config: { ...samba.config, managed: false, shares: [] }, users: [] },
      });
      render(<StoragePage csrfToken="csrf-token" />);
      fireEvent.click(await screen.findByRole("button", { name: "Share /mnt/the-dump on the network" }));
      expect(await screen.findByText("Samba is not installed")).toBeTruthy();
      // No sheet whose share would go into a list this tab does not draw yet.
      expect(screen.queryByRole("dialog", { name: "Add a share" })).toBeNull();
      expect(screen.getByText(/Install it first to share/).textContent).toContain("/mnt/the-dump");
    });

    it("says the firewall has to allow SMB on the LAN, and goes there", async () => {
      const onNavigate = vi.fn();
      mockFetch();
      render(<StoragePage csrfToken="csrf-token" onNavigate={onNavigate} />);
      await screen.findByText("Example USB HDD");
      openTab(/^File sharing/);
      await screen.findByText("smb://homebox.tail1234.ts.net/Media");
      expect(screen.queryByText("The firewall has to allow SMB on the LAN")).toBeNull();
      fireEvent.click(within(screen.getByRole("radiogroup", { name: "Samba reachable from" })).getByRole("radio", { name: "Tailscale + LAN" }));
      expect(screen.getByText("The firewall has to allow SMB on the LAN")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open the Firewall page" }));
      expect(onNavigate).toHaveBeenCalledWith("firewall");
    });

    it("empties a share's recycle bin and schedules its weekly clean", async () => {
      let posted: string | undefined;
      let scheduled = false;
      const withRecycle = { ...samba, config: { ...samba.config, shares: [{ name: "Docs", path: "/mnt/docs", comment: null, readOnly: false, guest: false, users: ["jamie"], forceUser: "homebox", recycle: true, recycleBytes: 2_415_919_104 }] } };
      const { staged } = mockFetch({ samba: withRecycle, extra: (url, init) => {
        if (url === "/api/v1/schedules" && init?.method === "POST") { posted = init.body as string; scheduled = true; return json({ id: "s9" }, 201); }
        // The scheduler exposes the target as parameters.subject, not .share.
        if (url === "/api/v1/schedules") return json({ schedules: scheduled ? [{ id: "s9", operationId: "samba.recycle.empty", parameters: { subject: "Docs" } }] : [] });
        return null;
      } });
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^File sharing/);
      expect(await screen.findByLabelText("Recycle bin for Docs")).toBeTruthy();
      expect(screen.getByText("Recycle bin (2.3 GiB)")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Clean Docs's bin weekly" }));
      await waitFor(() => expect(JSON.parse(posted ?? "{}")).toEqual({ operationId: "samba.recycle.empty", parameters: { share: "Docs", olderThanDays: 30 }, frequency: "weekly", minute: 0, hour: 5, weekday: 0 }));
      expect(await screen.findByRole("button", { name: "Stop cleaning Docs's bin weekly" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Empty the recycle bin of Docs" }));
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["samba.recycle.empty"] ?? "{}")).toEqual({ parameters: { share: "Docs" } }));
    });

    it("adds a file-server user from a sheet with a password held only for the job, and removes one", async () => {
      const { staged } = mockFetch();
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^File sharing/);
      fireEvent.click(await screen.findByRole("button", { name: "Add a user" }));
      const sheet = screen.getByRole("dialog", { name: "Add a user" });
      fireEvent.change(within(sheet).getByLabelText("User name"), { target: { value: "Sam" } });
      fireEvent.change(within(sheet).getByLabelText("Password"), { target: { value: "short" } });
      expect(within(sheet).getByRole("button", { name: "Add user" })).toHaveProperty("disabled", true);
      fireEvent.change(within(sheet).getByLabelText("Password"), { target: { value: "long enough pw" } });
      fireEvent.click(within(sheet).getByRole("button", { name: "Add user" }));
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["samba.user.set"] ?? "{}")).toEqual({ parameters: { username: "sam", password: "long enough pw" } }));
      fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove jamie" }));
      await waitFor(() => expect(JSON.parse(staged["samba.user.remove"] ?? "{}")).toEqual({ parameters: { username: "jamie" } }));
    });

    it("shows each NFS export's mount commands and applies an edited list on the LAN", async () => {
      const { staged } = mockFetch();
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^File sharing/);
      expect(await screen.findByText("sudo mount -t nfs4 homebox.tail1234.ts.net:/srv/media /mnt/media")).toBeTruthy();
      expect(screen.getByText("nfs://homebox.tail1234.ts.net/srv/media")).toBeTruthy();
      expect(screen.getByText(/nfs4 defaults,nofail,_netdev/)).toBeTruthy(); // whitespace is normalised in the query
      fireEvent.click(within(screen.getByRole("radiogroup", { name: "NFS reachable from" })).getByRole("radio", { name: "Tailscale + LAN" }));
      fireEvent.change(screen.getByLabelText("Folder to export"), { target: { value: "/srv/shared/" } });
      fireEvent.click(screen.getByRole("button", { name: "Add export" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Apply changes" }).at(-1) as HTMLElement);
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["nfs.apply"] ?? "{}")).toEqual({ parameters: { scope: "lan", exports: [{ path: "/srv/media", readOnly: true }, { path: "/srv/shared", readOnly: false }] } }));
    });
  });

  describe("Snapshots", () => {
    it("takes a snapshot of the root volume from a sheet, and asks for the snapshot's name to roll back", async () => {
      const { staged } = mockFetch({ overview: { ...report, snapshots: [{ path: "/dev/mapper/ubuntu--vg-boxpilot--snap--20260821--2005--before--upgrade", name: "boxpilot-snap-20260821-2005-before-upgrade", volumeGroup: "ubuntu-vg", sizeBytes: 100 * GiB, origin: "/dev/mapper/ubuntu--vg-ubuntu--lv", sizeGiB: 10, createdAt: "2026-08-21T20:05:00.000Z", suffix: "before-upgrade" }] } });
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^Snapshots/);
      expect(screen.getByText("before-upgrade")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Take a snapshot" }));
      const sheet = screen.getByRole("dialog", { name: "Take a snapshot" });
      fireEvent.change(within(sheet).getByLabelText("Space for changes (GiB)"), { target: { value: "20" } });
      fireEvent.change(within(sheet).getByLabelText(/^Label/), { target: { value: "test-run" } });
      fireEvent.click(within(sheet).getByRole("button", { name: "Take a snapshot" }));
      expect(await screen.findByText("Medium risk")).toBeTruthy();
      await waitFor(() => expect(JSON.parse(staged["storage.lvm.snapshot.create"] ?? "{}")).toEqual({ parameters: { path: "/dev/mapper/ubuntu--vg-ubuntu--lv", sizeGiB: 20, suffix: "test-run" } }));
      fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
      fireEvent.click(screen.getByRole("button", { name: "Roll back to boxpilot-snap-20260821-2005-before-upgrade" }));
      expect(await screen.findByText("High risk")).toBeTruthy();
      const approve = screen.getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
      fireEvent.change(screen.getByLabelText("Approval password"), { target: { value: "correct horse battery" } });
      expect(approve.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Typed confirmation"), { target: { value: "boxpilot-snap-20260821-2005-before-upgrade" } });
      expect(approve.disabled).toBe(false);
    });

    it("takes and deletes btrfs and ZFS snapshots", async () => {
      const fs = { supported: true, btrfs: { filesystems: [{ target: "/mnt/pool", source: "/dev/sdc1", snapshots: [{ name: "before-reorg", path: "/mnt/pool/.boxpilot-snapshots/before-reorg" }] }] }, zfs: { datasets: [{ name: "tank/media", mountpoint: "/tank/media", snapshots: [] }] } };
      const { staged } = mockFetch({ extra: (url) => (url.endsWith("/operations/storage.fs-snapshots.inspect/inspect") ? json({ result: fs }) : null) });
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^Snapshots/);
      fireEvent.click(await screen.findByRole("button", { name: "Delete snapshot before-reorg of /mnt/pool" }));
      await waitFor(() => expect(JSON.parse(staged["storage.fs-snapshot.delete"] ?? "{}")).toEqual({ parameters: { kind: "btrfs", target: "/mnt/pool", name: "before-reorg" } }));
      fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
      const takes = screen.getAllByRole("button", { name: "Take a snapshot" });
      fireEvent.click(takes.at(-1) as HTMLElement);
      const sheet = screen.getByRole("dialog", { name: "Take a snapshot" });
      fireEvent.change(within(sheet).getByLabelText("Filesystem"), { target: { value: "zfs:tank/media" } });
      fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "nightly" } });
      fireEvent.click(within(sheet).getByRole("button", { name: "Take a snapshot" }));
      await waitFor(() => expect(JSON.parse(staged["storage.fs-snapshot.create"] ?? "{}")).toEqual({ parameters: { kind: "zfs", target: "tank/media", name: "nightly" } }));
    });
  });

  describe("Mounts", () => {
    it("names what is filling a drive, counting a shared folder once", async () => {
      // Nothing is nearly full here, so the forecast is the verdict.
      const roomy = { ...report, mounts: [report.mounts[0], { ...report.mounts[1], usedBytes: 50, availableBytes: 50 }] };
      mockFetch({ overview: roomy, extra: (url) => (url === "/api/v1/storage/forecast" ? json({ forecasts: [{ target: "/mnt/shared", daysToFull: 10, availableBytes: GiB }], usage: ["one", "two"].map((appId) => ({ appId, path: "/mnt/shared/downloads", mount: "/mnt/shared", bytes: 3 * GiB, grewBytes: 2 * GiB, days: 7, sharedWith: ["one", "two"] })) }) : null) });
      render(<StoragePage csrfToken="csrf-token" />);
      expect(await screen.findByText("Fills in ~10 days")).toBeTruthy();
      openTab(/^Mounts/);
      expect(screen.getAllByText(/Shared folder used by/)).toHaveLength(1);
      expect(screen.getByText("one, two")).toBeTruthy();
      expect(screen.getByText(/Shared folder used by/).closest("li")?.textContent).toContain("grew 2.0 GiB");
      expect(screen.getByText("~10 days left")).toBeTruthy();
    });

    it("lists every mounted filesystem with its use, and says nearly full in words", async () => {
      mockFetch();
      render(<StoragePage csrfToken="csrf-token" />);
      await screen.findByText("Example USB HDD");
      openTab(/^Mounts/);
      const table = screen.getByRole("table", { name: "Mounted filesystems" });
      expect(within(table).getByText("managed")).toBeTruthy();
      expect(within(table).getByRole("meter", { name: "/mnt/olddata: 95% used" })).toBeTruthy();
      expect(rowWith("/dev/sdc1").textContent).toContain("nearly full");
      expect(rowWith("/dev/sdc1").getAttribute("data-status")).toBe("danger");
    });
  });
});
