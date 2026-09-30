import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { upsOperations } from "./ups.mjs";

describe("ups operations", () => {
  it("stages the setup task with defaults and validates ids and thresholds", async () => {
    const operation = upsOperations()[0];
    expect(operation.id).toBe("ups.setup");
    expect(operation.risk).toBe("medium");
    expect(validateParameters(operation.parameters, { driver: "usbhid-ups", vendorId: "051d", productId: "0002", description: "APC Back-UPS" }, "t")).toBeNull();
    expect(validateParameters(operation.parameters, { driver: "magic" }, "t")).toContain("one of");
    expect(validateParameters(operation.parameters, { vendorId: "zz" }, "t")).toContain("invalid");
    expect(validateParameters(operation.parameters, { lowBatteryPercent: 30, lowRuntimeSeconds: 300 }, "t")).toBeNull();
    expect(validateParameters(operation.parameters, { lowBatteryPercent: null, lowRuntimeSeconds: null }, "t")).toBeNull();
    expect(validateParameters(operation.parameters, { lowBatteryPercent: 95 }, "t")).toContain("from 10 to 90");
    expect(validateParameters(operation.parameters, { lowRuntimeSeconds: 60 }, "t")).toContain("from 120 to 1800");
    // The simulated UPS of the real-host test is not a parameter anyone can send.
    expect(validateParameters(operation.parameters, { simulated: { driver: "dummy-ups" } }, "t")).toContain("does not accept");
    expect(validateParameters(operation.parameters, { driver: "dummy-ups" }, "t")).toContain("one of");
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operation.run({ vendorId: "051d" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("ups.setup", { name: "ups", driver: "usbhid-ups", vendorId: "051d", productId: null, description: "UPS", shutdownAtLowBattery: true, lowBatteryPercent: null, lowRuntimeSeconds: null }, expect.anything());
  });
});
