import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import { TopBarSlotProvider } from "../../shell/TopBarSlot";
import SwissHome from "./Home";
import { spellOut } from "./homeData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** 07:41 on the drawing's Tuesday, in the browser's own time. */
const at = new Date(2026, 8, 29, 7, 41).getTime();

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><SwissHome csrfToken="csrf" role={role} onNavigate={onNavigate} now={() => at} /></FactsProvider>);
  return onNavigate;
}

describe("Home as a Swiss poster", () => {
  it("prints how many things need a look, each with its tier in words and its fix through the approval dialog", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Good morning");
    expect(await screen.findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();
    expect(document.querySelector(".swiss-num")?.textContent).toBe("2");
    expect(document.querySelector(".swiss-h")?.textContent).toBe("things need you.");

    const list = screen.getByRole("list", { name: "What needs a look" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".swiss-item__tier")?.textContent)).toEqual(["Low", "Medium", "Medium"]);
    const start = within(list).getByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.getAttribute("data-risk")).toBe("low");
    expect(within(list).getByRole("button", { name: "Install: 4 updates available" }).getAttribute("data-risk")).toBe("medium");
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST" }));
  });

  it("opens each figure's page and each app from the list at the foot", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    const processor = await screen.findByRole("button", { name: "11% Processor" });
    fireEvent.click(processor);
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
    fireEvent.click(screen.getByRole("button", { name: /Apps backed up$/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("backups");
    const apps = screen.getByRole("list", { name: "Apps" });
    fireEvent.click(await within(apps).findByRole("button", { name: "Vaultwarden, not running" }));
    expect(onNavigate).toHaveBeenLastCalledWith("catalog", { app: "vaultwarden" });
  });

  it("puts the page, the host and the date in the bar's line", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const slot = document.createElement("div");
    document.body.append(slot);
    render(<FactsProvider><TopBarSlotProvider value={slot}><SwissHome csrfToken="csrf" role="owner" onNavigate={vi.fn()} now={() => at} /></TopBarSlotProvider></FactsProvider>);
    await vi.waitFor(() => expect(slot.querySelector(".swiss-bar__host")?.textContent).toBe("homebox"));
    expect(slot.querySelector(".swiss-bar__date")?.textContent).toBe("Tue 29.09.2026 07:41");
    cleanup();
    slot.remove();
  });

  it("writes small numbers out for the e-paper's sentences", () => {
    expect(spellOut("homebox is running. 3 things need a look. 2 more can wait.")).toBe("homebox is running. Three things need a look. Two more can wait.");
    expect(spellOut("homebox needs you: 1 problem and 2 things to look at.")).toBe("homebox needs you: one problem and two things to look at.");
    expect(spellOut("Backup 63 days old")).toBe("Backup 63 days old");
  });
});
