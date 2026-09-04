import { describe, expect, it } from "vitest";
import { shared } from "./cache.mjs";

/** A read that never settles until released, so overlap is deterministic rather than timing-dependent. */
function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

describe("sharing a slow read", () => {
  it("gives concurrent callers one round trip", async () => {
    let calls = 0;
    const gate = deferred();
    const read = shared(() => { calls += 1; return gate.promise; });
    const all = Promise.all([read(), read(), read()]);
    gate.release("containers");
    expect(await all).toEqual(["containers", "containers", "containers"]);
    expect(calls).toBe(1);
  });

  it("reads again once the first call has settled, so nothing goes stale by default", async () => {
    let calls = 0;
    const read = shared(async () => { calls += 1; return calls; });
    expect(await read()).toBe(1);
    expect(await read()).toBe(2);
  });

  it("holds an answer only for as long as it was told to", async () => {
    let calls = 0;
    let clock = 1000;
    const read = shared(async () => { calls += 1; return calls; }, { ttlMs: 5000, now: () => clock });
    expect(await read()).toBe(1);
    clock += 4999;
    expect(await read()).toBe(1);
    clock += 2;
    expect(await read()).toBe(2);
  });

  it("forgets what it held when told the facts changed", async () => {
    let calls = 0;
    const read = shared(async () => { calls += 1; return calls; }, { ttlMs: 60_000, now: () => 0 });
    expect(await read()).toBe(1);
    expect(await read()).toBe(1);
    read.forget();
    expect(await read()).toBe(2);
  });

  it("never holds a failure", async () => {
    let calls = 0;
    const read = shared(async () => { calls += 1; if (calls === 1) throw new Error("helper is down"); return "back"; }, { ttlMs: 60_000, now: () => 0 });
    await expect(read()).rejects.toThrow("helper is down");
    expect(await read()).toBe("back");
  });

  it("lets every concurrent caller see the same failure", async () => {
    let calls = 0;
    const gate = deferred();
    const read = shared(() => { calls += 1; return gate.promise; });
    const both = Promise.allSettled([read(), read()]);
    gate.release(Promise.reject(new Error("no")));
    const [first, second] = await both;
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    expect(calls).toBe(1);
  });
});
