import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { upsOperations } from "./ups.mjs";

describe("ups operations", () => {
  it("stages the setup task with defaults and validates ids", async () => {
    const operation = upsOperations()[0];
    expect(operation.id).toBe("ups.setup");
    expect(validateParameters(operation.parameters, { driver: "usbhid-ups", vendorId: "051d", productId: "0002", description: "APC Back-UPS" }, "t")).toBeNull();
    expect(validateParameters(operation.parameters, { driver: "magic" }, "t")).toContain("one of");
    expect(validateParameters(operation.parameters, { vendorId: "zz" }, "t")).toContain("invalid");
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operation.run({ vendorId: "051d" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("ups.setup", { name: "ups", driver: "usbhid-ups", vendorId: "051d", productId: null, description: "UPS", shutdownAtLowBattery: true }, expect.anything());
  });
});
