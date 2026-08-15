import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapOwner, fetchAuthStatus } from "./auth";

afterEach(() => vi.unstubAllGlobals());

describe("authentication API client", () => {
  it("preserves the server bootstrap-required state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      bootstrapRequired: true,
      authenticated: false,
      owner: null,
      csrfToken: null,
      expiresAt: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    expect(await fetchAuthStatus()).toMatchObject({ bootstrapRequired: true, authenticated: false });
  });

  it("clears bootstrap-required only after successful owner creation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      authenticated: true,
      owner: { id: "owner-one", username: "operator" },
      csrfToken: "csrf",
      expiresAt: "later",
    }), { status: 201, headers: { "Content-Type": "application/json" } })));

    expect(await bootstrapOwner("operator", "correct horse battery", "token")).toMatchObject({ bootstrapRequired: false, authenticated: true });
  });
});
