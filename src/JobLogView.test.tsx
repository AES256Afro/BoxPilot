import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobLogView } from "./JobLogView";
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
    id: "22222222-2222-4222-8222-222222222222",
    type: "op:apt.upgrade",
    title: "Install package updates",
    state: "completed",
    risk: "medium",
    error: null,
    result: null,
    createdAt: "2026-08-27T03:00:00.000Z",
    updatedAt: "2026-08-27T03:00:00.000Z",
    steps: [],
    approvals: [],
    ...overrides,
  };
}

describe("the job log, viewable from wherever the action lives", () => {
  it("shows recorded follow-up notices after the live output has been released", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ output: "" })));
    render(<JobLogView job={job({ result: { warnings: ["Old local backups could not be removed.", null, { detail: "not a display string" }] } })} />);
    expect(screen.getByText("Old local backups could not be removed.")).toBeTruthy();
    expect(await screen.findByText("This job recorded no output.")).toBeTruthy();
    expect(screen.queryByText("not a display string")).toBeNull();
  });

  it("says the output could not be opened instead of claiming the job printed nothing (M30.1)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ output: "" })));
    const detail = "BoxPilot could not open this job's output: permission denied (the log folder is mode 700). The job itself ran; its output is not shown here.";
    render(<JobLogView job={job({ steps: [{ name: "log", state: "failed", detail, createdAt: "2026-08-27T03:01:00.000Z" }] })} />);
    expect(await screen.findByText(/BoxPilot could not open this job's output, so none is shown/)).toBeTruthy();
    expect(screen.getByText(/the log folder is mode 700/)).toBeTruthy();
    expect(screen.queryByText("This job recorded no output.")).toBeNull();
  });

  it("given only an id, fetches the job and shows its recorded output and steps", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/output")) return json({ output: "unpacked 4 packages" });
      if (url.includes("/jobs/")) return json({ job: job({ steps: [{ name: "verify", state: "completed", detail: "Upgrade finished", createdAt: "2026-08-27T03:01:00.000Z" }] }) });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<JobLogView jobId="22222222-2222-4222-8222-222222222222" />);
    expect(await screen.findByText("unpacked 4 packages")).toBeTruthy();
    expect(screen.getByText(/Upgrade finished/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/jobs/22222222-2222-4222-8222-222222222222/output", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("says a pruned job is gone rather than showing an empty terminal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "not found" }, 404)));
    render(<JobLogView jobId="33333333-3333-4333-8333-333333333333" title="Refresh package lists" />);
    expect(await screen.findByText(/no longer in the history/)).toBeTruthy();
    expect(screen.getByText(/Refresh package lists/)).toBeTruthy();
  });

  it("shows a retry after an output read fails instead of claiming the log is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error: "unavailable" }, 503)).mockResolvedValueOnce(json({ output: "recovered output" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<JobLogView job={job({})} />);
    expect(await screen.findByText(/Saved output could not be read/)).toBeTruthy();
    expect(screen.queryByText("This job recorded no output.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try reading again" }));
    expect(await screen.findByText("recovered output")).toBeTruthy();
  });

  it("says a job handed in whose output is gone from the history is gone, with no retry that could only fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Job not found", code: "job_not_found" }, 404)));
    render(<JobLogView job={job({ title: "Back up Immich" })} />);
    expect(await screen.findByText(/Back up Immich is no longer in the history/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try reading again" })).toBeNull();
  });

  it("recovers a failed job lookup and clears a prior missing-job state when the id changes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => input.toString().includes("missing") ? json({}, 404) : input.toString().endsWith("/output") ? json({ output: "found" }) : json({ job: job({}) }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<JobLogView jobId="missing" />);
    await screen.findByText(/no longer in the history/);
    rerender(<JobLogView jobId={job({}).id} />);
    expect(await screen.findByText("found")).toBeTruthy();
    expect(screen.queryByText(/no longer in the history/)).toBeNull();
  });

  it("reports a failed initial lookup and aborts an in-flight read on unmount", async () => {
    let observed: AbortSignal | undefined;
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 503)).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      observed = options.signal;
      observed!.addEventListener("abort", () => reject(observed!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<JobLogView jobId={job({}).id} />);
    expect(await screen.findByText(/This job could not be refreshed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try reading again" }));
    await waitFor(() => expect(observed).toBeTruthy());
    unmount(); expect(observed?.aborted).toBe(true);
  });

  it("follows a running job live, replacing on a poll and appending on the stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "no polling in this test" }, 500)));
    render(<JobLogView job={job({ state: "applying" })} />);
    const source = FakeEventSource.instances.at(-1);
    expect(source?.url).toBe("/api/v1/jobs/22222222-2222-4222-8222-222222222222/stream");
    act(() => source?.emit("output", { text: "Reading package lists...\n" }));
    act(() => source?.emit("output", { text: "Unpacking openssl...\n" }));
    // The stream appends fragments; both lines must be present, once each.
    const terminal = screen.getByLabelText("Output for Install package updates");
    expect(terminal.textContent).toBe("Reading package lists...\nUnpacking openssl...\n");
  });

  // M89: Repair's running-fix card says its log is live; one failed read used to freeze it as running.
  it("keeps reading a job opened by id after a failed read, and clears the error once it answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let down = true;
      const id = job({}).id;
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (down) throw new TypeError("Failed to fetch");
        if (url.endsWith("/output")) return json({ output: "all done" });
        return json({ job: job({ id, state: "completed" }) });
      }));
      render(<JobLogView jobId={id} />);
      expect(await screen.findByText(/This job could not be refreshed\. BoxPilot did not answer\./)).toBeTruthy();
      down = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(await screen.findByText("all done")).toBeTruthy();
      expect(screen.queryByText(/could not be refreshed/)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("stops reading a job the server refuses, rather than asking again forever", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      for (const [status, words] of [[401, "Sign in again."], [403, "Only the owner can read this job."]] as const) {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL) => json({ error: words, code: status === 401 ? "authentication_required" : "forbidden" }, status));
        vi.stubGlobal("fetch", fetchMock);
        render(<JobLogView jobId={`refused-${status}`} />);
        expect(await screen.findByText(new RegExp(`This job could not be read\\. ${words.replace(".", "\\.")}`))).toBeTruthy();
        expect(screen.queryByText(/Trying again by itself/)).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(fetchMock.mock.calls.filter(([input]) => !String(input).endsWith("/output"))).toHaveLength(1);
        cleanup();
      }
    } finally { vi.useRealTimers(); }
  });

  it("reads the job again when its output stream says it has ended", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const id = job({}).id;
    let state = "applying";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/output")) return json({ output: "saved log" });
      return json({ job: job({ id, state, error: state === "failed" ? "The install failed" : null }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<JobLogView jobId={id} />);
    await waitFor(() => expect(FakeEventSource.instances.some((source) => source.url.endsWith("/stream"))).toBe(true));
    const reads = () => fetchMock.mock.calls.filter(([url]) => url.toString().endsWith(id)).length;
    const before = reads();
    state = "failed";
    act(() => FakeEventSource.instances.find((source) => source.url.endsWith("/stream"))!.emit("state", { state: "failed", error: "The install failed" }));
    // At once, not at the next two-second poll.
    await act(async () => { await Promise.resolve(); });
    expect(reads()).toBeGreaterThan(before);
    expect(await screen.findByText("The install failed")).toBeTruthy();
  });
});

