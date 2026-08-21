import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SetupWizard from "./SetupWizard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const setupState = {
  firstRun: true, installedApps: 0,
  profiles: [{
    id: "home-server", name: "Home server", icon: "🏠", description: "Media and monitoring.", remaining: 2, blocked: 0,
    steps: [
      { id: "prerequisite-docker", kind: "prerequisite", title: "Install Docker Engine", status: "done", detail: "installed 28.0.0-1", job: null },
      { id: "app-jellyfin", kind: "app", title: "Install Jellyfin", status: "ready", detail: "with default settings", job: { operationId: "app.install", parameters: { id: "jellyfin", values: {} } } },
      { id: "schedule-database-backup", kind: "schedule", title: "Back up the database nightly", status: "ready", detail: "daily", job: null, schedule: { operationId: "controller.backup.create", parameters: {}, frequency: "daily", minute: 15, hour: 3, weekday: null } },
    ],
  }],
};

describe("setup wizard", () => {
  it("shows profiles with live state and runs the remaining steps through jobs and schedules", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      calls.push(`${init?.method ?? "GET"} ${url}${init?.body ? ` ${init.body}` : ""}`);
      if (url.endsWith("/api/v1/setup")) return json(setupState);
      if (url.endsWith("/operations/app.install/jobs")) return json({ job: { id: "job-1" }, approval: { tier: "medium", passwordRequired: false } }, 201);
      if (url.endsWith("/jobs/job-1/approve")) return json({ job: { id: "job-1", state: "applying" } }, 202);
      if (url.endsWith("/jobs/job-1")) return json({ job: { id: "job-1", state: "completed", error: null } });
      if (url.endsWith("/api/v1/schedules")) return json({ schedule: { id: "s1" } }, 201);
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    render(<SetupWizard csrfToken="csrf" onDone={onDone} />);

    fireEvent.click(await screen.findByRole("button", { name: /Home server/ }));
    expect(screen.getByText("installed 28.0.0-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install everything (2)" }));
    expect(await screen.findByText(/All done/)).toBeTruthy();
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
      'POST /api/v1/operations/app.install/jobs {"parameters":{"id":"jellyfin","values":{}}}',
      "POST /api/v1/jobs/job-1/approve {}",
      'POST /api/v1/schedules {"operationId":"controller.backup.create","parameters":{},"frequency":"daily","minute":15,"hour":3,"weekday":null}',
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Go to overview" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("asks for the owner password once when approval demands it, then continues", async () => {
    let approvals = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/setup")) return json(setupState);
      if (url.endsWith("/operations/app.install/jobs")) return json({ job: { id: "job-1" } }, 201);
      if (url.endsWith("/jobs/job-1/approve")) { approvals += 1; const body = JSON.parse(String(init?.body)); return body.password ? json({ job: { id: "job-1" } }, 202) : json({ error: "Approval reauthentication required" }, 401); }
      if (url.endsWith("/jobs/job-1")) return json({ job: { id: "job-1", state: "completed", error: null } });
      if (url.endsWith("/api/v1/schedules")) return json({ schedule: { id: "s1" } }, 201);
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupWizard csrfToken="csrf" onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Home server/ }));
    fireEvent.click(screen.getByRole("button", { name: "Install everything (2)" }));
    const passwordInput = await screen.findByLabelText("Owner password");
    fireEvent.change(passwordInput, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/All done/)).toBeTruthy();
    expect(approvals).toBe(2);
  });
});
