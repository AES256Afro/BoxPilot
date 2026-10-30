import { describe, expect, it } from "vitest";
import { fill, slowness } from "../../test/hostile-text.mjs";
import { apiRolePolicy } from "./access.mjs";

/** What the role policy does with a request: "next" when it lets it through, else the status it answers. */
function decide(method, path, role) {
  let outcome = null;
  const response = { status: (code) => ({ json: () => { outcome = code; } }) };
  apiRolePolicy()({ method, path, boxpilotSession: { owner: { role } } }, response, () => { outcome = "next"; });
  return outcome;
}

describe("the /api/v1 role policy's path", () => {
  it("judges a path with trailing slashes, in any case, as the route it is", () => {
    expect(decide("POST", "/operations/apt.update/run///", "viewer")).toBe("next");
    expect(decide("POST", "/Settings/", "operator")).toBe(403);
    expect(decide("POST", "/settings////", "operator")).toBe(403);
    expect(decide("POST", "/assistant/ask/", "viewer")).toBe("next");
    expect(decide("POST", "/auth/logout//", "viewer")).toBe("next");
    expect(decide("POST", "/jobs/", "viewer")).toBe(403);
    expect(decide("POST", "/", "operator")).toBe("next");
    expect(decide("POST", "////", "viewer")).toBe(403);
  });

  it("reads a long run of slashes once (sweep 5)", () => {
    // Node takes a request line of up to 16 KiB; the policy is held to more than that.
    expect(slowness((path) => decide("POST", path, "operator"), (n) => `/${"/".repeat(n - 3)}x/`)).toBeNull();
    expect(slowness((path) => decide("POST", path, "operator"), (n) => fill("/a//", n))).toBeNull();
  });
});
