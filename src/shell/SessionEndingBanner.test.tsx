import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEndingBanner, minutesLeft } from "./SessionEndingBanner";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-10-18T14:00:00Z")); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("the notice before a session ends (M36)", () => {
  it("counts whole minutes, never below one while time is left", () => {
    expect(minutesLeft(600_000, 0)).toBe(10);
    expect(minutesLeft(600_000, 541_000)).toBe(1);
    expect(minutesLeft(600_000, 599_999)).toBe(1);
  });

  it("says nothing until ten minutes before, then counts down, and is gone once the session ends", async () => {
    const ends = new Date(Date.parse("2026-10-18T14:30:00Z")).toISOString();
    render(<SessionEndingBanner expiresAt={ends} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/Your session ends/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000); });
    expect(screen.getByText(/Your session ends at .*, in 10 minutes/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(9 * 60_000 + 30_000); });
    expect(screen.getByText(/in 1 minute$/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.queryByText(/Your session ends/)).toBeNull();
  });

  it("can be put away, and stays away for that session", async () => {
    const ends = new Date(Date.parse("2026-10-18T14:05:00Z")).toISOString();
    const { rerender } = render(<SessionEndingBanner expiresAt={ends} />);
    expect(screen.getByText(/in 5 minutes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/Your session ends/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.queryByText(/Your session ends/)).toBeNull();
    // A new session (signed in again) is its own.
    rerender(<SessionEndingBanner expiresAt={new Date(Date.parse("2026-10-18T14:10:00Z")).toISOString()} />);
    expect(screen.getByText(/Your session ends/)).toBeTruthy();
  });

  it("looks again when the tab is seen, for a laptop that slept through its timer", () => {
    let clock = Date.parse("2026-10-18T14:00:00Z");
    const ends = new Date(Date.parse("2026-10-18T14:30:00Z")).toISOString();
    render(<SessionEndingBanner expiresAt={ends} now={() => clock} />);
    expect(screen.queryByText(/Your session ends/)).toBeNull();
    // Asleep for 25 minutes: no timer has run, and the tab comes back into view.
    clock += 25 * 60_000;
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getByText(/in 5 minutes/)).toBeTruthy();
  });

  it("is held under the bar as the offline banner is, so it is seen from anywhere down the page", () => {
    const ends = new Date(Date.parse("2026-10-18T14:05:00Z")).toISOString();
    render(<SessionEndingBanner expiresAt={ends} />);
    expect(screen.getByText(/Your session ends/).closest(".offline-session")).not.toBeNull();
  });

  it("says nothing without an expiry", () => {
    const { container } = render(<SessionEndingBanner expiresAt={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("what the notice says, and staying signed in (M89)", () => {
  const ends = () => new Date(Date.parse("2026-10-18T14:05:00Z")).toISOString();
  const clockOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  it("at the three-day cap says so, and offers no way to stay that would not work", () => {
    render(<SessionEndingBanner expiresAt={ends()} capAt={() => ends()} />);
    expect(screen.getByText(`You signed in three days ago; BoxPilot asks again at ${clockOf(ends())}.`, { exact: false })).toBeTruthy();
    expect(screen.queryByText(/twelve hours/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Stay signed in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Got it" })).toBeTruthy();
  });

  it("reads the cap the server sent, as this browser kept it", () => {
    window.localStorage.setItem("boxpilot:signed-in-cap", ends());
    render(<SessionEndingBanner expiresAt={ends()} />);
    expect(screen.getByText(/You signed in three days ago/)).toBeTruthy();
  });

  it("unused, offers to stay signed in: one request that needs the session, and the notice goes once it is renewed", async () => {
    const later = new Date(Date.parse("2026-10-19T02:05:00Z")).toISOString();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json", "X-BoxPilot-Session-Expires": later } }));
    vi.stubGlobal("fetch", fetchMock);
    const heard = vi.fn();
    window.addEventListener("boxpilot:auth-changed", heard);
    render(<SessionEndingBanner expiresAt={ends()} capAt={() => "2026-10-20T09:00:00Z"} />);
    expect(screen.getByText(/BoxPilot has not been used here for a while/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    window.removeEventListener("boxpilot:auth-changed", heard);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/v1/auth/sessions");
    expect(heard).toHaveBeenCalled();
    expect(window.localStorage.getItem("boxpilot:signed-in-until")).toBe(later);
    expect(screen.queryByText(/Your session ends/)).toBeNull();
  });

  /** The renewal request answers with no new end; the status then says where the session ends now. */
  const statusSays = (expiresAt: string) => vi.fn(async (input: RequestInfo | URL) => {
    const body = input.toString().endsWith("/auth/status")
      ? { bootstrapRequired: false, authenticated: true, owner: { id: "o", username: "alex" }, csrfToken: "c", expiresAt, sessionCap: ends() }
      : { sessions: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  it("when another tab already renewed it, takes the status's later end rather than calling it the cap", async () => {
    const later = new Date(Date.parse(ends()) + 12 * 3_600_000).toISOString();
    vi.stubGlobal("fetch", statusSays(later));
    render(<SessionEndingBanner expiresAt={ends()} capAt={() => null} />);
    fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText(/You signed in three days ago/)).toBeNull();
    expect(screen.queryByText(/Your session ends/)).toBeNull();
    expect(window.localStorage.getItem("boxpilot:signed-in-until")).toBe(later);
  });

  it("when staying moved nothing, says the session is at its cap", async () => {
    vi.stubGlobal("fetch", statusSays(ends()));
    render(<SessionEndingBanner expiresAt={ends()} capAt={() => null} />);
    fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/You signed in three days ago; BoxPilot asks again at/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stay signed in" })).toBeNull();
  });

  it("says in plain words when BoxPilot did not answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Load failed"); }));
    render(<SessionEndingBanner expiresAt={ends()} capAt={() => null} />);
    fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/BoxPilot did not answer\. It may be restarting/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stay signed in" })).toBeTruthy();
  });
});
