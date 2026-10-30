import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import QuestHome from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  const view = render(<FactsProvider><QuestHome csrfToken="csrf" role={role} onNavigate={onNavigate} /></FactsProvider>);
  return { onNavigate, container: view.container };
}

describe("Home in the Quest look", () => {
  it("greets you with the quests waiting, and runs a quest's fix through the approval dialog at its tier", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const { onNavigate, container } = renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(await screen.findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();
    expect(container.querySelector(".quest-say__text")?.textContent).toMatch(/^Good (morning|afternoon|evening)! Two quests are waiting for you\.$/);

    // Each need a quest: a name, its words, what it earns and its risk; what can wait is a side quest.
    const quests = screen.getByRole("region", { name: /QUESTS/ });
    expect(within(quests).getByRole("button", { name: "Revive Vaultwarden: Vaultwarden is not running" })).toBeTruthy();
    expect(within(quests).getByText("Reward: +1 security · Risk: medium")).toBeTruthy();
    expect(within(quests).getByRole("button", { name: "new gear for Jellyfin: An update for Jellyfin" })).toBeTruthy();
    const install = within(quests).getByRole("button", { name: "Accept, Install: 4 updates available" });
    expect(install.textContent).toBe("Accept");
    expect(install.getAttribute("data-risk")).toBe("medium");
    expect(document.getElementById(install.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(/^Medium risk/);

    // The quest's name opens its page; Accept goes through the approval dialog, never around it.
    fireEvent.click(within(quests).getByRole("button", { name: "Revive Vaultwarden: Vaultwarden is not running" }));
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "vaultwarden" });
    fireEvent.click(within(quests).getByRole("button", { name: "Accept, Start: Vaultwarden is not running" }));
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST" }));
  });

  it("shows every app as a party member with its status effect and HP, each opening its sheet", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    const party = screen.getByRole("region", { name: /PARTY/ });
    const vaultwarden = await within(party).findByRole("button", { name: "Vaultwarden, Not running" });
    expect(vaultwarden.querySelector(".quest-fx")?.textContent).toBe("KO");
    expect(vaultwarden.querySelector(".quest-hp")?.textContent).toBe("HP 15/100");
    const jellyfin = within(party).getByRole("button", { name: "Jellyfin, Healthy, update ready" });
    expect(jellyfin.querySelector(".quest-hp")?.textContent).toBe("HP 100/100");
    expect(jellyfin.querySelector(".quest-av")?.getAttribute("data-hue")).toBe("violet");
    expect(within(party).getByText("2 members · 1 awake")).toBeTruthy();
    fireEvent.click(jellyfin);
    expect(screen.getByRole("dialog", { name: "Jellyfin" })).toBeTruthy();
  });

  it("gives a viewer the same quests and no Accept it could not use", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome("viewer");
    const quests = screen.getByRole("region", { name: /QUESTS/ });
    expect(await within(quests).findByRole("button", { name: "Revive Vaultwarden: Vaultwarden is not running" })).toBeTruthy();
    expect(within(quests).queryByRole("button", { name: /^Accept/ })).toBeNull();
  });
});
