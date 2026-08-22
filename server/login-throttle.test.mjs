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

describe("the per-account ceiling", () => {
  it("cannot be held armed by one wrong guess per expiry", () => {
    // The ceiling is a key any caller can drive, so escalation there is a lock-out weapon: an
    // attacker who reaches it once could hold the owner's account shut indefinitely with a single
    // guess every few minutes. Serving the block clears the count, so the next one costs a full run.
    let clock = 1_000_000;
    const spray = createLoginThrottle({ maxFailures: 50, baseDelayMs: 60_000, maxDelayMs: 300_000, resetOnExpiry: true, now: () => clock });
    const keys = ["user:owner"];
    for (let index = 0; index < 53; index += 1) spray.record(keys, false);
    expect(spray.check(keys).retryAfterMs).toBe(300_000);
    clock += 301_000;
    expect(spray.check(keys).blocked).toBe(false);
    spray.record(keys, false);
    expect(spray.check(keys).blocked).toBe(false); // one guess does not re-arm it
  });

  it("still escalates on a per-caller key, where only the guesser waits", () => {
    let clock = 1_000_000;
    const throttle = createLoginThrottle({ now: () => clock });
    const keys = ["user:owner|ip:100.64.0.9"];
    for (let index = 0; index < 5; index += 1) throttle.record(keys, false);
    expect(throttle.check(keys).retryAfterMs).toBe(30_000);
    clock += 30_000;
    throttle.record(keys, false);
    expect(throttle.check(keys).retryAfterMs).toBe(60_000);
  });

  it("forgets a key nobody has used for a while, so the map cannot grow without bound", () => {
    let clock = 1_000_000;
    const throttle = createLoginThrottle({ now: () => clock, maxDelayMs: 60_000 });
    for (let index = 0; index < 50; index += 1) throttle.record([`user:owner|ip:10.0.0.${index}`], false);
    expect(throttle.size()).toBe(50);
    clock += 10 * 60_000;
    throttle.record(["user:owner|ip:10.9.9.9"], false); // any activity prunes
    expect(throttle.size()).toBe(1);
  });
});
