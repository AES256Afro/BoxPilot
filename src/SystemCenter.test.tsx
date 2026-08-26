import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SystemCenter from "./SystemCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const settings = {
  hostname: { static: "shiny-box", live: "shiny-box" },
  timezone: "Etc/UTC",
  timezones: ["Etc/UTC", "Europe/Berlin", "America/New_York"],
  swappiness: 60,
  swap: [{ device: "/swap.img", type: "file", sizeKiB: 4194300, usedKiB: 0, priority: -2 }],
  memory: { memTotalKiB: 32768000, memAvailableKiB: 16384000, swapTotalKiB: 4194300, swapFreeKiB: 4194300 },
  fstrim: { active: "active", enabled: "enabled", nextRun: "Mon 2026-08-24 00:00:00 UTC" },
};

describe("System center", () => {
  it("shows live settings and stages a time zone change through the dialog", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/system.settings.inspect/inspect")) return json({ operation: "system.settings.inspect", result: settings });
      if (url.endsWith("/operations/system.timezone.set/jobs")) { staged = init?.body as string; return json({ job: { id: "job-tz", type: "op:system.timezone.set", title: "Change the time zone", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SystemCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("shiny-box")).toBeTruthy();
    expect(screen.getAllByText("Etc/UTC").length).toBeGreaterThan(0);
    const changeButton = screen.getByRole("button", { name: "Change" });
    expect((changeButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/Berlin" } });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { timezone: "Europe/Berlin" } });
  });

  it("offers the newer GitHub release and stages the high-risk update with only the tag", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/system.settings.inspect/inspect")) return json({ operation: "system.settings.inspect", result: settings });
      if (url.endsWith("/api/v1/system/update")) return json({ current: { version: "0.61.0" }, latest: { tag: "v0.62.0", version: "0.62.0", name: "BoxPilot v0.62.0", url: "https://github.com/AES256Afro/BoxPilot/releases/tag/v0.62.0", publishedAt: "2026-08-21T16:00:00Z", prerelease: false, notes: null }, updateAvailable: true, checkedAt: "2026-08-21T16:05:00Z", error: null });
      if (url.endsWith("/operations/system.update.status/inspect")) return json({ operation: "system.update.status", result: { units: [], log: ["[boxpilot-upgrade] BoxPilot 0.61.0 (v0.61.0) is live; 0 unit file(s) updated"], outcome: "live" } });
      if (url.endsWith("/operations/system.update/jobs")) { staged = init?.body as string; return json({ job: { id: "job-up", type: "op:system.update", title: "Update BoxPilot", state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SystemCenter csrfToken="csrf-token" />);

    fireEvent.click(await screen.findByRole("button", { name: "Update to v0.62.0" }));
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByLabelText("Typed confirmation")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { tag: "v0.62.0" } });
    expect(screen.getByText(/Last update log, live/)).toBeTruthy();
  });

  it("offers to enable the trim timer when it is disabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/system.settings.inspect/inspect")) return json({ operation: "system.settings.inspect", result: { ...settings, fstrim: { active: "inactive", enabled: "disabled", nextRun: null } } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SystemCenter csrfToken="csrf-token" />);
    expect(await screen.findByRole("button", { name: "Enable" })).toBeTruthy();
    expect(screen.getByText(/Weekly trim keeps SSDs/)).toBeTruthy();
  });
});
