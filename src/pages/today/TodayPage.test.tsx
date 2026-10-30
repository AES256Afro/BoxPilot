import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsProvider } from "../../home/facts";
import { ago, answers, busier, stubFetch } from "../../home/testData";
import { resetConnection } from "../../pwa/connection";
import { readLastKnown, saveLastKnown } from "../../pwa/lastKnown";
import { requestRefresh } from "../../shell/refresh";
import TodayPage from "./TodayPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetConnection(); window.localStorage.clear(); });

const ran = {
  "/api/v1/jobs?limit=100&view=summary": { jobs: [
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

  it("opens the page a need's fix is on, as Home and Ops do", async () => {
    // Today never handed the needs a way to navigate: Free up space, Open Repair and the rest did nothing.
    const full = { id: "full", type: "op:app.update", title: "Update an app", state: "failed", risk: "medium", error: "pull failed: no space left on device", result: null, steps: [], approvals: [], parameters: { id: "immich" }, createdAt: ago(0.3), updatedAt: ago(0.2) };
    vi.stubGlobal("fetch", stubFetch({ "/api/v1/jobs?limit=50": { jobs: [full] }, "/api/v1/jobs?limit=100&view=summary": { jobs: [full] } }));
    const onNavigate = renderToday();
    const attention = await screen.findByRole("region", { name: /Needs a look/ });
    fireEvent.click(await within(attention).findByRole("button", { name: /^Free up space:/ }));
    expect(onNavigate).toHaveBeenCalledWith("system", { tab: "housekeeping" });
  });

  it("draws the backups the way Home does", async () => {
    vi.stubGlobal("fetch", stubFetch({ ...ran }));
    const onNavigate = renderToday();
    // The panel is "Backups" (M49): it held the database tile too, which is not off this server.
    const backups = await screen.findByRole("region", { name: "Backups" });
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

  it("draws a card for an app the server reads (M51), from what the server sent, each figure opening the app", async () => {
    const summary = answers["/api/v1/catalog?view=summary"] as { host: unknown; liveError: null; applications: unknown[] };
    const catalog = { ...summary, applications: [...summary.applications, { manifest: { id: "baselinewatch", name: "BaselineWatch", icon: "🛡️", category: "Monitoring" }, live: { installed: true, container: { running: true, status: "running", health: "healthy" }, urls: [{ host: 8790, exposure: "lan", path: "/login" }] } }] };
    const glance = {
      app: "baselinewatch", name: "BaselineWatch", title: "Baselines and threats", window: "since yesterday", url: { host: 8790, exposure: "lan", path: "/login" },
      running: true, available: true, reason: null, since: ago(24), readAt: ago(0), digest: { period: "daily", generatedAt: ago(2) },
      metrics: [
        { id: "kev", label: "KEV additions", value: 4, caption: "known exploited", status: "danger", path: "/wire?kind=kev" },
        { id: "watched", label: "Watched CVEs changed", value: 0, caption: "on your watchlist", status: "neutral", path: "/vulns?watch=1" },
        { id: "releases", label: "Standard releases", value: 1, caption: "9 controls changed", status: "warning", path: "/" },
        { id: "affects", label: "Marked affects us", value: 2, caption: "open in triage", status: "warning", path: "/triage?state=affects" },
      ],
    };
    vi.stubGlobal("fetch", stubFetch({ ...ran, "/api/v1/catalog?view=summary": catalog, "/api/v1/apps/glances": { glances: [glance], liveKnown: true } }));
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    renderToday();
    const card = await screen.findByRole("region", { name: /^Baselines and threats/ });
    // The app's root, from the catalog's own link (which lands on its sign-in page), not the sign-in page.
    const link = await within(card).findByRole("link", { name: "Open BaselineWatch" });
    await vi.waitFor(() => expect(link.getAttribute("href")).toBe("http://192.0.2.10:8790"));
    expect(card.querySelector("h2")?.textContent).toContain("7 to look at");
    const kev = within(card).getByRole("button", { name: /KEV additions/ });
    expect(kev.textContent).toContain("4");
    fireEvent.click(kev);
    expect(opened).toHaveBeenCalledWith("http://192.0.2.10:8790/wire?kind=kev", "_blank", "noopener");
    expect(within(card).getByText(/Digest written 2 hours ago/)).toBeTruthy();
    // The card says why when the app could not be read, and the page has no such card when no installed app has a reader.
    cleanup();
    vi.stubGlobal("fetch", stubFetch({ ...ran, "/api/v1/apps/glances": { glances: [{ ...glance, available: false, reason: "BaselineWatch is not running.", metrics: [] }], liveKnown: true } }));
    renderToday();
    expect((await screen.findByRole("region", { name: /^Baselines and threats/ })).textContent).toContain("BaselineWatch is not running.");
    cleanup();
    vi.stubGlobal("fetch", stubFetch({ ...ran, "/api/v1/apps/glances": { glances: [], liveKnown: true } }));
    renderToday();
    await screen.findByRole("region", { name: /What ran/ });
    expect(screen.queryByRole("region", { name: /^Baselines and threats/ })).toBeNull();
  });

  it("reads everything again from the bar's Refresh, in place", async () => {
    const fetch = stubFetch({ ...ran });
    vi.stubGlobal("fetch", fetch);
    renderToday();
    await screen.findByRole("region", { name: /What ran/ });
    const before = fetch.mock.calls.filter(([url]) => String(url) === "/api/v1/jobs?limit=100&view=summary").length;
    const reload = vi.fn();
    expect(requestRefresh({ reload })).toBe("refreshed");
    expect(reload).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url) === "/api/v1/jobs?limit=100&view=summary").length).toBeGreaterThan(before));
  });
});

