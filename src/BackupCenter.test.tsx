import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackupCenter from "./BackupCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const blockedRetention = { executable: false, repositoryId: null, beforeCount: 0, policy: { minimumCopies: 3, minimumAgeDays: 30, requiresProtectedRestoreDrill: true, preserveActiveControllerOperations: true }, candidates: [], kept: [], retentionRuns: [], blockers: ["No eligible controller snapshot"], changes: [], warnings: [], verification: [], recovery: "Keep retained snapshots", prunePerformed: false, spaceReclaimed: false };
const blockedApplicationProtection = { destination: { ready: false, blockers: ["Mount independent application storage"], setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-application-restic-setup.sh" }, protections: [] };
const blockedApplicationRetention = { executable: false, repositoryId: null, beforeCount: 0, policy: { minimumCopiesPerApplication: 3, minimumAgeDays: 30, requiresProtectedRestoreDrill: true, preserveRecoveryReferences: true, preserveActiveApplicationOperations: true }, candidates: [], kept: [], retentionRuns: [], blockers: ["No eligible application snapshot"], changes: [], warnings: [], verification: [], recovery: "Keep retained snapshots", prunePerformed: false, spaceReclaimed: false };

describe("Backup Center", () => {
  it("plans and stages a restore-verified backup", async () => {
    const onOpenRepair = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/controller-backup-protection" && !init?.method) return new Response(JSON.stringify({ destination: { ready: false, blockers: ["Mount independent storage"], setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-controller-restic-setup.sh" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/application-backup-protection" && !init?.method) return new Response(JSON.stringify(blockedApplicationProtection), { status: 200 });
      if (url === "/api/v1/controller-backup-retention" && !init?.method) return new Response(JSON.stringify(blockedRetention), { status: 200 });
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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() === "/api/v1/controller-backup-protection") return new Response(JSON.stringify({ destination: { ready: false, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (input.toString() === "/api/v1/application-backup-protection") return new Response(JSON.stringify(blockedApplicationProtection), { status: 200 });
      if (input.toString() === "/api/v1/controller-backup-retention") return new Response(JSON.stringify(blockedRetention), { status: 200 });
      return new Response(JSON.stringify({ coverage: [], backups: [], limitations: [] }), { status: 200 });
    }));
    render(<BackupCenter csrfToken="csrf" onOpenRepair={() => {}} />);
    expect(await screen.findByText(/No backup is listed as successful/)).toBeTruthy();
  });

  it("shows complete controller artifact and manifest verification evidence", async () => {
    const artifactSha = "a".repeat(64);
    const manifestSha = "b".repeat(64);
    const artifactPath = "/var/lib/boxpilot-managed/backups/boxpilot-controller/11111111-1111-4111-8111-111111111111/boxpilot.sqlite3";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => input.toString() === "/api/v1/controller-backup-protection"
      ? new Response(JSON.stringify({ destination: { ready: false, blockers: ["Mount independent storage"], setupCommand: "sudo setup" }, protections: [] }), { status: 200 })
      : input.toString() === "/api/v1/application-backup-protection"
        ? new Response(JSON.stringify(blockedApplicationProtection), { status: 200 })
      : input.toString() === "/api/v1/controller-backup-retention"
        ? new Response(JSON.stringify(blockedRetention), { status: 200 })
        : new Response(JSON.stringify({
      coverage: [{ applicationId: "boxpilot-controller", name: "BoxPilot controller", sourceKind: "controller-state", source: { installed: true, healthy: true, state: "ready", detail: "Live SQLite source is ready" }, state: "locally-verified", protected: false, latestBackup: null, requirement: "WAL-aware restore required" }],
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

  it("plans independent encrypted controller protection only from a verified local snapshot", async () => {
    const onOpenRepair = vi.fn();
    const artifactSha = "a".repeat(64);
    const manifestSha = "b".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/backups" && !init?.method) return new Response(JSON.stringify({
        coverage: [{ applicationId: "boxpilot-controller", name: "BoxPilot controller", sourceKind: "controller-state", source: { installed: true, healthy: true, state: "ready", detail: "Live SQLite source is ready" }, state: "locally-verified", protected: false, latestBackup: { id: "backup-one", restoreDrill: { passed: true } }, latestProtection: null, requirement: "WAL-aware restore required" }],
        backups: [{ id: "backup-one", applicationId: "boxpilot-controller", destination: "local-managed", artifactPath: "/fixed/boxpilot.sqlite3", checksumSha256: artifactSha, sizeBytes: 4096, downtimeMs: 0, restoreDrill: { passed: true, mode: "isolated-copy-open", manifestChecksumSha256: manifestSha }, createdAt: "2026-08-16T00:00:00.000Z", verifiedAt: "2026-08-16T00:00:01.000Z" }],
        limitations: [],
      }), { status: 200 });
      if (url === "/api/v1/controller-backup-protection" && !init?.method) return new Response(JSON.stringify({ destination: { ready: true, encrypted: true, independent: true, resticVersion: "0.18.1", mount: { target: "/mnt/boxpilot-backup", sourceType: "ext4" }, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/application-backup-protection" && !init?.method) return new Response(JSON.stringify(blockedApplicationProtection), { status: 200 });
      if (url === "/api/v1/controller-backup-retention" && !init?.method) return new Response(JSON.stringify(blockedRetention), { status: 200 });
      if (url === "/api/v1/controller-backups/backup-one/protection-plans" && init?.method === "POST") return new Response(JSON.stringify({ plan: { id: "protect-plan", revision: "protect-revision", subjectId: "backup-one", output: { executable: true, destination: "mounted-restic-controller", destinationFreeBytes: 1024 ** 3, blockers: [], changes: ["Encrypt exact backup"], verification: ["Restore exact snapshot"], warnings: ["Keep password outside this server"], recovery: "Preserve all source evidence" } } }), { status: 201 });
      if (url === "/api/v1/controller-protection-plans/protect-plan/stage" && init?.method === "POST") return new Response(JSON.stringify({ job: { id: "protect-job" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));

    render(<BackupCenter csrfToken="csrf" onOpenRepair={onOpenRepair} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan encrypted copy" }));
    expect(await screen.findByRole("region", { name: "Controller protection plan" })).toBeTruthy();
    expect(screen.getByText("Restore exact snapshot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage independent protection" }));
    await waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
  });

  it("shows and stages the fixed no-prune controller retention plan", async () => {
    const onOpenRepair = vi.fn();
    const eligible = { ...blockedRetention, executable: true, repositoryId: "a".repeat(64), beforeCount: 5, blockers: [], candidates: [{ protectionId: "protect-one", backupId: "backup-one", snapshotId: "b".repeat(64), createdAt: "2026-06-01T00:00:00.000Z", ageDays: 76, sizeBytes: 8192 }], kept: [], changes: ["Forget exactly one reviewed snapshot"], warnings: ["No prune"], verification: ["Full repository read"], recovery: "Use another retained snapshot" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/backups") return new Response(JSON.stringify({ coverage: [], backups: [], limitations: [] }), { status: 200 });
      if (url === "/api/v1/controller-backup-protection") return new Response(JSON.stringify({ destination: { ready: true, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/application-backup-protection") return new Response(JSON.stringify(blockedApplicationProtection), { status: 200 });
      if (url === "/api/v1/controller-backup-retention" && !init?.method) return new Response(JSON.stringify(eligible), { status: 200 });
      if (url === "/api/v1/controller-retention-plans" && init?.method === "POST") return new Response(JSON.stringify({ plan: { id: "retention-plan", revision: "retention-revision", subjectId: eligible.repositoryId, output: eligible } }), { status: 201 });
      if (url === "/api/v1/controller-retention-plans/retention-plan/stage" && init?.method === "POST") return new Response(JSON.stringify({ job: { id: "retention-job" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));

    render(<BackupCenter csrfToken="csrf" onOpenRepair={onOpenRepair} />);
    fireEvent.click(await screen.findByRole("button", { name: "Build fixed retention plan" }));
    expect(await screen.findByRole("region", { name: "Controller retention plan" })).toBeTruthy();
    expect(screen.getByText("Full repository read")).toBeTruthy();
    expect(screen.getByText("No prune")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage exact retention batch" }));
    await waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
  });

  it("shows and stages fixed per-application no-prune retention", async () => {
    const onOpenRepair = vi.fn();
    const eligible = { ...blockedApplicationRetention, executable: true, repositoryId: "a".repeat(64), beforeCount: 5, blockers: [], candidates: [{ protectionId: "protect-one", backupId: "backup-one", applicationId: "uptime-kuma", snapshotId: "b".repeat(64), createdAt: "2026-06-01T00:00:00.000Z", ageDays: 76, sizeBytes: 8192 }], kept: [], changes: ["Forget one exact application snapshot"], warnings: ["No prune"], verification: ["Full application repository read"], recovery: "Use another retained application snapshot" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/backups") return new Response(JSON.stringify({ coverage: [], backups: [], limitations: [] }), { status: 200 });
      if (url === "/api/v1/controller-backup-protection") return new Response(JSON.stringify({ destination: { ready: false, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/application-backup-protection") return new Response(JSON.stringify(blockedApplicationProtection), { status: 200 });
      if (url === "/api/v1/controller-backup-retention") return new Response(JSON.stringify(blockedRetention), { status: 200 });
      if (url === "/api/v1/application-backup-retention" && !init?.method) return new Response(JSON.stringify(eligible), { status: 200 });
      if (url === "/api/v1/application-retention-plans" && init?.method === "POST") return new Response(JSON.stringify({ plan: { id: "app-retention-plan", revision: "app-retention-revision", subjectId: eligible.repositoryId, output: eligible } }), { status: 201 });
      if (url === "/api/v1/application-retention-plans/app-retention-plan/stage" && init?.method === "POST") return new Response(JSON.stringify({ job: { id: "app-retention-job" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));

    render(<BackupCenter csrfToken="csrf" onOpenRepair={onOpenRepair} />);
    fireEvent.click(await screen.findByRole("button", { name: "Build application retention plan" }));
    expect(await screen.findByRole("region", { name: "Application retention plan" })).toBeTruthy();
    expect(screen.getByText("Full application repository read")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage application retention batch" }));
    await waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
  });

  it("plans and stages an exact encrypted application archive restore", async () => {
    const onOpenRepair = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/backups") return new Response(JSON.stringify({ coverage: [{ applicationId: "pi-hole", name: "Pi-hole", sourceKind: "application-state", source: { installed: true, healthy: true, state: "running", detail: "Healthy" }, state: "locally-verified", protected: false, latestBackup: { id: "app-backup", restoreDrill: { passed: true } }, latestProtection: null, requirement: "No-network restore" }], backups: [{ id: "app-backup", applicationId: "pi-hole", destination: "local-managed", artifactPath: "/fixed/pi-hole.tar.gz", checksumSha256: "a".repeat(64), sizeBytes: 4096, downtimeMs: 10, restoreDrill: { passed: true, network: "none", publishedPorts: 0 }, createdAt: "2026-08-16T00:00:00.000Z", verifiedAt: "2026-08-16T00:00:01.000Z" }], limitations: [] }), { status: 200 });
      if (url === "/api/v1/controller-backup-protection") return new Response(JSON.stringify({ destination: { ready: false, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/application-backup-protection" && !init?.method) return new Response(JSON.stringify({ destination: { ready: true, encrypted: true, independent: true, mount: { target: "/mnt/boxpilot-backup", sourceType: "ext4" }, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/controller-backup-retention") return new Response(JSON.stringify(blockedRetention), { status: 200 });
      if (url === "/api/v1/application-backups/app-backup/protection-plans" && init?.method === "POST") return new Response(JSON.stringify({ plan: { id: "app-plan", revision: "app-revision", subjectId: "app-backup", output: { executable: true, destination: "mounted-restic-applications", blockers: [], changes: ["Encrypt exact application archive"], verification: ["Restore exact archive SHA-256"], warnings: ["Keep separate key"], recovery: "Preserve source evidence" } } }), { status: 201 });
      if (url === "/api/v1/application-protection-plans/app-plan/stage" && init?.method === "POST") return new Response(JSON.stringify({ job: { id: "app-job" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));
    render(<BackupCenter csrfToken="csrf" onOpenRepair={onOpenRepair} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan encrypted copy" }));
    expect(await screen.findByRole("region", { name: "Application protection plan" })).toBeTruthy();
    expect(screen.getByText("Restore exact archive SHA-256")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage independent protection" }));
    await waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
  });

  it("plans and stages a stopped no-network Keel recovery clone", async () => {
    const onOpenRepair = vi.fn();
    const backupId = "11111111-1111-4111-8111-111111111111";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/backups") return new Response(JSON.stringify({
        coverage: [{ applicationId: "keel", name: "Keel Notes", sourceKind: "application-state", source: { installed: true, healthy: true, state: "installed", detail: "Healthy" }, state: "locally-verified", protected: false, latestBackup: { id: backupId, restoreDrill: { passed: true } }, latestProtection: null, requirement: "Isolated SQLite-open restore" }],
        backups: [{ id: backupId, applicationId: "keel", destination: "local-managed", artifactPath: `/fixed/${backupId}.tar.gz`, checksumSha256: "a".repeat(64), sizeBytes: 8192, downtimeMs: 20, restoreDrill: { passed: true, mode: "isolated-keel-export-open", network: "none", publishedPorts: 0, manifestChecksumSha256: "b".repeat(64) }, createdAt: "2026-08-16T00:00:00.000Z", verifiedAt: "2026-08-16T00:00:01.000Z" }], limitations: [],
      }), { status: 200 });
      if (url === "/api/v1/controller-backup-protection") return new Response(JSON.stringify({ destination: { ready: false, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/application-backup-protection") return new Response(JSON.stringify(blockedApplicationProtection), { status: 200 });
      if (url === "/api/v1/controller-backup-retention") return new Response(JSON.stringify(blockedRetention), { status: 200 });
      if (url === "/api/v1/keel-recoveries" && !init?.method) return new Response(JSON.stringify({ recoveries: [] }), { status: 200 });
      if (url === `/api/v1/application-backups/${backupId}/keel-recovery-plans` && init?.method === "POST") return new Response(JSON.stringify({ plan: { id: "recovery-plan", revision: "recovery-revision", subjectId: backupId, output: { executable: true, destination: "managed-keel-recovery", initialState: "stopped", network: "none", blockers: [], changes: ["Rehash exact archive"], verification: ["SQLite integrity and schema"], warnings: ["Promotion is separate"], recovery: "Remove only the generated partial before publication" } } }), { status: 201 });
      if (url === "/api/v1/keel-recovery-plans/recovery-plan/stage" && init?.method === "POST") return new Response(JSON.stringify({ job: { id: "recovery-job" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));
    render(<BackupCenter csrfToken="csrf" onOpenRepair={onOpenRepair} />);
    fireEvent.click(await screen.findByRole("button", { name: /Plan stopped clone from/ }));
    expect(await screen.findByRole("region", { name: "Keel recovery plan" })).toBeTruthy();
    expect(screen.getByText("SQLite integrity and schema")).toBeTruthy();
    expect(screen.getAllByText("Promotion is separate").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: "Stage stopped recovery clone" }));
    await waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
  });

  it("plans and stages an isolated startup rehearsal from a stopped Keel clone", async () => {
    const onOpenRepair = vi.fn();
    const recoveryId = "22222222-2222-4222-8222-222222222222";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/backups") return new Response(JSON.stringify({ coverage: [], backups: [], limitations: [] }), { status: 200 });
      if (url === "/api/v1/controller-backup-protection") return new Response(JSON.stringify({ destination: { ready: false, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/application-backup-protection") return new Response(JSON.stringify(blockedApplicationProtection), { status: 200 });
      if (url === "/api/v1/controller-backup-retention") return new Response(JSON.stringify(blockedRetention), { status: 200 });
      if (url === "/api/v1/keel-recoveries") return new Response(JSON.stringify({ recoveries: [{ id: recoveryId, backupId: "11111111-1111-4111-8111-111111111111", applicationId: "keel", destination: "managed-keel-recovery", statePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/state`, evidencePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/recovery.json`, sizeBytes: 4096, state: "stopped", network: "none", createdAt: "2026-08-16T00:00:00.000Z" }] }), { status: 200 });
      if (url === "/api/v1/keel-recovery-drills" && !init?.method) return new Response(JSON.stringify({ drills: [] }), { status: 200 });
      if (url === `/api/v1/keel-recoveries/${recoveryId}/drill-plans` && init?.method === "POST") return new Response(JSON.stringify({ plan: { id: "drill-plan", revision: "drill-revision", subjectId: recoveryId, output: { executable: true, mode: "isolated-keel-startup-health", releaseVersion: "1.2.6", network: "private-loopback-only", port: 3100, blockers: [], changes: ["Copy disposable state"], verification: ["Exact health identity"], warnings: ["Owner login is not tested"], recovery: "Remove only the generated workspace" } } }), { status: 201 });
      if (url === "/api/v1/keel-recovery-drill-plans/drill-plan/stage" && init?.method === "POST") return new Response(JSON.stringify({ job: { id: "drill-job" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));
    render(<BackupCenter csrfToken="csrf" onOpenRepair={onOpenRepair} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan isolated startup rehearsal" }));
    expect(await screen.findByRole("region", { name: "Keel recovery drill plan" })).toBeTruthy();
    expect(screen.getByText("Exact health identity")).toBeTruthy();
    expect(screen.getByText(/private-loopback-only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage isolated startup rehearsal" }));
    await waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
  });

  it("plans and stages only a drilled Keel recovery for critical production promotion", async () => {
    const onOpenRepair = vi.fn();
    const recoveryId = "22222222-2222-4222-8222-222222222222";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/backups") return new Response(JSON.stringify({ coverage: [], backups: [], limitations: [] }), { status: 200 });
      if (url === "/api/v1/controller-backup-protection") return new Response(JSON.stringify({ destination: { ready: false, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/application-backup-protection") return new Response(JSON.stringify(blockedApplicationProtection), { status: 200 });
      if (url === "/api/v1/controller-backup-retention") return new Response(JSON.stringify(blockedRetention), { status: 200 });
      if (url === "/api/v1/keel-recoveries") return new Response(JSON.stringify({ recoveries: [{ id: recoveryId, backupId: "11111111-1111-4111-8111-111111111111", applicationId: "keel", destination: "managed-keel-recovery", statePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/state`, evidencePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/recovery.json`, sizeBytes: 4096, state: "stopped", network: "none", createdAt: "2026-08-16T00:00:00.000Z" }] }), { status: 200 });
      if (url === "/api/v1/keel-recovery-drills") return new Response(JSON.stringify({ drills: [{ id: "33333333-3333-4333-8333-333333333333", recoveryId, applicationId: "keel", releaseVersion: "1.2.6", network: "private-loopback-only", healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, processStarted: true, processStopped: true, workspaceRemoved: true, sourceRecoveryUnchanged: true, passed: true, createdAt: "2026-08-16T00:05:00.000Z" }] }), { status: 200 });
      if (url === "/api/v1/keel-recovery-promotions") return new Response(JSON.stringify({ promotions: [] }), { status: 200 });
      if (url === `/api/v1/keel-recoveries/${recoveryId}/promotion-plans` && init?.method === "POST") return new Response(JSON.stringify({ plan: { id: "promotion-plan", revision: "promotion-revision", subjectId: recoveryId, output: { executable: true, releaseVersion: "1.2.6", network: "host-loopback-only", rollbackDestination: "managed-keel-promotion-rollback", blockers: [], changes: ["Atomically activate drilled state"], verification: ["Previous production rollback retained"], warnings: ["Owner login is not tested"], recovery: "Restore previous production automatically" } } }), { status: 201 });
      if (url === "/api/v1/keel-promotion-plans/promotion-plan/stage" && init?.method === "POST") return new Response(JSON.stringify({ job: { id: "promotion-job" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));
    render(<BackupCenter csrfToken="csrf" onOpenRepair={onOpenRepair} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan production promotion" }));
    expect(await screen.findByRole("region", { name: "Keel production promotion plan" })).toBeTruthy();
    expect(screen.getByText("Previous production rollback retained")).toBeTruthy();
    expect(screen.getByText(/host-loopback-only/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage critical production promotion" }));
    await waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
  });

  it("does not offer promotion when a newer rehearsal failed", async () => {
    const recoveryId = "22222222-2222-4222-8222-222222222222";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/backups") return new Response(JSON.stringify({ coverage: [], backups: [], limitations: [] }), { status: 200 });
      if (url === "/api/v1/controller-backup-protection") return new Response(JSON.stringify({ destination: { ready: false, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/application-backup-protection") return new Response(JSON.stringify(blockedApplicationProtection), { status: 200 });
      if (url === "/api/v1/controller-backup-retention") return new Response(JSON.stringify(blockedRetention), { status: 200 });
      if (url === "/api/v1/keel-recoveries") return new Response(JSON.stringify({ recoveries: [{ id: recoveryId, backupId: "11111111-1111-4111-8111-111111111111", applicationId: "keel", destination: "managed-keel-recovery", statePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/state`, evidencePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/recovery.json`, sizeBytes: 4096, state: "stopped", network: "none", createdAt: "2026-08-16T00:00:00.000Z" }] }), { status: 200 });
      if (url === "/api/v1/keel-recovery-drills") return new Response(JSON.stringify({ drills: [
        { id: "44444444-4444-4444-8444-444444444444", recoveryId, applicationId: "keel", releaseVersion: "1.2.6", passed: false, createdAt: "2026-08-16T00:10:00.000Z" },
        { id: "33333333-3333-4333-8333-333333333333", recoveryId, applicationId: "keel", releaseVersion: "1.2.6", passed: true, createdAt: "2026-08-16T00:05:00.000Z" },
      ] }), { status: 200 });
      if (url === "/api/v1/keel-recovery-promotions") return new Response(JSON.stringify({ promotions: [] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }));
    render(<BackupCenter csrfToken="csrf" onOpenRepair={() => {}} />);
    expect(await screen.findByRole("button", { name: "Plan isolated startup rehearsal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan production promotion" })).toBeNull();
  });

  it("plans and stages an exact operator rollback while showing both retained checkpoints", async () => {
    const onOpenRepair = vi.fn();
    const recoveryId = "22222222-2222-4222-8222-222222222222";
    const promotionId = "44444444-4444-4444-8444-444444444444";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/backups") return new Response(JSON.stringify({ coverage: [], backups: [], limitations: [] }), { status: 200 });
      if (url === "/api/v1/controller-backup-protection") return new Response(JSON.stringify({ destination: { ready: false, blockers: [], setupCommand: "sudo setup" }, protections: [] }), { status: 200 });
      if (url === "/api/v1/application-backup-protection") return new Response(JSON.stringify(blockedApplicationProtection), { status: 200 });
      if (url === "/api/v1/controller-backup-retention") return new Response(JSON.stringify(blockedRetention), { status: 200 });
      if (url === "/api/v1/keel-recoveries") return new Response(JSON.stringify({ recoveries: [{ id: recoveryId, backupId: "11111111-1111-4111-8111-111111111111", applicationId: "keel", destination: "managed-keel-recovery", statePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/state`, evidencePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/recovery.json`, sizeBytes: 4096, state: "stopped", network: "none", createdAt: "2026-08-16T00:00:00.000Z" }] }), { status: 200 });
      if (url === "/api/v1/keel-recovery-drills") return new Response(JSON.stringify({ drills: [{ id: "33333333-3333-4333-8333-333333333333", recoveryId, applicationId: "keel", releaseVersion: "1.2.6", network: "private-loopback-only", healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, processStarted: true, processStopped: true, workspaceRemoved: true, sourceRecoveryUnchanged: true, passed: true, createdAt: "2026-08-16T00:05:00.000Z" }] }), { status: 200 });
      if (url === "/api/v1/keel-recovery-promotions") return new Response(JSON.stringify({ promotions: [{ id: promotionId, recoveryId, drillId: "33333333-3333-4333-8333-333333333333", applicationId: "keel", releaseVersion: "1.2.6", rollbackPath: `/var/lib/boxpilot-managed/keel-promotion-rollbacks/${promotionId}/state`, healthIdentityVerified: true, databaseIntegrity: "ok", rollbackAvailable: true, sourceRecoveryUnchanged: true, ownerLoginTested: false, createdAt: "2026-08-16T00:10:00.000Z" }] }), { status: 200 });
      if (url === "/api/v1/keel-rollbacks") return new Response(JSON.stringify({ rollbacks: [] }), { status: 200 });
      if (url === `/api/v1/keel-promotions/${promotionId}/rollback-plans` && init?.method === "POST") return new Response(JSON.stringify({ plan: { id: "rollback-plan", revision: "rollback-revision", subjectId: promotionId, output: { executable: true, releaseVersion: "1.2.6", network: "host-loopback-only", displacedDestination: "managed-keel-rollback-checkpoint", sourceCheckpointPreserved: true, blockers: [], changes: ["Activate exact retained checkpoint"], verification: ["Original checkpoint remains unchanged"], warnings: ["Owner login is not tested"], recovery: "Restore displaced current production automatically" } } }), { status: 201 });
      if (url === "/api/v1/keel-rollback-plans/rollback-plan/stage" && init?.method === "POST") return new Response(JSON.stringify({ job: { id: "rollback-job" } }), { status: 201 });
      return new Response("{}", { status: 404 });
    }));
    render(<BackupCenter csrfToken="csrf" onOpenRepair={onOpenRepair} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan operator rollback" }));
    expect(await screen.findByRole("region", { name: "Keel operator rollback plan" })).toBeTruthy();
    expect(screen.getByText("Original checkpoint remains unchanged")).toBeTruthy();
    expect(screen.getByText(/managed-keel-rollback-checkpoint/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage critical operator rollback" }));
    await waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
  });
});
