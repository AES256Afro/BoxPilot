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
});
