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
      const stop = watchConnection({ intervalMs: 1_000 });
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
