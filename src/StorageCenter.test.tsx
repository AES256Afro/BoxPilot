import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StorageCenter from "./StorageCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const report = {
  devices: [
    { path: "/dev/sda", type: "disk", sizeBytes: 500 * 1024 ** 3, fstype: null, uuid: null, label: null, model: "Samsung SSD", transport: "sata", mountpoints: [], readOnly: false, removable: false, depth: 0 },
    { path: "/dev/sda1", type: "part", sizeBytes: 499 * 1024 ** 3, fstype: "ext4", uuid: "root-uuid", label: null, model: null, transport: null, mountpoints: ["/"], readOnly: false, removable: false, depth: 1 },
    { path: "/dev/sdb", type: "disk", sizeBytes: 4000 * 1024 ** 3, fstype: null, uuid: null, label: null, model: "WD Elements", transport: "usb", mountpoints: [], readOnly: false, removable: true, depth: 0 },
    { path: "/dev/sdb1", type: "part", sizeBytes: 4000 * 1024 ** 3, fstype: "ext4", uuid: "data-uuid", label: "media", model: null, transport: null, mountpoints: [], readOnly: false, removable: true, depth: 1 },
  ],
  mounts: [
    { target: "/", source: "/dev/sda1", fstype: "ext4", sizeBytes: 100, usedBytes: 40, availableBytes: 60 },
    { target: "/mnt/olddata", source: "/dev/sdc1", fstype: "ext4", sizeBytes: 100, usedBytes: 95, availableBytes: 5 },
  ],
  fstab: [
    { device: "UUID=root-uuid", mountpoint: "/", fstype: "ext4", options: "defaults", managedName: null },
    { device: "UUID=old-uuid", mountpoint: "/mnt/olddata", fstype: "ext4", options: "defaults,nofail", managedName: "olddata" },
  ],
};

describe("Storage center", () => {
  it("offers Mount for unmounted filesystems and stages it with the fstab preview", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/storage.inspect/inspect")) return json({ operation: "storage.inspect", result: report });
      if (url.endsWith("/operations/storage.mount/jobs")) { staged = init?.body as string; return json({ job: { id: "job-m", type: "op:storage.mount", title: "Mount a filesystem", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<StorageCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("WD Elements")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows.find((row) => row.textContent?.includes("/dev/sda1"))?.textContent).not.toContain("Mount"); // mounted at /
    fireEvent.click(screen.getByRole("button", { name: "Mount" })); // /dev/sdb1, prefilled from its label
    fireEvent.change(screen.getByLabelText("Mount name"), { target: { value: "media" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Mount" }).at(-1) as HTMLElement);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.getByText(/UUID=data-uuid \/mnt\/media ext4 defaults,nofail 0 2/)).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { uuid: "data-uuid", name: "media" } });
  });

  it("requires typing the device name before a format can be approved", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/storage.inspect/inspect")) return json({ operation: "storage.inspect", result: report });
      if (url.endsWith("/operations/storage.format/jobs")) return json({ job: { id: "job-f", type: "op:storage.format", title: "Erase and format a disk", state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk" } }, 201);
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<StorageCenter csrfToken="csrf-token" />);

    // /dev/sdb has an unmounted child, so both sdb and sdb1 offer Format; take the first.
    fireEvent.click((await screen.findAllByRole("button", { name: "Format" }))[0]);
    expect(await screen.findByText("High risk")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Approval password"), { target: { value: "correct horse battery" } });
    expect(approve.disabled).toBe(true); // password alone is not enough
    fireEvent.change(screen.getByLabelText("Typed confirmation"), { target: { value: "/dev/sdb" } });
    expect(approve.disabled).toBe(false);
  });

  it("offers Unmount only for BoxPilot-managed mounts", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/storage.inspect/inspect")) return json({ operation: "storage.inspect", result: report });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<StorageCenter csrfToken="csrf-token" />);
    expect(await screen.findByRole("button", { name: "Unmount" })).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows.find((row) => row.textContent?.includes("/dev/sda1") && row.textContent?.includes("40"))?.textContent).not.toContain("Unmount");
    expect(screen.getByText(/95%/)).toBeTruthy();
  });
});
