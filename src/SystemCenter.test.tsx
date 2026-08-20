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
