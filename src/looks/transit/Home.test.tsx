import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import TransitHome from "./Home";
import { labelWidth, transitMap } from "./map";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const at = new Date(2026, 8, 29, 7, 41).getTime();

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><TransitHome csrfToken="csrf" role={role} onNavigate={onNavigate} now={() => at} /></FactsProvider>);
  return onNavigate;
}

describe("Home as a transit map", () => {
  it("draws each app as a station on the lines it is reached and kept by, each opening the app", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Good morning");
    expect(await screen.findByText(/^homebox needs you: 1 problem and 1 thing to look at\. One more thing can wait\./)).toBeTruthy();
    const map = screen.getByRole("group", { name: "Your apps on the lines" });
    // Both apps are on the network; both have a backup from the last day, so both are on the orange line.
    const jellyfin = await within(map).findByRole("button", { name: "Jellyfin, on your network, healthy, update ready" });
    expect(within(map).getByRole("button", { name: "Jellyfin, backed up recently, healthy, update ready" })).toBeTruthy();
    expect(within(map).getByRole("button", { name: "Vaultwarden, on your network, not running" })).toBeTruthy();
    fireEvent.click(jellyfin);
    expect(onNavigate).toHaveBeenLastCalledWith("catalog", { app: "jellyfin" });
    fireEvent.keyDown(within(map).getByRole("button", { name: "Vaultwarden, on your network, not running" }), { key: "Enter" });
    expect(onNavigate).toHaveBeenLastCalledWith("catalog", { app: "vaultwarden" });
  });

  it("reads the line status board: a row per line and per thing that needs you, the fix naming its tier", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    const board = screen.getByRole("region", { name: /^Line status/ });
    expect(within(board).getByRole("heading", { level: 2 }).textContent).toBe("Line status 07:41");
    await within(board).findByRole("heading", { level: 3, name: "Vaultwarden" });
    const names = within(board).getAllByRole("heading", { level: 3 });
    expect(names.map((name) => name.textContent)).toEqual(["Your network", "Tailnet", "Backups", "Updates", "Vaultwarden"]);
    const updates = names[3].closest(".transit-line") as HTMLElement;
    expect(within(updates).getByText("Planned works")).toBeTruthy();
    expect(updates.textContent).toContain("1 security fix among them. Medium risk.");
    expect(within(updates).getByRole("button", { name: "Install: 4 updates available" }).getAttribute("data-risk")).toBe("medium");
    const vaultwarden = names[4].closest(".transit-line") as HTMLElement;
    expect(within(vaultwarden).getByText("Suspended")).toBeTruthy();
    fireEvent.click(within(vaultwarden).getByRole("button", { name: "Start: Vaultwarden is not running" }));
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
  });
});

describe("the transit map's geometry", () => {
  it("keeps every station's name clear of every other, twelve apps on one line included", () => {
    const names = ["Homepage", "Immich", "Jellyfin", "Nextcloud", "ntfy", "Open WebUI", "Pi-hole", "qBittorrent", "Scrutiny", "Uptime Kuma", "Vaultwarden", "Zulip"];
    const stops = names.map((name) => ({ id: name.toLowerCase(), name }));
    const map = transitMap({ tailnet: stops.slice(0, 3), network: stops, backups: stops.slice(4, 9), unprotected: stops.slice(0, 4) });
    expect(map.stops).toHaveLength(12 + 3 + 5 + 4);
    const boxes = map.stops.map((stop) => ({ x1: stop.label.x - labelWidth(stop.name) / 2, x2: stop.label.x + labelWidth(stop.name) / 2, y: stop.label.y }));
    for (const [index, box] of boxes.entries()) {
      for (const other of boxes.slice(index + 1)) {
        if (other.y !== box.y) continue;
        expect(box.x1 < other.x2 && other.x1 < box.x2, `${JSON.stringify(box)} and ${JSON.stringify(other)}`).toBe(false);
      }
      expect(box.x1).toBeGreaterThanOrEqual(0);
      expect(box.x2).toBeLessThanOrEqual(520);
    }
  });
});
