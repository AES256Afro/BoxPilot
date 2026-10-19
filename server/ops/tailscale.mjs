import { defineOperation } from "./registry.mjs";
import { validateRoutes } from "../tasks/tailscale.mjs";
import { serveSocketMove } from "../tasks/serve-socket.mjs";

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
    defineOperation({
      // Owner only: it decides which connection BoxPilot believes when it says who is calling.
      id: "tailscale.serve.socket", title: "Move Tailscale Serve to BoxPilot's socket", risk: "medium", minimumRole: "owner", timeoutMs: minutes(3),
      description: "Points Tailscale Serve at BoxPilot's socket instead of its loopback port. Anything on this server can open the loopback port and claim to be Serve, apps on the host network included; only BoxPilot and root can open the socket. Needs a Tailscale that can forward to a socket.",
      parameters: { fields: {} },
      run: (_parameters, { run, progress }) => serveSocketMove({ ...(run ? { run } : {}), log: progress ?? null }),
    }),
  ];
}
