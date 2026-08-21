import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackupCenter from "./BackupCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const backup = {
  id: "10000000-0000-4000-8000-000000000001", applicationId: "boxpilot-controller", destination: "local-managed",
  checksumSha256: "a".repeat(64), sizeBytes: 4 * 1024 * 1024, downtimeMs: 0,
  restoreDrill: { passed: true }, createdAt: "2026-08-20T03:00:00.000Z",
};

describe("Backup Center", () => {
  it("lists verified database snapshots and stages a one-click backup", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/backups")) return json({ backups: [backup, { ...backup, id: "x", applicationId: "legacy-app" }] });
      if (url.endsWith("/controller-backup-protection")) return json({ destination: { repositoryInitialized: true }, protections: [{ id: "p1", backupId: backup.id, createdAt: backup.createdAt }] });
      if (url.endsWith("/controller-backup-retention")) return json({ policy: { minimumCopies: 3, minimumAgeDays: 30 }, candidates: [] });
      if (url.endsWith("/operations/controller.backup.create/jobs")) { staged = init?.body as string; return json({ job: { id: "job-b", type: "op:controller.backup.create", title: "Back up the BoxPilot database", state: "awaiting_approval", risk: "low", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "low", passwordRequired: false, elevated: false, mode: "tiered", reason: "low risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BackupCenter csrfToken="csrf-token" onOpenRepair={vi.fn()} />);

    expect(await screen.findByText("passed")).toBeTruthy(); // only the controller row renders
    expect(screen.getByText("protected")).toBeTruthy();
    expect(screen.queryByText("legacy-app")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Low risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: {} });
  });

  it("offers Protect only when the restic repository is ready and stages it in the dialog", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/backups")) return json({ backups: [backup] });
      if (url.endsWith("/controller-backup-protection")) return json({ destination: { repositoryInitialized: true }, protections: [] });
      if (url.endsWith("/controller-backup-retention")) return json({});
      if (url.endsWith("/operations/controller.backup.protect/jobs")) { staged = init?.body as string; return json({ job: { id: "job-p", type: "op:controller.backup.protect", title: "Protect a database backup independently", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BackupCenter csrfToken="csrf-token" />);

    fireEvent.click(await screen.findByRole("button", { name: "Protect" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { backupId: backup.id } });
  });
  it("lists machine snapshots and stages snapshot creation and the off-box mirror", async () => {
    let staged: Array<{ url: string; body: string }> = [];
    const machineState = {
      snapshots: [{ artifact: "machine-snapshot-20260821T020000Z-11111111.tar.gz", sizeBytes: 5 * 1024 * 1024, checksumSha256: "b".repeat(64), createdAt: "2026-08-21T02:00:00.000Z", contents: { apps: [{ id: "uptime-kuma" }], vms: { domains: ["snapshot-lab"] } } }],
      keep: 3,
      sync: { destination: "/mnt/boxpilot-backup/boxpilot-local-mirror", mount: { mounted: true, freeBytes: 9 * 1024 ** 3 }, lastSync: { completedAt: "2026-08-20T02:00:00.000Z", copiedCount: 4 } },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/backups")) return json({ backups: [backup] });
      if (url.endsWith("/controller-backup-protection")) return json({ destination: {}, protections: [] });
      if (url.endsWith("/controller-backup-retention")) return json({});
      if (url.endsWith("/operations/host.snapshot.inspect/inspect")) return json({ operation: "host.snapshot.inspect", result: machineState });
      if (url.includes("/operations/") && url.endsWith("/jobs")) {
        staged.push({ url, body: init?.body as string });
        return json({ job: { id: "job-m", type: "op:x", title: "Machine snapshot", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201);
      }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BackupCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("5.0 MiB")).toBeTruthy(); // the snapshot row rendered
    expect(screen.getByText(/last synced/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create machine snapshot" }));
    expect(await screen.findByText(/contains secrets/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sync to backup drive" }));
    expect(await screen.findByText(/never deleted/)).toBeTruthy();
    expect(staged.map((entry) => entry.url.split("/operations/")[1])).toEqual(["host.snapshot.create/jobs", "backup.sync/jobs"]);
  });

  it("walks the off-box SSH destination from key to mirror", async () => {
    let saved: string | undefined; const staged: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/backups")) return json({ backups: [] });
      if (url.endsWith("/operations/backup.remote.inspect/inspect")) return json({ operation: "backup.remote.inspect", result: { keyReady: true, publicKey: "ssh-ed25519 AAAA boxpilot-backup-mirror", fingerprint: "SHA256:abc", hostKeysPinned: 1, rsyncInstalled: true } });
      if (url.endsWith("/api/v1/settings/backup-destination") && init?.method === "PUT") { saved = init.body as string; return json({ destination: { host: "nas.local", port: 22, user: "backup", path: "/srv/boxpilot" }, lastSync: null }); }
      if (url.endsWith("/api/v1/settings/backup-destination")) return json({ destination: null, lastSync: null });
      if (url.includes("/operations/") && url.endsWith("/jobs")) { staged.push(url.split("/operations/")[1]); return json({ job: { id: "j", type: "op:x", title: "x", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium" } }, 201); }
      return json({ error: "unavailable" }, 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BackupCenter csrfToken="csrf-token" />);

    expect(await screen.findByLabelText("Mirror public key")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Destination host"), { target: { value: "nas.local" } });
    fireEvent.change(screen.getByLabelText("Destination user"), { target: { value: "backup" } });
    fireEvent.change(screen.getByLabelText("Destination path"), { target: { value: "/srv/boxpilot" } });
    fireEvent.change(screen.getByLabelText("Owner password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Save destination" }));
    expect(await screen.findByText(/backup@nas.local:\/srv\/boxpilot/)).toBeTruthy();
    expect(JSON.parse(saved ?? "{}")).toEqual({ password: "correct horse battery", destination: { host: "nas.local", port: 22, user: "backup", path: "/srv/boxpilot" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/pins the destination's host key/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Mirror now" }));
    expect(await screen.findByText(/Nothing on the destination is deleted/)).toBeTruthy();
    expect(staged).toEqual(["backup.remote.test/jobs", "backup.remote.sync/jobs"]);
  });

  it("shows the empty state and points at catalog and VM backups", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/backups")) return json({ backups: [] });
      return json({ error: "unavailable" }, 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BackupCenter csrfToken="csrf-token" onOpenRepair={vi.fn()} />);
    expect(await screen.findByText(/No database backups yet/)).toBeTruthy();
    expect(screen.getByText(/App catalog/)).toBeTruthy();
    expect(screen.getByText(/Virtual Machines/)).toBeTruthy();
  });
});
