import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SchedulesPanel from "./SchedulesPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const schedule = {
  id: "s1", operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "daily", minute: 0, hour: 3, weekday: null,
  enabled: true, nextDueAt: "2026-08-21T03:00:00.000Z", lastRunAt: "2026-08-20T03:00:05.000Z", lastJobId: "j1", lastResult: "completed", lastOutcome: "ran", lastReason: null,
  title: "Back up application data", cadence: "daily at 03:00",
};

describe("Schedules panel", () => {
  it("lists schedules and creates a nightly app backup", async () => {
    let created: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/schedules") && init?.method === "POST") { created = init.body as string; return json({ schedule }, 201); }
      if (url.endsWith("/api/v1/schedules")) return json({ schedules: [schedule] });
      if (url.includes("/api/v1/catalog")) return json({ applications: [{ manifest: { id: "jellyfin", name: "Jellyfin" }, live: { installed: true } }], host: {} });
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
    const blocked = { ...schedule, id: "s2", lastResult: "blocked-by-approval-mode", lastOutcome: "did-not-run", lastReason: "Approvals are set to always ask" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/schedules")) return json({ schedules: [blocked] });
      if (url.includes("/api/v1/catalog")) return json({ applications: [], host: {} });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SchedulesPanel csrfToken="csrf-token" />);
    expect(await screen.findByText("did not run: Always-ask approvals")).toBeTruthy();
  });

  it("shows a run whose job failed as failed, and one that could not start as did not run (M27.2)", async () => {
    // Starting the job used to be all the panel knew, so this backup read "ran" all week.
    const failed = { ...schedule, id: "s4", title: "Back up application data", lastResult: "failed: tar failed: disk full", lastOutcome: "failed", lastReason: "tar failed: disk full" };
    const refused = { ...schedule, id: "s5", title: "Refresh package lists", parameters: {}, lastResult: "error: previous run still active", lastOutcome: "did-not-run", lastReason: "previous run still active" };
    const running = { ...schedule, id: "s6", title: "Clean up Docker disk space", parameters: {}, lastResult: "started", lastOutcome: "running", lastReason: null };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/schedules")) return json({ schedules: [failed, refused, running] });
      if (url.includes("/api/v1/catalog")) return json({ applications: [], host: {} });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SchedulesPanel csrfToken="csrf-token" />);
    expect(await screen.findByText(/^failed /)).toBeTruthy();
    expect(screen.getByText("tar failed: disk full")).toBeTruthy();
    expect(screen.getByText(/^did not run /)).toBeTruthy();
    expect(screen.getByText("previous run still active")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.queryByText(/^ran /)).toBeNull();
  });

  it("marks an overdue schedule as behind", async () => {
    const overdue = { ...schedule, id: "s3", overdue: true };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/schedules")) return json({ schedules: [overdue] });
      if (url.includes("/api/v1/catalog")) return json({ applications: [], host: {} });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SchedulesPanel csrfToken="csrf-token" />);
    expect(await screen.findByText("behind")).toBeTruthy();
  });

});
