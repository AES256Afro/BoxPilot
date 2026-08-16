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
          evidence: { jobs: [], applicationBackups: [], vmBackups: [], routerCheckpoints: [], migrationTransfers: [], fleet: { activeAgents: 0, revokedAgents: 0 } },
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
});
