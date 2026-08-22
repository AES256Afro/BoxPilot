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
