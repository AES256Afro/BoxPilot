import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import { TopBarSlotProvider } from "../../shell/TopBarSlot";
import WorkbookHome from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** 07:41 on a Tuesday, in the browser's own time. */
const at = new Date(2026, 8, 29, 7, 41).getTime();

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><WorkbookHome csrfToken="csrf" role={role} onNavigate={onNavigate} now={() => at} /></FactsProvider>);
  return onNavigate;
}

describe("Home as the first sheet of a workbook", () => {
  it("fills the verdict's cell, and lists each need as a row with its tier and its fix through the approval dialog", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Good morning");
    const verdict = await screen.findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.");
    expect(verdict.getAttribute("data-fill")).toBe("danger");
    expect(document.querySelector(".workbook-fx__formula")?.textContent).toContain("needs_a_look: 2, can_wait: 1");

    const list = screen.getByRole("list", { name: "What needs a look" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".workbook-row__tier")?.textContent)).toEqual(["Low", "Medium", "Medium"]);
    expect(rows.map((row) => row.getAttribute("data-fill"))).toEqual(["danger", "warning", null]);
    const start = within(list).getByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.getAttribute("data-risk")).toBe("low");
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST" }));
  });

  it("opens each figure's page and each app from its row", async () => {
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

  it("puts the page, the host and the time in the title strip", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const slot = document.createElement("div");
    document.body.append(slot);
    render(<FactsProvider><TopBarSlotProvider value={slot}><WorkbookHome csrfToken="csrf" role="owner" onNavigate={vi.fn()} now={() => at} /></TopBarSlotProvider></FactsProvider>);
    await vi.waitFor(() => expect(slot.querySelector(".workbook-bar")?.textContent).toBe("Homehomebox"));
    expect(slot.querySelector(".workbook-bar__date")?.textContent).toBe("07:41");
    cleanup();
    slot.remove();
  });
});
