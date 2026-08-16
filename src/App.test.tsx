import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BoxPilot console", () => {
  const inventoryFixture = {
    generatedAt: "2026-08-15T20:00:00Z",
    host: { hostname: "bigbox", operatingSystem: "Ubuntu 26.04 LTS", kernel: "7.0.0", architecture: "x64", uptimeSeconds: 90000 },
    compute: { cpuCount: 8, cpuModel: "fixture", load1: 1, loadPercent: 13, totalMemoryBytes: 32 * 1024 ** 3, usedMemoryBytes: 8 * 1024 ** 3, memoryUsedPercent: 25 },
    storage: { root: { totalBytes: 100 * 1024 ** 3, usedBytes: 20 * 1024 ** 3, freeBytes: 80 * 1024 ** 3, usedPercent: 20 } },
    network: { addresses: [], tailscale: { installed: true, connected: true, dnsName: "bigbox.example.ts.net" } },
    services: [],
    docker: { available: true, containers: [], images: [], networks: [], volumes: [], projects: [] },
  };

  function authenticatedFetch(input: RequestInfo | URL) {
    const url = input.toString();
    const body = url.includes("/auth/status")
      ? { bootstrapRequired: false, authenticated: true, owner: { id: "owner-one", username: "operator" }, csrfToken: "csrf-token", expiresAt: "2026-08-15T20:00:00Z" }
      : url.endsWith("/api/v1/inventory")
        ? inventoryFixture
      : url.endsWith("/api/v1/applications")
        ? { applications: [{ id: "uptime-kuma", name: "Uptime Kuma", category: "Monitoring", description: "Private monitoring", execution: "enabled", risk: "low", targets: ["docker"], image: { version: "2.5.0", digestPinned: true }, integrity: `sha256:${"a".repeat(64)}`, live: { installed: false, state: "not-installed", detail: "Ready to plan" } }] }
      : { status: "ok", mode: "host-aware" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }

  it("navigates between product areas", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Server overview" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Data source" }).textContent).toContain("Live sanitized inventory");
    expect(await screen.findByText("bigbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Applications/ }));
    expect(screen.getByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(await screen.findByText("Uptime Kuma")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Data source" }).textContent).toContain("staging are live");
    fireEvent.click(screen.getByRole("button", { name: /Backups/ }));
    expect(screen.getByRole("heading", { name: "Backups" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Data source" }).textContent).toContain("Controller and application backup engine");
    expect(screen.getByRole("region", { name: "Data source" }).textContent).toContain("WAL-aware snapshot and isolated copy-open drill");
  });

  it("opens the browser-only Compose inspector", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Server overview" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Applications/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import Compose" }));
    expect(screen.getByRole("dialog", { name: "Inspect a Compose stack" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run dry scan" }));
    expect(screen.getByText("No high-risk patterns detected by this basic scan.")).toBeTruthy();
  });

  it("renders fixed redacted system logs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      const body = url.includes("/auth/status")
        ? { bootstrapRequired: false, authenticated: true, owner: { id: "owner-one", username: "operator" }, csrfToken: "csrf-token", expiresAt: "2026-08-15T20:00:00Z" }
        : url.endsWith("/api/v1/inventory")
        ? inventoryFixture
        : url.includes("/logs")
        ? { source: "boxpilot", entries: [{ timestamp: "2026-08-14T12:00:00Z", unit: "boxpilot.service", priority: 6, message: "BoxPilot listening" }] }
        : { status: "ok", mode: "host-aware" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:boxpilot-support-bundle");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Server overview" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Logs/ }));

    expect(await screen.findByText("BoxPilot listening")).toBeTruthy();
    expect(screen.getByText("boxpilot.service")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download support bundle" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/support-bundle"));
  });
});
