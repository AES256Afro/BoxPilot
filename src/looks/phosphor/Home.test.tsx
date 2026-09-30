import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import type { NeedAction } from "../../home/needs";
import PhosphorHome, { asciiBar, keyedActions } from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><PhosphorHome csrfToken="csrf" role={role} onNavigate={onNavigate} /></FactsProvider>);
  return onNavigate;
}

describe("Home as a phosphor terminal", () => {
  it("types out the status, what needs you and what can wait, each fix with its key and tier", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(await screen.findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();
    expect(document.querySelector(".phosphor-status .phosphor-inv")?.textContent).toBe(" 2 NEED A LOOK ");

    const install = screen.getByRole("button", { name: "Install: 4 updates available" });
    expect(install.querySelector(".ui-button__label")?.textContent).toBe("(i)nstall");
    expect(install.getAttribute("aria-keyshortcuts")).toBe("i");
    expect(install.getAttribute("data-risk")).toBe("medium");
    expect(within(install.closest("li")!).getByText("[MED]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start: Vaultwarden is not running" }).querySelector(".ui-button__label")?.textContent).toBe("(s)tart");
  });

  it("opens the approval dialog from a fix's button, and from its key", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    await screen.findByRole("button", { name: "Install: 4 updates available" });
    fireEvent.keyDown(document, { key: "s" });
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST", body: JSON.stringify({ parameters: { id: "vaultwarden", action: "start" } }) }));
  });

  it("lists the apps, the one that needs a look marked, and opens each", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    const vaultwarden = await screen.findByRole("button", { name: "Vaultwarden, Not running" });
    expect(vaultwarden.textContent).toMatch(/^! vaultwarden\s+not running/);
    fireEvent.click(vaultwarden);
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "vaultwarden" });
    fireEvent.click(screen.getByRole("button", { name: /^CPU/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
  });

  it("opens the command bar from the prompt, as Ctrl K does", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    const pressed = vi.fn();
    window.addEventListener("keydown", pressed);
    fireEvent.click(await screen.findByRole("button", { name: "Search, or say what you want (Ctrl K)" }));
    window.removeEventListener("keydown", pressed);
    expect(pressed.mock.calls[0][0]).toMatchObject({ key: "k", ctrlKey: true });
  });

  it("draws bars and gives each fix a key of its own", () => {
    expect(asciiBar(11, 10)).toBe("[#.........]");
    expect(asciiBar(null, 4)).toBe("[....]");
    const action = (label: string): NeedAction => ({ operationId: "x", label, title: label, parameters: {}, preview: "", risk: "medium" });
    const taken = new Set<string>();
    expect(keyedActions([action("Back up now"), action("Back up nightly")], taken).map(({ words, key }) => [words, key])).toEqual([["Back up now", "b"], ["nightly", "n"]]);
    expect(keyedActions([action("Update")], taken).map(({ key }) => key)).toEqual(["u"]);
    expect(keyedActions([action("Update")], taken).map(({ key, at }) => [key, at])).toEqual([["p", 1]]);
  });
});
