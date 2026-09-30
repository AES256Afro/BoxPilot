import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { busier, stubFetch } from "../../home/testData";
import BlendHome from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHome(clock: number, role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><BlendHome csrfToken="csrf" role={role} onNavigate={onNavigate} now={() => clock} /></FactsProvider>);
  return onNavigate;
}

describe("Home in Home + Ops", () => {
  it("greets, says the verdict and lists what needs you, each fix with its tier, through the approval dialog", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome(Date.now());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(await screen.findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();

    // What needs a look first, then what can wait, in the one panel, as the drawing has them.
    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("2 + 1 can wait")).toBeTruthy();
    const titles = within(needs).getAllByRole("button").filter((button) => button.className.includes("need__title")).map((button) => button.textContent);
    expect(titles).toEqual(["Problem: Vaultwarden is not running", "Needs a look: 4 updates available", "Suggestion: An update for Jellyfin"]);
    // The tier leads the row in words; the button carries it too, and is what is read out.
    const install = within(needs).getByRole("button", { name: "Install: 4 updates available" });
    expect(install.getAttribute("data-risk")).toBe("medium");
    expect(install.closest("li")?.querySelector(".need__tier-tag")?.textContent).toBe("Medium risk");

    const start = within(needs).getByRole("button", { name: "Start: Vaultwarden is not running" });
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST" }));
  });

  it("draws the figures, the apps with their numbers or their problem, and what ran overnight", async () => {
    const clock = Date.now();
    const at = (hours: number) => new Date(clock - hours * 3_600_000).toISOString();
    const job = (id: string, type: string, state: string, hours: number, parameters: Record<string, unknown>) => ({
      id, type, title: type, state, risk: "medium", error: null, result: null, steps: [], approvals: [], parameters, createdAt: at(hours), updatedAt: at(hours - 0.05),
    });
    vi.stubGlobal("fetch", stubFetch({
      ...busier,
      "/api/v1/jobs?limit=50": { jobs: [] },
      "/api/v1/jobs?limit=200": { jobs: [
        job("n1", "op:app.backup", "completed", 4, { id: "jellyfin" }),
        job("n2", "op:app.backup.verify", "completed", 3, { id: "jellyfin" }),
        job("n3", "op:app.backup", "failed", 2, { id: "vaultwarden" }),
        job("n4", "op:apt.upgrade", "completed", 1, {}),
        job("old", "op:app.backup", "completed", 30, { id: "jellyfin" }),
      ] },
    }));
    const onNavigate = renderHome(clock);

    const strip = screen.getByRole("region", { name: "The figures" });
    const cpu = await within(strip).findByRole("button", { name: /^CPU: 27 %, load 2\.31/ });
    expect(await within(strip).findByRole("button", { name: "Hottest: 52 °C, k10temp" })).toBeTruthy();
    fireEvent.click(cpu);
    expect(onNavigate).toHaveBeenCalledWith("performance");

    const apps = screen.getByRole("region", { name: /Apps/ });
    expect((await within(apps).findByRole("button", { name: /^Jellyfin, Healthy, update ready/ })).textContent).toContain("34.2% · 412 MB");
    expect(within(apps).getByRole("button", { name: /^Vaultwarden, Not running/ }).getAttribute("data-status")).toBe("danger");
    fireEvent.click(within(apps).getByRole("button", { name: /Add an app/ }));
    expect(onNavigate).toHaveBeenCalledWith("catalog");

    // The failure stays in view; the rest are on Today, one press away.
    const night = screen.getByRole("region", { name: "Overnight" });
    expect(await within(night).findByText("Could not back up Vaultwarden")).toBeTruthy();
    const all = within(night).getByRole("button", { name: /^4 jobs · 1 failed/ });
    expect(within(night).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(all);
    expect(onNavigate).toHaveBeenCalledWith("today");
  });
});
