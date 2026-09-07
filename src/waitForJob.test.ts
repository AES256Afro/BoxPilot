import { afterEach, expect, it, vi } from "vitest";
import { waitForJob } from "./operations";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const reply = (state: string) => new Response(JSON.stringify({ job: { id: "job-1", state } }));

it("aborts an in-flight observation when the view leaves", async () => {
  vi.useFakeTimers();
  let observed: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
    observed = options.signal;
    observed!.addEventListener("abort", () => reject(observed!.reason), { once: true });
  })));
  const controller = new AbortController();
  const waiting = expect(waitForJob("job-1", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await waiting;
  expect(observed?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels the delay between polls without another request", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => reply("applying")));
  const controller = new AbortController();
  const waiting = expect(waitForJob("job-1", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  await waiting;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("enforces its deadline even when a request never answers", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }))));
  const waiting = expect(waitForJob("job-1", { timeoutMs: 50 })).rejects.toThrow("Timed out");
  await vi.advanceTimersByTimeAsync(50);
  await waiting;
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the deadline after success and retries temporary failures", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("restarting")).mockImplementation(async () => reply("completed")));
  const waiting = waitForJob("job-1", { intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(10);
  expect((await waiting).state).toBe("completed");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a request after cancellation", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const controller = new AbortController(); controller.abort();
  await expect(waitForJob("job-1", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});
