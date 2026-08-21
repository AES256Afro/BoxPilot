import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BoxPilot console", () => {
  const inventoryFixture = {
    generatedAt: "2026-08-15T20:00:00Z",
    host: { hostname: "homebox", operatingSystem: "Ubuntu 26.04 LTS", kernel: "7.0.0", architecture: "x64", uptimeSeconds: 90000 },
    compute: { cpuCount: 8, cpuModel: "fixture", load1: 1, loadPercent: 13, totalMemoryBytes: 32 * 1024 ** 3, usedMemoryBytes: 8 * 1024 ** 3, memoryUsedPercent: 25 },
    storage: { root: { totalBytes: 100 * 1024 ** 3, usedBytes: 20 * 1024 ** 3, freeBytes: 80 * 1024 ** 3, usedPercent: 20 } },
    network: { addresses: [], tailscale: { installed: true, connected: true, dnsName: "homebox.example.ts.net" } },
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
    expect(await screen.findByText("homebox")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Product areas" })).getByRole("button", { name: /Backups/ }));
    expect(screen.getByRole("heading", { name: "Backups" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Data source" }).textContent).toContain("verified restore drills");
  });

  it("opens the page named in the URL and keeps the URL in step", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    window.history.replaceState(null, "", "/?view=backups");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Backups" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Product areas" })).getByRole("button", { name: /Overview/ }));
    expect(await screen.findByRole("heading", { name: "Server overview" })).toBeTruthy();
    expect(window.location.search).toBe("");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Product areas" })).getByRole("button", { name: /Backups/ }));
    expect(window.location.search).toBe("?view=backups");
    window.history.replaceState(null, "", "/");
  });

  it("renders the log viewer and the support bundle download", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      const body = url.includes("/auth/status")
        ? { bootstrapRequired: false, authenticated: true, owner: { id: "owner-one", username: "operator" }, csrfToken: "csrf-token", expiresAt: "2026-08-15T20:00:00Z" }
        : url.endsWith("/api/v1/inventory")
        ? inventoryFixture
        : url.endsWith("/operations/logs.sources/inspect")
        ? { operation: "logs.sources", result: { groups: [{ id: "boxpilot", label: "BoxPilot" }, { id: "kernel", label: "Kernel" }], units: [{ unit: "docker.service", description: "Docker", active: "active" }], containers: [], dockerAvailable: false } }
        : url.endsWith("/operations/logs.read/run")
        ? { operation: "logs.read", result: { kind: "group", target: "boxpilot", lines: ["2026-08-14T12:00:00+0000 host boxpilot[1]: BoxPilot listening"], truncated: false } }
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

    expect(await screen.findByText(/BoxPilot listening/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kernel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download support bundle" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/support-bundle"));
  });
});
