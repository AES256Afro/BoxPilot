import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackupCenter from "./BackupCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Backup Center", () => {
  it("plans and stages a restore-verified backup", async () => {
    const onOpenRepair = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/backups" && !init?.method) return new Response(JSON.stringify({ coverage: [
        { applicationId: "boxpilot-controller", name: "BoxPilot controller", sourceKind: "controller-state", source: { installed: true, healthy: true, state: "ready", detail: "Live SQLite source is ready" }, state: "unprotected", protected: false, latestBackup: null, requirement: "WAL-aware restore required" },
        { applicationId: "uptime-kuma", name: "Uptime Kuma", sourceKind: "application-state", source: { installed: true, healthy: true, state: "running", detail: "Managed container is running" }, state: "unprotected", protected: false, latestBackup: null, requirement: "Restore required" },
        { applicationId: "pi-hole", name: "Pi-hole", sourceKind: "application-state", source: { installed: true, healthy: true, state: "running", detail: "Managed DNS container is running" }, state: "unprotected", protected: false, latestBackup: null, requirement: "Restore required" },
      ], backups: [], limitations: ["Local only"] }), { status: 200 });
      if (url.endsWith("/plans") && init?.method === "POST") return new Response(JSON.stringify({ plan: { id: "plan-one", revision: "rev-one", subjectId: url.includes("pi-hole") ? "pi-hole" : "uptime-kuma", output: { executable: true, destination: "local-managed", blockers: [], changes: ["Archive data"], warnings: ["Brief downtime"], recovery: "Restart source" } } }), { status: 201 });
      if (url.includes("/backup-plans/") && init?.method === "POST") return new Response(JSON.stringify({ job: { id: "job-one" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));

    render(<BackupCenter csrfToken="csrf" onOpenRepair={onOpenRepair} />);
    expect(await screen.findByRole("button", { name: "Plan verified backup for Uptime Kuma" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan verified backup for BoxPilot controller" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan verified backup for Pi-hole" }));
    expect(await screen.findByRole("region", { name: "Backup plan" })).toBeTruthy();
    expect(screen.getByText(/Pi-hole: ready for approval/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/v1/backups/pi-hole/plans", expect.objectContaining({ method: "POST" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage for approval" }));
    await waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
  });

  it("shows an explicit empty evidence state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ coverage: [], backups: [], limitations: [] }), { status: 200 })));
    render(<BackupCenter csrfToken="csrf" onOpenRepair={() => {}} />);
    expect(await screen.findByText(/No backup is listed as successful/)).toBeTruthy();
  });

  it("shows complete controller artifact and manifest verification evidence", async () => {
    const artifactSha = "a".repeat(64);
    const manifestSha = "b".repeat(64);
    const artifactPath = "/var/lib/boxpilot-managed/backups/boxpilot-controller/11111111-1111-4111-8111-111111111111/boxpilot.sqlite3";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      coverage: [{ applicationId: "boxpilot-controller", name: "BoxPilot controller", sourceKind: "controller-state", source: { installed: true, healthy: true, state: "ready", detail: "Live SQLite source is ready" }, state: "verified", protected: true, latestBackup: null, requirement: "WAL-aware restore required" }],
      backups: [{ id: "backup-one", applicationId: "boxpilot-controller", destination: "local-managed", artifactPath, checksumSha256: artifactSha, sizeBytes: 4096, downtimeMs: 0, restoreDrill: { passed: true, mode: "isolated-copy-open", manifestChecksumSha256: manifestSha }, createdAt: "2026-08-16T00:00:00.000Z", verifiedAt: "2026-08-16T00:00:01.000Z" }],
      limitations: [],
    }), { status: 200 })));
    render(<BackupCenter csrfToken="csrf" onOpenRepair={() => {}} />);
    expect(await screen.findByText("Passed, isolated copy-open")).toBeTruthy();
    fireEvent.click(screen.getByText("Verification details"));
    expect(screen.getByText(artifactPath)).toBeTruthy();
    expect(screen.getByText(artifactSha)).toBeTruthy();
    expect(screen.getByText(manifestSha)).toBeTruthy();
  });
});
