import { describe, expect, it } from "vitest";
import { createRateLimit, rateLimited } from "./rate-limit.mjs";

describe("rate limit", () => {
  it("allows the count within the window, refuses the next, and forgets as the window passes", () => {
    let at = 1_000_000;
    const limit = createRateLimit({ count: 3, perMs: 60_000, now: () => at });
    expect([limit.take("a"), limit.take("a"), limit.take("a")]).toEqual([true, true, true]);
    expect(limit.take("a")).toBe(false);
    expect(limit.retryAfterMs("a")).toBe(60_000);
    expect(limit.take("b"), "another key is not affected").toBe(true);
    at += 30_000;
    expect(limit.take("a")).toBe(false);
    expect(limit.retryAfterMs("a")).toBe(30_000);
    at += 30_001;
    expect(limit.take("a"), "the first call has left the window").toBe(true);
    expect(limit.retryAfterMs("b")).toBe(0);
  });

  it("keeps no more keys than it is told, dropping the quiet and then the oldest", () => {
    let at = 0;
    const limit = createRateLimit({ count: 1, perMs: 1_000, maxKeys: 3, now: () => at });
    for (const key of ["a", "b", "c"]) limit.take(key);
    at = 2_000;
    limit.take("d");
    expect(limit.size(), "the three quiet keys were swept when the fourth arrived").toBe(1);
    for (const key of ["e", "f", "g", "h"]) limit.take(key);
    expect(limit.size()).toBeLessThanOrEqual(3);
  });

  it("as middleware answers 429 with Retry-After, keyed on the account or the address", () => {
    const limit = createRateLimit({ count: 1, perMs: 60_000, now: () => 5_000 });
    const guard = rateLimited(limit, "send");
    const answers = [];
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { answers.push(code); return this; }, json(body) { answers.push(body); return this; } };
    let passed = 0;
    guard({ boxpilotSession: { owner: { id: "owner-1" } } }, response, () => { passed += 1; });
    guard({ boxpilotSession: { owner: { id: "owner-1" } } }, response, () => { passed += 1; });
    guard({ ip: "10.0.0.9" }, response, () => { passed += 1; });
    expect(passed).toBe(2);
    expect(answers).toEqual([429, { error: "Too many requests; wait a minute", code: "rate_limited" }]);
    expect(response.headers["Retry-After"]).toBe("60");
  });
});
