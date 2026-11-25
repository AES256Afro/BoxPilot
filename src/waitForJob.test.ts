import { afterEach, describe, expect, it, vi } from "vitest";
import { lostConnection, waitForJob } from "./operations";
import { ApiError } from "./http";

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
  const waiting = waitForJob("job-1", { intervalMs: 10, answers: async () => true });
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

/*
 * The audit's probe (M89, s1-05 Function): the job keeps running and completes at 60 s while BoxPilot
 * stops answering for a while at the start. Before M89 every one of these gave up at about 8 s.
 */
describe("a restart while a job is followed", () => {
  const completesAtMs = 60_000;
  const follow = async (outageMs: number, during: () => Promise<Response>) => {
    vi.useFakeTimers();
    const start = Date.now();
    const down = () => Date.now() - start < outageMs;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (down()) return during();
      return reply(Date.now() - start >= completesAtMs ? "completed" : "applying");
    }));
    let settled: { job?: { state: string }; error?: unknown; at?: number } = {};
    void waitForJob("job-1", { answers: async () => !down() }).then(
      (job) => { settled = { job, at: Date.now() - start }; },
      (error: unknown) => { settled = { error, at: Date.now() - start }; },
    );
    await vi.advanceTimersByTimeAsync(completesAtMs + 10_000);
    return settled;
  };

  it.each([
    ["no reply for 9 s", 9_000, async () => { throw new TypeError("Failed to fetch"); }],
    ["no reply for 15 s", 15_000, async () => { throw new TypeError("Failed to fetch"); }],
    ["a proxy's 502 for 15 s", 15_000, async () => new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } })],
  ])("follows the job to its end through %s", async (_name, outageMs, during) => {
    const settled = await follow(outageMs, during);
    expect(settled.error).toBeUndefined();
    expect(settled.job?.state).toBe("completed");
    expect(settled.at).toBeGreaterThanOrEqual(completesAtMs);
  });

  it("does not count reads while BoxPilot is down, and widens the gap to the watcher's pace", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const controller = new AbortController();
    const waiting = waitForJob("job-1", { answers: async () => false, signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    // 2 s, 4 s, then every 5 s: about 13 reads in a minute rather than 30, and still waiting.
    expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(14);
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(10);
    controller.abort();
    expect(await waiting).toMatchObject({ name: "AbortError" });
  });

  it("gives up at once when the server says there is no such job", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "No such job" }), { status: 404 })));
    const answers = vi.fn(async () => true);
    await expect(waitForJob("job-1", { answers })).rejects.toThrow("No such job");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(answers).not.toHaveBeenCalled();
  });

  it("still gives up after five failed reads while BoxPilot otherwise answers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "database is locked" }), { status: 500 })));
    const waiting = expect(waitForJob("job-1", { answers: async () => true })).rejects.toThrow("database is locked");
    await vi.advanceTimersByTimeAsync(10_000);
    await waiting;
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

describe("lostConnection", () => {
  const up = { online: true, reachable: true, lastHeardAt: 1 };
  it("is true for no reply, a gateway error, or the watcher saying BoxPilot is down", () => {
    expect(lostConnection(new TypeError("Load failed"), up)).toBe(true);
    expect(lostConnection(new ApiError("BoxPilot is not answering.", 502), up)).toBe(true);
    expect(lostConnection(new ApiError("BoxPilot's admin service is not answering.", 503, "helper_unavailable"), up)).toBe(true);
    expect(lostConnection(new Error("anything"), { ...up, reachable: false })).toBe(true);
  });
  it("is false for a refusal while BoxPilot answers", () => {
    expect(lostConnection(new ApiError("This needs the owner role.", 403), up)).toBe(false);
    expect(lostConnection(new Error("Install failed"), up)).toBe(false);
  });
});
