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

  it("offers Protect only when the restic repository is ready, staging through the desk", async () => {
    const onOpenRepair = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/backups")) return json({ backups: [backup] });
      if (url.endsWith("/controller-backup-protection")) return json({ destination: { repositoryInitialized: true }, protections: [] });
      if (url.endsWith("/controller-backup-retention")) return json({});
      if (url.endsWith(`/controller-backups/${backup.id}/protection-plans`)) return json({ plan: { id: "plan-1", revision: "r1" } }, 201);
      if (url.endsWith("/controller-protection-plans/plan-1/stage")) { expect(init?.body).toBe(JSON.stringify({ revision: "r1" })); return json({ job: { id: "j" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BackupCenter csrfToken="csrf-token" onOpenRepair={onOpenRepair} />);

    fireEvent.click(await screen.findByRole("button", { name: "Protect" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
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
