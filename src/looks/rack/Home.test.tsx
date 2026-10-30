import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import type { Need, NeedAction } from "../../home/needs";
import RackHome, { keyWords, lcdLine, lcdText, segments } from "./Home";

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
    const lamp = document.querySelector(".rack-lamp");
    expect(lamp?.textContent).toBe("2 tolook at");
    expect(lamp?.hasAttribute("data-lit")).toBe(true);

    const needs = screen.getByRole("region", { name: "Needs you" });
    const lines = within(needs).getAllByRole("button").filter((button) => button.className.includes("rack-lcd__line"));
    // Terse fixed-width lines, as the drawing's LCD prints them; the whole sentence is what is read out.
    expect(lines.map((line) => line.querySelector(".rack-lcd__text")?.textContent)).toEqual(["1 VAULTWARDEN    DOWN       LOW", "2 UPDATES 4      1 SECURITY MED"]);
    expect(lines.map((line) => line.querySelector(".ui-visually-hidden")?.textContent)).toEqual(["Vaultwarden is not running. Its container is stopped. low risk", "4 updates available. 1 security fix among them. medium risk"]);
    const wait = screen.getByRole("region", { name: "Can wait" });
    const update = within(wait).getByRole("button", { name: "Update: An update for Jellyfin" });
    expect(update.getAttribute("data-risk")).toBe("medium");
    // In what can wait a medium fix is a grey key, as drawn; the one to press in what needs you is amber.
    expect(update.getAttribute("data-tone")).toBe("grey");
    expect(within(needs).getByRole("button", { name: "Install: 4 updates available" }).getAttribute("data-tone")).toBe("amber");
    expect(within(wait).getByRole("button", { name: /^An update for Jellyfin/ }).querySelector(".rack-lcd__text")?.textContent).toBe("JELLYFIN UPDATE READY     MED");
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

  it("writes each need as the LCD does: short, in columns, never with an ellipsis", () => {
    const apps = [{ id: "vaultwarden", name: "Vaultwarden" }, { id: "immich", name: "Immich" }, { id: "open-webui", name: "Open WebUI + Ollama" }];
    const due = { id: "repair:backups-due", title: "Vaultwarden, Immich and 2 more have not been backed up recently", detail: null,
      finding: { id: "backups-due", fix: { operationId: "app.backup.many", parameters: { ids: ["vaultwarden", "immich", "nextcloud", "homepage"] } }, fixes: [], evidence: [] } } as unknown as Need;
    expect(lcdText(due, apps, 1, "medium")).toBe("1 VAULTWARDEN+3  NO BACKUP  MED");
    const paused = { id: "app-paused:open-webui", title: "Open WebUI + Ollama is paused", detail: null } as unknown as Need;
    expect(lcdLine(paused, apps)).toEqual(["OPEN WEBUI", "PAUSED"]);
    expect(lcdText(paused, apps, null, "low")).toBe("OPEN WEBUI PAUSED         LOW");
    const other = { id: "alert:x:0", title: "Something long happened to a drive nobody has named yet", detail: null } as unknown as Need;
    expect(lcdLine(other, apps)).toEqual(["SOMETHING LONG HAPPENED", ""]);
  });
});
