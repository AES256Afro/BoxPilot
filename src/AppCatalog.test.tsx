import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppCatalog from "./AppCatalog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const manifest = {
  id: "jellyfin", name: "Jellyfin", category: "Media", description: "Media server", website: "https://jellyfin.org", icon: "🎬", risk: "medium", notes: "Setup wizard on first run",
  image: { reference: "jellyfin/jellyfin:10.10.7", version: "10.10.7", digestPinned: false },
  ports: [{ id: "web", label: "Web UI", container: 8096, host: 8096, protocol: "tcp", exposure: "lan", fixed: false }],
  volumes: [{ id: "config", label: "Configuration", container: "/config", path: "config", hostPath: null, readOnly: false, backup: true, configurable: false, description: null }, { id: "media", label: "Media library", container: "/media", path: null, hostPath: "/srv/media", readOnly: true, backup: false, configurable: true, description: "Your media folder" }],
  env: [{ name: "TZ", label: "Time zone", description: null, type: "timezone", default: "Etc/UTC", required: false, secret: false, generate: false, options: null, fixed: false }],
  health: { kind: "healthcheck", stableSeconds: 10, timeoutSeconds: 240 }, sha256: "abc",
};

describe("App catalog", () => {
  it("shows catalog apps, collects install settings, and stages app.install through the approval dialog", async () => {
    let stagedBody: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest, live: { id: "jellyfin", installed: false, dataPresent: false, state: null, container: { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null }, urls: [] } }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.endsWith("/catalog/jellyfin/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) { stagedBody = init?.body as string; return json({ job: { id: "job-9", type: "op:app.install", title: "Install application", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    expect(await screen.findByText("Jellyfin")).toBeTruthy();
    expect(screen.getByText("Not installed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    fireEvent.change(await screen.findByLabelText("Web UI port"), { target: { value: "8097" } });
    fireEvent.change(screen.getByLabelText("Media library path"), { target: { value: "/mnt/media" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to install" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(stagedBody ?? "{}")).toEqual({ parameters: { id: "jellyfin", values: { ports: { web: 8097 }, env: {}, volumes: { media: "/mnt/media" } } } });
  });

  it("offers lifecycle, update, uninstall, and purge for an installed app", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest, live: { id: "jellyfin", installed: true, dataPresent: true, state: { installedAt: "x", updatedAt: "x", manifestSha256: "abc", image: { reference: "jellyfin/jellyfin:10.10.7", id: "sha256:1" }, values: { ports: { web: 8096 }, env: {}, volumes: {} }, pinnedRollback: false, uninstalledAt: null }, container: { exists: true, running: true, status: "running", health: "healthy", restarts: 0, image: "sha256:1" }, urls: [{ id: "web", label: "Web UI", host: 8096, exposure: "lan" }] } }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    expect(await screen.findByText("Running")).toBeTruthy();
    expect((screen.getByRole("link", { name: "Open Web UI" }) as HTMLAnchorElement).href).toBe("http://192.168.1.10:8096/");
    for (const name of ["Restart", "Stop", "Settings", "Update", "Logs", "Uninstall", "Delete data"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("browses a backup's files and stages a single-file restore", async () => {
    const staged: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest, live: { id: "jellyfin", installed: true, dataPresent: true, state: { installedAt: "x", updatedAt: "x", manifestSha256: "abc", image: { reference: "jellyfin/jellyfin:10.10.7", id: "sha256:1" }, values: { ports: { web: 8096 }, env: {}, volumes: {} }, pinnedRollback: false, uninstalledAt: null }, container: { exists: true, running: true, status: "running", health: "healthy", restarts: 0, image: "sha256:1" }, urls: [{ id: "web", label: "Web UI", host: 8096, exposure: "lan" }] } }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.endsWith("/operations/app.backups.inspect/run")) return json({ operation: "app.backups.inspect", result: { id: "jellyfin", directory: "/x", backups: [{ artifact: "20260816T030000Z.tar.gz", createdAt: "2026-08-16T03:00:00.000Z", sizeBytes: 2 * 1024 * 1024, downtimeMs: 900, skippedHostPaths: [], image: null }] } });
      if (url.endsWith("/operations/app.backup.files/run")) return json({ operation: "app.backup.files", result: { id: "jellyfin", backup: "20260816T030000Z.tar.gz", files: [{ path: "config", sizeBytes: 0, type: "directory" }, { path: "config/system.xml", sizeBytes: 2048, type: "file" }, { path: "config/users.db", sizeBytes: 40960, type: "file" }], truncated: false } });
      if (url.endsWith("/operations/app.backup.restore-path/jobs")) { staged.push(init?.body as string); return json({ job: { id: "job-rp", type: "op:app.backup.restore-path", title: "Restore one file", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    expect(await screen.findByText("Running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Backups" }));
    fireEvent.click(await screen.findByRole("button", { name: "Browse" }));
    expect(await screen.findByText("config/users.db")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter files"), { target: { value: "system" } });
    expect(screen.queryByText("config/users.db")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore this file" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged[0] ?? "{}")).toEqual({ parameters: { id: "jellyfin", backup: "20260816T030000Z.tar.gz", path: "config/system.xml" } });
  });
});
