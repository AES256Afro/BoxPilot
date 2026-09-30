import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner } from "../shell/OfflineBanner";
import { onRefresh, requestRefresh } from "../shell/refresh";
import { checkConnection, connectionState, resetConnection } from "./connection";
import { registerServiceWorker } from "./register";

afterEach(() => { cleanup(); resetConnection(); vi.restoreAllMocks(); });

const health = (mode: string, status = 200, type = "application/json") => async () => new Response(JSON.stringify({ status: "ok", mode }), { status, headers: { "Content-Type": type } });

describe("registering the service worker (M25.1)", () => {
  it("registers it at the root over HTTPS", async () => {
    const register = vi.fn(async () => ({ scope: "/" }) as unknown as ServiceWorkerRegistration);
    await registerServiceWorker({ location: { protocol: "https:" }, container: { register }, fetcher: health("host-aware") });
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("does nothing over plain HTTP, in the demo, or where there are no workers", async () => {
    const register = vi.fn();
    expect(await registerServiceWorker({ location: { protocol: "http:" }, container: { register }, fetcher: health("host-aware") })).toBeNull();
    expect(await registerServiceWorker({ location: { protocol: "https:" }, container: { register }, fetcher: health("demo") })).toBeNull();
    expect(await registerServiceWorker({ location: { protocol: "https:" }, container: null, fetcher: health("host-aware") })).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it("leaves the app working when registering fails", async () => {
    const register = vi.fn(async () => { throw new Error("SecurityError"); });
    expect(await registerServiceWorker({ location: { protocol: "https:" }, container: { register }, fetcher: health("host-aware") })).toBeNull();
  });
});

describe("whether BoxPilot can be reached", () => {
  it("counts only BoxPilot's own answer, and remembers when it last came", async () => {
    await checkConnection({ fetcher: health("host-aware"), now: () => 1_000 });
    expect(connectionState()).toEqual({ online: true, reachable: true, lastHeardAt: 1_000 });
    // A proxy's error page, as Tailscale Serve answers while BoxPilot restarts, is not an answer.
    await checkConnection({ fetcher: health("x", 502, "text/html"), now: () => 2_000 });
    expect(connectionState()).toEqual({ online: true, reachable: false, lastHeardAt: 1_000 });
    await checkConnection({ fetcher: async () => { throw new TypeError("Failed to fetch"); }, now: () => 3_000 });
    expect(connectionState().reachable).toBe(false);
  });
});

describe("the offline banner", () => {
  it("says nothing while BoxPilot answers", () => {
    render(<OfflineBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the phone is offline, what is stale, and that approvals wait", () => {
    resetConnection({ online: false, lastHeardAt: Date.parse("2026-09-29T07:42:00") });
    render(<OfflineBanner now={() => Date.parse("2026-09-29T08:00:00")} />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("You are offline");
    expect(banner.textContent).toContain("read before you went offline");
    expect(banner.textContent).toMatch(/BoxPilot last answered at 07:42/);
    expect(banner.textContent).toContain("Approvals and actions wait");
  });

  it("says BoxPilot is not answering when the phone is online but off the tailnet, and can try again", async () => {
    resetConnection({ online: true, reachable: false });
    render(<OfflineBanner />);
    expect(screen.getByRole("alert").textContent).toContain("Check that Tailscale is connected");
    vi.stubGlobal("fetch", vi.fn(health("host-aware")));
    await act(async () => { screen.getByRole("button", { name: "Try again" }).click(); });
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    vi.unstubAllGlobals();
  });
});

describe("the bar's Refresh", () => {
  it("lets a view that reads its own facts read them again in place", () => {
    const read = vi.fn();
    const reload = vi.fn();
    const stop = onRefresh(read);
    expect(requestRefresh({ reload })).toBe("refreshed");
    expect(read).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    stop();
  });

  it("loads any other page again", () => {
    const reload = vi.fn();
    expect(requestRefresh({ reload })).toBe("reloaded");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
