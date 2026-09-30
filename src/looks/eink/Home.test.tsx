import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import { TopBarSlotProvider } from "../../shell/TopBarSlot";
import EinkHome from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const at = new Date(2026, 8, 29, 7, 41).getTime();

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><EinkHome csrfToken="csrf" role={role} onNavigate={onNavigate} now={() => at} /></FactsProvider>);
  return onNavigate;
}

describe("Home on e-paper", () => {
  it("says the verdict in words, marks what needs you with a filled square, and names each tier", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Good morning.");
    expect(await screen.findByText("homebox needs you: one problem and one thing to look at. One more thing can wait.")).toBeTruthy();

    const needs = screen.getByRole("region", { name: "Needs you" });
    const items = within(needs).getAllByRole("listitem");
    // Filled for what needs you, open for what can wait: the shape carries it, the words say it.
    expect(items.map((item) => item.hasAttribute("data-soft"))).toEqual([false, false, true]);
    expect(within(needs).getByRole("button", { name: "Problem: Vaultwarden is not running." })).toBeTruthy();
    expect(within(needs).getByRole("button", { name: "Needs you: Four updates available." })).toBeTruthy();
    expect(within(needs).getByRole("button", { name: "Can wait: An update for Jellyfin." })).toBeTruthy();
    expect(items[1].querySelector(".eink-need__detail i")?.textContent).toBe("Medium.");
    expect(items[0].querySelector(".eink-need__detail i")?.textContent).toBe("Low.");

    const install = within(needs).getByRole("button", { name: "Install: 4 updates available" });
    expect(install.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(within(needs).getByRole("button", { name: "Start: Vaultwarden is not running" }));
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
  });

  it("draws the figures as dithered bars that open their pages, and the apps with their state in words", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    const glance = screen.getByRole("region", { name: "At a glance" });
    fireEvent.click(await within(glance).findByRole("button", { name: "Memory: 34%" }));
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
    fireEvent.click(within(glance).getByRole("button", { name: /^Backed up/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("backups");
    const apps = within(glance).getByRole("list", { name: "Apps" });
    const vaultwarden = await within(apps).findByRole("button", { name: /^Vaultwarden, / });
    expect(vaultwarden.hasAttribute("data-attention")).toBe(true);
    expect(within(apps).getByRole("button", { name: "Jellyfin, running" }).hasAttribute("data-attention")).toBe(false);
  });

  it("says in the bar when the figures were read and when they are read next", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const slot = document.createElement("div");
    document.body.append(slot);
    render(<FactsProvider><TopBarSlotProvider value={slot}><EinkHome csrfToken="csrf" role="owner" onNavigate={vi.fn()} now={() => at} /></TopBarSlotProvider></FactsProvider>);
    await vi.waitFor(() => expect(slot.querySelector(".eink-bar__refresh")?.textContent).toBe("Refreshed 7:41 · next refresh 7:42"));
    expect(slot.querySelector(".eink-bar")?.textContent).toBe("homebox · Home");
    cleanup();
    slot.remove();
  });
});
