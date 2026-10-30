import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followRun, type RunEvent } from "./api";

/** EventSource as the page meets it: the test says when a frame arrives and when the stream fails. */
class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, (event: MessageEvent) => void>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSource.last = this; }
  addEventListener(name: string, listener: (event: MessageEvent) => void) { this.listeners.set(name, listener); }
  close() { this.closed = true; }
  emit(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent); }
  fail() { this.onerror?.(); }
}

const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let reads = 0;

beforeEach(() => {
  vi.useFakeTimers();
  reads = 0;
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("fetch", vi.fn(async () => { reads += 1; return new Response(JSON.stringify({ id: runId, state: "running", steps: [] }), { status: 200, headers: { "Content-Type": "application/json" } }); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); FakeSource.last = null; });

describe("following a run", () => {
  it("falls back to one chain of reads when the stream fails before its first frame", async () => {
    const events: RunEvent[] = [];
    const stop = followRun(runId, (event) => events.push(event));
    FakeSource.last!.fail();
    // Its own fallback timer, due at 2.5 s, used to start a second chain beside the first.
    await vi.advanceTimersByTimeAsync(10_000);
    // One read at once, then one every two seconds: six in ten seconds, not eleven.
    expect(reads).toBe(6);
    stop();
  });

  it("reads nothing more, and says nothing twice, when the stream closes after the run ended", async () => {
    const events: RunEvent[] = [];
    const stop = followRun(runId, (event) => events.push(event));
    const source = FakeSource.last!;
    source.emit("snapshot", { id: runId, state: "running", steps: [] });
    source.emit("state", { state: "completed" });
    // The server ends the stream with the run; EventSource reports that as an error.
    source.fail();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(0);
    expect(events.map((event) => event.event)).toEqual(["snapshot", "state"]);
    stop();
  });
});
