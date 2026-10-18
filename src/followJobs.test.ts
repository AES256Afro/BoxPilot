import { afterEach, describe, expect, it, vi } from "vitest";
import { followJobs, type Job } from "./operations";

class FakeSource {
  static last: FakeSource | null = null;
  static opened = 0;
  listeners = new Map<string, (event: { data: string }) => void>();
  closed = false;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSource.last = this; FakeSource.opened += 1; }
  addEventListener(name: string, handler: (event: { data: string }) => void) { this.listeners.set(name, handler); }
  emit(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
const job = { id: "job-1", title: "Back up database", state: "completed", steps: [], result: null } as unknown as Job;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeSource.last = null; FakeSource.opened = 0; });

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

describe("one job feed per tab (M50.2)", () => {
  it("opens one stream for every follower, hands a late one what is known, and closes with the last", async () => {
    vi.useFakeTimers(); vi.stubGlobal("EventSource", FakeSource); vi.stubGlobal("fetch", vi.fn());
    const drawer = { onSnapshot: vi.fn(), onJob: vi.fn(), onStatus: vi.fn() };
    const stopDrawer = followJobs(drawer);
    const source = FakeSource.last!;
    const older = { ...job, id: "job-0", createdAt: "2026-10-18T08:00:00Z" } as Job;
    const newer = { ...job, id: "job-2", state: "applying", createdAt: "2026-10-18T09:00:00Z" } as Job;
    source.emit("snapshot", { jobs: [older] });
    source.emit("job", { job: newer });
    // Home opens later: the same stream, with the snapshot and the event since, newest first.
    const home = { onSnapshot: vi.fn(), onJob: vi.fn(), onStatus: vi.fn() };
    const stopHome = followJobs(home);
    expect(FakeSource.opened).toBe(1);
    expect(home.onSnapshot).toHaveBeenCalledWith([newer, older]);
    expect(home.onStatus).toHaveBeenLastCalledWith("live");
    const done = { ...newer, state: "completed" } as Job;
    source.emit("job", { job: done });
    expect(drawer.onJob).toHaveBeenLastCalledWith(done);
    expect(home.onJob).toHaveBeenLastCalledWith(done);
    // Leaving Home keeps the drawer's stream; the last to leave closes it, and a stop twice is harmless.
    stopHome(); stopHome();
    expect(source.closed).toBe(false);
    stopDrawer();
    expect(source.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    // The next follower starts a fresh stream, with nothing carried over.
    const again = { onSnapshot: vi.fn(), onJob: vi.fn(), onStatus: vi.fn() };
    const stopAgain = followJobs(again);
    expect(FakeSource.opened).toBe(2);
    expect(again.onSnapshot).not.toHaveBeenCalled();
    expect(again.onStatus).toHaveBeenLastCalledWith("loading");
    stopAgain();
  });

  it("starts again when someone follows a feed that has given up, as Activity's retry does", async () => {
    vi.useFakeTimers(); vi.stubGlobal("EventSource", FakeSource);
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "down" }, 503)));
    const home = { onSnapshot: vi.fn(), onJob: vi.fn(), onStatus: vi.fn() };
    const stopHome = followJobs(home);
    FakeSource.last!.onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(home.onStatus).toHaveBeenLastCalledWith("unavailable");
    const retry = { onSnapshot: vi.fn(), onJob: vi.fn(), onStatus: vi.fn() };
    const stopRetry = followJobs(retry);
    expect(FakeSource.opened).toBe(2);
    expect(home.onStatus).toHaveBeenLastCalledWith("loading");
    FakeSource.last!.emit("snapshot", { jobs: [job] });
    expect(home.onSnapshot).toHaveBeenLastCalledWith([job]);
    expect(retry.onSnapshot).toHaveBeenLastCalledWith([job]);
    stopRetry(); stopHome();
    expect(vi.getTimerCount()).toBe(0);
  });
});
