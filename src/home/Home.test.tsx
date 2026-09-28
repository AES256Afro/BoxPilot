import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "./facts";
import Home from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const GiB = 1024 ** 3;
// Fixture times are relative to the moment the test runs, like the loaders' own clock.
const started = Date.now();
const ago = (hours: number) => new Date(started - hours * 3_600_000).toISOString();

const answers: Record<string, unknown> = {
  "/api/v1/catalog?view=summary": { host: { lanAddress: "192.0.2.10" }, liveError: null, applications: [
    { manifest: { id: "jellyfin", name: "Jellyfin", icon: "🎬", category: "Media" }, live: { installed: true, container: { running: true, status: "running", health: "healthy" }, updateAvailable: true, urls: [{ host: 8096, exposure: "lan" }] } },
    { manifest: { id: "vaultwarden", name: "Vaultwarden", icon: null, category: "Security" }, live: { installed: true, container: { running: false, status: "exited", health: "none" }, urls: [{ host: 8222, exposure: "lan" }] } },
    { manifest: { id: "mealie", name: "Mealie", category: "Food" }, live: null },
  ] },
  "/api/v1/operations/app.serve.inspect/inspect": { operation: "app.serve.inspect", result: { available: true, serves: [] } },
  "/api/v1/inventory": {
    host: { hostname: "homebox", operatingSystem: "Ubuntu 24.04 LTS", kernel: "6.8.0", uptimeSeconds: 90_000 },
    compute: { cpuCount: 8, cpuModel: "fixture", load1: 0.84, loadPercent: 11, totalMemoryBytes: 32 * GiB, usedMemoryBytes: 11 * GiB, memoryUsedPercent: 34 },
    storage: { root: { totalBytes: 100 * GiB, usedBytes: 20 * GiB, usedPercent: 20 }, filesystems: { mounts: [{ target: "/", source: "/dev/sda2", totalBytes: 100 * GiB, usedBytes: 20 * GiB, usedPercent: 20, capacityState: "healthy" }] } },
    network: { addresses: [], tailscale: { installed: true, connected: true, dnsName: null } },
  },
  "/api/v1/operations/apt.upgradable.inspect/inspect": { result: { count: 4, securityCount: 1, rebootRequired: false } },
  "/api/v1/operations/apt.unattended.inspect/inspect": { result: { installed: true, enabled: true } },
  "/api/v1/operations/service.list/inspect": { result: { counts: { total: 100, active: 80, failed: 0 } } },
  "/api/v1/settings/watch": { targetConfigured: true, conditions: [], notices: [] },
  "/api/v1/remediations": { findings: [], counts: { critical: 0, warning: 0, info: 0 }, unavailableChecks: [] },
  "/api/v1/schedules": { schedules: [] },
  "/api/v1/operations/app.backup.protection/inspect": { result: { available: true, apps: [
    { id: "jellyfin", name: "Jellyfin", protectable: true, backups: 3, newestAt: ago(10) },
    { id: "vaultwarden", name: "Vaultwarden", protectable: true, backups: 1, newestAt: ago(20) },
  ] } },
  "/api/v1/settings/cloud-destination": { destination: { provider: "b2" }, lastSync: { completedAt: ago(5) } },
  "/api/v1/settings/backup-destination": { destination: null, lastSync: null },
  "/api/v1/operations/host.snapshot.inspect/inspect": { result: { sync: { mount: { mounted: false }, lastSync: null } } },
  "/api/v1/backups": { backups: [{ applicationId: "boxpilot-controller", createdAt: ago(3) }] },
  "/api/v1/setup": { firstRun: false, installedApps: 2 },
  "/api/v1/setup/checklist": { done: 5, total: 5, items: [] },
  "/api/v1/virtualization/domains": { domains: [] },
  "/api/v1/jobs?limit=50": { jobs: [] },
};

function stubFetch(overrides: Record<string, unknown> = {}, fail = false) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method === "POST" && url.endsWith("/jobs")) {
      const operation = url.split("/")[4];
      return json({ job: { id: "staged", type: `op:${operation}`, title: operation, state: "awaiting_approval", risk: "low", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "low", passwordRequired: false, elevated: false, mode: "tiered", reason: "" } }, 201);
    }
    if (fail && !url.startsWith("/api/v1/jobs")) return json({ error: "BoxPilot is not answering" }, 503);
    const table = { ...answers, ...overrides };
    return url in table ? json(table[url]) : json({ error: `unexpected ${url}` }, 404);
  });
}

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><Home csrfToken="csrf" role={role} onNavigate={onNavigate} /></FactsProvider>);
  return onNavigate;
}

describe("Home", () => {
  it("answers whether everything is OK, worst first, with each fix's tier on its button", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(await screen.findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();

    const needs = screen.getByRole("region", { name: /What needs you/ });
    const titles = within(needs).getAllByRole("button").filter((button) => button.className.includes("need__title")).map((button) => button.textContent);
    expect(titles).toEqual(["Problem: Vaultwarden is not running", "Needs a look: 4 updates available", "Suggestion: An update for Jellyfin"]);

    const start = within(needs).getByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.getAttribute("data-risk")).toBe("low");
    expect(document.getElementById(start.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Low risk.");
    expect(within(needs).getByRole("button", { name: "Install: 4 updates available" }).getAttribute("data-risk")).toBe("medium");

    // The fact opens its detail; the fix goes through the approval dialog, never around it.
    fireEvent.click(within(needs).getByRole("button", { name: "Problem: Vaultwarden is not running" }));
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "vaultwarden" });
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST", body: JSON.stringify({ parameters: { id: "vaultwarden", action: "start" } }) }));
  });

  it("shows the installed apps as tiles, each opening a sheet with its facts and its tiers", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    const apps = await screen.findByRole("region", { name: /Apps/ });
    const vaultwarden = await within(apps).findByRole("button", { name: "Vaultwarden, Not running" });
    expect(vaultwarden.getAttribute("data-status")).toBe("danger");
    expect(vaultwarden.textContent).toContain("V"); // initials: no icon in its manifest
    const jellyfin = within(apps).getByRole("button", { name: "Jellyfin, Healthy, update ready" });
    expect(jellyfin.textContent).toContain("🎬");
    expect(within(apps).getByRole("button", { name: /Add an app/ }).textContent).toContain("3 in the catalog");
    expect(within(apps).queryByText("Mealie")).toBeNull();

    fireEvent.click(jellyfin);
    const sheet = screen.getByRole("dialog", { name: "Jellyfin" });
    expect(within(sheet).getByRole("link", { name: /Open Jellyfin/ }).getAttribute("href")).toBe("http://192.0.2.10:8096");
    expect(within(sheet).getByText("A new version is ready")).toBeTruthy();
    expect(within(sheet).getByText(/3 backups, the newest 10 hours ago/)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Update" }).getAttribute("data-risk")).toBe("medium");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Jellyfin" })).toBeNull();

    fireEvent.click(jellyfin);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Jellyfin" })).getByRole("button", { name: "Manage in the App catalog" }));
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "jellyfin" });
  });

  it("opens each figure's page", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    await screen.findByText("load 0.84 on 8 cores");
    const processor = screen.getByRole("button", { name: /^Processor/ });
    expect(processor.textContent).toContain("11%");
    expect(processor.getAttribute("data-status")).toBe("good");
    fireEvent.click(processor);
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
    fireEvent.click(screen.getByRole("button", { name: /^System disk/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("storage");
    fireEvent.click(screen.getByRole("button", { name: /^Off this server/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("backups");
  });

  it("never calls the server healthy when it could not read it", async () => {
    vi.stubGlobal("fetch", stubFetch({}, true));
    renderHome();
    expect(await screen.findByText(/^Nothing wrong found, but BoxPilot could not read the apps, the health alerts, Repair's problem scan/)).toBeTruthy();
    expect(screen.getAllByText("Not fully checked").length).toBeGreaterThan(0);
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.getByText("Which apps are installed could not be read.", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Processor/ }).getAttribute("data-status")).toBe("unknown");
  });

  it("shows a viewer the same facts and no buttons it could not use", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome("viewer");
    const needs = await screen.findByRole("region", { name: /What needs you/ });
    expect(await within(needs).findByRole("button", { name: "Problem: Vaultwarden is not running" })).toBeTruthy();
    expect(within(needs).queryByRole("button", { name: /^Start:/ })).toBeNull();
    expect(within(needs).queryByRole("button", { name: /^Install:/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Jellyfin, Healthy, update ready" }));
    expect(within(screen.getByRole("dialog", { name: "Jellyfin" })).queryByRole("button", { name: "Update" })).toBeNull();
  });
});
