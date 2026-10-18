import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../../operations";
import { runningTitles, useRunningJobs } from "./runningJobs";

const job = (id: string, state: string, type = "op:app.backup"): Job => ({ id, type, title: `Job ${id}`, state, risk: "low", error: null, result: null, steps: [], approvals: [] });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("jobs the update would interrupt", () => {
  it("are the ones applying or verifying, the update itself left out", () => {
    expect(runningTitles([job("a", "applying"), job("b", "verifying"), job("c", "awaiting_approval"), job("d", "failed"), job("e", "applying", "op:system.update")])).toEqual(["Job a", "Job b"]);
  });

  it("are read again until they finish, and not at all while no update is offered", async () => {
    vi.useFakeTimers();
    let answer = [job("a", "applying")];
    const fetch = vi.fn(async () => new Response(JSON.stringify({ jobs: answer }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const { result, rerender } = renderHook(({ on }) => useRunningJobs(on, 1_000), { initialProps: { on: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetch).not.toHaveBeenCalled();
    rerender({ on: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toEqual(["Job a"]);
    answer = [job("a", "completed")];
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current).toEqual([]);
    // A read that fails keeps what was last known rather than calling the house quiet.
    answer = [job("b", "applying")];
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    fetch.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current).toEqual(["Job b"]);
  });
});
