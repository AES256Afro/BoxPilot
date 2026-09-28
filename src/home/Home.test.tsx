import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "./facts";
import Home from "./Home";
import { stubFetch } from "./testData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
    expect(await screen.findByText("homebox needs you: 1 problem and 1 thing to look at.")).toBeTruthy();

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
