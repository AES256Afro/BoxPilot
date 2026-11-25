import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OffBoxTab, { type OffBoxTabProps } from "./OffBoxTab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const providers = {
  b2: { label: "Backblaze B2", fields: ["account", "bucket", "path"], secrets: ["key", "passphrase"], help: "Create an application key." },
  s3: { label: "S3-compatible", fields: ["endpoint", "region", "bucket", "path", "accessKeyId"], secrets: ["secretAccessKey", "passphrase"], help: "S3 help." },
};
const saved = { provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox" };
const artifact = "machine-snapshot-20261124T020000Z-1a2b3c4d.tar.gz";
const older = "machine-snapshot-20261117T020000Z-0a0b0c0d.tar.gz";

function mockFetch(extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  const bodies: Record<string, string> = {};
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    urls.push(url);
    const handled = extra(url, init);
    if (handled) return handled;
    const match = url.match(/\/operations\/([a-z.-]+)\/jobs$/);
    if (match) {
      bodies[match[1]] = init?.body as string;
      return json({ job: { id: `job-${match[1]}`, type: `op:${match[1]}`, title: match[1], state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201);
    }
    return json({ error: `unexpected ${url}` }, 404);
  }));
  return { bodies, urls };
}

function renderTab(overrides: Partial<OffBoxTabProps> = {}) {
  const props: OffBoxTabProps = {
    csrfToken: "csrf", role: "owner", tailnetHosts: [], machine: null, remote: null, remoteSettings: null,
    cloud: { rcloneInstalled: true, configured: true, sealed: true, provider: "b2", providers },
    cloudSettings: { destination: saved, lastSync: null },
    cloudError: null, summary: null, scheduling: null, onMirrorNightly: () => {}, onChanged: () => {},
    ...overrides,
  };
  return render(<OffBoxTab {...props} />);
}

describe("changing a saved cloud destination (M91)", () => {
  // Before: every secret was required again, so renaming the folder meant typing the key and the passphrase twice.
  it("keeps the saved key and passphrase when they are left empty", async () => {
    const { bodies } = mockFetch();
    renderTab();
    fireEvent.click(within(screen.getByRole("region", { name: "Cloud bucket" })).getByRole("button", { name: "Change destination" }));
    const sheet = screen.getByRole("dialog", { name: "Change the cloud destination" });
    expect(within(sheet).queryByText(/Still needed/)).toBeNull();
    expect(within(sheet).getAllByText(/Leave it empty to keep the saved one/)).toHaveLength(2);
    fireEvent.change(within(sheet).getByLabelText("Folder in the bucket", { exact: false }), { target: { value: "homebox-2027" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save destination" }));
    const approval = await screen.findByRole("dialog", { name: "Save the Backblaze B2 backup destination" });
    expect(JSON.parse(bodies["backup.cloud.setup"] ?? "{}")).toEqual({ parameters: { provider: "b2", account: "0012abc", bucket: "home-backups", path: "homebox-2027" } });
    expect(approval.textContent).toContain("The saved application key and encryption passphrase stay as they are.");
    expect(approval.textContent).not.toContain("held in memory");
  });

  it("asks for the key again when the key ID it belongs to changes, and for the passphrase twice only when one is typed", () => {
    mockFetch();
    renderTab();
    fireEvent.click(within(screen.getByRole("region", { name: "Cloud bucket" })).getByRole("button", { name: "Change destination" }));
    const sheet = screen.getByRole("dialog", { name: "Change the cloud destination" });
    fireEvent.change(within(sheet).getByLabelText("Key ID"), { target: { value: "0099xyz" } });
    expect(within(sheet).getByText("Still needed: Application key.")).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText("Application key"), { target: { value: "K456" } });
    expect(within(sheet).queryByText(/Still needed/)).toBeNull();
    fireEvent.change(within(sheet).getByLabelText("Encryption passphrase", { exact: false }), { target: { value: "a new long passphrase" } });
    expect(within(sheet).getByText("Still needed: the passphrase typed again.")).toBeTruthy();
  });

  it("asks for the passphrase when the saved destination was never sealed", () => {
    mockFetch();
    renderTab({ cloud: { rcloneInstalled: true, configured: true, sealed: false, provider: "b2", providers } });
    fireEvent.click(within(screen.getByRole("region", { name: "Cloud bucket" })).getByRole("button", { name: "Change destination" }));
    expect(within(screen.getByRole("dialog", { name: "Change the cloud destination" })).getByText("Still needed: Encryption passphrase.")).toBeTruthy();
  });
});

describe("reading the cloud copy back (M91)", () => {
  it("says when the copy was last read back, and when it was not", () => {
    mockFetch();
    const lastSync = { completedAt: "2026-11-24T03:00:00.000Z", filesTransferred: 2, bytesTransferred: "1 MiB", destination: "d", errors: 0 };
    renderTab({ cloudSettings: { destination: saved, lastSync: { ...lastSync, readBack: { ok: true, at: "2026-11-24T03:10:00.000Z", artifact, error: null, reason: null, lastVerifiedAt: "2026-11-24T03:10:00.000Z" } } as never } });
    const cloud = screen.getByRole("region", { name: "Cloud bucket" });
    expect(within(cloud).getByText("Last read back")).toBeTruthy();
    expect(within(cloud).getByText(new RegExp(artifact.replace(/\./g, "\\.")))).toBeTruthy();
    expect(within(cloud).queryByText("The copy in the bucket did not read back")).toBeNull();
    cleanup();
    renderTab({ cloudSettings: { destination: saved, lastSync: { ...lastSync, readBack: { ok: false, at: "2026-11-24T03:10:00.000Z", artifact, error: "failed to authenticate decrypted block - bad password?", reason: null, lastVerifiedAt: null } } as never } });
    const failed = screen.getByRole("region", { name: "Cloud bucket" });
    expect(within(failed).getByText("The copy in the bucket did not read back")).toBeTruthy();
    expect(within(failed).getByText(/bad password/)).toBeTruthy();
  });

  it("lists the snapshots in the bucket when asked, and stages a fetch of one for the owner", async () => {
    const { bodies, urls } = mockFetch((url) => (url.endsWith("/operations/backup.cloud.snapshots/inspect")
      ? json({ operation: "backup.cloud.snapshots", result: { total: 2, snapshots: [
        { artifact, sizeBytes: 5 * 1024 * 1024, modifiedAt: null, hasMeta: true, local: false },
        { artifact: older, sizeBytes: 4 * 1024 * 1024, modifiedAt: null, hasMeta: true, local: true },
      ] } })
      : null));
    renderTab();
    const cloud = screen.getByRole("region", { name: "Cloud bucket" });
    // Nothing is read from the provider until asked.
    expect(urls.some((url) => url.includes("backup.cloud.snapshots"))).toBe(false);
    fireEvent.click(within(cloud).getByRole("button", { name: "Find snapshots in the cloud" }));
    const table = await within(cloud).findByRole("table", { name: "Snapshots in the cloud" });
    // One already here can still have its apps' backups fetched (outside review: a snapshot alone restored apps empty).
    expect(within(table).getByRole("button", { name: `Fetch the app backups of ${older}` })).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: `Fetch ${artifact}` }));
    const approval = await screen.findByRole("dialog", { name: "Fetch a machine snapshot from the cloud" });
    expect(approval.textContent).toContain("and each of its apps' newest backup from the bucket");
    expect(approval.textContent).toContain("checks each against the checksum recorded when it was taken");
    expect(approval.textContent).toContain("nothing is fetched unless all of it fits");
    expect(JSON.parse(bodies["backup.cloud.fetch"] ?? "{}")).toEqual({ parameters: { artifact } });
  });

  it("shows an operator the list without the fetch, and a viewer neither", async () => {
    mockFetch((url) => (url.endsWith("/operations/backup.cloud.snapshots/inspect") ? json({ result: { total: 1, snapshots: [{ artifact, sizeBytes: 1, modifiedAt: null, hasMeta: true, local: false }] } }) : null));
    renderTab({ role: "operator" });
    fireEvent.click(screen.getByRole("button", { name: "Find snapshots in the cloud" }));
    const table = await screen.findByRole("table", { name: "Snapshots in the cloud" });
    await waitFor(() => expect(within(table).getAllByRole("row").length).toBeGreaterThan(1));
    expect(within(table).queryByRole("button", { name: /Fetch/ })).toBeNull();
    cleanup();
    renderTab({ role: "viewer" });
    expect(screen.queryByRole("button", { name: "Find snapshots in the cloud" })).toBeNull();
  });

  it("says when the bucket could not be listed", async () => {
    mockFetch((url) => (url.endsWith("/operations/backup.cloud.snapshots/inspect") ? json({ error: "Could not list the encrypted copies: AccessDenied" }, 500) : null));
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Find snapshots in the cloud" }));
    expect(await screen.findByText("The bucket could not be listed")).toBeTruthy();
    expect(screen.getByText(/AccessDenied/)).toBeTruthy();
  });
});
