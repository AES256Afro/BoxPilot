import { afterEach, describe, expect, it, vi } from "vitest";
import { followJobOutput } from "./operations";

/**
 * A medium-risk operation that looks frozen is one people cancel half way through. It looked frozen
 * because server-sent events reach a browser fine over a direct connection and are held back by a
 * proxy that buffers until the response ends, which is what fronts this server on a tailnet. So the
 * dialog asks as well as listens, and whichever answers first is the one it believes.
 */
class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, (event: { data: string }) => void>();
  closed = false;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSource.last = this; }
  addEventListener(type: string, handler: (event: { data: string }) => void) { this.listeners.set(type, handler); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
}

const withFakes = (outputBody: unknown) => {
  vi.stubGlobal("EventSource", FakeSource as unknown as typeof EventSource);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => outputBody })));
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeSource.last = null; });

describe("following a job's output", () => {
  it("uses the stream when the stream arrives, and never asks", async () => {
    vi.useFakeTimers();
    withFakes({ output: "from polling", state: "applying" });
    const seen: Array<[string, boolean]> = [];
    const stop = followJobOutput("job-1", { onOutput: (text, append) => seen.push([text, append]), onState: () => {} });

    FakeSource.last!.emit("output", { text: "line one\n" });
    FakeSource.last!.emit("output", { text: "line two\n" });
    await vi.advanceTimersByTimeAsync(6000);

    expect(seen).toEqual([["line one\n", true], ["line two\n", true]]);
    expect(fetch).not.toHaveBeenCalled();  // a working stream must not cause a second request per job
    stop();
  });

  it("asks when the stream says nothing, which is what a buffering proxy looks like", async () => {
    vi.useFakeTimers();
    withFakes({ output: "$ docker compose up\nRecreating...\n", state: "applying" });
    const seen: Array<[string, boolean]> = [];
    const stop = followJobOutput("job-2", { onOutput: (text, append) => seen.push([text, append]), onState: () => {} });

    await vi.advanceTimersByTimeAsync(2600);
    expect(seen).toEqual([["$ docker compose up\nRecreating...\n", false]]);
    // false means replace: asking returns the whole log, so appending it would duplicate every line
    stop();
  });

  it("stops asking once the job reaches a terminal state", async () => {
    vi.useFakeTimers();
    withFakes({ output: "done\n", state: "completed", error: null });
    const states: string[] = [];
    const stop = followJobOutput("job-3", { onOutput: () => {}, onState: (s) => states.push(s.state) });

    await vi.advanceTimersByTimeAsync(2600);
    const callsAfterFinish = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);

    expect(states).toEqual(["completed"]);
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsAfterFinish);
    stop();
  });

  it("still follows when the browser has no EventSource at all", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ output: "polled\n", state: "applying" }) })));
    const seen: string[] = [];
    const stop = followJobOutput("job-4", { onOutput: (text) => seen.push(text), onState: () => {} });
    await vi.advanceTimersByTimeAsync(2600);
    expect(seen).toEqual(["polled\n"]);
    stop();
  });

  it("stops everything when told to", async () => {
    vi.useFakeTimers();
    withFakes({ output: "x", state: "applying" });
    const stop = followJobOutput("job-5", { onOutput: () => {}, onState: () => {} });
    stop();
    await vi.advanceTimersByTimeAsync(8000);
    expect(FakeSource.last!.closed).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("not hammering the server for a long operation", () => {
  it("widens the gap between asks instead of asking every second for an hour", async () => {
    vi.useFakeTimers();
    withFakes({ output: "working\n", state: "applying" });
    const stop = followJobOutput("job-6", { onOutput: () => {}, onState: () => {}, pollAfterMs: 100, pollEveryMs: 1000, maxPollEveryMs: 5000 });

    await vi.advanceTimersByTimeAsync(100 + 1000 * 6);
    const early = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    const later = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    // A fixed one-second interval would be ~66 asks in that span; backing off keeps it far below.
    expect(later).toBeLessThan(30);
    expect(later).toBeGreaterThan(early);
    stop();
  });
});
