import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RepairCenter from "./RepairCenter";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Repair Center", () => {
  it("renders live checks and verifies the helper directly", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("prerequisites")) {
        return new Response(JSON.stringify({ checks: [
          { id: "helper.boundary", group: "BoxPilot", name: "Restricted helper", status: "ready", summary: "Typed protocol responded", repair: null },
          { id: "containers.docker", group: "Applications", name: "Docker Engine", status: "missing", summary: "Docker is unavailable", repair: { kind: "planned", description: "Install after approval" } },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/operations/canary.verify/inspect")) {
        return new Response(JSON.stringify({ operation: "canary.verify", result: { verified: true, helperVersion: "0.61.0", mutationPerformed: false } }), { status: 200, headers: { "Content-Type": "application/json" } });
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
          evidence: { jobs: [], controllerBackups: [], controllerProtections: [], controllerRetentionRuns: [], applications: [], virtualMachines: [], vmBackups: [], prerequisites: [] },
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
    fireEvent.click(screen.getByRole("button", { name: "Verify the helper" }));
    expect(await screen.findByText(/version 0.61.0/)).toBeTruthy();
  });

  it("approves a low-risk job with one click and asks for the password only when the policy requires it", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const job = { id: "job-low", title: "Restart Uptime Kuma", type: "application.uptime-kuma.action", state: "awaiting_approval", risk: "low", error: null, steps: [], recovery: { reason: "Reversible" } };
    let approved: RequestInit | undefined;
    let policy = { jobId: "job-low", tier: "low", passwordRequired: false, elevated: false, mode: "tiered", reason: "low risk" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("prerequisites")) return json({ checks: [] });
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      if (url.endsWith("/approval")) return json(policy);
      if (url.endsWith("/approve")) { approved = init; return json({ job: { ...job, state: "completed" } }); }
      return json({ jobs: [job] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<RepairCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Low risk · one click")).toBeTruthy();
    expect(screen.queryByLabelText("Approval password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await vi.waitFor(() => expect(approved).toBeTruthy());
    expect(approved?.body).toBe("{}");
    unmount();

    policy = { jobId: "job-low", tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk" };
    render(<RepairCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("High risk · password required")).toBeTruthy();
    const input = screen.getByLabelText("Approval password");
    const button = screen.getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "correct horse battery" } });
    expect(button.disabled).toBe(false);
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

  it("reviews a pinned repair through the registry inspect and stages it in the shared dialog", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/operations/prerequisites") return json({ checks: [{ id: "storage.smartmontools", group: "Storage", name: "SMART monitoring tools", status: "repairable", summary: "Configured APT metadata offers smartmontools 7.5-2", repair: { kind: "approved", description: "Review the exact repair" } }] });
      if (url.endsWith("/operations/prerequisite.smartmontools.inspect/inspect")) return json({ operation: "prerequisite.smartmontools.inspect", result: { package: "smartmontools", installed: false, selectedVersion: "7.5-2", candidateVersion: "7.5-2" } });
      if (url.endsWith("/operations/prerequisite.smartmontools.install/jobs")) { staged = init?.body as string; return json({ job: { id: "job-s", type: "op:prerequisite.smartmontools.install", title: "Install smartmontools", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      return json({ jobs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review exact repair" }));
    expect(await screen.findByText("Install smartmontools 7.5-2")).toBeTruthy();
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { expectedVersion: "7.5-2" } }));
  });

  it("pins the exact five-package set when staging the virtualization install", async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const candidatePackages = { "qemu-system-x86": "1:10.2.1+ds-1ubuntu3.2", "libvirt-daemon-system": "12.0.0-1ubuntu5.2", "libvirt-clients": "12.0.0-1ubuntu5.2", virtinst: "1:5.1.0-1", ovmf: "2025.11-3ubuntu7" };
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/operations/prerequisites") return json({ checks: [{ id: "virtualization.libvirt", group: "Virtualization", name: "KVM, QEMU, and libvirt", status: "repairable", summary: "Every fixed candidate is available", repair: { kind: "approved", description: "Review the exact five-package plan" } }] });
      if (url.endsWith("/operations/prerequisite.virtualization.inspect/inspect")) return json({ operation: "prerequisite.virtualization.inspect", result: { installed: false, candidatePackages } });
      if (url.endsWith("/operations/prerequisite.virtualization.install/jobs")) { staged = init?.body as string; return json({ job: { id: "job-v", type: "op:prerequisite.virtualization.install", title: "Install KVM/QEMU/libvirt", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      if (url.includes("action-center") || url.includes("recovery-kit")) return json({ error: "unavailable" }, 503);
      return json({ jobs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RepairCenter csrfToken="csrf-token" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review exact repair" }));
    expect(await screen.findByText(/qemu-system-x86 1:10.2.1/)).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { expectedPackages: candidatePackages } }));
  });
});
