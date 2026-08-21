import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { tailscaleOperations } from "./tailscale.mjs";

describe("tailscale operations", () => {
  it("validates routes and stages the task with defaults", async () => {
    const operation = tailscaleOperations()[0];
    expect(validateParameters(operation.parameters, { exitNode: true, subnetRouter: true, routes: ["192.168.1.0/24"] }, "t")).toBeNull();
    expect(validateParameters(operation.parameters, { routes: ["nope"] }, "t")).toContain("not an IPv4 subnet");
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operation.run({ exitNode: true }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("tailscale.set", { exitNode: true, subnetRouter: false, routes: [] }, expect.anything());
    expect(operation.risk).toBe("medium");
  });
});
