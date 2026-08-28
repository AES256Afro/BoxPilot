import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SchedulesPanel from "./SchedulesPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const schedule = {
  id: "s1", operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "daily", minute: 0, hour: 3, weekday: null,
  enabled: true, nextDueAt: "2026-08-21T03:00:00.000Z", lastRunAt: "2026-08-20T03:00:05.000Z", lastJobId: "j1", lastResult: "started",
  title: "Back up application data", cadence: "daily at 03:00",
};

describe("Schedules panel", () => {
  it("lists schedules and creates a nightly app backup", async () => {
    let created: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/schedules") && init?.method === "POST") { created = init.body as string; return json({ schedule }, 201); }
      if (url.endsWith("/api/v1/schedules")) return json({ schedules: [schedule] });
      if (url.endsWith("/api/v1/catalog")) return json({ applications: [{ manifest: { id: "jellyfin", name: "Jellyfin" }, live: { installed: true } }], host: {} });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SchedulesPanel csrfToken="csrf-token" />);

    expect(await screen.findByText("daily at 03:00")).toBeTruthy();
    expect(screen.getByText(/^ran /)).toBeTruthy();

    fireEvent.change(await screen.findByLabelText("Scheduled action"), { target: { value: "backup:jellyfin" } });
    fireEvent.change(screen.getByLabelText("Time of day"), { target: { value: "02:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    await screen.findByText("daily at 03:00"); // refreshed
    expect(JSON.parse(created ?? "{}")).toEqual({ operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "daily", minute: 30, hour: 2, weekday: null });
  });

  it("shows the approval-mode skip clearly", async () => {
    const blocked = { ...schedule, id: "s2", lastResult: "blocked-by-approval-mode" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/schedules")) return json({ schedules: [blocked] });
      if (url.endsWith("/api/v1/catalog")) return json({ applications: [], host: {} });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SchedulesPanel csrfToken="csrf-token" />);
    expect(await screen.findByText("skipped: Always-ask approvals")).toBeTruthy();
  });

  it("marks an overdue schedule as behind", async () => {
    const overdue = { ...schedule, id: "s3", overdue: true };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/schedules")) return json({ schedules: [overdue] });
      if (url.endsWith("/api/v1/catalog")) return json({ applications: [], host: {} });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SchedulesPanel csrfToken="csrf-token" />);
    expect(await screen.findByText("behind")).toBeTruthy();
  });

});
