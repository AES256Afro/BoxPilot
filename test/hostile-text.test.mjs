// @vitest-environment node
import { describe, expect, it } from "vitest";
import { slowness } from "./hostile-text.mjs";

/*
 * The timer the speed tests stand on, run on a clock the test moves: each call to the code under
 * test costs what the test says, so a busy machine and slow code can be told apart without one.
 */

function timed(cost) {
  let clock = 0;
  let calls = 0;
  const apply = (text) => {
    clock += cost(text.length / 1024, calls);
    calls += 1;
  };
  return { apply, now: () => clock, calls: () => calls };
}

const text = (size) => "x".repeat(size);

describe("slowness", () => {
  it("passes code that reads in linear time", () => {
    const code = timed((kib) => kib * 0.01);
    expect(slowness(code.apply, text, { now: code.now })).toBeNull();
    expect(code.calls()).toBe(9);
  });

  it("passes linear code measured once while the machine was busy", () => {
    // The first sweep's times as a CI runner reported them: 7.4 ms at 16 KiB, 92 ms at 64 KiB.
    const code = timed((kib, call) => (call < 9 ? { 4: 1, 16: 7.4, 64: 92 }[kib] : kib * 0.01));
    expect(slowness(code.apply, text, { now: code.now })).toBeNull();
    expect(code.calls()).toBe(18);
  });

  it("fails code that grows faster than its text, every sweep", () => {
    const code = timed((kib) => kib * kib * 0.02);
    expect(slowness(code.apply, text, { now: code.now })).toMatch(/at 16 KiB but .* at 64 KiB: faster growth/);
    expect(code.calls()).toBe(27);
  });

  it("fails code far over its budget at once, without another sweep", () => {
    const code = timed(() => 1_000);
    expect(slowness(code.apply, text, { now: code.now })).toBe("1000.0 ms at 4 KiB (budget 20 ms)");
    expect(code.calls()).toBe(1);
  });
});
