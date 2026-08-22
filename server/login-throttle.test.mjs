import { describe, expect, it } from "vitest";
import { createLoginThrottle } from "./login-throttle.mjs";

describe("login throttle", () => {
  it("blocks after five failures with a doubling delay and clears on success", () => {
    let clock = 1_000_000;
    const throttle = createLoginThrottle({ now: () => clock });
    const keys = ["user:alex", "ip:192.0.2.1"];
    for (let i = 0; i < 4; i += 1) { throttle.record(keys, false); expect(throttle.check(keys).blocked).toBe(false); }
    throttle.record(keys, false); // fifth failure
    expect(throttle.check(keys)).toEqual({ blocked: true, retryAfterMs: 30_000 });
    clock += 30_000;
    expect(throttle.check(keys).blocked).toBe(false);
    throttle.record(keys, false); // sixth: 60 s
    expect(throttle.check(keys).retryAfterMs).toBe(60_000);
    expect(throttle.check(["ip:192.0.2.1"]).blocked).toBe(true); // the address alone is blocked too
    expect(throttle.check(["user:someone-else"]).blocked).toBe(false);
    clock += 60_000;
    throttle.record(keys, true);
    expect(throttle.check(keys).blocked).toBe(false);
    expect(throttle.size()).toBe(0);
  });

  it("caps the delay", () => {
    let clock = 0;
    const throttle = createLoginThrottle({ now: () => clock, maxDelayMs: 120_000 });
    for (let i = 0; i < 12; i += 1) { throttle.record(["k"], false); clock += 1; }
    expect(throttle.check(["k"]).retryAfterMs).toBeLessThanOrEqual(120_000);
  });
});

describe("who gets throttled", () => {
  it("blocks the account, not the address, so nobody can lock the owner out from one client", async () => {
    const { createAuthService } = await import("./security.mjs");
    const store = {
      recordAudit: () => {},
      getSetting: () => null,
      setSetting: () => {},
    };
    const auth = createAuthService(store);
    const request = { socket: { remoteAddress: "127.0.0.1" }, get: () => undefined, headers: {} };
    const attacker = { id: "owner-1", passwordHash: "scrypt$16384$8$1$c2FsdA$aGFzaA" }; // never matches
    for (let i = 0; i < 6; i += 1) await auth.checkPassword(request, attacker, "wrong");
    expect((await auth.checkPassword(request, attacker, "wrong")).blocked).toBe(true);
    // A different account from the same address is unaffected.
    const other = { id: "owner-2", passwordHash: "scrypt$16384$8$1$c2FsdA$aGFzaA" };
    expect((await auth.checkPassword(request, other, "wrong")).blocked).toBe(false);
  });
});
