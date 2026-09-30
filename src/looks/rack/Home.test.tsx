import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import type { NeedAction } from "../../home/needs";
import RackHome, { keyWords, segments } from "./Home";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><RackHome csrfToken="csrf" role={role} onNavigate={onNavigate} /></FactsProvider>);
  return onNavigate;
}

describe("Home as a rack of equipment", () => {
  it("lights the lamp, shows the verdict and lists what needs you on the LCD with its tier", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(await screen.findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("2 tolook at");

    const needs = screen.getByRole("region", { name: "Needs you" });
    const lines = within(needs).getAllByRole("button").filter((button) => button.className.includes("rack-lcd__line"));
    expect(lines.map((line) => line.querySelector(".rack-lcd__words")?.textContent)).toEqual(["Vaultwarden is not running", "4 updates available"]);
    expect(lines.map((line) => line.querySelector(".rack-lcd__tier")?.textContent)).toEqual(["LOW", "MED"]);
    const wait = screen.getByRole("region", { name: "Can wait" });
    expect(within(wait).getByRole("button", { name: "Update: An update for Jellyfin" }).getAttribute("data-risk")).toBe("medium");
  });

  it("presses a key through the approval dialog at its tier", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    const start = await screen.findByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.getAttribute("data-risk")).toBe("low");
    expect(start.getAttribute("data-tone")).toBe("green");
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
  });

  it("opens each module and each reading", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    fireEvent.click(await screen.findByRole("button", { name: "Jellyfin, Healthy, update ready" }));
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "jellyfin" });
    fireEvent.click(await screen.findByRole("button", { name: "Processor 11%" }));
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
  });

  it("writes readings and key labels as the panel does", () => {
    expect(segments(11)).toBe("011");
    expect(segments(11.04, true)).toBe("11.0");
    expect(segments(null)).toBe("---");
    const action = (label: string): NeedAction => ({ operationId: "x", label, title: label, parameters: {}, preview: "", risk: "medium" });
    expect(keyWords([action("Back up now"), action("Back up nightly")])).toEqual(["Back up", "nightly"]);
  });
});
