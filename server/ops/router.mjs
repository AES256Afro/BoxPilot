/**
 * The router as a source of truth about the network.
 *
 * Read-only to begin with. Writing to a router — DNS options, static leases, port forwards — can
 * take a house off the internet, and the write path cannot be exercised here without a real device
 * and its password, so it is not shipped on the strength of an untested guess. See docs/NETWORK.md.
 */
import { defineOperation } from "./registry.mjs";
import { routerKinds } from "../tasks/router.mjs";

const minutes = (value) => value * 60_000;

export function routerOperations() {
  return [
    defineOperation({
      id: "router.inspect", title: "Read the router connection", risk: "low", readOnly: true, timeoutMs: minutes(2),
      description: "Whether a router is connected, and whether the stored credential still works.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("router.inspect", {}, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "router.connect", title: "Connect to the router", risk: "medium", minimumRole: "owner", timeoutMs: minutes(3),
      description: "Signs in to the router once to prove the password works, then stores it root-only on this server and pins the certificate the router presented. Nothing on the router is changed.",
      parameters: { fields: {
        kind: { type: "string", validate: (value) => (routerKinds.includes(value) ? null : `must be one of ${routerKinds.join(", ")}`) },
        host: { type: "string", maxLength: 253, pattern: /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/ },
        // These routers have one admin account and do not ask which; root is filled in.
        username: { type: "string", maxLength: 64, pattern: /^[A-Za-z0-9._-]{1,64}$/, optional: true },
        password: { type: "string", maxLength: 256, pattern: /^[^\r\n]+$/, secret: true },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("router.connect", parameters, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "router.leases", title: "Read the devices the router knows", risk: "low", readOnly: true, timeoutMs: minutes(2),
      description: "Every device the router has given an address to, with the name it reported and whether the address is reserved.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("router.leases", {}, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
  ];
}
