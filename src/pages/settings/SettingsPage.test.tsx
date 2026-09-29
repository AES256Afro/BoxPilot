import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Every read the Settings tabs make, answered; anything else is a failure the test would see. */
function stubSettings({ configured = true } = {}) {
  const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    reads.push(url);
    if (url.endsWith("/settings/notifications")) return json({ configured, kind: configured ? "ntfy" : null, url: configured ? "http://127.0.0.1:8093" : null, topic: "boxpilot", hasToken: false });
    if (url.endsWith("/settings/approval-mode")) return json({ approvalMode: "tiered", modes: ["tiered", "always-password"], elevationTtlMs: 600_000 });
    if (url.endsWith("/auth/sessions")) return json({ currentId: "s1", sessions: [{ id: "s1", createdAt: "2026-09-29T06:00:00Z", expiresAt: "2026-09-29T18:00:00Z", lastSeenAt: "2026-09-29T07:00:00Z", address: "100.64.0.2", userAgent: "Mozilla/5.0 (Macintosh) Chrome/130.0", method: "passkey", elevated: false }] });
    if (url.endsWith("/auth/passkey")) return json({ passkeys: [], recoveryCodesRemaining: 8 });
    if (url.endsWith("/auth/identity/links")) return json({ tailscaleLogins: [], githubLogins: [], githubConfigured: false, githubClientId: "", currentTailscale: null });
    if (url.endsWith("/people")) return json({ people: [{ id: "o1", username: "alex", role: "owner", createdAt: "2026-08-01T00:00:00Z" }] });
    return json({ error: `unexpected ${url}` }, 500);
  }));
  return reads;
}

const tabNames = () => within(screen.getByRole("tablist", { name: "Settings" })).getAllByRole("tab").map((tab) => tab.textContent);

describe("Settings (M33.13)", () => {
  it("gives the owner every tab, and says first whether alerts can reach them", async () => {
    stubSettings({ configured: false });
    render(<SettingsPage csrfToken="csrf" role="owner" />);
    expect(tabNames()).toEqual(["Account & sign-in", "People", "Notifications", "Approvals", "Single sign-on", "Credentials", "Appearance"]);
    expect(await screen.findByText("No notification target")).toBeTruthy();
    // The Notifications tab carries the same warning, in words for assistive technology.
    expect(screen.getByRole("tab", { name: /Notifications, no target set/ })).toBeTruthy();
    expect(screen.getByText("tiered")).toBeTruthy();
  });

  it("keeps box-level settings the owner's: an operator gets their account and the theme (ADR-003)", async () => {
    const reads = stubSettings();
    render(<SettingsPage csrfToken="csrf" role="operator" />);
    expect(tabNames()).toEqual(["Account & sign-in", "Appearance"]);
    expect(await screen.findByRole("region", { name: "Sign-in methods" })).toBeTruthy();
    expect(reads.some((url) => url.endsWith("/settings/notifications") || url.endsWith("/settings/approval-mode"))).toBe(false);
  });

  it("leaves a viewer their password, passkeys and sessions, and no sign-in methods", async () => {
    stubSettings();
    render(<SettingsPage csrfToken="csrf" role="viewer" />);
    expect(tabNames()).toEqual(["Account & sign-in", "Appearance"]);
    expect(await screen.findByRole("region", { name: "Your password" })).toBeTruthy();
    expect(screen.getByRole("region", { name: /Passkeys/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: /Where you're signed in/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Sign-in methods" })).toBeNull();
  });

  it("keeps the open tab in the address, so a reload or a link opens it", async () => {
    stubSettings();
    window.history.replaceState(null, "", "/?view=settings&tab=people");
    render(<SettingsPage csrfToken="csrf" role="owner" />);
    expect(screen.getByRole("tab", { name: "People" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("alex")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    expect(window.location.search).toBe("?view=settings&tab=appearance");
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
  });
});
