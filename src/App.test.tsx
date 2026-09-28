import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { connectionLabel } from "./appLinks";

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

  const greeting = /^Good (morning|afternoon|evening)$/;
  const dock = () => screen.getByRole("navigation", { name: "Admin areas" });

  it("lands on Home and reaches every area from the dock", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: greeting })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Features" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(dock()).getByRole("button", { name: "Backups" }));
    expect(screen.getByRole("heading", { name: "Backups" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Features" }).textContent).toContain("Restore from a snapshot");
    expect(within(dock()).getByRole("button", { name: "Backups" }).getAttribute("aria-current")).toBe("page");
    expect(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Home" }).hasAttribute("aria-current")).toBe(false);
  });

  it("keeps the Classic overview reachable", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    render(<App />);
    fireEvent.click(within(dock()).getByRole("button", { name: "Overview (Classic)" }));
    expect(await screen.findByRole("heading", { name: "Server overview" })).toBeTruthy();
    expect(screen.getByText("Classic overview")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Features" }).textContent).toContain("Setup checklist");
    expect(await screen.findByText("homebox")).toBeTruthy();
    expect(window.location.search).toBe("?view=overview");
    window.history.replaceState(null, "", "/");
  });

  it("opens the page named in the URL and keeps the URL in step", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    window.history.replaceState(null, "", "/?view=backups");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Backups" })).toBeTruthy();
    const views = screen.getByRole("navigation", { name: "Views" });
    fireEvent.click(within(views).getByRole("button", { name: "Ops" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Ops" })).toBeTruthy();
    expect(window.location.search).toBe("?view=ops");
    expect(within(views).getByRole("button", { name: "Ops" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(views).getByRole("button", { name: "Home" }));
    expect(await screen.findByRole("heading", { level: 1, name: greeting })).toBeTruthy();
    expect(window.location.search).toBe("");
    fireEvent.click(within(dock()).getByRole("button", { name: "Backups" }));
    expect(window.location.search).toBe("?view=backups");
    window.history.replaceState(null, "", "/");
  });

  it("opens the command bar from anywhere with Ctrl K", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    window.history.replaceState(null, "", "/?view=backups");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Backups" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search pages, apps and settings" }).closest(".topbar")).not.toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = within(screen.getByRole("dialog", { name: "Search BoxPilot" })).getByRole("combobox");
    fireEvent.change(input, { target: { value: "firewall" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("heading", { level: 1, name: "Firewall" })).toBeTruthy();
    expect(window.location.search).toBe("?view=firewall");
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
    expect(await screen.findByRole("heading", { level: 1, name: greeting })).toBeTruthy();
    fireEvent.click(within(dock()).getByRole("button", { name: "Logs" }));

    expect(await screen.findByText(/BoxPilot listening/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kernel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download support bundle" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/support-bundle"));
  });

  it("describes the connection from the address bar instead of a fixed Tailscale claim", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    render(<App />);
    expect(await screen.findByText("HTTP connection")).toBeTruthy();
    expect(screen.queryByText(/Funnel/)).toBeNull();
    expect(connectionLabel({ protocol: "https:", hostname: "box.tail1234.ts.net" })).toBe("Tailscale HTTPS");
    expect(connectionLabel({ protocol: "http:", hostname: "100.101.102.103" })).toBe("Tailscale HTTP");
    expect(connectionLabel({ protocol: "https:", hostname: "192.168.1.10" })).toBe("HTTPS connection");
    expect(connectionLabel({ protocol: "http:", hostname: "100.200.1.1" })).toBe("HTTP connection");
  });

  it("counts the catalog's categories instead of naming a fixed number", async () => {
    const manifests = import.meta.glob<string>("../catalog/*.yaml", { query: "?raw", import: "default", eager: true });
    const categories = new Set(Object.values(manifests).map((text) => /^category:\s*(.+?)\s*$/m.exec(text)?.[1]).filter(Boolean));
    expect(categories.size).toBeGreaterThan(0);
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    window.history.replaceState(null, "", "/?view=catalog");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "App catalog" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Features" }).textContent).toContain(`apps in ${categories.size} categories`);
    window.history.replaceState(null, "", "/");
  });

  it("opens the design system gallery only when the server is the demo", async () => {
    // The gallery (M33.1) is for reviewing components; a real BoxPilot ignores ?gallery.
    const demoFetch = (input: RequestInfo | URL) => input.toString().endsWith("/api/v1/health")
      ? Promise.resolve(new Response(JSON.stringify({ status: "ok", mode: "demo" }), { status: 200, headers: { "Content-Type": "application/json" } }))
      : authenticatedFetch(input);
    window.history.replaceState(null, "", "/?gallery");
    vi.stubGlobal("fetch", vi.fn(demoFetch));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Design system" })).toBeTruthy();
    expect(screen.getAllByRole("radiogroup", { name: "Theme" }).length).toBeGreaterThan(1);
    cleanup();

    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: greeting })).toBeTruthy();
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/health"));
    expect(screen.queryByRole("heading", { name: "Design system" })).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it("offers System, Light and Dark in the top bar", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: greeting })).toBeTruthy();
    const theme = screen.getByRole("radiogroup", { name: "Theme" });
    expect(theme.closest(".topbar")).not.toBeNull();
    expect(within(theme).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["System", "Light", "Dark"]);
  });
});
