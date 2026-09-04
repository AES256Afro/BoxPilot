import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomeDashboard from "./HomeDashboard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.endsWith("/operations/apt.upgradable.inspect/inspect")) return json({ operation: "apt.upgradable.inspect", result: { count: 3, securityCount: 1, rebootRequired: false, upgradable: [] } });
    if (url.endsWith("/operations/service.list/inspect")) return json({ operation: "service.list", result: { counts: { total: 120, active: 80, failed: 1 }, units: [] } });
    if (url.includes("/api/v1/catalog")) return json({ host: { lanAddress: "192.0.2.10" }, applications: [
      { manifest: { id: "jellyfin", name: "Jellyfin" }, live: { installed: true, container: { running: true, health: "healthy" }, updateAvailable: true, urls: [{ host: 8096, exposure: "lan" }] } },
      { manifest: { id: "vaultwarden", name: "Vaultwarden" }, live: { installed: true, container: { running: false, health: "none" }, updateAvailable: false, urls: [] } },
      { manifest: { id: "mealie", name: "Mealie" }, live: null },
    ] });
    if (url.endsWith("/api/v1/virtualization/domains")) return json({ domains: [{ state: "running" }, { state: "stopped" }] });
    if (url.includes("/api/v1/jobs")) return json({ jobs: [
      { id: "j1", type: "op:apt.upgrade", title: "Install package updates", state: "completed", risk: "medium", error: null, result: null, createdAt: "2026-08-20T10:00:00.000Z", steps: [], approvals: [] },
      { id: "j2", type: "op:app.update", title: "Update application", state: "failed", risk: "medium", error: "pull failed", result: null, createdAt: "2026-08-19T10:00:00.000Z", steps: [], approvals: [] },
    ] });
    return json({ error: `unexpected ${url}` }, 500);
  });
}

describe("Home dashboard", () => {
  it("summarizes updates, services, apps, and VMs with attention items", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = vi.fn();
    render(<HomeDashboard onNavigate={onNavigate} />);

    expect(await screen.findByText("3")).toBeTruthy();
    // Apps and VMs tiles both read "1/2" here: one of two running.
    expect(await screen.findAllByText("1/2")).toHaveLength(2);
    expect(screen.getByText("3 updates available (1 security)")).toBeTruthy();
    expect(screen.getByText("1 failed service")).toBeTruthy();
    expect(screen.getByText("Vaultwarden is not running")).toBeTruthy();
    expect(screen.getByText("Jellyfin has an update")).toBeTruthy();
    expect(screen.getByText("Job failed: Update application")).toBeTruthy();
    expect(screen.getByText("192.0.2.10:8096")).toBeTruthy();

    fireEvent.click(screen.getByText("1 failed service"));
    expect(onNavigate).toHaveBeenCalledWith("services");
  });

  it("shows the setup checklist with links for what is left", async () => {
    const checklist = { done: 2, total: 5, allEssentialDone: false, items: [
      { id: "tailscale", title: "Reach BoxPilot from anywhere", detail: "Connected as homebox.tail1234.ts.net.", done: true, optional: false, view: "network" },
      { id: "firewall", title: "Turn on the firewall with a profile", detail: "Block everything you did not ask for.", done: false, optional: false, view: "firewall" },
      { id: "ups", title: "Protect against power cuts", detail: "Plug a UPS in.", done: false, optional: true, view: "system" },
    ] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (input.toString().endsWith("/api/v1/setup/checklist") ? json(checklist) : json({ error: "unavailable" }, 503))));
    const onNavigate = vi.fn();
    render(<HomeDashboard onNavigate={onNavigate} />);
    expect(await screen.findByText("2 of 5 essentials done", { exact: false })).toBeTruthy();
    expect(screen.getByText("Reach BoxPilot from anywhere")).toBeTruthy();
    expect(screen.getByText("(optional)")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]);
    expect(onNavigate).toHaveBeenCalledWith("firewall");
  });

  it("renders quiet tiles when sources are unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "down" }, 500)));
    render(<HomeDashboard onNavigate={vi.fn()} />);
    expect((await screen.findAllByText("—")).length).toBeGreaterThan(1);
    expect(screen.queryByText("Needs attention")).toBeNull();
  });
});
