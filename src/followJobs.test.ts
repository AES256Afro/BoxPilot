import { afterEach, describe, expect, it, vi } from "vitest";
import { followJobs, type Job } from "./operations";

class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, (event: { data: string }) => void>();
  closed = false;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSource.last = this; }
  addEventListener(name: string, handler: (event: { data: string }) => void) { this.listeners.set(name, handler); }
  emit(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
const job = { id: "job-1", title: "Back up database", state: "completed", steps: [], result: null } as unknown as Job;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeSource.last = null; });

describe("Activity history transport", () => {
  it("keeps a valid stream free of polling and cleans up on removal", async () => {
    vi.useFakeTimers(); vi.stubGlobal("EventSource", FakeSource); vi.stubGlobal("fetch", vi.fn());
    const onSnapshot = vi.fn(); const onJob = vi.fn(); const onStatus = vi.fn();
    const stop = followJobs({ onSnapshot, onJob, onStatus });
    const source = FakeSource.last!;
    source.emit("snapshot", { jobs: [job] }); source.emit("job", { job });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).not.toHaveBeenCalled(); expect(onSnapshot).toHaveBeenCalledWith([job]); expect(onJob).toHaveBeenCalledWith(job);
    expect(onStatus).toHaveBeenLastCalledWith("live");
    stop(); expect(source.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("fetches history after a buffered stream and ignores late stream snapshots", async () => {
    vi.useFakeTimers(); vi.stubGlobal("EventSource", FakeSource);
    vi.stubGlobal("fetch", vi.fn(async () => response({ jobs: [job] })));
    const onSnapshot = vi.fn(); const onStatus = vi.fn();
    const stop = followJobs({ onSnapshot, onJob: vi.fn(), onStatus });
    const source = FakeSource.last!;
    await vi.advanceTimersByTimeAsync(2500);
    expect(source.closed).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    source.emit("snapshot", { jobs: [] });
    expect(onSnapshot).toHaveBeenCalledTimes(1); expect(onSnapshot).toHaveBeenLastCalledWith([job]);
    expect(onStatus).toHaveBeenLastCalledWith("polling");
    stop(); await vi.advanceTimersByTimeAsync(30_000); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("recovers malformed or disconnected streams through bounded sequential polling", async () => {
    vi.useFakeTimers(); vi.stubGlobal("EventSource", FakeSource);
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal; signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    })));
    const onStatus = vi.fn();
    const stop = followJobs({ onSnapshot: vi.fn(), onJob: vi.fn(), onStatus });
    const source = FakeSource.last!; source.emit("snapshot", { jobs: null }); source.onerror?.();
    await vi.advanceTimersByTimeAsync(14_999); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(signal?.aborted).toBe(true); expect(onStatus).toHaveBeenLastCalledWith("unavailable");
    stop(); await vi.advanceTimersByTimeAsync(60_000); expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("works without EventSource and preserves an unavailable result instead of inventing empty history", async () => {
    vi.useFakeTimers(); vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("fetch", vi.fn(async () => response({ jobs: [null] })));
    const onSnapshot = vi.fn(); const onStatus = vi.fn();
    const stop = followJobs({ onSnapshot, onJob: vi.fn(), onStatus });
    await vi.advanceTimersByTimeAsync(1);
    expect(onSnapshot).not.toHaveBeenCalled(); expect(onStatus).toHaveBeenLastCalledWith("unavailable");
    stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("stops automatic requests after session refusal and aborts an abandoned request", async () => {
    vi.useFakeTimers(); vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "Sign in again" }, 401)));
    const stop = followJobs({ onSnapshot: vi.fn(), onJob: vi.fn() });
    await vi.advanceTimersByTimeAsync(120_000); expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0); stop();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal; signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    })));
    const onStatus = vi.fn();
    const stopPending = followJobs({ onSnapshot: vi.fn(), onJob: vi.fn(), onStatus }); stopPending();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true); expect(onStatus).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
