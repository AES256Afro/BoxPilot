import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { navItems } from "../data";
import { CommandBar } from "./CommandBar";
import { actionCommands, buildCommands, searchCommands } from "./commandIndex";
import { dockAreas } from "./ShellNav";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const catalog = { host: { lanAddress: "192.0.2.10" }, liveError: null, applications: [
  { manifest: { id: "jellyfin", name: "Jellyfin", icon: "🎬", category: "Media", keepsBackup: true }, live: { installed: true, updateAvailable: true, container: { running: true, status: "running" }, urls: [{ host: 8096, exposure: "lan" }] } },
  { manifest: { id: "mealie", name: "Mealie", category: "Food" }, live: null },
] };

const answer = {
  answer: "Vaultwarden has never been backed up [S1].",
  sources: [{ id: "S1", kind: "fact", title: "Which apps have backups", cited: true }],
  plan: { steps: [{ operationId: "app.backup", title: "Back up application data", risk: "medium", readOnly: false, parameters: { id: "vaultwarden" }, why: "It has never been backed up." }], dropped: [] },
  model: "hermes3:8b",
  degraded: null,
};

function stub(status: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "/api/v1/catalog?view=summary") return json(catalog);
    if (url === "/api/v1/assistant/status") return status === "fail" ? json({ error: "not answering" }, 503) : json(status);
    if (url === "/api/v1/assistant/ask") return json(answer);
    return json({ error: "unexpected" }, 404);
  });
}

function open(status: unknown = { ready: false, problem: { reason: "no-model", message: "No local model is set up." } }, role: string | null = null) {
  vi.stubGlobal("fetch", stub(status));
  const onNavigate = vi.fn();
  const onStart = vi.fn();
  render(<CommandBar csrfToken="csrf" onNavigate={onNavigate} onStart={onStart} role={role} />);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const dialog = screen.getByRole("dialog", { name: "Search BoxPilot" });
  const input = within(dialog).getByRole("combobox", { name: "Search pages, apps and settings" });
  return { dialog, input, onNavigate, onStart };
}

describe("the command bar", () => {
  it("opens with Ctrl K, takes the typing, and jumps to a page with Enter", () => {
    const { dialog, input, onNavigate } = open();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "fire" } });
    const options = within(dialog).getAllByRole("option");
    expect(options[0].textContent).toContain("Firewall");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavigate.mock.calls[0][0]).toBe("firewall");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("finds a setting by what it does, and moves with the arrow keys", () => {
    const { dialog, input, onNavigate } = open();
    fireEvent.change(input, { target: { value: "swap" } });
    const labels = within(dialog).getAllByRole("option").map((option) => option.querySelector(".command-option__label")?.textContent);
    expect(labels.slice(0, 2)).toEqual(["Swap and swappiness", "Swap files"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(within(dialog).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith("storage", undefined);
  });

  it("opens an installed app's own page, or its card in the catalog", async () => {
    const { dialog, input, onNavigate } = open();
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    fireEvent.change(input, { target: { value: "jelly" } });
    const first = await within(dialog).findByRole("option", { name: /^Jellyfin\s*Opens it in a new tab/ });
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(windowOpen).toHaveBeenCalledWith("http://192.0.2.10:8096", "_blank", "noopener,noreferrer");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const again = screen.getByRole("combobox", { name: "Search pages, apps and settings" });
    fireEvent.change(again, { target: { value: "jelly" } });
    fireEvent.click(await screen.findByRole("option", { name: /Jellyfin in the App catalog/ }));
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "jellyfin" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "mealie" } });
    expect((await screen.findByRole("option", { name: /Install Mealie/ })).textContent).toContain("App catalog · Food");
  });

  it("says plainly that no assistant is set up, and stays a search box", async () => {
    const { dialog, input } = open();
    expect(await within(dialog).findByText("The local assistant is not set up, so this only searches. No local model is set up.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "why did the backup fail" } });
    expect(within(dialog).queryByRole("option", { name: /^Ask/ })).toBeNull();
    expect(within(dialog).getByText(/Nothing matches/)).toBeTruthy();
  });

  it("says so when the assistant does not answer at all", async () => {
    const { dialog } = open("fail");
    expect(await within(dialog).findByText("The local assistant did not answer, so this only searches.")).toBeTruthy();
  });

  it("asks the assistant where one is set up, and sends a suggested step to the approval dialog at its tier", async () => {
    const { dialog, input, onStart } = open({ ready: true, chatModel: "hermes3:8b", problem: null });
    expect(await within(dialog).findByText(/put it to hermes3:8b, which runs on this server/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "what is not backed up" } });
    const ask = within(dialog).getByRole("option", { name: /^Ask: what is not backed up/ });
    fireEvent.click(ask);
    expect(await within(dialog).findByText("Vaultwarden has never been backed up [S1].")).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/assistant/ask", expect.objectContaining({ method: "POST", body: JSON.stringify({ question: "what is not backed up" }), headers: expect.objectContaining({ "X-BoxPilot-CSRF": "csrf", Accept: "application/json" }) }));
    expect(within(dialog).getByText("Drawn from one source")).toBeTruthy();
    const steps = within(dialog).getByRole("region", { name: "Suggested steps" });
    expect(within(steps).getByText("Medium").closest(".ui-risk")).not.toBeNull();
    const review = within(steps).getByRole("button", { name: "Review" });
    expect(review.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(review);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ operationId: "app.backup", title: "Back up application data", parameters: { id: "vaultwarden" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and gives the keyboard back", () => {
    vi.stubGlobal("fetch", stub({ ready: false }));
    render(<CommandBar csrfToken="csrf" onNavigate={vi.fn()} onStart={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Search pages, apps and settings" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Search BoxPilot" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("what the command bar can reach", () => {
  it("lists every page with nothing typed", () => {
    const pages = searchCommands(buildCommands([]), "").map((command) => command.view);
    for (const item of navItems) expect(pages).toContain(item.id);
    expect(pages).toContain("setup");
  });

  it("puts every admin area in the dock and the two views in the switch, so no page is lost", () => {
    const reachable = new Set<string>(["home", "ops", ...dockAreas.map((area) => area.id)]);
    expect(navItems.filter((item) => !reachable.has(item.id)).map((item) => item.id)).toEqual([]);
    expect(dockAreas.length).toBe(new Set(dockAreas.map((area) => area.id)).size);
  });
});

// M36: the bar does things as well as finding them, each through the approval dialog at its tier.
describe("actions in the command bar", () => {
  it("backs up an app from what was typed, through the approval dialog, with its tier shown first", async () => {
    const { dialog, input, onStart } = open(undefined, "owner");
    fireEvent.change(input, { target: { value: "back up jelly" } });
    const option = await within(dialog).findByRole("option", { name: /^Back up Jellyfin/ });
    expect(option.querySelector(".ui-risk")?.getAttribute("data-risk")).toBe("medium");
    expect(option.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ operationId: "app.backup", title: "Back up Jellyfin", parameters: { id: "jellyfin" } }));
    expect(screen.queryByRole("dialog", { name: "Search BoxPilot" })).toBeNull();
  });

  it("restarts an app, and checks for updates, in a click", async () => {
    const { dialog, input, onStart } = open(undefined, "owner");
    fireEvent.change(input, { target: { value: "restart jellyfin" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /^Restart Jellyfin/ }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ operationId: "app.action", parameters: { id: "jellyfin", action: "restart" } }));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "check for updates" } });
    fireEvent.click(await screen.findByRole("option", { name: /^Check for updates/ }));
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: "apt.refresh", parameters: {} }));
  });

  it("offers each role only what it could start, and a viewer nothing", () => {
    const apps = [{ id: "plex", name: "Plex", running: true, paused: false, updateAvailable: false, backup: true }];
    const labels = (role: string | null) => actionCommands(apps, role).map((command) => command.label);
    expect(labels("owner")).toEqual(["Check for updates", "Install all updates", "Back up BoxPilot's database", "Reboot the server", "Back up Plex", "Restart Plex", "Stop Plex"]);
    expect(labels("operator")).not.toContain("Reboot the server");
    expect(labels("viewer")).toEqual([]);
    expect(labels(null)).toEqual([]);
    expect(actionCommands(apps, "owner").find((command) => command.label === "Reboot the server")?.action?.risk).toBe("high");
  });

  it("offers to start a stopped app, and no backup where an app keeps nothing worth one", () => {
    const labels = actionCommands([{ id: "homepage", name: "Homepage", running: false, paused: false, updateAvailable: false, backup: false }], "owner").map((command) => command.label);
    expect(labels).toContain("Start Homepage");
    expect(labels).not.toContain("Back up Homepage");
    expect(labels).not.toContain("Restart Homepage");
  });

  it("finds actions only when something is typed, so an empty bar still lists the pages", () => {
    const commands = buildCommands([], actionCommands([], "owner"));
    expect(searchCommands(commands, "").every((command) => command.group === "Pages")).toBe(true);
    expect(searchCommands(commands, "reboot")[0]).toMatchObject({ label: "Reboot the server", group: "Actions" });
  });
});
