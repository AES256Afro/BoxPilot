import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import { TopBarSlotProvider } from "../../shell/TopBarSlot";
import ConsoleHome from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><ConsoleHome csrfToken="csrf" role={role} onNavigate={onNavigate} /></FactsProvider>);
  return onNavigate;
}

describe("Home in the Command Center", () => {
  it("says the verdict under the greeting, and leads the inbox with each fix's tier", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)\.$/);
    expect(await screen.findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();

    const inbox = screen.getByRole("region", { name: "Action inbox" });
    const titles = within(inbox).getAllByRole("button").filter((button) => button.className.includes("need__title")).map((button) => button.textContent);
    expect(titles).toEqual(["Problem: Vaultwarden is not running", "Needs a look: 4 updates available", "Suggestion: An update for Jellyfin"]);
    const install = within(inbox).getByRole("button", { name: "Install: 4 updates available" });
    expect(install.getAttribute("data-risk")).toBe("medium");
    expect(install.closest("li")?.querySelector(".need__tier-tag")?.textContent).toBe("Med risk");
  });

  it("runs a fix through the approval dialog at its tier", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    const inbox = await screen.findByRole("region", { name: "Action inbox" });
    const start = await within(inbox).findByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.getAttribute("data-risk")).toBe("low");
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST", body: JSON.stringify({ parameters: { id: "vaultwarden", action: "start" } }) }));
  });

  it("shows each app's state in words, opens its sheet, and leads each figure to its page", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    const apps = await screen.findByRole("region", { name: "Apps" });
    const vaultwarden = await within(apps).findByRole("button", { name: "Vaultwarden, Not running" });
    expect(vaultwarden.getAttribute("data-status")).toBe("danger");
    expect(vaultwarden.textContent).toContain("not running");
    expect(within(apps).getByRole("button", { name: /Add an app/ }).textContent).toContain("3 in the catalog");
    fireEvent.click(within(apps).getByRole("button", { name: "Jellyfin, Healthy, update ready" }));
    expect(screen.getByRole("dialog", { name: "Jellyfin" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(await screen.findByRole("button", { name: /^Memory/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
    fireEvent.click(screen.getByRole("button", { name: /^Apps backed up/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("backups");
  });

  it("names the server and its facts at the start of the shell's bar", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const slot = document.createElement("div");
    document.body.append(slot);
    render(<FactsProvider><TopBarSlotProvider value={slot}><ConsoleHome csrfToken="csrf" role="owner" onNavigate={vi.fn()} /></TopBarSlotProvider></FactsProvider>);
    await vi.waitFor(() => expect(slot.querySelector(".cc-crumb__host")?.textContent).toBe("homebox"));
    expect(slot.textContent).toMatch(/homebox\/homeUbuntu 24\.04 LTS · up \d+d \d+h · kernel 6\.8\.0/);
    // One h1 on the page: the greeting, not the bar's name.
    expect(slot.querySelector("h1")).toBeNull();
    cleanup();
    slot.remove();
  });
});
