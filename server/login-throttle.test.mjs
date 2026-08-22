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
  async function service() {
    const { createAuthService } = await import("./security.mjs");
    return createAuthService({ recordAudit: () => {}, getSetting: () => null, setSetting: () => {} });
  }
  const from = (address) => ({ socket: { remoteAddress: address }, get: () => undefined, headers: {} });
  const account = (id) => ({ id, passwordHash: "scrypt$16384$8$1$c2FsdA$aGFzaA" }); // never matches

  it("stops the caller who is guessing, and only that caller", async () => {
    const auth = await service();
    const guesser = from("100.64.0.9");
    const target = account("owner-throttle-1");
    for (let i = 0; i < 6; i += 1) await auth.checkPassword(guesser, target, "wrong");
    expect((await auth.checkPassword(guesser, target, "wrong")).blocked).toBe(true);
    // A different account from the same caller is unaffected...
    expect((await auth.checkPassword(guesser, account("owner-throttle-2"), "wrong")).blocked).toBe(false);
    // ...and, the point of the pair: the same account from anywhere else still gets in. Keying on
    // the account alone let anyone who could reach the port hold the owner out of their own box.
    expect((await auth.checkPassword(from("100.64.0.44"), target, "wrong")).blocked).toBe(false);
  });

  it("still slows an attack spread across many callers", async () => {
    const auth = await service();
    const target = account("owner-throttle-3");
    for (let caller = 0; caller < 55; caller += 1) await auth.checkPassword(from(`100.64.1.${caller}`), target, "wrong");
    expect((await auth.checkPassword(from("100.64.2.1"), target, "wrong")).blocked).toBe(true);
  });
});
