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
    expect(await within(strip).findByText("27.4%")).toBeTruthy();
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
    // Already staged: nothing to run here, but its tier is still shown beside it.
    const staged = within(alerts).getByRole("button", { name: "Needs a look: Waiting for approval: Reconnect a drive" });
    expect(staged.closest("li")?.querySelector(".ui-risk")?.textContent).toBe("Medium risk");
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
    expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["🎬Jellyfin", "Vaultwarden", "dev-lab", "win11-test"]);
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
    const needs = await screen.findByRole("region", { name: /What needs you/ });
    // Six things need the owner on this server: two problems, three to look at, one suggestion.
    const homeFacts = await vi.waitFor(() => {
      const titles = within(needs).getAllByRole("button").filter((button) => button.className.includes("need__title")).map((button) => button.textContent);
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

  it("gives a viewer the same facts and no fixes", async () => {
    renderOps("viewer");
    const inbox = await screen.findByRole("region", { name: /Action inbox/ });
    const alerts = screen.getByRole("region", { name: /Alerts/ });
    expect(await within(alerts).findByRole("button", { name: /Vaultwarden is not running/ })).toBeTruthy();
    expect(within(inbox).queryAllByRole("button")).toEqual([]);
  });
});
