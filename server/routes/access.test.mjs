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

describe("Check again on the watch list (M88)", () => {
  it("lets operators and the owner start a health round, not viewers, and still keeps the rest of /settings the owner's", () => {
    for (const role of ["operator", "owner"]) {
      expect(decide("POST", "/settings/watch/check", role), role).toBe("next");
      expect(decide("POST", "/Settings/Watch/Check/", role), role).toBe("next");
    }
    // A round can push to the owner's phone and reads the box through the helper; a viewer gets
    // cached answers everywhere else, so here too.
    expect(decide("POST", "/settings/watch/check", "viewer")).toBe(403);
    expect(decide("POST", "/Settings/Watch/Check/", "viewer")).toBe(403);
    expect(decide("POST", "/settings/watch/check", "disabled")).toBe(403);
    expect(decide("POST", "/settings/watch", "operator")).toBe(403);
    expect(decide("PUT", "/settings/watch/check", "operator")).toBe(403);
    expect(decide("POST", "/settings/watch/check/more", "operator")).toBe(403);
  });
});
