import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { ago, busier, stubFetch } from "../../home/testData";
import { resetConnection } from "../../pwa/connection";
import { readLastKnown, saveLastKnown } from "../../pwa/lastKnown";
import { requestRefresh } from "../../shell/refresh";
import TodayPage from "./TodayPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetConnection(); window.localStorage.clear(); });

const ran = {
  "/api/v1/jobs?limit=100": { jobs: [
    { id: "nightly", type: "op:app.backup", title: "Back up application data", state: "completed", risk: "medium", error: null, result: null, steps: [], approvals: [], parameters: { id: "jellyfin" }, createdAt: ago(0.5), updatedAt: ago(0.4) },
    { id: "update", type: "op:app.update", title: "Update an app", state: "failed", risk: "medium", error: "pull failed", result: null, steps: [], approvals: [], parameters: { id: "immich" }, createdAt: ago(0.3), updatedAt: ago(0.2) },
  ] },
};

function renderToday({ role = "owner", accountId = "owner-1" }: { role?: string; accountId?: string | null } = {}) {
  const onNavigate = vi.fn();
  render(<FactsProvider><TodayPage csrfToken="csrf" role={role} accountId={accountId} onNavigate={onNavigate} /></FactsProvider>);
  return onNavigate;
}

describe("Today (M25.3)", () => {
  it("leads with the approvals waiting, each opening the ordinary approval dialog at its own tier", async () => {
    const fetch = stubFetch({ ...busier, ...ran, "/api/v1/jobs/wait1": { job: { id: "wait1", type: "op:storage.remount", title: "Reconnect a drive", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [], parameters: { name: "media" }, createdAt: ago(0.3) } }, "/api/v1/jobs/wait1/approval": { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", confirmText: null } });
    vi.stubGlobal("fetch", fetch);
    renderToday();
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeTruthy();
    const approvals = await screen.findByRole("region", { name: /Waiting for approval/ });
    const review = await within(approvals).findByRole("button", { name: "Review: Waiting for approval: Reconnect a drive" });
    expect(review.getAttribute("data-risk")).toBe("medium");
    // The panels come in the order a phone reads them: approvals first.
    const regions = screen.getAllByRole("region").map((region) => region.getAttribute("aria-labelledby") ? region.querySelector("h2")?.textContent : region.getAttribute("aria-label"));
    expect(regions[0]).toMatch(/^Waiting for approval/);
    fireEvent.click(review);
    // The same dialog as everywhere, for the job already staged: nothing new is staged.
    const dialog = await screen.findByRole("dialog", { name: "Reconnect a drive" });
    expect(await within(dialog).findByText("Medium risk")).toBeTruthy();
    expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith("/jobs") && (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("says what ran overnight, failures first, and what else needs a look", async () => {
    vi.stubGlobal("fetch", stubFetch({ ...busier, ...ran }));
    renderToday();
    const what = await screen.findByRole("region", { name: /What ran/ });
    const updates = await within(what).findByRole("region", { name: "Updates" });
    expect(within(updates).getByRole("button", { name: /Update an app.*immich.*Failed/ })).toBeTruthy();
    expect(within(what).getByRole("region", { name: "Backups" }).textContent).toContain("jellyfin");
    const attention = screen.getByRole("region", { name: /Needs a look/ });
    expect(await within(attention).findByText(/Vaultwarden is not running/)).toBeTruthy();
    // A job still waiting for a person is an approval, not something that ran.
    expect(within(what).queryByText("Reconnect a drive")).toBeNull();
  });

  it("draws the backups the way Home does", async () => {
    vi.stubGlobal("fetch", stubFetch({ ...ran }));
    const onNavigate = renderToday();
    const backups = await screen.findByRole("region", { name: "Off this server" });
    const offBox = await within(backups).findByRole("button", { name: /Off this server/ });
    fireEvent.click(offBox);
    expect(onNavigate).toHaveBeenCalledWith("backups");
    expect(within(backups).getByRole("button", { name: /BoxPilot's database/ }).textContent).toContain("3 hours ago");
  });

  it("keeps what it showed for this account, and shows it marked not live, with no buttons, when BoxPilot cannot be reached", async () => {
    vi.stubGlobal("fetch", stubFetch({ ...busier, ...ran }));
    renderToday({ accountId: "owner-1" });
    await screen.findByRole("button", { name: "Review: Waiting for approval: Reconnect a drive" });
    await vi.waitFor(() => expect(readLastKnown("owner-1", "today")?.value).toBeTruthy());
    const kept = JSON.stringify(readLastKnown("owner-1", "today")?.value);
    expect(kept).toContain("Reconnect a drive");
    // The copy carries no way to act: no staged job's id, no operation's parameters.
    expect(kept).not.toContain("existingJobId");
    cleanup();

    resetConnection({ online: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    renderToday({ accountId: "owner-1" });
    expect(screen.getAllByText("Not live").length).toBeGreaterThan(0);
    expect(screen.getByText(/This is what BoxPilot said at/)).toBeTruthy();
    const approvals = screen.getByRole("region", { name: /Waiting for approval/ });
    expect(within(approvals).getByText(/Reconnect a drive/)).toBeTruthy();
    expect(within(approvals).queryByRole("button", { name: /^Review/ })).toBeNull();
  });

  it("never shows one account what another account kept", () => {
    saveLastKnown("someone-else", "today", { verdict: { status: "good", label: "Healthy", sentence: "their server" } });
    resetConnection({ online: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    renderToday({ accountId: "owner-1" });
    expect(screen.queryByText("their server")).toBeNull();
    expect(screen.queryByText(/This is what BoxPilot said at/)).toBeNull();
  });

  it("reads everything again from the bar's Refresh, in place", async () => {
    const fetch = stubFetch({ ...ran });
    vi.stubGlobal("fetch", fetch);
    renderToday();
    await screen.findByRole("region", { name: /What ran/ });
    const before = fetch.mock.calls.filter(([url]) => String(url) === "/api/v1/jobs?limit=100").length;
    const reload = vi.fn();
    expect(requestRefresh({ reload })).toBe("refreshed");
    expect(reload).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url) === "/api/v1/jobs?limit=100").length).toBeGreaterThan(before));
  });
});

