import { afterEach, describe, expect, it } from "vitest";
import { forgetAccount, forgetSession, rememberSession, rememberedAccount } from "../auth";
import { clearLastKnown, lastKnownTtlMs, readLastKnown, saveLastKnown } from "./lastKnown";

afterEach(() => { window.localStorage.clear(); });

const now = Date.parse("2026-09-29T07:00:00Z");

describe("the last known state (M25.1)", () => {
  it("is read back by the account that saved it, and by no other", () => {
    saveLastKnown("alex", "today", { verdict: "healthy" }, now);
    expect(readLastKnown("alex", "today", now + 60_000)).toEqual({ savedAt: now, value: { verdict: "healthy" } });
    expect(readLastKnown("sam", "today", now + 60_000)).toBeNull();
    expect(readLastKnown(null, "today", now)).toBeNull();
    saveLastKnown(null, "today", { verdict: "anyone" }, now);
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("boxpilot:last-known:"))).toEqual(["boxpilot:last-known:alex:today"]);
  });

  it("lasts a day, and is thrown away unread after that", () => {
    saveLastKnown("alex", "today", { verdict: "healthy" }, now);
    expect(readLastKnown("alex", "today", now + lastKnownTtlMs - 1)).not.toBeNull();
    expect(readLastKnown("alex", "today", now + lastKnownTtlMs)).toBeNull();
    expect(window.localStorage.getItem("boxpilot:last-known:alex:today")).toBeNull();
  });

  it("refuses a copy that cannot be read or claims to come from the future", () => {
    window.localStorage.setItem("boxpilot:last-known:alex:today", "{not json");
    expect(readLastKnown("alex", "today", now)).toBeNull();
    window.localStorage.setItem("boxpilot:last-known:alex:today", JSON.stringify({ savedAt: now + 3_600_000, expiresAt: now + 7_200_000, value: {} }));
    expect(readLastKnown("alex", "today", now)).toBeNull();
  });

  it("goes with the session: signing out, a session that ended, or BoxPilot saying nobody is signed in", () => {
    saveLastKnown("alex", "today", { verdict: "healthy" }, now);
    saveLastKnown("sam", "today", { verdict: "healthy" }, now);
    window.localStorage.setItem("boxpilot-theme", "dark");
    forgetSession();
    expect(readLastKnown("alex", "today", now)).toBeNull();
    expect(readLastKnown("sam", "today", now)).toBeNull();
    // Only BoxPilot's offline copies go; the device's own choices stay.
    expect(window.localStorage.getItem("boxpilot-theme")).toBe("dark");

    saveLastKnown("alex", "today", { verdict: "healthy" }, now);
    forgetAccount();
    expect(readLastKnown("alex", "today", now)).toBeNull();
    saveLastKnown("alex", "today", { verdict: "healthy" }, now);
    clearLastKnown();
    expect(readLastKnown("alex", "today", now)).toBeNull();
  });
});

describe("the remembered account", () => {
  const signedIn = (expiresAt: string) => rememberSession({ bootstrapRequired: false, authenticated: true, owner: { id: "o1", username: "alex", role: "owner" }, csrfToken: "secret-csrf", expiresAt });

  it("says who this device's session is, while it has time left, and never keeps a token", () => {
    signedIn("2026-09-29T19:00:00Z");
    expect(rememberedAccount(now)).toEqual({ owner: { id: "o1", username: "alex", role: "owner" }, expiresAt: "2026-09-29T19:00:00Z" });
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("secret-csrf");
    expect(rememberedAccount(Date.parse("2026-09-29T19:00:01Z"))).toBeNull();
  });

  it("is forgotten with the session, and when BoxPilot says nobody is signed in", () => {
    signedIn("2026-09-29T19:00:00Z");
    forgetSession();
    expect(rememberedAccount(now)).toBeNull();
    signedIn("2026-09-29T19:00:00Z");
    forgetAccount();
    expect(rememberedAccount(now)).toBeNull();
  });
});
