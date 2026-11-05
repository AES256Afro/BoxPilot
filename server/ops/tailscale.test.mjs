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

/**
 * Moving Serve to BoxPilot's socket (M56.2): in the registry, named by no test. Owner-only for the
 * reason the description gives — anything on this server can open the loopback port and claim to be
 * Serve, apps on the host network included, and only BoxPilot and root can open the socket.
 */
describe("moving Tailscale Serve to the socket", () => {
  const operation = () => tailscaleOperations().find((entry) => entry.id === "tailscale.serve.socket");

  it("is the owner's, at medium, with nothing to choose", () => {
    expect(operation()).toMatchObject({ risk: "medium", minimumRole: "owner", readOnly: false });
    expect(Object.keys(operation().parameters?.fields ?? {})).toEqual([]);
  });

  it("carries the reason it is the owner's in its own words", () => {
    expect(operation().description).toContain("claim to be Serve");
  });

  it("refuses before touching Tailscale when BoxPilot is not on the socket yet", async () => {
    // The move itself is server/tasks/serve-socket.mjs and has its own tests. What matters at this
    // level is the order: pointing Serve at a socket nothing is listening on would take the tailnet
    // address down, so the check comes before the change, and the injected runner is never reached.
    const run = () => { throw new Error("Tailscale was reconfigured before the socket was checked"); };
    await expect(operation().run({}, { run, progress: () => {} })).rejects.toThrow(/not listening on/);
  });
});
