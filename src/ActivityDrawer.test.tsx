import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ActivityDrawer from "./ActivityDrawer";
import type { Job } from "./operations";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); FakeEventSource.instances.length = 0; });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() { this.closed = true; }
}

function job(overrides: Partial<Job>): Job {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "op:apt.upgrade",
    title: "Upgrade packages",
    state: "applying",
    risk: "medium",
    error: null,
    result: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    steps: [],
    approvals: [],
    ...overrides,
  };
}

describe("Activity drawer", () => {
  it("focuses the drawer and returns to its opener when Escape closes it", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<ActivityDrawer />);
    const opener = screen.getByRole("button", { name: "Activity" }); opener.focus(); fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Activity" }));
    fireEvent.keyDown(document, { key: "Tab" }); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close activity" }));
    fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(opener);
  });

  it("shows a running badge from the snapshot and clears it when the job finishes", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<ActivityDrawer />);
    const source = FakeEventSource.instances.at(-1);
    expect(source?.url).toBe("/api/v1/events");

    act(() => source?.emit("snapshot", { jobs: [job({})] }));
    expect(screen.getByLabelText("1 running").textContent).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    expect(screen.getByText("1 job running")).toBeTruthy();
    expect(screen.getByText("Upgrade packages")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();

    act(() => source?.emit("job", { job: job({ state: "completed" }) }));
    expect(screen.queryByLabelText("1 running")).toBeNull();
    expect(screen.getByText("Latest")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
  });

  it("expands a finished job to its persisted output and step log", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/output")) return json({ jobId: "11111111-1111-4111-8111-111111111111", state: "completed", output: "unpacked 3 packages", live: false });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ActivityDrawer />);
    const source = FakeEventSource.instances.at(-1);
    act(() => source?.emit("snapshot", { jobs: [job({ state: "completed", steps: [{ name: "verify", state: "completed", detail: "Upgrade finished", createdAt: "2026-08-20T10:01:00.000Z" }] })] }));

    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    fireEvent.click(screen.getByRole("button", { name: /Upgrade packages/ }));
    expect(await screen.findByText("unpacked 3 packages")).toBeTruthy();
    expect(screen.getByText(/Upgrade finished/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/jobs/11111111-1111-4111-8111-111111111111/output", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("marks a completed job with notices before its details are opened", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<ActivityDrawer />);
    act(() => FakeEventSource.instances.at(-1)?.emit("snapshot", { jobs: [job({ state: "completed", result: { warnings: ["Local retention needs attention."] } })] }));
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    expect(screen.getByText("Completed with notice").className).toContain("status-warning");
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("distinguishes unread history, failed refresh and a confirmed empty history", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Unavailable" }, 503)));
    render(<ActivityDrawer />);
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    expect(screen.getByText("Reading job history...")).toBeTruthy();
    expect(screen.queryByText(/No jobs are visible/)).toBeNull();
    act(() => FakeEventSource.instances.at(-1)?.onerror?.());
    expect(await screen.findByText(/Job history is unavailable/)).toBeTruthy();
    expect(screen.queryByText(/No jobs are visible/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try refreshing Activity" }));
    act(() => FakeEventSource.instances.at(-1)?.emit("snapshot", { jobs: [] }));
    expect(screen.getByText(/No jobs are visible to this account/)).toBeTruthy();
    expect(screen.queryByText(/Job history is unavailable/)).toBeNull();
  });
});

describe("a job that ran out of time, in Activity (M30.3)", () => {
  const timedOutJob = job({
    id: "22222222-2222-4222-8222-222222222222", type: "op:app.update", title: "Update application", state: "failed",
    error: "Jellyfin update failed before anything was restarted; the app was unchanged. Downloading the new images did not finish within 30 minutes",
    timeout: { scope: "step", budgetMs: 30 * 60_000, elapsedMs: 34 * 60_000, phase: "running", step: "Downloading the new images", lastOutput: "jellyfin Pulling fs layer", moreTimeMs: 80 * 60_000 },
  });
  const failedJob = job({ id: "33333333-3333-4333-8333-333333333333", title: "Install packages", state: "failed", error: "apt-get install failed", timeout: null });
  const api = () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/output")) return json({ jobId: timedOutJob.id, state: "failed", output: "", live: false });
      if (url.endsWith("/more-time") && init?.method === "POST") return json({ job: { ...timedOutJob, id: "44444444-4444-4444-8444-444444444444", state: "awaiting_approval", error: null, timeout: null }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201);
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("is marked timed out rather than failed, and offers more time through the approval dialog", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = api();
    render(<ActivityDrawer csrfToken="csrf" />);
    act(() => FakeEventSource.instances.at(-1)?.emit("snapshot", { jobs: [timedOutJob, failedJob] }));
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    expect(screen.getByText("Timed out").className).toContain("status-warning");
    expect(screen.getByText("Failed").className).toContain("status-danger");

    fireEvent.click(screen.getByRole("button", { name: /Update application/ }));
    expect(screen.getByText("Downloading the new images had 30 minutes and did not finish. The job ran for 34 minutes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again with more time" }));
    expect(await screen.findByRole("button", { name: "Confirm and run" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/jobs/${timedOutJob.id}/more-time`, expect.objectContaining({ method: "POST", headers: { "X-BoxPilot-CSRF": "csrf" } }));
  });

  it("offers nothing for an ordinary failure, or where no approval can be sent", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    api();
    render(<ActivityDrawer />);
    act(() => FakeEventSource.instances.at(-1)?.emit("snapshot", { jobs: [timedOutJob, failedJob] }));
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    fireEvent.click(screen.getByRole("button", { name: /Update application/ }));
    expect(screen.getByText("Ran out of time")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again with more time" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Install packages/ }));
    expect(screen.queryByText("Ran out of time")).toBeNull();
  });
});
