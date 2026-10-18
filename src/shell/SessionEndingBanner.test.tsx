import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEndingBanner, minutesLeft } from "./SessionEndingBanner";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-10-18T14:00:00Z")); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

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

  it("says nothing without an expiry", () => {
    const { container } = render(<SessionEndingBanner expiresAt={null} />);
    expect(container.textContent).toBe("");
  });
});
