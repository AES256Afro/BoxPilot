import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import { TopBarSlotProvider } from "../../shell/TopBarSlot";
import AquaHome from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><AquaHome csrfToken="csrf" role={role} onNavigate={onNavigate} /></FactsProvider>);
  return onNavigate;
}

describe("Home in the Aqua look", () => {
  it("says the verdict and what needs you, the tier in words, and fixes through the approval dialog", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(await screen.findByText(/homebox needs you: 1 problem and 1 thing to look at\. One more thing can wait\.$/)).toBeTruthy();

    const needs = screen.getByRole("region", { name: "What needs you" });
    expect(await within(needs).findByRole("button", { name: "Problem: Vaultwarden is not running." })).toBeTruthy();
    expect(within(needs).getByRole("button", { name: "Needs a look: 4 updates available." })).toBeTruthy();
    // The tier in words under each sentence, as the drawing has it ("Medium · 1 security fix among them.").
    expect(needs.textContent).toContain("Low · Its container is stopped.");
    expect(needs.textContent).toContain("Medium · 1 security fix among them.");
    // What can wait is folded under a disclosure triangle.
    const more = within(needs).getByRole("button", { name: "1 more can wait" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(within(needs).getByRole("button", { name: "Suggestion: An update for Jellyfin." })).toBeTruthy();

    fireEvent.click(within(needs).getByRole("button", { name: "Problem: Vaultwarden is not running." }));
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "vaultwarden" });
    const start = within(needs).getByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.getAttribute("data-risk")).toBe("low");
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST" }));
  });

  it("shows the server's figures, each opening its page, and the apps as icons that open their sheet", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    const memory = await screen.findByRole("button", { name: /^Memory/ });
    expect(memory.textContent).toContain("11.0 of 32.0 GB");
    fireEvent.click(memory);
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
    fireEvent.click(screen.getByRole("button", { name: /^System disk/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("storage");

    const apps = screen.getByRole("region", { name: "Apps" });
    const vaultwarden = await within(apps).findByRole("button", { name: "Vaultwarden, Not running" });
    expect(vaultwarden.textContent).toContain("Not running");
    fireEvent.click(within(apps).getByRole("button", { name: "Jellyfin, Healthy, update ready" }));
    expect(screen.getByRole("dialog", { name: "Jellyfin" })).toBeTruthy();
  });

  it("puts the server's name in the window's title and the toolbar's buttons beside the page", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const slot = document.createElement("div");
    document.body.append(slot);
    render(<FactsProvider><TopBarSlotProvider value={slot}><AquaHome csrfToken="csrf" role="owner" onNavigate={vi.fn()} /></TopBarSlotProvider></FactsProvider>);
    await vi.waitFor(() => expect(slot.querySelector(".cc-crumb__host")?.textContent).toBe("homebox"));
    const toolbar = screen.getByRole("toolbar", { name: "Home" });
    expect(within(toolbar).getAllByRole("button").map((button) => button.textContent)).toEqual(["Check Again", "App Catalog", "Activity"]);
    cleanup();
    slot.remove();
  });
});
