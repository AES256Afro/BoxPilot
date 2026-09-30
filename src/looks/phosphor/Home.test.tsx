import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { stubFetch } from "../../home/testData";
import type { Need, NeedAction } from "../../home/needs";
import PhosphorHome, { asciiBar, keyedActions, suggestion } from "./Home";

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

  it("offers the first fix at the prompt, typed out, and runs it through the approval dialog", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    const next = await screen.findByRole("button", { name: "Run: start vaultwarden. Vaultwarden is not running" });
    expect(next.textContent).toBe("start vaultwarden");
    fireEvent.click(next);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
  });

  it("gives Dismiss no letter: a stray keypress never sets a failure aside", async () => {
    const failed = { id: "f1", type: "op:app.update", title: "Update Immich", state: "failed", risk: "medium", error: "pull failed", parameters: { id: "immich" }, steps: [], approvals: [], createdAt: new Date(Date.now() - 3_600_000).toISOString() };
    vi.stubGlobal("fetch", stubFetch({ "/api/v1/jobs?limit=50": { jobs: [failed] } }));
    renderHome();
    const dismiss = await screen.findByRole("button", { name: "Dismiss: Failed: Update Immich" });
    expect(dismiss.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(dismiss.textContent).toBe("dismiss");
    // Every letter of the word it is written with, and the ones no other fix took.
    const taken = [...document.querySelectorAll("[aria-keyshortcuts]")].map((button) => button.getAttribute("aria-keyshortcuts"));
    for (const key of "dismiss".split("").filter((letter) => !taken.includes(letter))) fireEvent.keyDown(document, { key });
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).endsWith("/dismiss") && init?.method === "POST")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("answers no key while someone types, in a field or anything editable", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    await screen.findByRole("button", { name: "Install: 4 updates available" });
    for (const value of ["", "true", "plaintext-only"]) {
      const editable = document.createElement("div");
      editable.setAttribute("contenteditable", value);
      document.body.append(editable);
      fireEvent.keyDown(editable, { key: "i" });
      editable.remove();
    }
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("writes the prompt's suggestion as the drawing does", () => {
    const apps = [{ id: "vaultwarden", name: "Vaultwarden" }, { id: "open-webui", name: "Open WebUI + Ollama" }];
    const backUp: NeedAction = { operationId: "app.backup.many", label: "Back up now", title: "", parameters: {}, preview: "", risk: "medium" };
    const due = { id: "repair:backups-due", kind: "repair", title: "", detail: null, finding: { id: "backups-due", fix: { operationId: "app.backup.many", parameters: { ids: ["vaultwarden", "immich"] } }, fixes: [] } } as unknown as Need;
    expect(suggestion(due, backUp, apps)).toBe("back up vaultwarden");
    const install: NeedAction = { operationId: "apt.upgrade", label: "Install", title: "", parameters: {}, preview: "", risk: "medium" };
    expect(suggestion({ id: "updates", kind: "updates", title: "4 updates available", detail: null } as Need, install, apps)).toBe("install updates");
    const resume: NeedAction = { operationId: "app.action", label: "Resume", title: "", parameters: {}, preview: "", risk: "low" };
    expect(suggestion({ id: "app-paused:open-webui", kind: "alert", appId: "open-webui", title: "", detail: null } as unknown as Need, resume, apps)).toBe("resume open webui");
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
