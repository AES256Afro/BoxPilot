import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RepairCenter from "./RepairCenter";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Repair Center", () => {
  it("renders live checks and stages the harmless helper canary", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("prerequisites")) {
        return new Response(JSON.stringify({ checks: [
          { id: "helper.boundary", group: "BoxPilot", name: "Restricted helper", status: "ready", summary: "Typed protocol responded", repair: null },
          { id: "containers.docker", group: "Applications", name: "Docker Engine", status: "missing", summary: "Docker is unavailable", repair: { kind: "planned", description: "Install after approval" } },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("operations/canary")) {
        expect(init?.headers).toMatchObject({ "X-BoxPilot-CSRF": "csrf-token" });
        return new Response(JSON.stringify({ job: { id: "job-one" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("action-center")) {
        return new Response(JSON.stringify({
          generatedAt: "2026-08-16T05:00:00.000Z",
          sourceStatus: "ready",
          summary: { critical: 0, warning: 1, info: 0, total: 1 },
          notices: [{
            id: "recovery.router.checkpoint", severity: "warning", category: "Router recovery", title: "Router configuration checkpoint", summary: "Export and hash the active router configuration.",
            evidence: ["No router backup identity is recorded.", "Recovery evidence state: action-required."],
            recommendation: { view: "routers", title: "Open Routers", steps: ["Export the active configuration.", "Keep the file independently.", "Record its SHA-256."] },
            boundary: { mutationPerformed: false, automaticFixAvailable: false, commandsIncluded: false, secretsIncluded: false, logsIncluded: false },
          }],
          boundary: { mutationPerformed: false, automaticRepair: false, persistence: false, browserNotifications: false, externalDelivery: false, credentialsIncluded: false, arbitraryLogsIncluded: false },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("recovery-kit")) {
        return new Response(JSON.stringify({
          schemaVersion: 1, generatedAt: "2026-08-16T04:05:00.000Z", product: { name: "BoxPilot", version: "0.26.0" },
          summary: { status: "action-required", verified: 1, actionRequired: 1, operatorChecks: 2, notApplicable: 4, total: 8 },
          checks: [
            { id: "controller.database", state: "operator-check", title: "Independent BoxPilot database copy", evidence: "The controller cannot prove an off-host copy.", action: "Create and verify an independent copy." },
            { id: "router.checkpoint", state: "action-required", title: "Router configuration checkpoint", evidence: "No checkpoint exists.", action: "Export and hash the active router configuration." },
          ],
          evidence: { jobs: [], controllerBackups: [], applicationBackups: [], vmBackups: [], routerCheckpoints: [], migrationTransfers: [], fleet: { activeAgents: 0, revokedAgents: 0 } },
          boundary: { mutationsPerformed: false, databaseCopied: false, backupDataIncluded: false, configurationFilesIncluded: false, credentialsIncluded: false, excluded: ["credentials"] },
          runbookMarkdown: "# BoxPilot recovery kit\n",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Restricted helper")).toBeTruthy();
    expect(screen.getByText("Docker Engine")).toBeTruthy();
    expect(screen.getByText("Recovery readiness and ordered runbook")).toBeTruthy();
    expect(screen.getByText("Prioritized evidence and guided next steps")).toBeTruthy();
    expect(screen.getByText("No automatic fix, command, credential, or log payload.")).toBeTruthy();
    expect(screen.getByText("Independent BoxPilot database copy")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download evidence JSON" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create verification job" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/operations/canary", expect.objectContaining({ method: "POST" })));
  });

  it("keeps prerequisites and jobs available when recovery-kit collection fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("prerequisites")) return new Response(JSON.stringify({ checks: [{ id: "helper.boundary", group: "BoxPilot", name: "Restricted helper", status: "ready", summary: "Ready", repair: null }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("action-center")) return new Response(JSON.stringify({ error: "Action collector unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      if (url.includes("recovery-kit")) return new Response(JSON.stringify({ error: "Collector unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Restricted helper")).toBeTruthy();
    expect(screen.getByText("Recovery kit unavailable")).toBeTruthy();
    expect(screen.getByText(/Prerequisite checks and durable jobs remain available/)).toBeTruthy();
  });

  it("reviews and stages only the immutable smartmontools repair plan", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/operations/prerequisites") return new Response(JSON.stringify({ checks: [{ id: "storage.smartmontools", group: "Storage", name: "SMART monitoring tools", status: "repairable", summary: "Configured APT metadata offers smartmontools 7.5-2", repair: { kind: "approved", description: "Review the exact repair" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/v1/prerequisite-repairs/smartmontools/plans") {
        expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": "csrf-token" }, body: "{}" });
        return new Response(JSON.stringify({ plan: { id: "plan-one", revision: "revision-one", expiresAt: "2026-08-16T06:00:00.000Z", output: { package: "smartmontools", selectedVersion: "7.5-2", currentState: "Not installed", action: "Install only smartmontools and run the fixed scan", networkAccess: true, aptUpdatePerformed: false, arbitraryPackageSelection: false, automaticRollback: false, recovery: "Inspect APT and dpkg before retrying." } } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/v1/prerequisite-repair-plans/plan-one/stage") {
        expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ revision: "revision-one" }) });
        return new Response(JSON.stringify({ job: { id: "job-one" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("action-center")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      if (url.includes("recovery-kit")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review exact repair" }));
    expect(await screen.findByText("smartmontools 7.5-2")).toBeTruthy();
    expect(screen.getByText("Not permitted")).toBeTruthy();
    expect(screen.getByText(/No package name, repository, command, argument, disk, mount, or SMART setting comes from the browser/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage exact repair for password approval" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/prerequisite-repair-plans/plan-one/stage", expect.objectContaining({ method: "POST" })));
  });

  it("reviews and stages only the immutable metadata-only APT refresh", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/operations/prerequisites") return new Response(JSON.stringify({ checks: [{ id: "host.apt-metadata", group: "Host maintenance", name: "APT package metadata", status: "repairable", summary: "APT metadata is stale", repair: { kind: "approved", description: "Review a fixed metadata refresh" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/v1/prerequisite-repairs/apt-metadata/plans") {
        expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": "csrf-token" }, body: "{}" });
        return new Response(JSON.stringify({ plan: { id: "apt-plan", revision: "apt-revision", expiresAt: "2026-08-16T08:00:00.000Z", output: { currentState: "stale", currentUpdatedAt: "2026-08-01T00:00:00.000Z", currentAgeHours: 360, action: "Run only the fixed APT metadata update", networkAccess: true, aptUpdatePerformed: true, packageInstallPerformed: false, packageUpgradePerformed: false, packageRemovalPerformed: false, arbitraryCommandAccepted: false, automaticRollback: false, recovery: "Inspect repository availability before retrying." } } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/v1/prerequisite-repair-plans/apt-plan/stage") {
        expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ revision: "apt-revision" }) });
        return new Response(JSON.stringify({ job: { id: "apt-job" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("action-center")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      if (url.includes("recovery-kit")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review metadata refresh" }));
    expect(await screen.findByText("APT metadata refresh")).toBeTruthy();
    expect(screen.getByText("None permitted")).toBeTruthy();
    expect(screen.getByText(/browser supplies no package, repository, command, option, or target/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage metadata refresh for password approval" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/prerequisite-repair-plans/apt-plan/stage", expect.objectContaining({ method: "POST" })));
  });

  it("reviews and stages only the immutable restic package repair", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/operations/prerequisites") return new Response(JSON.stringify({ checks: [{ id: "backup.restic", group: "Backups", name: "Restic encryption engine", status: "repairable", summary: "Configured APT metadata offers restic 0.18.1-1", repair: { kind: "approved", description: "Review the exact restic repair" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/v1/prerequisite-repairs/restic/plans") {
        expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": "csrf-token" }, body: "{}" });
        return new Response(JSON.stringify({ plan: { id: "restic-plan", revision: "restic-revision", expiresAt: "2026-08-16T13:00:00.000Z", output: { package: "restic", selectedVersion: "0.18.1-1", currentState: "Not installed", action: "Install only restic and verify its fixed binary", networkAccess: true, aptUpdatePerformed: false, arbitraryPackageSelection: false, automaticRollback: false, storageSetupPerformed: false, recovery: "Inspect APT and dpkg before retrying." } } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/v1/prerequisite-repair-plans/restic-plan/stage") {
        expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ revision: "restic-revision" }) });
        return new Response(JSON.stringify({ job: { id: "restic-job" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("action-center")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      if (url.includes("recovery-kit")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review restic repair" }));
    expect(await screen.findByText("restic 0.18.1-1")).toBeTruthy();
    expect(screen.getByText("Separate terminal step")).toBeTruthy();
    expect(screen.getByText(/Installation does not mount a disk, create a recovery key, initialize a repository, or start a backup/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage exact repair for password approval" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/prerequisite-repair-plans/restic-plan/stage", expect.objectContaining({ method: "POST" })));
  });

  it("reviews and stages only the immutable Ubuntu Docker Engine repair", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/operations/prerequisites") return new Response(JSON.stringify({ checks: [{ id: "containers.docker", group: "Applications", name: "Docker Engine", status: "repairable", summary: "Configured Ubuntu APT metadata offers docker.io 28.2.2-0ubuntu1", repair: { kind: "approved", description: "Review the exact Docker install" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/v1/prerequisite-repairs/docker/plans") {
        expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": "csrf-token" }, body: "{}" });
        return new Response(JSON.stringify({ plan: { id: "docker-plan", revision: "docker-revision", expiresAt: "2026-08-16T13:00:00.000Z", output: { package: "docker.io", selectedVersion: "28.2.2-0ubuntu1", currentState: "No compatible active Docker Engine detected", action: "Install only docker.io and verify docker.service", networkAccess: true, aptUpdatePerformed: false, arbitraryPackageSelection: false, arbitraryRepositorySelection: false, daemonConfigurationChanged: false, userGroupChanged: false, containerCreated: false, automaticRollback: false, recovery: "Inspect the dedicated unit, Docker service, APT, and dpkg before retrying." } } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/v1/prerequisite-repair-plans/docker-plan/stage") {
        expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ revision: "docker-revision" }) });
        return new Response(JSON.stringify({ job: { id: "docker-job" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("action-center")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      if (url.includes("recovery-kit")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review Docker install" }));
    expect(await screen.findByText("Ubuntu docker.io 28.2.2-0ubuntu1")).toBeTruthy();
    expect(screen.getByText("Untouched")).toBeTruthy();
    expect(screen.getByText(/Existing compatible Docker providers are never replaced/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage Docker install for password approval" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/prerequisite-repair-plans/docker-plan/stage", expect.objectContaining({ method: "POST" })));
  });

  it("reviews and stages only the immutable Ubuntu virtualization bundle", async () => {
    const packageSet = [
      { name: "qemu-system-x86", version: "1:10.2.1+ds-1ubuntu3.2" },
      { name: "libvirt-daemon-system", version: "12.0.0-1ubuntu5.2" },
      { name: "libvirt-clients", version: "12.0.0-1ubuntu5.2" },
      { name: "virtinst", version: "1:5.1.0-1" },
      { name: "ovmf", version: "2025.11-3ubuntu7" },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/operations/prerequisites") return new Response(JSON.stringify({ checks: [{ id: "virtualization.libvirt", group: "Virtualization", name: "KVM, QEMU, and libvirt", status: "repairable", summary: "Every fixed candidate is available", repair: { kind: "approved", description: "Review the exact five-package plan" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url === "/api/v1/prerequisite-repairs/virtualization/plans") {
        expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": "csrf-token" }, body: "{}" });
        return new Response(JSON.stringify({ plan: { id: "virtualization-plan", revision: "virtualization-revision", expiresAt: "2026-08-16T13:00:00.000Z", output: { packageSet, currentState: "Hardware virtualization is available and no provider was detected", action: "Install the fixed Ubuntu virtualization bundle and verify qemu:///system", networkAccess: true, aptUpdatePerformed: false, dependencyChangesPossible: true, arbitraryPackageSelection: false, arbitraryRepositorySelection: false, operatorUserGroupChanged: false, networkCreated: false, storagePoolCreated: false, virtualMachineCreated: false, automaticRollback: false, recovery: "Inspect the dedicated unit, libvirtd, APT, dpkg, and /dev/kvm before retrying." } } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/v1/prerequisite-repair-plans/virtualization-plan/stage") {
        expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ revision: "virtualization-revision" }) });
        return new Response(JSON.stringify({ job: { id: "virtualization-job" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("action-center")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      if (url.includes("recovery-kit")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Review virtualization install" }));
    expect(await screen.findByText("KVM, QEMU, and libvirt Ubuntu bundle")).toBeTruthy();
    expect(screen.getByText("5 exact Ubuntu candidates")).toBeTruthy();
    expect(screen.getByText(/Ubuntu may install or update required dependencies/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage virtualization install for password approval" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/prerequisite-repair-plans/virtualization-plan/stage", expect.objectContaining({ method: "POST" })));
  });
});
