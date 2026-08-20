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
    expect(screen.getByText("Recent jobs")).toBeTruthy();
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
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/jobs/11111111-1111-4111-8111-111111111111/output");
  });
});
