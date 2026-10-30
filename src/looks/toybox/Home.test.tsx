import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import ToyboxHome from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><ToyboxHome csrfToken="csrf" role={role} onNavigate={onNavigate} /></FactsProvider>);
  return onNavigate;
}

describe("Home in the Toybox look", () => {
  it("has the robot say how it is doing, lists what needs you with the tier in words, and fixes through the approval dialog", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(await screen.findByText(/^(Morning|Afternoon|Evening)! I need help: 1 problem\.$/)).toBeTruthy();
    expect(screen.getByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();

    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getByRole("button", { name: "Problem: Vaultwarden is not running" })).toBeTruthy();
    expect(within(needs).getByRole("button", { name: "Needs a look: 4 updates are ready, 1 is a security fix" })).toBeTruthy();
    expect(within(needs).getByText("Low risk")).toBeTruthy();
    expect(within(needs).getByText("Medium risk")).toBeTruthy();
    const waiting = screen.getByRole("region", { name: "Can wait" });
    expect(within(waiting).getByRole("button", { name: "Suggestion: Jellyfin has a new version" })).toBeTruthy();

    fireEvent.click(within(needs).getByRole("button", { name: "Needs a look: 4 updates are ready, 1 is a security fix" }));
    expect(onNavigate).toHaveBeenCalledWith("updates", undefined);
    const start = within(needs).getByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.getAttribute("data-risk")).toBe("low");
    expect(start.className).toContain("ui-button--primary");
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST" }));
  });

  it("shows what can be fixed from here in its two rows before a note with nothing to press", async () => {
    const note = { key: "dns.single", active: true, details: [{ title: "If homebox goes down, every device on your network loses the internet" }] };
    vi.stubGlobal("fetch", stubFetch({ "/api/v1/settings/watch": { targetConfigured: true, conditions: [note], notices: [] } }));
    renderHome();
    await screen.findByRole("button", { name: /^Needs a look: 4 updates/ });
    const needs = screen.getByRole("region", { name: "Needs you" });
    const titles = within(needs).getAllByRole("button").filter((button) => button.className.includes("toybox-need__title")).map((button) => button.textContent?.trim());
    expect(titles).toEqual(["Problem: Vaultwarden is not running", "Needs a look: 4 updates are ready, 1 is a security fix"]);
    fireEvent.click(within(needs).getByRole("button", { name: "Show 1 more" }));
    expect(within(needs).getByRole("button", { name: "Needs a look: If homebox goes down, every device on your network loses the internet" })).toBeTruthy();
  });

  it("shows the apps as bubbles with how each is doing, and the bars each open their page", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    const apps = await screen.findByRole("region", { name: "Your apps" });
    const vaultwarden = await within(apps).findByRole("button", { name: "Vaultwarden, Not running" });
    expect(vaultwarden.textContent).toContain("not running");
    expect(vaultwarden.querySelector(".toybox-app__sticker")?.textContent).toBe("!");
    const jellyfin = within(apps).getByRole("button", { name: "Jellyfin, Healthy, update ready" });
    expect(jellyfin.textContent).toContain("🎬");
    expect(jellyfin.textContent).toContain("happy");
    expect(within(apps).getByRole("button", { name: /Add an app/ }).textContent).toContain("3 to pick from");
    fireEvent.click(jellyfin);
    expect(screen.getByRole("dialog", { name: "Jellyfin" })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /^Busy-ness/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
    fireEvent.click(screen.getByRole("button", { name: /^System disk/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("storage");
  });
});
