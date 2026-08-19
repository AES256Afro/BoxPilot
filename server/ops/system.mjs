import { defineOperation } from "./registry.mjs";

export function systemOperations() {
  return [
    defineOperation({
      id: "system.reboot", title: "Reboot the server", risk: "high", timeoutMs: 60_000,
      description: "Schedules a reboot in a few seconds. Running VMs and containers stop; BoxPilot comes back when the host does.",
      parameters: { fields: { delaySeconds: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 2 && value <= 300 ? null : "must be a whole number of seconds between 2 and 300") } } },
      run: (parameters, { runUnit }) => runUnit.runTask("system.reboot", { delaySeconds: parameters.delaySeconds ?? 5 }, { timeoutMs: 30_000 }),
    }),
  ];
}
