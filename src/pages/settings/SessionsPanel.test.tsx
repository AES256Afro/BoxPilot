import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionsPanel, { deviceLabel } from "./SessionsPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const chromeMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const safariPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const firefoxLinux = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const session = (id: string, userAgent: string, extra = {}) => ({ id, createdAt: "2026-10-18T08:00:00.000Z", expiresAt: "2026-10-18T20:00:00.000Z", lastSeenAt: new Date().toISOString(), address: "100.64.0.9", userAgent, method: "password", elevated: false, ...extra });

function serve({ revoke = () => json({ ok: true }) }: { revoke?: () => Response } = {}) {
  let sessions = [session("s-here", chromeMac, { elevated: true }), session("s-phone", safariPhone, { method: "passkey" }), session("s-desk", firefoxLinux, { method: "tailscale" })];
  const sent: Array<{ method: string; url: string; csrf: string | undefined }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (!init?.method) return json({ currentId: "s-here", sessions });
    sent.push({ method: init.method, url, csrf: (init.headers as Record<string, string>)["X-BoxPilot-CSRF"] });
    const answer = revoke();
    if (answer.ok) sessions = url.endsWith("revoke-others") ? sessions.filter((entry) => entry.id === "s-here") : sessions.filter((entry) => !url.endsWith(entry.id));
    return answer;
  }));
  return sent;
}

describe("Where you're signed in", () => {
  it("names each device and how it signed in, marks this one, and offers no sign-out for it", async () => {
    serve();
    render(<SessionsPanel csrfToken="csrf" />);
    expect(await screen.findByText("Chrome on macOS")).toBeTruthy();
    expect(screen.getByText("this device")).toBeTruthy();
    expect(screen.getByText("unlocked")).toBeTruthy();
    expect(screen.getByText("Passkey")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out Chrome on macOS" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out Safari on iOS" })).toBeTruthy();
  });

  it("signs one device out with the CSRF token", async () => {
    const sent = serve();
    render(<SessionsPanel csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Safari on iOS" }));
    expect(await screen.findByText("Signed out Safari on iOS.")).toBeTruthy();
    expect(sent).toEqual([{ method: "DELETE", url: "/api/v1/auth/sessions/s-phone", csrf: "csrf" }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sign out Safari on iOS" })).toBeNull());
  });

  it("asks before signing out every other device, and Keep them sends nothing", async () => {
    const sent = serve();
    render(<SessionsPanel csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out everywhere else (2)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Safari on iOS")).toBeTruthy();
    expect(within(dialog).queryByText("Chrome on macOS")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep them" }));
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere else (2)" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sign them out" }));
    expect(await screen.findByText("Signed out everywhere else.")).toBeTruthy();
    expect(sent).toEqual([{ method: "POST", url: "/api/v1/auth/sessions/revoke-others", csrf: "csrf" }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Sign out everywhere else/ })).toBeNull());
  });

  it("says why a sign-out was refused", async () => {
    serve({ revoke: () => json({ error: "That session is not yours" }, 404) });
    render(<SessionsPanel csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Firefox on Linux" }));
    expect(await screen.findByText("That session is not yours")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out Firefox on Linux" })).toBeTruthy();
  });

  it("names browsers and systems from the user agent, and says when it cannot", () => {
    expect(deviceLabel(null)).toBe("Unknown device");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0")).toBe("Edge on Windows");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36 OPR/80.0")).toBe("Opera on Android");
    expect(deviceLabel("curl/8.5.0")).toBe("Unknown device");
  });
});
