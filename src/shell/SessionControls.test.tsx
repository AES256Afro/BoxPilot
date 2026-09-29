import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthStatus } from "../auth";
import { SessionControls } from "./SessionControls";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const status = (overrides: Partial<AuthStatus> = {}): AuthStatus => ({ bootstrapRequired: false, authenticated: true, owner: { id: "o1", username: "alex", role: "owner" }, csrfToken: "csrf", expiresAt: null, elevatedUntil: null, ...overrides } as AuthStatus);

describe("who is signed in, in the top bar (M33.13)", () => {
  it("says approvals are tiered, and signs out", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { calls.push(input.toString()); return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }); }));
    const signedOut = vi.fn();
    render(<SessionControls authStatus={status()} csrfToken="csrf" onRefresh={vi.fn()} onSignedOut={signedOut} />);
    expect(screen.getByText("Tiered approvals")).toBeTruthy();
    expect(screen.queryByTitle("Your role on this server")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signedOut).toHaveBeenCalledWith(null));
    expect(calls.some((url) => url.includes("/auth/logout"))).toBe(true);
  });

  it("shows until when the session is elevated, and locks it on a press", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: input.toString(), method: init?.method ?? "GET" }); return new Response(null, { status: 204 }); }));
    const refresh = vi.fn();
    const until = new Date(Date.now() + 5 * 60_000).toISOString();
    render(<SessionControls authStatus={status({ elevatedUntil: until, owner: { id: "o2", username: "sam", role: "operator" } } as Partial<AuthStatus>)} csrfToken="csrf" onRefresh={refresh} onSignedOut={vi.fn()} />);
    expect(screen.getByTitle("Your role on this server").textContent).toBe("operator");
    fireEvent.click(screen.getByRole("button", { name: /^Elevated until .*\. Lock now$/ }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls.some((call) => call.method !== "GET")).toBe(true);
  });
});
