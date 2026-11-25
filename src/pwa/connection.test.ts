import { afterEach, describe, expect, it, vi } from "vitest";
import { checkConnection, connected, connectionState, resetConnection, subscribeConnection, watchConnection } from "./connection";

/*
 * Whether BoxPilot is reachable, not only whether there is a network: a phone off the tailnet is
 * online, and a captive portal or proxy answers with its own page, which is not BoxPilot answering.
 */

afterEach(() => { resetConnection(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const reply = (body: string, contentType: string, status = 200) => async () => new Response(body, { status, headers: { "Content-Type": contentType } });

describe("checking the connection", () => {
  it("does not count a captive portal's page as BoxPilot, even with 200 OK", async () => {
    await checkConnection({ fetcher: reply("{\"ok\":true}", "application/json"), now: () => 1_000 });
    expect(await checkConnection({ fetcher: reply("<html>Sign in to the hotel Wi-Fi</html>", "text/html"), now: () => 2_000 })).toEqual({ online: true, reachable: false, lastHeardAt: 1_000 });
    expect(connected(connectionState())).toBe(false);
  });

  it("asks nothing while the device has no network", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const fetcher = vi.fn();
    expect(await checkConnection({ fetcher })).toMatchObject({ online: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("tells listeners only when something changed", async () => {
    const heard = vi.fn();
    const stop = subscribeConnection(heard);
    await checkConnection({ fetcher: reply("{}", "application/json"), now: () => 5 });
    await checkConnection({ fetcher: reply("{}", "application/json"), now: () => 5 });
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("watching the connection", () => {
  it("asks at once, when the network returns, when the page is shown, and on its interval, and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => new Response("{}", { headers: { "Content-Type": "application/json" } }));
      vi.stubGlobal("fetch", fetcher);
      // (No page read on coming back here: that is the next test's, and its one-a-second timer is the tab's.)
      const stop = watchConnection({ intervalMs: 1_000, onBack: () => {} });
      expect(fetcher).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      expect(fetcher).toHaveBeenCalledTimes(3);
      window.dispatchEvent(new Event("offline"));
      expect(connectionState().online).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetcher).toHaveBeenCalledTimes(4);
      stop();
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("how often it asks", () => {
  /** Timers the test fires by hand: each armed timer with its delay, newest last. */
  function timers() {
    const armed = new Map<number, { run: () => void; ms: number }>();
    let next = 1;
    return {
      setTimer: (run: () => void, ms: number) => { armed.set(next, { run, ms }); return next++; },
      clearTimer: (id: number) => { armed.delete(id); },
      delays: () => [...armed.values()].map((timer) => timer.ms),
      fire: async () => { const [id, timer] = [...armed.entries()].at(-1)!; armed.delete(id); timer.run(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
    };
  }
  const answering = async () => new Response("{}", { headers: { "Content-Type": "application/json" } });
  const silent = async () => { throw new TypeError("Failed to fetch"); };

  it("once a minute while BoxPilot answers, every five seconds while it does not, and a minute again once it is back", async () => {
    const clock = timers();
    let fetcher: () => Promise<Response> = answering;
    const asked = vi.fn(() => fetcher());
    vi.stubGlobal("fetch", asked);
    const stop = watchConnection({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await vi.waitFor(() => expect(connectionState().lastHeardAt).not.toBeNull());
    expect(clock.delays()).toEqual([60_000]);
    // A reboot: the minute's question is not answered, and the next is five seconds away.
    fetcher = silent;
    await clock.fire();
    await vi.waitFor(() => expect(connectionState().reachable).toBe(false));
    expect(clock.delays()).toEqual([5_000]);
    await clock.fire();
    expect(clock.delays()).toEqual([5_000]);
    // Back: the first answer puts the banner away, and the pace returns to a minute.
    fetcher = answering;
    await clock.fire();
    await vi.waitFor(() => expect(connected(connectionState())).toBe(true));
    expect(clock.delays()).toEqual([60_000]);
    const before = asked.mock.calls.length;
    stop();
    expect(clock.delays()).toEqual([]);
    expect(asked.mock.calls.length).toBe(before);
  });

  it("never asks more often than its own interval", async () => {
    const clock = timers();
    vi.stubGlobal("fetch", vi.fn(silent));
    const stop = watchConnection({ intervalMs: 1_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await vi.waitFor(() => expect(connectionState().reachable).toBe(false));
    expect(clock.delays()).toEqual([1_000]);
    stop();
  });
});

describe("coming back (M89)", () => {
  it("has the page read again quietly, once, when BoxPilot answers after not answering", async () => {
    vi.useFakeTimers();
    try {
      let up = true;
      vi.stubGlobal("fetch", vi.fn(async () => (up ? new Response("{}", { headers: { "Content-Type": "application/json" } }) : new Response("<html>502</html>", { status: 502, headers: { "Content-Type": "text/html" } }))));
      const reads: unknown[] = [];
      const listener = (event: Event) => { reads.push((event as CustomEvent).detail); };
      window.addEventListener("boxpilot:refresh", listener);
      const stop = watchConnection({ intervalMs: 60_000, retryMs: 5_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toEqual([]);
      up = false;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(connected(connectionState())).toBe(false);
      expect(reads).toEqual([]);
      up = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(connected(connectionState())).toBe(true);
      expect(reads).toEqual(["job"]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(reads).toEqual(["job"]);
      stop();
      window.removeEventListener("boxpilot:refresh", listener);
    } finally {
      vi.useRealTimers();
    }
  });
});
