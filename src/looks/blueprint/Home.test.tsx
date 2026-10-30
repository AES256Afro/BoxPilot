import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import type { Need } from "../../home/needs";
import BlueprintHome, { appsOfNeed, dataDrive, driveFigures, partName } from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><BlueprintHome csrfToken="csrf" role={role} onNavigate={onNavigate} /></FactsProvider>);
  return onNavigate;
}

describe("Home as a blueprint", () => {
  it("draws the verdict, the notes worst first, and the parts they refer to", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(await screen.findByText(/homebox needs you: 1 problem and 1 thing to look at\. One more thing can wait\.$/)).toBeTruthy();
    expect(screen.getByText("homebox · General arrangement")).toBeTruthy();

    const notes = screen.getByRole("region", { name: "General notes" });
    // The words the note shows; its detail is there too, for a screen reader, under them.
    const own = (element: Element) => [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("");
    const words = within(notes).getAllByRole("button").filter((button) => button.className.includes("blueprint-note__words")).map(own);
    expect(words).toEqual(["Vaultwarden is not running.", "4 updates available.", "An update for Jellyfin."]);

    // Each part carries the triangle of the note about it, and opens its card in the catalog.
    const apps = screen.getByRole("region", { name: "Apps" });
    const jellyfin = within(apps).getByRole("button", { name: "Jellyfin, Healthy, update ready, see note 3" });
    expect(within(apps).getByRole("button", { name: "Vaultwarden, Not running, see note 1" })).toBeTruthy();
    fireEvent.click(jellyfin);
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "jellyfin" });
  });

  it("runs a fix through the approval dialog at its tier", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    const start = await screen.findByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.getAttribute("data-risk")).toBe("low");
    expect(screen.getByRole("button", { name: "Install: 4 updates available" }).getAttribute("data-risk")).toBe("medium");
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST", body: JSON.stringify({ parameters: { id: "vaultwarden", action: "start" } }) }));
  });

  it("gives a viewer the notes and no buttons it could not use", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome("viewer");
    expect(await screen.findByText("Vaultwarden is not running.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Start:/ })).toBeNull();
  });

  it("names parts, drives and a note's apps as the drawing does", () => {
    expect(partName("qBittorrent (through a VPN)")).toBe("qBittorrent");
    expect(partName("Open WebUI + Ollama")).toBe("Open WebUI");
    expect(driveFigures(2.65 * 1024 ** 4, 3.9 * 1024 ** 4)).toEqual({ used: "2.65", total: "3.90", unit: "TB" });
    expect(driveFigures(212 * 1024 ** 3, 800 * 1024 ** 3)).toEqual({ used: "212", total: "800", unit: "GB" });
    const mount = (target: string, percent: number) => ({ target, source: "/dev/sda1", total: 100, used: percent, percent, state: "healthy" });
    expect(dataDrive([mount("/", 90), mount("/boot", 95), mount("/mnt/media", 68), mount("/mnt/b", 20)])?.target).toBe("/mnt/media");
    const apps = [{ id: "immich", name: "Immich" }, { id: "homepage", name: "Homepage" }, { id: "pi-hole", name: "Pi-hole" }] as never;
    const backups = { id: "repair:backups-due", title: "Immich and 1 more", finding: { fix: { operationId: "app.backup.many", parameters: { ids: ["immich", "homepage"] } }, fixes: [], evidence: [] } } as unknown as Need;
    expect(appsOfNeed(backups, apps)).toEqual(["immich", "homepage"]);
    const dns = { id: "repair:dns", title: "If homebox goes down…", detail: null, finding: { fix: null, evidence: ["Pi-hole's own log shows 8 devices"] } } as unknown as Need;
    expect(appsOfNeed(dns, apps)).toEqual(["pi-hole"]);
  });
});
