import { defineOperation } from "./registry.mjs";
import { drivers, shutdownPreparationSeconds, thresholdLimits, upsNamePattern } from "../tasks/ups.mjs";

const minutes = (value) => value * 60_000;
const whole = ({ min, max }, unit) => (value) => (Number.isInteger(value) && value >= min && value <= max ? null : `must be a whole number of ${unit} from ${min} to ${max}`);

/** UPS monitoring (NUT, M39.1): one operation that configures a detected USB UPS end to end. */
export function upsOperations() {
  return [
    defineOperation({
      id: "ups.setup", title: "Set up UPS monitoring", risk: "medium", timeoutMs: minutes(4),
      description: `Writes a standalone NUT configuration for the UPS (driver, local server on loopback, monitor user with a generated password), starts the driver and services, and checks the UPS answers and the monitor is connected. Every power event (on battery, back on mains, low battery, the shutdown) is logged for the System page and Home. With shutdown on, when the battery runs low the apps stop and the drives unmount the way BoxPilot's reboot does them, for at most ${shutdownPreparationSeconds} seconds, then the server powers off and the UPS switches its outlets off until the mains returns. Thresholds, when given, replace the UPS's own idea of a low battery.`,
      parameters: { fields: {
        name: { type: "string", optional: true, maxLength: 32, pattern: upsNamePattern },
        driver: { type: "string", optional: true, enum: [...drivers] },
        vendorId: { type: "string", optional: true, nullable: true, maxLength: 4, pattern: /^[0-9a-f]{4}$/ },
        productId: { type: "string", optional: true, nullable: true, maxLength: 4, pattern: /^[0-9a-f]{4}$/ },
        description: { type: "string", optional: true, maxLength: 60, pattern: /^[A-Za-z0-9 ._()/-]{1,60}$/ },
        shutdownAtLowBattery: { type: "boolean", optional: true },
        lowBatteryPercent: { type: "number", optional: true, nullable: true, validate: whole(thresholdLimits.percent, "percent") },
        lowRuntimeSeconds: { type: "number", optional: true, nullable: true, validate: whole(thresholdLimits.runtimeSeconds, "seconds") },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("ups.setup", {
        name: parameters.name ?? "ups", driver: parameters.driver ?? "usbhid-ups", vendorId: parameters.vendorId ?? null, productId: parameters.productId ?? null,
        description: parameters.description ?? "UPS", shutdownAtLowBattery: parameters.shutdownAtLowBattery ?? true,
        lowBatteryPercent: parameters.lowBatteryPercent ?? null, lowRuntimeSeconds: parameters.lowRuntimeSeconds ?? null,
      }, { timeoutMs: minutes(3), logPath: jobLog?.path ?? null }),
    }),
  ];
}
