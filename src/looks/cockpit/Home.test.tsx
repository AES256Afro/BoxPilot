import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import { TopBarSlotProvider } from "../../shell/TopBarSlot";
import CockpitHome from "./Home";
import { nextBackupRun } from "./nextRun";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHome(slot?: HTMLElement) {
  const onNavigate = vi.fn();
  const home = <CockpitHome csrfToken="csrf" role="owner" onNavigate={onNavigate} />;
  render(<FactsProvider>{slot ? <TopBarSlotProvider value={slot}>{home}</TopBarSlotProvider> : home}</FactsProvider>);
  return onNavigate;
}

describe("Home in the Glass Cockpit look", () => {
  it("says the verdict in the memo, each fix a cyan line ending in its tier, run through the approval dialog", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    const memo = screen.getByRole("region", { name: "Memo" });
    expect(await within(memo).findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();

    // What needs you by section, what can wait under MEMO; each fix says its tier at the end of its line.
    const install = within(memo).getByRole("button", { name: "Install: 4 updates available" });
    expect(install.textContent).toMatch(/^- INSTALL \.{3,} MED$/);
    expect(install.getAttribute("data-risk")).toBe("medium");
    expect(document.getElementById(install.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(/^Medium risk/);
    expect(within(memo).getByRole("button", { name: "Update: An update for Jellyfin" }).textContent).toMatch(/MED$/);

    // A caution line opens its page; its fix goes through the approval dialog, never around it.
    fireEvent.click(within(memo).getByRole("button", { name: "Problem: Vaultwarden is not running" }));
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "vaultwarden" });
    const start = within(memo).getByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.textContent).toMatch(/LOW$/);
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST" }));
  });

  it("draws the gauges from the figures it has, each opening its page", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    const instruments = screen.getByRole("group", { name: "Instruments" });
    fireEvent.click(await within(instruments).findByRole("button", { name: "Processor: 11%" }));
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
    expect(within(instruments).getByRole("button", { name: "Memory: 34%" })).toBeTruthy();
    fireEvent.click(within(instruments).getByRole("button", { name: "System disk: 20%" }));
    expect(onNavigate).toHaveBeenLastCalledWith("storage");
    // No sensor answered in this fixture: the dial says so rather than showing a figure.
    expect(within(instruments).getByRole("button", { name: "Hottest sensor: not read" })).toBeTruthy();
  });

  it("lights the master lamp and the annunciators from the facts, in the shell's bar", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const slot = document.createElement("div");
    document.body.append(slot);
    const onNavigate = renderHome(slot);
    const bar = within(slot);
    const master = await bar.findByRole("button", { name: /^Master warning: 1 problem/ });
    expect(master.getAttribute("data-state")).toBe("danger");
    expect(bar.getByRole("button", { name: "Updates: needs a look" }).getAttribute("data-state")).toBe("warning");
    expect((await bar.findByRole("button", { name: "Backups: normal" })).getAttribute("data-state")).toBe("good");
    fireEvent.click(bar.getByRole("button", { name: "Updates: needs a look" }));
    expect(onNavigate).toHaveBeenLastCalledWith("updates");
    expect(slot.querySelector(".cockpit-clock")?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    cleanup();
    slot.remove();
  });

  it("says when the next backup runs, from the schedules' own words", () => {
    const at = new Date(2026, 8, 30, 11, 48).getTime();
    const schedule = (cadence: string, operationId = "app.backup") => ({ id: cadence, operationId, title: "", parameters: null, enabled: true, overdue: false, cadence, lastRunAt: null, lastOutcome: null, lastReason: null });
    expect(nextBackupRun([schedule("daily at 04:30", "backup.cloud.sync"), schedule("daily at 03:00")], at)?.words).toBe("03:00");
    expect(nextBackupRun([schedule("Sundays at 05:00")], at)?.words).toBe("SUN 05:00");
    expect(nextBackupRun([schedule("daily at 03:00", "apt.refresh")], at)).toBeNull();
  });
});
