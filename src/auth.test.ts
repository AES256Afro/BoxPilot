import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapOwner, fetchAuthStatus, forgetSession, noteSessionRenewal, rememberSession, signedOutReason, signedOutReasonFor, watchSessionRenewals } from "./auth";

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("authentication API client", () => {
  it("preserves the server bootstrap-required state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      bootstrapRequired: true,
      authenticated: false,
      owner: null,
      csrfToken: null,
      expiresAt: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    expect(await fetchAuthStatus()).toMatchObject({ bootstrapRequired: true, authenticated: false });
  });

  it("clears bootstrap-required only after successful owner creation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      authenticated: true,
      owner: { id: "owner-one", username: "operator" },
      csrfToken: "csrf",
      expiresAt: "later",
    }), { status: 201, headers: { "Content-Type": "application/json" } })));

    expect(await bootstrapOwner("operator", "correct horse battery", "token")).toMatchObject({ bootstrapRequired: false, authenticated: true });
  });
});

// M36: after an update the owner was at the sign-in page with no word of why.
describe("why a browser is back at sign-in", () => {
  const now = Date.parse("2026-09-29T20:00:00Z");
  const signedIn = (expiresAt: string) => rememberSession({ bootstrapRequired: false, authenticated: true, owner: { id: "o", username: "alex" }, csrfToken: "c", expiresAt });

  it("says a session that reached its end expired, and one ended early was ended elsewhere", () => {
    expect(signedOutReason(now)).toBeNull();
    signedIn("2026-09-29T19:59:00Z");
    expect(signedOutReason(now)).toBe("expired");
    signedIn("2026-09-30T06:00:00Z");
    expect(signedOutReason(now)).toBe("ended");
  });

  it("says what the server said when it ended the session for coming from another address", () => {
    signedIn("2026-09-30T06:00:00Z");
    expect(signedOutReasonFor({ signedOut: "address-changed" }, now)).toBe("address-changed");
    expect(signedOutReasonFor({}, now)).toBe("ended");
    expect(signedOutReasonFor(null, now)).toBe("ended");
  });

  it("forgets on signing out, so signing out on purpose says nothing", () => {
    signedIn("2026-09-29T19:59:00Z");
    forgetSession();
    expect(signedOutReason(now)).toBeNull();
    rememberSession({ bootstrapRequired: false, authenticated: false, owner: null, csrfToken: null, expiresAt: null });
    expect(signedOutReason(now)).toBeNull();
  });
});

describe("a session renewed by an ordinary request", () => {
  it("moves the end this browser remembers and asks the app to read its status again", async () => {
    const owner = { id: "o1", username: "alex", role: "owner" as const };
    const now = Date.parse("2026-10-19T08:00:00.000Z");
    rememberSession({ bootstrapRequired: false, authenticated: true, owner, csrfToken: "c", expiresAt: new Date(now + 3_600_000).toISOString() });
    const heard = vi.fn();
    window.addEventListener("boxpilot:auth-changed", heard);
    const target = { fetch: vi.fn(async () => new Response("{}", { headers: { "X-BoxPilot-Session-Expires": new Date(now + 12 * 3_600_000).toISOString() } })) } as unknown as typeof window;
    watchSessionRenewals(target);
    await target.fetch("/api/v1/inventory");
    window.removeEventListener("boxpilot:auth-changed", heard);
    expect(heard).toHaveBeenCalledTimes(1);
    // Past the old end the session still runs, so a sign-out then was from somewhere else.
    expect(signedOutReason(now + 2 * 3_600_000)).toBe("ended");
    // The same end heard again says nothing new.
    const again = vi.fn();
    window.addEventListener("boxpilot:auth-changed", again);
    noteSessionRenewal(new Date(now + 12 * 3_600_000).toISOString());
    noteSessionRenewal("not a date");
    window.removeEventListener("boxpilot:auth-changed", again);
    expect(again).not.toHaveBeenCalled();
  });
});
