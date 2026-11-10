import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { navItems } from "../data";
import { CommandBar } from "./CommandBar";
import { act } from "react";
import { publishWaiting } from "./approvalsWaiting";
import { actionCommands, buildCommands, searchCommands, suggestedCommands } from "./commandIndex";
import { openActivityEvent, openNotificationsEvent } from "../activityEvents";
import type { Job } from "../operations";
import { dockAreas } from "./ShellNav";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); publishWaiting([]); });

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
    fireEvent.click(await screen.findByRole("option", { name: /Jellyfin in Apps/ }));
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "jellyfin" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "mealie" } });
    expect((await screen.findByRole("option", { name: /Install Mealie/ })).textContent).toContain("Apps · Food");
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

describe("the assistant's answer is not thrown away by one key", () => {
  it("goes back to the list on the first Escape and closes on the second; a click outside does nothing while it shows", async () => {
    const { dialog, input } = open({ ready: true, chatModel: "hermes3:8b" });
    fireEvent.change(input, { target: { value: "is vaultwarden backed up" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /^Ask:/ }));
    expect(await within(dialog).findByText(/Vaultwarden has never been backed up/)).toBeTruthy();
    fireEvent.mouseDown(document.querySelector(".command-overlay") as Element);
    expect(within(dialog).getByText(/Vaultwarden has never been backed up/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    // Still open, back on the list, with what was typed and the keyboard in the box.
    expect(screen.getByRole("dialog", { name: "Search BoxPilot" })).toBeTruthy();
    expect(within(dialog).queryByText(/Vaultwarden has never been backed up/)).toBeNull();
    expect(within(dialog).getByRole("option", { name: /^Ask:/ })).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("is vaultwarden backed up");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a question that is still being answered through a click outside, and stops it on Escape", async () => {
    let signal: AbortSignal | undefined;
    const base = stub({ ready: true, chatModel: "hermes3:8b" });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString() !== "/api/v1/assistant/ask") return base(input);
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }));
    render(<CommandBar csrfToken="csrf" onNavigate={vi.fn()} onStart={vi.fn()} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Search BoxPilot" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "why is it slow" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /^Ask:/ }));
    expect(within(dialog).getByText(/an answer can take a minute/)).toBeTruthy();
    fireEvent.mouseDown(document.querySelector(".command-overlay") as Element);
    expect(within(dialog).getByText(/an answer can take a minute/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("dialog", { name: "Search BoxPilot" })).toBeTruthy();
    expect(within(dialog).getByRole("listbox")).toBeTruthy();
  });

  it("still closes on a click outside while it is only a search", () => {
    open();
    fireEvent.mouseDown(document.querySelector(".command-overlay") as Element);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the / shortcut", () => {
  const mount = () => { vi.stubGlobal("fetch", stub({ ready: false })); return render(<><CommandBar csrfToken="csrf" onNavigate={vi.fn()} onStart={vi.fn()} /><input aria-label="A page's own field" /><div contentEditable="true" data-testid="editable" /></>); };

  it("opens the bar when nothing is being typed into", () => {
    mount();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByRole("dialog", { name: "Search BoxPilot" })).toBeTruthy();
    // Open, a slash is a character for its own box.
    const typed = fireEvent.keyDown(screen.getByRole("combobox"), { key: "/" });
    expect(typed).toBe(true);
  });

  it("is left alone in a field, in editable text, with a modifier, under another dialog, and when a look's own bar took it", () => {
    mount();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "A page's own field" }), { key: "/" });
    fireEvent.keyDown(screen.getByTestId("editable"), { key: "/" });
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    // Phosphor's bar handles "/" on the document and marks it handled before it reaches the window.
    const taken = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", taken);
    fireEvent.keyDown(document.body, { key: "/" });
    document.removeEventListener("keydown", taken);
    expect(screen.queryByRole("dialog")).toBeNull();
    const other = document.createElement("div"); other.setAttribute("aria-modal", "true"); document.body.append(other);
    fireEvent.keyDown(document.body, { key: "/" });
    other.remove();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("what the shell does, from the command bar", () => {
  it("opens Activity and the notifications, and signs out where it was given the means", async () => {
    vi.stubGlobal("fetch", stub({ ready: false }));
    const onSignOut = vi.fn();
    render(<CommandBar csrfToken="csrf" onNavigate={vi.fn()} onStart={vi.fn()} onSignOut={onSignOut} />);
    const activity = vi.fn(); const notifications = vi.fn();
    window.addEventListener(openActivityEvent, activity);
    window.addEventListener(openNotificationsEvent, notifications);
    const choose = (words: string) => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      const input = screen.getByRole("combobox");
      fireEvent.change(input, { target: { value: words } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.queryByRole("dialog"), words).toBeNull();
    };
    choose("activity");
    expect(activity).toHaveBeenCalledTimes(1);
    choose("open notifications");
    expect(notifications).toHaveBeenCalledTimes(1);
    choose("sign out");
    expect(onSignOut).toHaveBeenCalledTimes(1);
    window.removeEventListener(openActivityEvent, activity);
    window.removeEventListener(openNotificationsEvent, notifications);
  });

  it("offers no Sign out where it could not do it", () => {
    const { dialog, input } = open();
    fireEvent.change(input, { target: { value: "sign out" } });
    expect(within(dialog).queryByRole("option", { name: /^Sign out/ })).toBeNull();
  });

  it("opens a feature's page at its tab", () => {
    const { input, onNavigate } = open();
    fireEvent.change(input, { target: { value: "fail2ban" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith("firewall", { app: undefined, tab: "bans" });
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

const feedJob = (id: string, state: string, title: string, createdAt: string, extra: Partial<Job> = {}): Job => ({ id, type: "op:app.backup", title, state, risk: "low", error: null, result: null, steps: [], approvals: [], createdAt, parameters: { id }, ...extra });

describe("the command bar with nothing typed (M36)", () => {
  it("suggests the approvals waiting, the failure nobody has dealt with, and the updates ready, above the pages", async () => {
    act(() => publishWaiting([
      feedJob("w1", "awaiting_approval", "Install updates", "2026-10-18T09:03:00Z"),
      feedJob("w2", "awaiting_approval", "Reboot the server", "2026-10-18T09:02:00Z"),
      feedJob("f2", "failed", "Back up Immich", "2026-10-18T09:01:00Z"),
      feedJob("f1", "failed", "Back up Jellyfin", "2026-10-18T08:00:00Z"),
    ]));
    const { dialog } = open(undefined, "owner");
    const suggested = await within(dialog).findByRole("group", { name: "Suggested" });
    await within(suggested).findByRole("option", { name: /Update Jellyfin/ });
    expect(within(suggested).getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("Review 2 jobs waiting for approval"),
      expect.stringContaining("Failed: Back up Immich"),
      expect.stringContaining("Update Jellyfin"),
    ]);
    // The pages follow, as before.
    expect(within(dialog).getByRole("group", { name: "Pages" })).toBeTruthy();
  });

  it("opens Activity at the failure, and Today for the approvals", () => {
    act(() => publishWaiting([feedJob("f1", "failed", "Back up Jellyfin", "2026-10-18T08:00:00Z")]));
    const opened: Array<string | null> = [];
    const listen = (event: Event) => opened.push((event as CustomEvent<{ jobId: string | null }>).detail.jobId);
    window.addEventListener(openActivityEvent, listen);
    try {
      const { dialog, input } = open();
      expect(within(dialog).getAllByRole("option")[0].textContent).toContain("Failed: Back up Jellyfin");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(opened).toEqual(["f1"]);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      window.removeEventListener(openActivityEvent, listen);
    }
    cleanup();
    act(() => publishWaiting([feedJob("w1", "awaiting_approval", "Install updates", "2026-10-18T09:03:00Z")]));
    const { input, onNavigate } = open();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavigate.mock.calls[0][0]).toBe("today");
  });

  it("does not suggest a failure that was run again since, and suggests nothing once something is typed", () => {
    const failed = feedJob("f1", "failed", "Back up Jellyfin", "2026-10-18T08:00:00Z", { parameters: { id: "jellyfin" } });
    const again = feedJob("r1", "completed", "Back up Jellyfin", "2026-10-18T08:30:00Z", { parameters: { id: "jellyfin" } });
    expect(suggestedCommands({ waiting: 0, failure: null, actions: [] })).toEqual([]);
    act(() => publishWaiting([again, failed]));
    const { dialog, input } = open();
    expect(within(dialog).queryByRole("group", { name: "Suggested" })).toBeNull();
    act(() => publishWaiting([failed]));
    expect(within(dialog).getByRole("group", { name: "Suggested" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "jelly" } });
    expect(within(dialog).queryByRole("group", { name: "Suggested" })).toBeNull();
  });

  it("goes back to the top when a suggestion arrives under the highlight", () => {
    act(() => publishWaiting([feedJob("f1", "failed", "Back up Jellyfin", "2026-10-18T08:00:00Z")]));
    const { dialog, input } = open();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(within(dialog).getAllByRole("option")[1].id);
    act(() => publishWaiting([feedJob("w1", "awaiting_approval", "Install updates", "2026-10-18T09:03:00Z"), feedJob("f1", "failed", "Back up Jellyfin", "2026-10-18T08:00:00Z")]));
    expect(input.getAttribute("aria-activedescendant")).toBe(within(dialog).getAllByRole("option")[0].id);
  });
});
