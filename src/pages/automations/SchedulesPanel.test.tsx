import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SchedulesPanel from "./SchedulesPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const schedule = {
  id: "s1", operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "daily", minute: 0, hour: 3, weekday: null,
  enabled: true, nextDueAt: "2026-08-21T03:00:00.000Z", lastRunAt: "2026-08-20T03:00:05.000Z", lastJobId: "j1", lastResult: "completed", lastOutcome: "ran", lastReason: null,
  title: "Back up application data", cadence: "daily at 03:00",
};

const answer = (schedules: unknown[]) => vi.fn(async (input: RequestInfo | URL) => {
  const url = input.toString();
  if (url.endsWith("/api/v1/schedules")) return json({ schedules });
  if (url.includes("/api/v1/catalog")) return json({ applications: [], host: {} });
  return json({ error: `unexpected ${url}` }, 500);
});

describe("Schedules panel", () => {
  it("lists schedules and creates a nightly app backup from its sheet", async () => {
    let created: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/schedules") && init?.method === "POST") { created = init.body as string; return json({ schedule }, 201); }
      if (url.endsWith("/api/v1/schedules")) return json({ schedules: [schedule] });
      if (url.includes("/api/v1/catalog")) return json({ applications: [{ manifest: { id: "jellyfin", name: "Jellyfin" }, live: { installed: true } }], host: {} });
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<SchedulesPanel csrfToken="csrf-token" serverTimezone="Europe/Berlin" />);

    expect(await screen.findByText("daily at 03:00")).toBeTruthy();
    expect(screen.getByText(/^ran /)).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /When \(Europe\/Berlin\)/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add a schedule" }));
    const sheet = await screen.findByRole("dialog", { name: "Run something on its own" });
    await within(sheet).findByRole("option", { name: "Back up Jellyfin" });
    fireEvent.change(within(sheet).getByLabelText("What to run"), { target: { value: "backup:jellyfin" } });
    fireEvent.change(within(sheet).getByLabelText("Time of day"), { target: { value: "02:30" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Add schedule" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.parse(created ?? "{}")).toEqual({ operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "daily", minute: 30, hour: 2, weekday: null });
  });

  it("shows the approval-mode skip clearly", async () => {
    const blocked = { ...schedule, id: "s2", lastResult: "blocked-by-approval-mode", lastOutcome: "did-not-run", lastReason: "Approvals are set to always ask" };
    vi.stubGlobal("fetch", answer([blocked]));
    render(<SchedulesPanel csrfToken="csrf-token" />);
    expect(await screen.findByText("did not run: Always-ask approvals")).toBeTruthy();
    // Not a dead end: the row says what stops it and where that is changed.
    expect(screen.getByText("Schedules are skipped while approvals always ask for the password. Change that in Settings, under Approvals.")).toBeTruthy();
    // Each row's buttons say which schedule they act on.
    expect(screen.getByRole("button", { name: "Pause Back up application data" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete the schedule: Back up application data" })).toBeTruthy();
  });

  it("shows a run whose job failed as failed, and one that could not start as did not run (M27.2)", async () => {
    // Starting the job used to be all the panel knew, so this backup read "ran" all week.
    const failed = { ...schedule, id: "s4", title: "Back up application data", lastResult: "failed: tar failed: disk full", lastOutcome: "failed", lastReason: "tar failed: disk full" };
    const refused = { ...schedule, id: "s5", title: "Refresh package lists", parameters: {}, lastResult: "error: previous run still active", lastOutcome: "did-not-run", lastReason: "previous run still active" };
    const running = { ...schedule, id: "s6", title: "Clean up Docker disk space", parameters: {}, lastResult: "started", lastOutcome: "running", lastReason: null };
    vi.stubGlobal("fetch", answer([failed, refused, running]));
    render(<SchedulesPanel csrfToken="csrf-token" />);
    expect(await screen.findByText(/^failed /)).toBeTruthy();
    expect(screen.getByText("tar failed: disk full")).toBeTruthy();
    expect(screen.getByText(/^did not run /)).toBeTruthy();
    expect(screen.getByText("previous run still active")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.queryByText(/^ran /)).toBeNull();
    expect(screen.getByText(/^failed /).closest("tr")?.getAttribute("data-status")).toBe("danger");
  });

  it("marks an overdue schedule as behind", async () => {
    vi.stubGlobal("fetch", answer([{ ...schedule, id: "s3", overdue: true }]));
    render(<SchedulesPanel csrfToken="csrf-token" />);
    expect(await screen.findByText("behind")).toBeTruthy();
    expect(screen.getByText("behind").closest("tr")?.getAttribute("data-status")).toBe("warning");
  });

  it("opens the last run's log in a sheet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/schedules")) return json({ schedules: [schedule] });
      if (url.endsWith("/api/v1/jobs/j1")) return json({ job: { id: "j1", type: "op:app.backup", title: "Back up", state: "completed", risk: "medium", error: null, result: null, createdAt: "x", updatedAt: "x", steps: [], approvals: [] } });
      if (url.endsWith("/api/v1/jobs/j1/output")) return json({ output: "archive written" });
      return json({ applications: [] });
    }));
    render(<SchedulesPanel csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "View log: Back up application data" }));
    const sheet = await screen.findByRole("dialog", { name: "Back up application data" });
    expect(await within(sheet).findByText("archive written")).toBeTruthy();
  });
});
