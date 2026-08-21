import { defineOperation } from "./registry.mjs";
import { drivers, upsNamePattern } from "../tasks/ups.mjs";

const minutes = (value) => value * 60_000;

/** UPS monitoring (NUT): one operation that configures a detected USB UPS end to end. */
export function upsOperations() {
  return [
    defineOperation({
      id: "ups.setup", title: "Set up UPS monitoring", risk: "medium", timeoutMs: minutes(4),
      description: "Writes a standalone NUT configuration for the UPS (driver, local server on loopback, monitor user with a generated password), starts the driver and services, and verifies the UPS reports a status. With shutdown enabled, this server powers off cleanly when the battery runs low.",
      parameters: { fields: {
        name: { type: "string", optional: true, maxLength: 32, pattern: upsNamePattern },
        driver: { type: "string", optional: true, enum: [...drivers] },
        vendorId: { type: "string", optional: true, nullable: true, maxLength: 4, pattern: /^[0-9a-f]{4}$/ },
        productId: { type: "string", optional: true, nullable: true, maxLength: 4, pattern: /^[0-9a-f]{4}$/ },
        description: { type: "string", optional: true, maxLength: 60, pattern: /^[A-Za-z0-9 ._()/-]{1,60}$/ },
        shutdownAtLowBattery: { type: "boolean", optional: true },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("ups.setup", {
        name: parameters.name ?? "ups", driver: parameters.driver ?? "usbhid-ups", vendorId: parameters.vendorId ?? null, productId: parameters.productId ?? null,
        description: parameters.description ?? "UPS", shutdownAtLowBattery: parameters.shutdownAtLowBattery ?? true,
      }, { timeoutMs: minutes(3), logPath: jobLog?.path ?? null }),
    }),
  ];
}
