import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { navItems, viewLabel } from "./data";
import { viewCopy } from "./pageCopy";
import { dockAreas } from "./shell/ShellNav";
import { connectionLabel } from "./appLinks";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // A test that fails half way must not leave the next one on its page.
  window.history.replaceState(null, "", "/");
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

  it("lands on Home, and opens every other area inside the console", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    const { container } = render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: greeting })).toBeTruthy();
    expect(container.querySelector(".app-shell")?.getAttribute("data-shell")).toBe("launcher");
    expect(dock().classList.contains("shell-dock--rail")).toBe(false);
    expect(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(dock()).getByRole("button", { name: "Backups" }));
    // The console (M33.8): the rail, the compact bar with the page's name in it, and the look set on
    // the page's root too, so a sheet or dialog opened over the page is drawn the same way.
    // Backups draws its own header (M33.9), so its name arrives with the page.
    const heading = await screen.findByRole("heading", { level: 1, name: "Backups" });
    expect(heading.closest(".topbar")).not.toBeNull();
    expect(container.querySelector(".app-shell")?.getAttribute("data-shell")).toBe("console");
    expect(document.documentElement.dataset.shell).toBe("console");
    expect(dock().classList.contains("shell-dock--rail")).toBe(true);
    expect(within(dock()).getByRole("button", { name: "Backups" }).getAttribute("aria-current")).toBe("page");
    expect(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Home" }).hasAttribute("aria-current")).toBe(false);
    // The server's name leads the bar once the inventory answers.
    await vi.waitFor(() => expect(heading.closest(".cc-crumb")?.querySelector(".cc-crumb__host")?.textContent).toBe("homebox"));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Home" }));
    expect(await screen.findByRole("heading", { level: 1, name: greeting })).toBeTruthy();
    expect(document.documentElement.dataset.shell).toBe("launcher");
  });

  it("never draws the old frame: no page header, no feature strip, the description behind the info toggle", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    const { container } = render(<App />);
    await screen.findByRole("heading", { level: 1, name: greeting });
    for (const area of dockAreas) {
      fireEvent.click(within(dock()).getByRole("button", { name: new RegExp(`^${viewLabel(area.id).replace(/[&()]/g, "\\$&")}`) }));
      // Every page's name is in the bar, Repair's too since M33.14 (it is called Repair there).
      const title = area.id === "repairs" ? "Repair" : viewCopy[area.id].title;
      const heading = await screen.findByRole("heading", { level: 1, name: title });
      expect(heading.closest(".topbar")).not.toBeNull();
      expect(container.querySelector(".page-header, .feature-strip, [aria-label='Features']")).toBeNull();
      const described = screen.queryByText(viewCopy[area.id].description);
      if (described) expect(described.closest("[hidden]")).not.toBeNull();
      // One name in the bar: the page left behind takes its name with it.
      expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([title]);
      expect(container.querySelector(".app-shell")?.getAttribute("data-shell")).toBe("console");
    }
    // A page says what it is for only when asked.
    fireEvent.click(within(dock()).getByRole("button", { name: "Firewall" }));
    const about = await screen.findByRole("button", { name: "About Firewall" });
    expect(screen.getByText(viewCopy.firewall.description).closest("[hidden]")).not.toBeNull();
    fireEvent.click(about);
    expect(screen.getByText(viewCopy.firewall.description).closest("[hidden]")).toBeNull();
    // Each rebuilt page draws its own name once its chunk has loaded, so walking every area takes
    // longer than the default five seconds on a busy runner.
  }, 20_000);

  it("has retired the Classic overview: its link opens Home and leaves the address clean", async () => {
    vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
    window.history.replaceState(null, "", "/?view=overview");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: greeting })).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(within(dock()).queryByRole("button", { name: /Classic|Overview/ })).toBeNull();
    expect(navItems.some((item) => (item.id as string) === "overview")).toBe(false);
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
    expect(screen.getByRole("radio", { name: "Kernel" })).toBeTruthy();
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
    // The features the pages list are what the command bar finds (the strip that showed them is gone).
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = within(screen.getByRole("dialog", { name: "Search BoxPilot" })).getByRole("combobox");
    fireEvent.change(input, { target: { value: "categories" } });
    expect(screen.getAllByRole("option").some((option) => option.textContent?.includes(`apps in ${categories.size} categories`))).toBe(true);
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

  describe("opened from the home screen (M25)", () => {
    const phone = (matches: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: matches && query.includes("max-width"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));

    it("starts a phone on Today, and leaves the address as a link to it", async () => {
      phone(true);
      vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
      window.history.replaceState(null, "", "/?launch=pwa");
      render(<App />);
      expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeTruthy();
      expect(window.location.search).toBe("?view=today");
      expect(within(dock()).getByRole("button", { name: /^Today/ }).getAttribute("aria-current")).toBe("page");
    });

    it("starts anything wider on Home", async () => {
      phone(false);
      vi.stubGlobal("fetch", vi.fn(authenticatedFetch));
      window.history.replaceState(null, "", "/?launch=pwa");
      render(<App />);
      expect(await screen.findByRole("heading", { level: 1, name: greeting })).toBeTruthy();
      expect(window.location.search).toBe("");
    });

    it("opens offline as the account this device remembers, saying so, when BoxPilot cannot be reached", async () => {
      window.localStorage.setItem("boxpilot:signed-in-until", new Date(Date.now() + 3_600_000).toISOString());
      window.localStorage.setItem("boxpilot:signed-in-as", JSON.stringify({ id: "owner-one", username: "alex", role: "owner" }));
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
      window.history.replaceState(null, "", "/?view=today");
      render(<App />);
      expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeTruthy();
      expect(screen.queryByText(/Unable to reach|could not be reached/i, { selector: "h1" })).toBeNull();
      window.localStorage.clear();
    });

    it("shows the sign-in problem, as before, when no session was remembered", async () => {
      window.localStorage.clear();
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
      render(<App />);
      await vi.waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Today" })).toBeNull());
      expect(await screen.findByText(/Failed to fetch/)).toBeTruthy();
    });
  });
});
