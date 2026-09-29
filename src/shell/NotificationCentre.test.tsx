import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openActivityEvent, openNotifications } from "../activityEvents";
import { NotificationCentre, destinationOf, deliveryOf, type NotificationEntry, type NotificationList } from "./NotificationCentre";

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

function mount() {
  const posted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "/api/v1/notifications/seen" && init?.method === "POST") { posted.push(url); return json({ seenAt: "2026-09-29T09:00:00.000Z" }); }
    if (url === "/api/v1/notifications") return json(list);
    return json({ error: `unexpected ${url}` }, 500);
  }));
  const onNavigate = vi.fn();
  render(<NotificationCentre csrfToken="csrf" onNavigate={onNavigate} />);
  return { posted, onNavigate };
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
    expect(within(panel).getByText("Not sent: no target set")).toBeTruthy();
    expect(within(panel).getAllByText("New")).toHaveLength(2);
    expect(within(panel).getByText(/No notification target is set/)).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Open Storage" }));
    expect(onNavigate).toHaveBeenCalledWith("storage");
    window.removeEventListener(openActivityEvent, listener);
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
    expect(deliveryOf(entry({ delivered: true }))).toEqual({ status: "good", words: "Sent" });
  });
});
