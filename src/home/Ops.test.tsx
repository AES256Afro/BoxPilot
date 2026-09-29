import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "./facts";
import Home from "./Home";
import Ops from "./Ops";
import { busier, stubFetch } from "./testData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderOps(role = "owner") {
  vi.stubGlobal("fetch", stubFetch(busier));
  const onNavigate = vi.fn();
  render(<FactsProvider><Ops csrfToken="csrf" role={role} onNavigate={onNavigate} pollMs={60_000} /></FactsProvider>);
  return onNavigate;
}

describe("Ops", () => {
  it("puts load, memory, disks and network in a strip, each figure opening its page", async () => {
    const onNavigate = renderOps();
    const strip = screen.getByRole("region", { name: "Load, memory, disks and network" });
    // The figure in mono with its unit drawn smaller (M33.7): "27.4" and "%" are two pieces of one value.
    await vi.waitFor(() => expect(within(strip).getByRole("button", { name: /^CPU/ }).querySelector(".ui-metric__value")?.textContent).toBe("27.4%"));
    fireEvent.click(within(strip).getByRole("button", { name: /^CPU/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
    fireEvent.click(within(strip).getByRole("button", { name: /^System disk/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("storage");
    const network = within(strip).getByRole("button", { name: /^Network/ });
    expect(network.textContent).toContain("Tailnet up");
    expect(network.textContent).toContain("eno1 192.0.2.10");
    fireEvent.click(network);
    expect(onNavigate).toHaveBeenLastCalledWith("network");
    expect(within(strip).getByRole("button", { name: /^Hottest sensor/ }).textContent).toContain("52°C");
  });

  it("draws the processor's last reads as a sparkline, and nothing from a single read", async () => {
    renderOps();
    const strip = screen.getByRole("region", { name: "Load, memory, disks and network" });
    const cpu = await within(strip).findByRole("button", { name: /^CPU/ });
    await vi.waitFor(() => expect(cpu.querySelector(".ui-metric__value")?.textContent).toBe("27.4%"));
    expect(cpu.querySelector(".ui-spark")).toBeNull();
    cleanup();

    vi.stubGlobal("fetch", stubFetch(busier));
    render(<FactsProvider><Ops csrfToken="csrf" role="owner" onNavigate={vi.fn()} pollMs={10} /></FactsProvider>);
    const again = await within(screen.getByRole("region", { name: "Load, memory, disks and network" })).findByRole("button", { name: /^CPU/ });
    await vi.waitFor(() => expect(again.querySelector(".ui-metric__graphic .ui-spark polyline")).not.toBeNull());
    expect(again.querySelector(".ui-metric__graphic")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("names itself and its server where the shell's bar starts, or in place without a shell", async () => {
    renderOps();
    const heading = screen.getByRole("heading", { level: 1, name: "Ops" });
    await vi.waitFor(() => expect(heading.closest(".cc-crumb")?.querySelector(".cc-crumb__host")?.textContent).toBe("homebox"));
    expect(heading.closest(".cc-crumb")?.querySelector(".cc-kv")?.textContent).toContain("kernel 6.8.0");
  });

  it("groups what can be run by its tier, and keeps the rest as alerts", async () => {
    renderOps();
    const inbox = await screen.findByRole("region", { name: /Action inbox/ });
    const high = await within(inbox).findByRole("region", { name: "high risk" });
    expect(within(high).getByRole("button", { name: "Reboot: A reboot is pending" }).getAttribute("data-risk")).toBe("high");
    const medium = within(inbox).getByRole("region", { name: "medium risk" });
    expect(within(medium).getByRole("button", { name: "Install: 4 updates available" }).getAttribute("data-risk")).toBe("medium");
    expect(within(medium).getByRole("button", { name: "Update: An update for Jellyfin" })).toBeTruthy();
    const low = within(inbox).getByRole("region", { name: "low risk" });
    expect(within(low).getByRole("button", { name: "Start: Vaultwarden is not running" }).getAttribute("data-risk")).toBe("low");

    const alerts = screen.getByRole("region", { name: /Alerts/ });
    expect(await within(alerts).findByRole("button", { name: "Problem: 1 system service failed" })).toBeTruthy();
    // Already staged (M36): reviewed from the inbox, at the tier it was staged at.
    const staged = within(medium).getByRole("button", { name: "Review: Waiting for approval: Reconnect a drive" });
    expect(staged.getAttribute("data-risk")).toBe("medium");
  });

  it("starts a fix through the approval dialog, never around it", async () => {
    renderOps();
    const inbox = await screen.findByRole("region", { name: /Action inbox/ });
    fireEvent.click(await within(inbox).findByRole("button", { name: "Start: Vaultwarden is not running" }));
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
  });

  it("lists the containers with their numbers and the VMs, each opening its page", async () => {
    const onNavigate = renderOps();
    const table = await screen.findByRole("table", { name: "Containers and virtual machines" });
    await within(table).findByText("34.2%");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["Jellyfin", "Vaultwarden", "dev-lab", "win11-test"]);
    expect(rows[0].getAttribute("data-status")).toBe("good");
    expect(rows[1].getAttribute("data-status")).toBe("danger");
    expect(within(rows[1]).getByText("stopped")).toBeTruthy();
    expect(within(rows[0]).getByText("412 MB")).toBeTruthy();
    fireEvent.click(within(rows[0]).getByRole("button", { name: /Jellyfin/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("catalog", { app: "jellyfin" });
    fireEvent.click(within(rows[2]).getByRole("button", { name: "dev-lab" }));
    expect(onNavigate).toHaveBeenLastCalledWith("virtualization");
  });

  it("shows the job queue with what each job acted on", async () => {
    renderOps();
    const table = await screen.findByRole("table", { name: "Recent jobs" });
    const running = (await within(table).findByRole("button", { name: "app.update" })).closest("tr")!;
    expect(within(running).getByText("Running")).toBeTruthy();
    expect(within(running).getByText("jellyfin")).toBeTruthy();
    const waiting = within(table).getByRole("button", { name: "storage.remount" }).closest("tr")!;
    expect(within(waiting).getByText("Awaiting approval")).toBeTruthy();
    expect(within(waiting).getByText("media")).toBeTruthy();
    // The failed backup comes from the longer history, read once beside the live feed.
    expect(await screen.findByText("1 running · 1 waiting for approval · 1 failed today")).toBeTruthy();
  });

  it("shows each app's recent backup runs, and a failed one as a problem", async () => {
    renderOps();
    const table = await screen.findByRole("table", { name: "Backups of each app, with its last runs" });
    const jellyfin = (await within(table).findByRole("button", { name: "Jellyfin" })).closest("tr")!;
    await vi.waitFor(() => expect(jellyfin.querySelectorAll(".ops-run[data-run='ok']")).toHaveLength(3));
    expect(within(jellyfin).getByText(/^Completed 11 hours ago/)).toBeTruthy();
    const vaultwarden = within(table).getByRole("button", { name: "Vaultwarden" }).closest("tr")!;
    expect(vaultwarden.getAttribute("data-status")).toBe("danger");
    expect(within(vaultwarden).getByText("Last run failed")).toBeTruthy();
  });

  it("has every fact Home shows, one click from its page", async () => {
    vi.stubGlobal("fetch", stubFetch(busier));
    const { unmount } = render(<FactsProvider><Home csrfToken="csrf" role="owner" onNavigate={vi.fn()} /></FactsProvider>);
    await screen.findByRole("region", { name: /What needs you/ });
    // Six things need the owner on this server: two problems and three to look at down the side,
    // and one suggestion in the strip of what can wait.
    const homeFacts = await vi.waitFor(() => {
      const titles = [/What needs you/, /Can wait/].flatMap((name) => within(screen.getByRole("region", { name })).getAllByRole("button"))
        .filter((button) => button.className.includes("need__title")).map((button) => button.textContent);
      expect(titles).toHaveLength(6);
      return titles;
    });
    const homeApps = within(screen.getByRole("region", { name: /Apps/ })).getAllByRole("button").filter((button) => button.className.includes("home-tile") && !button.className.includes("home-tile--add")).map((button) => button.querySelector(".ui-tile__name")?.textContent);
    unmount();

    renderOps();
    await screen.findByRole("region", { name: /Action inbox/ });
    const opsFacts = await vi.waitFor(() => {
      const titles = screen.getAllByRole("button").filter((button) => button.className.includes("need__title")).map((button) => button.textContent);
      expect(titles.length).toBe(homeFacts.length);
      return titles;
    });
    expect([...opsFacts].sort()).toEqual([...homeFacts].sort());
    const containers = screen.getByRole("table", { name: "Containers and virtual machines" });
    for (const name of homeApps) expect(within(containers).getByRole("button", { name: new RegExp(name ?? "") })).toBeTruthy();
  });

  it("shows what the Classic overview did: each drive's health, the key services, the UPS and the setup checklist", async () => {
    const GiB = 1024 ** 3;
    vi.stubGlobal("fetch", stubFetch({
      ...busier,
      "/api/v1/inventory": {
        host: { hostname: "homebox", operatingSystem: "Ubuntu 24.04 LTS", kernel: "6.8.0", uptimeSeconds: 90_000 },
        compute: { cpuCount: 8, cpuModel: "fixture", load1: 0.84, loadPercent: 11, totalMemoryBytes: 32 * GiB, usedMemoryBytes: 11 * GiB, memoryUsedPercent: 34 },
        storage: {
          root: { totalBytes: 100 * GiB, usedBytes: 20 * GiB, usedPercent: 20 }, filesystems: { mounts: [] },
          smart: { available: true, status: "healthy", reason: "fixed-root-scan", generatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), stale: false, disks: [
            { device: "/dev/nvme0n1", health: "healthy", passed: true, temperatureCelsius: 42, percentageUsed: 4, mediaErrors: 0 },
            { device: "/dev/sdb", health: "healthy", passed: true, temperatureCelsius: 38, percentageUsed: null, mediaErrors: null, reason: "ok", deviceType: "sat" },
            { device: "/dev/sdc", health: "unavailable", passed: null, temperatureCelsius: null, percentageUsed: null, mediaErrors: null, reason: "usb-bridge-unsupported", deviceType: "sat" },
          ] },
        },
        power: { ups: { installed: true, configured: true, available: true, state: "online", reason: "ok", deviceCount: 1, statusTokens: ["CHRG", "OL"], batteryChargePercent: 96, estimatedRuntimeSeconds: 2700, loadPercent: 23 } },
        services: [
          { unit: "boxpilot.service", load: "loaded", active: "active", sub: "running", enabled: "enabled" },
          { unit: "docker.service", load: "loaded", active: "failed", sub: "failed", enabled: "enabled" },
          { unit: "nfs-server.service", load: "not-found", active: "inactive", sub: "dead", enabled: "" },
        ],
        network: { addresses: [{ interface: "eno1", address: "192.0.2.10" }], tailscale: { installed: true, connected: true, dnsName: null } },
      },
      "/api/v1/setup/checklist": { done: 1, total: 2, items: [
        { id: "backups", title: "Back up BoxPilot's database", detail: "Nightly, with a restore drill", done: true, optional: false, view: "backups" },
        { id: "firewall", title: "Turn the firewall on", detail: "Keeps SSH and BoxPilot reachable", done: false, optional: false, view: "firewall" },
      ] },
    }));
    const onNavigate = vi.fn();
    render(<FactsProvider><Ops csrfToken="csrf" role="owner" onNavigate={onNavigate} pollMs={60_000} /></FactsProvider>);

    const disks = await screen.findByRole("table", { name: "Each drive's health" });
    const rows = within(disks).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["nvme0n1", "sdb", "sdc"]);
    expect(within(rows[0]).getByText("healthy")).toBeTruthy();
    expect(within(rows[0]).getByText("42°C")).toBeTruthy();
    // A drive whose USB enclosure passes nothing through is not known, and says why.
    expect(rows[2].getAttribute("data-status")).toBe("unknown");
    expect(within(rows[2]).getByText("no SMART").getAttribute("title")).toBe("Its USB enclosure does not pass SMART through");
    expect(within(rows[1]).getByRole("button", { name: "sdb" }).getAttribute("title")).toContain("read through its USB bridge");
    expect(screen.getByRole("region", { name: /^Disks/ }).textContent).toContain("read 2 hours ago");

    const services = screen.getByRole("table", { name: "Key system services" });
    expect(within(services).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["boxpilot", "docker"]);
    expect(within(services).getByText("failed").closest("tr")?.getAttribute("data-status")).toBe("danger");
    expect(screen.getByRole("region", { name: /^Key services/ }).textContent).toContain("1 of 2 running");
    fireEvent.click(within(services).getByRole("button", { name: "docker" }));
    expect(onNavigate).toHaveBeenLastCalledWith("services");

    const power = screen.getByRole("region", { name: /^Power/ });
    expect(within(power).getByText("The UPS is on mains power")).toBeTruthy();
    expect(within(power).getByText("96%")).toBeTruthy();
    expect(within(power).getByText("45m 00s")).toBeTruthy();
    expect(within(power).getByText("CHRG OL")).toBeTruthy();

    const setup = await screen.findByRole("region", { name: /^Setup/ });
    expect(within(setup).getByRole("heading").textContent).toContain("1/2");
    expect(within(setup).getByText("Back up BoxPilot's database").closest("li")?.getAttribute("data-state")).toBe("done");
    fireEvent.click(within(setup).getByRole("button", { name: "Open: Turn the firewall on" }));
    expect(onNavigate).toHaveBeenLastCalledWith("firewall");
  });

  it("says why disk health and the UPS are not known rather than calling them fine", async () => {
    renderOps();
    const disks = await screen.findByRole("region", { name: /^Disks/ });
    await vi.waitFor(() => expect(disks.textContent).toContain("This server did not say how its drives are."));
    expect(screen.getByRole("region", { name: /^Power/ }).textContent).toContain("This server did not say whether a UPS is set up");
  });

  it("gives a viewer the same facts and no fixes", async () => {
    renderOps("viewer");
    const inbox = await screen.findByRole("region", { name: /Action inbox/ });
    const alerts = screen.getByRole("region", { name: /Alerts/ });
    expect(await within(alerts).findByRole("button", { name: /Vaultwarden is not running/ })).toBeTruthy();
    expect(within(inbox).queryAllByRole("button")).toEqual([]);
  });
});
