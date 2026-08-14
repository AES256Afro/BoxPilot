import { describe, expect, it, vi } from "vitest";
import { requireVmActionAuthorization, tokenMatches, vmActionsConfiguration } from "./auth.mjs";

describe("VM action authorization", () => {
  it("requires both the feature flag and a strong token", () => {
    expect(vmActionsConfiguration({ BOXPILOT_VM_ACTIONS_ENABLED: "false", BOXPILOT_ADMIN_TOKEN: "x" }).enabled).toBe(false);
    expect(vmActionsConfiguration({ BOXPILOT_VM_ACTIONS_ENABLED: "true", BOXPILOT_ADMIN_TOKEN: "too-short" }).enabled).toBe(false);
    expect(
      vmActionsConfiguration({
        BOXPILOT_VM_ACTIONS_ENABLED: "true",
        BOXPILOT_ADMIN_TOKEN: "12345678901234567890123456789012",
      }).enabled,
    ).toBe(true);
  });

  it("compares tokens without accepting prefixes or different lengths", () => {
    expect(tokenMatches("correct-token", "correct-token")).toBe(true);
    expect(tokenMatches("correct", "correct-token")).toBe(false);
    expect(tokenMatches("wrong--token", "correct-token")).toBe(false);
  });

  it("allows only the configured bearer token through the middleware", () => {
    const token = "12345678901234567890123456789012";
    const middleware = requireVmActionAuthorization(vmActionsConfiguration({
      BOXPILOT_VM_ACTIONS_ENABLED: "true",
      BOXPILOT_ADMIN_TOKEN: token,
    }));
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    middleware({ get: () => "Bearer wrong" }, response, next);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();

    middleware({ get: () => `Bearer ${token}` }, response, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
