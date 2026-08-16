import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ApplicationCatalog from "./ApplicationCatalog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("curated application catalog", () => {
  it("loads manifests and renders a live reviewed deployment plan", async () => {
    const application = {
      id: "uptime-kuma", name: "Uptime Kuma", category: "Monitoring", description: "Monitor services", execution: "enabled", risk: "low", targets: ["docker"],
      image: { version: "2.5.0", digestPinned: true }, integrity: `sha256:${"a".repeat(64)}`, live: { installed: false, state: "not-installed", detail: "Ready to plan" },
    };
    const plan = {
      id: "plan-one", subjectId: "uptime-kuma", revision: "revision123", input: { target: "docker", hostPort: 3001 }, expiresAt: "2026-08-15T20:00:00Z",
      output: { executable: true, changes: ["Create managed data directory"], blockers: [], warnings: [], recovery: { summary: "Preserve data", preservesData: true }, image: application.image },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/applications")) return new Response(JSON.stringify({ applications: [application] }), { status: 200, headers: { "Content-Type": "application/json" } });
      expect(init?.headers).toMatchObject({ "X-BoxPilot-CSRF": "csrf" });
      return new Response(JSON.stringify({ plan }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationCatalog csrfToken="csrf" onInspectCompose={vi.fn()} onOpenRepair={vi.fn()} />);

    expect(await screen.findByText("Uptime Kuma")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan deployment" }));
    expect(screen.getByText(/Image digest pinned/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate live plan" }));
    expect(await screen.findByText("Ready to stage")).toBeTruthy();
    expect(screen.getByText("Create managed data directory")).toBeTruthy();
  });

  it("carries the linked network assessment into an exact-address Pi-hole plan", async () => {
    const application = {
      id: "pi-hole", name: "Pi-hole", category: "DNS", description: "Filter DNS", execution: "enabled", risk: "network-critical", targets: ["docker", "virtual-machine"],
      image: { version: "2026.07.2", digestPinned: true }, integrity: `sha256:${"b".repeat(64)}`, live: { installed: false, state: "not-installed", detail: "Ready to plan", backup: { state: "not-applicable", verifiedAt: null } },
    };
    const plan = {
      id: "pihole-plan", subjectId: "pi-hole", revision: "revision456", input: { target: "docker", hostPort: 8080, lanAddress: "192.168.8.10", networkAssessmentId: "network-plan-one" }, expiresAt: "2026-08-15T20:00:00Z",
      output: { executable: true, lanAddress: "192.168.8.10", networkAssessmentId: "network-plan-one", changes: ["Start exact-address Pi-hole"], blockers: [], warnings: ["No DNS cutover"], recovery: { summary: "Preserve data", preservesData: true }, image: application.image },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/api/v1/applications")) return new Response(JSON.stringify({ applications: [application] }), { status: 200, headers: { "Content-Type": "application/json" } });
      expect(JSON.parse(String(init?.body))).toMatchObject({ target: "docker", hostPort: 8080, networkAssessmentId: "network-plan-one" });
      return new Response(JSON.stringify({ plan }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ApplicationCatalog csrfToken="csrf" networkAssessmentId="network-plan-one" onInspectCompose={vi.fn()} onOpenRepair={vi.fn()} onOpenNetwork={vi.fn()} />);

    expect(await screen.findByText("Pi-hole")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plan deployment" }));
    expect(screen.getByText("Network assessment linked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate live plan" }));
    expect(await screen.findByText("Ready to stage")).toBeTruthy();
    expect(screen.getByText(/DNS 192\.168\.8\.10:53 TCP\/UDP/)).toBeTruthy();
  });
});
