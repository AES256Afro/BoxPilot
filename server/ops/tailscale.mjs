import { defineOperation } from "./registry.mjs";
import { validateRoutes } from "../tasks/tailscale.mjs";

const minutes = (value) => value * 60_000;

/** Tailnet-wide node options. Per-app HTTPS (Serve) lives in app.serve.set. */
export function tailscaleOperations() {
  return [
    defineOperation({
      id: "tailscale.set", title: "Change Tailscale exit node and subnet router settings", risk: "medium", timeoutMs: minutes(3),
      description: "Offers this server as an exit node and/or advertises its LAN subnet(s) to the tailnet (tailscale set), enabling IP forwarding first. Offers take effect once approved in the Tailscale admin console.",
      parameters: { fields: {
        exitNode: { type: "boolean", optional: true },
        subnetRouter: { type: "boolean", optional: true },
        routes: { type: "array", optional: true, validate: (value) => validateRoutes(value) },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("tailscale.set", { exitNode: parameters.exitNode ?? false, subnetRouter: parameters.subnetRouter ?? false, routes: parameters.routes ?? [] }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
  ];
}
