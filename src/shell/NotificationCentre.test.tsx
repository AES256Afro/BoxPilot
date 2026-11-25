import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openActivityEvent, openNotifications } from "../activityEvents";
import { NotificationCentre, destinationOf, deliveryOf, foldEntries, needsALook, type NotificationEntry, type NotificationList } from "./NotificationCentre";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const entry = (overrides: Partial<NotificationEntry>): NotificationEntry => ({
  id: "n", kind: "alert", key: "storage.root.full", family: "storage.root.full", title: "Root disk is 91% full", message: "Free space on / is running out.",
  at: "2026-09-29T08:00:00.000Z", delivered: true, reason: null, deliveredAt: "2026-09-29T08:00:00.000Z", resolvedAt: null, live: true, ...overrides,
});

const list: NotificationList = {
  seenAt: "2026-09-29T07:00:00.000Z", unseen: 2, targetConfigured: false,
  entries: [
    entry({ id: "a" }),
    entry({ id: "b", kind: "job", key: "job.failed:job-7", family: "job.failed", title: "Back up application data failed", message: "tar failed", delivered: false, reason: "failed", live: false }),
    entry({ id: "c", kind: "notice", key: "release.available", family: "release.available", title: "BoxPilot v1.139.0 is out", at: "2026-09-28T08:00:00.000Z", delivered: false, reason: "no-target", live: false }),
  ],
};

function mount(served: NotificationList = list) {
  const posted: string[] = [];
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "/api/v1/notifications/seen" && init?.method === "POST") { posted.push(url); bodies.push(typeof init.body === "string" ? JSON.parse(init.body) : null); return json({ seenAt: "2026-09-29T09:00:00.000Z" }); }
    if (url === "/api/v1/notifications") return json(served);
    return json({ error: `unexpected ${url}` }, 500);
  }));
  const onNavigate = vi.fn();
  render(<NotificationCentre csrfToken="csrf" onNavigate={onNavigate} />);
  return { posted, bodies, onNavigate };
}

describe("the notification centre (M36)", () => {
  it("counts what is new on the bell, and lists what was said, when, and whether it arrived", async () => {
    mount();
    const bell = await screen.findByRole("button", { name: "Notifications, 2 new" });
    fireEvent.click(bell);
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    expect(await within(panel).findByText("Root disk is 91% full")).toBeTruthy();
    expect(within(panel).getByText("Still going")).toBeTruthy();
    expect(within(panel).getByText("Sending failed")).toBeTruthy();
    expect(within(panel).getAllByText("New")).toHaveLength(2);
    // It opens on what needs a look: the release note that was only never sent is under Everything.
    expect(within(panel).getByRole("radio", { name: /Needs a look/ }).getAttribute("aria-checked")).toBe("true");
    expect(within(panel).queryByText("Not sent: no target set")).toBeNull();
    fireEvent.click(within(panel).getByRole("radio", { name: /Everything/ }));
    expect(within(panel).getByText("Not sent: no target set")).toBeTruthy();
    expect(within(panel).getByText(/No notification target is set/)).toBeTruthy();
  });

  it("opens on Everything when nothing needs a look, and folds the same thing said several times into one row", async () => {
    const backup = (id: string, at: string) => entry({ id, kind: "notice", key: `backup.done:${id}`, family: "backup.done", title: "Backed up Vaultwarden", message: null, at, live: false });
    const routine: NotificationList = {
      seenAt: "2026-09-29T00:00:00.000Z", unseen: 1, targetConfigured: true,
      entries: [backup("b6", "2026-09-29T03:47:00.000Z"), backup("b5", "2026-09-28T03:47:00.000Z"), backup("b4", "2026-09-27T03:47:00.000Z"), entry({ id: "r", kind: "notice", key: "release.available", family: "release.available", title: "BoxPilot v1.139.0 is out", at: "2026-09-26T08:00:00.000Z", live: false }), backup("b3", "2026-09-25T03:47:00.000Z")],
    };
    expect(routine.entries.filter(needsALook)).toEqual([]);
    expect(foldEntries(routine.entries).map((run) => run.map((each) => each.id))).toEqual([["b6", "b5", "b4"], ["r"], ["b3"]]);
    mount(routine);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 1 new" }));
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    await within(panel).findByText("BoxPilot v1.139.0 is out");
    expect(within(panel).getByRole("radio", { name: /Everything/ }).getAttribute("aria-checked")).toBe("true");
    const rows = within(panel).getByRole("list", { name: "What BoxPilot told you" });
    expect(within(rows).getAllByText("Backed up Vaultwarden")).toHaveLength(2);
    expect(rows.textContent).toContain("3 times, latest");
    expect(within(rows).getByText("1 new")).toBeTruthy();
    fireEvent.click(within(rows).getByRole("button", { name: "Show all 3" }));
    expect(within(within(rows).getByRole("list", { name: "Backed up Vaultwarden, each time" })).getAllByRole("listitem")).toHaveLength(3);
    // Nothing needs a look: said, with the way back.
    fireEvent.click(within(panel).getByRole("radio", { name: /Needs a look/ }));
    expect(within(panel).getByText("Nothing needs a look")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Show everything" }));
    expect(within(panel).getByText("BoxPilot v1.139.0 is out")).toBeTruthy();
  });

  it("marks everything seen, and nothing else", async () => {
    const { posted } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 2 new" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark all seen" }));
    await waitFor(() => expect(posted).toEqual(["/api/v1/notifications/seen"]));
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByText("New")).toBeNull();
  });

  it("goes to the page an entry is about, or to its job in Activity", async () => {
    const { onNavigate } = mount();
    const opened: Array<string | null> = [];
    const listener = (event: Event) => opened.push((event as CustomEvent<{ jobId: string | null }>).detail.jobId);
    window.addEventListener(openActivityEvent, listener);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 2 new" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open in Activity" }));
    expect(opened).toEqual(["job-7"]);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 2 new" }));
    // A full root disk opens where its message says: System, Housekeeping (M88; it used to open Storage).
    fireEvent.click(await screen.findByRole("button", { name: "Open Housekeeping" }));
    expect(onNavigate).toHaveBeenCalledWith("system", { tab: "housekeeping" });
    window.removeEventListener(openActivityEvent, listener);
  });

  it("sends the owner to Settings' Notifications tab to set a target (M33.13)", async () => {
    const { onNavigate } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 2 new" }));
    fireEvent.click(await screen.findByRole("button", { name: "Set one in Settings" }));
    expect(onNavigate).toHaveBeenCalledWith("settings", { tab: "notifications" });
    expect(destinationOf(entry({ family: "report.weekly", key: "report.weekly" }))).toMatchObject({ view: "settings", tab: "notifications" });
  });

  it("opens when Home's 'could not tell you' item asks for it", async () => {
    mount();
    await screen.findByRole("button", { name: "Notifications, 2 new" });
    act(() => openNotifications());
    expect(await screen.findByRole("dialog", { name: "Notifications" })).toBeTruthy();
  });

  it("closes on Escape and holds the keyboard while open", async () => {
    mount();
    const bell = await screen.findByRole("button", { name: "Notifications, 2 new" });
    bell.focus();
    fireEvent.click(bell);
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Notifications" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names where each kind of entry leads, and never a job it cannot name", () => {
    expect(destinationOf(entry({ family: "job.failed", key: "job.failed" }))).toEqual({ kind: "activity", jobId: null, label: "Open in Activity" });
    expect(destinationOf(entry({ family: "approval.lapsed", key: "approval.lapsed:j9" }))).toMatchObject({ kind: "activity", jobId: "j9" });
    expect(destinationOf(entry({ family: "schedule.failed", key: "schedule.failed:s1" }))).toMatchObject({ kind: "view", view: "system" });
    expect(destinationOf(entry({ family: "signin.new", key: "signin.new" }))).toMatchObject({ kind: "view", view: "settings" });
    // BoxPilot's own restart that gave up or failed is made from Services (sweep 5).
    expect(destinationOf(entry({ family: "boxpilot.restart", key: "boxpilot.restart" }))).toEqual({ kind: "view", view: "services", label: "Open Services" });
    expect(deliveryOf(entry({ delivered: true }))).toEqual({ status: "good", words: "Sent" });
  });

  it("sends an alert where Home sends it, and where its message says (M88)", () => {
    expect(destinationOf(entry({ family: "storage.mount.detached", key: "storage.mount.detached:/mnt/media" }))).toEqual({ kind: "view", view: "repairs", label: "Open Repair" });
    expect(destinationOf(entry({ family: "schedule.overdue", key: "schedule.overdue:s1" }))).toEqual({ kind: "view", view: "automations", tab: "schedules", label: "Open Schedules" });
    expect(destinationOf(entry({ family: "hosted.down", key: "hosted.down:news.example.com" }))).toEqual({ kind: "view", view: "hosted", label: "Open Hosted domains" });
    expect(destinationOf(entry({ kind: "notice", family: "agent.important", key: "agent.important:a1" }))).toEqual({ kind: "view", view: "agents", label: "Open Agents" });
  });

  it("lets a failed job go from Needs a look once the server says it was dealt with (M88)", () => {
    const failed = entry({ kind: "job", key: "job.failed:j1", family: "job.failed", live: false });
    expect(needsALook(failed)).toBe(true);
    expect(needsALook({ ...failed, settled: false })).toBe(true);
    expect(needsALook({ ...failed, settled: true })).toBe(false);
    expect(needsALook({ ...failed, family: "job.interrupted", key: "job.interrupted:j1", settled: true })).toBe(false);
  });

  it("marks what it showed as seen when closed after being read, and not after a glance (M88)", async () => {
    let clock = Date.parse("2026-09-29T09:00:00.000Z");
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const { posted } = mount();
      const bell = await screen.findByRole("button", { name: "Notifications, 2 new" });
      // Opened and closed at once: nothing is marked.
      fireEvent.click(bell);
      await screen.findByText("Root disk is 91% full");
      fireEvent.click(bell);
      expect(posted).toEqual([]);
      // Open for a few seconds, then closed with Escape: read, so seen.
      fireEvent.click(bell);
      await screen.findByText("Root disk is 91% full");
      clock += 3_000;
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(posted).toEqual(["/api/v1/notifications/seen"]));
      expect(await screen.findByRole("button", { name: "Notifications" })).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  // M88 review: closing marked everything seen, including what arrived after the list was read.
  it("marks seen only up to the newest entry it showed", async () => {
    let clock = Date.parse("2026-09-29T09:00:00.000Z");
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      // The entries out of order, so the newest is found rather than taken from the top.
      const shown: NotificationList = { ...list, entries: [list.entries[2], entry({ id: "late", at: "2026-09-29T08:30:00.000Z" }), list.entries[0]] };
      const { bodies } = mount(shown);
      const bell = await screen.findByRole("button", { name: "Notifications, 2 new" });
      fireEvent.click(bell);
      await screen.findAllByText("Root disk is 91% full");
      clock += 3_000;
      fireEvent.click(bell);
      await waitFor(() => expect(bodies).toEqual([{ upTo: "2026-09-29T08:30:00.000Z" }]));
      // "Mark all seen" marks what the list showed too.
      fireEvent.click(bell);
      fireEvent.click(await screen.findByRole("button", { name: "Mark all seen" }));
      await waitFor(() => expect(bodies).toHaveLength(2));
      expect(bodies[1]).toEqual({ upTo: "2026-09-29T08:30:00.000Z" });
    } finally {
      spy.mockRestore();
    }
  });

  it("says the last hundred, not thirty days, when the history is full (M88)", async () => {
    const full: NotificationList = { seenAt: "2026-09-29T09:00:00.000Z", unseen: 0, targetConfigured: true,
      entries: Array.from({ length: 100 }, (_, index) => entry({ id: `r${index}`, kind: "notice", key: `release.available:${index}`, family: "release.available", title: `Release ${index}`, live: false, at: "2026-09-29T08:00:00.000Z" })) };
    mount(full);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    await within(panel).findByText("Release 0");
    expect(panel.textContent).toContain("The last 100");
    expect(panel.textContent).not.toContain("thirty days");
    fireEvent.click(within(panel).getByRole("radio", { name: /Needs a look/ }));
    expect(panel.textContent).toContain("Among the last 100 notifications");
  });
});
