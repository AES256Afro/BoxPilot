import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import { TopBarSlotProvider } from "../../shell/TopBarSlot";
import ManualHome from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** 07:41 on a Tuesday, in the browser's own time. */
const at = new Date(2026, 8, 29, 7, 41).getTime();

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><ManualHome csrfToken="csrf" role={role} onNavigate={onNavigate} now={() => at} /></FactsProvider>);
  return onNavigate;
}

describe("Home as an operator's manual", () => {
  it("stamps the result and prints each need in its block, with its fix through the approval dialog", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Good morning");
    expect(await screen.findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();
    expect(document.querySelector(".manual-stamp b")?.textContent).toBe("2 faults");

    const list = screen.getByRole("list", { name: "What needs a look" });
    const blocks = within(list).getAllByRole("listitem");
    expect(blocks.map((block) => block.querySelector(".manual-block__word")?.textContent)).toEqual(["Warning", "Caution", "Note"]);
    expect(blocks.map((block) => block.getAttribute("data-block"))).toEqual(["warning", "caution", "note"]);
    const start = within(list).getByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.getAttribute("data-risk")).toBe("low");
    expect(within(list).getByRole("button", { name: "Install: 4 updates available" }).getAttribute("data-risk")).toBe("medium");
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST" }));
  });

  it("opens each reading's page and each app from its row", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "11% Processor" }));
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
    fireEvent.click(screen.getByRole("button", { name: /Apps backed up$/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("backups");
    const apps = screen.getByRole("list", { name: "Apps" });
    fireEvent.click(await within(apps).findByRole("button", { name: "Vaultwarden, not running" }));
    expect(onNavigate).toHaveBeenLastCalledWith("catalog", { app: "vaultwarden" });
  });

  it("puts the page, the host and the date in the running head", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const slot = document.createElement("div");
    document.body.append(slot);
    render(<FactsProvider><TopBarSlotProvider value={slot}><ManualHome csrfToken="csrf" role="owner" onNavigate={vi.fn()} now={() => at} /></TopBarSlotProvider></FactsProvider>);
    await vi.waitFor(() => expect(slot.querySelector(".manual-bar")?.textContent).toBe("Homehomebox"));
    expect(slot.querySelector(".manual-bar__date")?.textContent).toBe("29 Sep 2026 07:41");
    cleanup();
    slot.remove();
  });
});
