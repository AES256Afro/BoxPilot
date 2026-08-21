import { defineOperation } from "./registry.mjs";
import { macPattern } from "../tasks/network.mjs";

/** LAN device verbs (M9.6). Device discovery is a web-side read (the helper has no network). */
export function networkOperations() {
  return [
    defineOperation({
      id: "network.wake", title: "Wake a device on the LAN", risk: "low", timeoutMs: 30_000,
      description: "Sends Wake-on-LAN magic packets to the device's hardware address. The device must have Wake-on-LAN enabled in its firmware and be on this server's network segment.",
      parameters: { fields: { mac: { type: "string", pattern: macPattern } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("network.wake", { mac: parameters.mac.toLowerCase() }, { timeoutMs: 20_000, logPath: jobLog?.path ?? null }),
    }),
  ];
}
