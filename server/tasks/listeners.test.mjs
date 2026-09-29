import { describe, expect, it, vi } from "vitest";
import { tasks } from "./index.mjs";
import { hostListeners } from "./listeners.mjs";

describe("the host's listening sockets, from the root task (the Dockge port trap, 2026-09-29)", () => {
  it("lists them with the process holding each, and is in the task table", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: 'tcp   LISTEN 0      4096     100.64.0.10:5001       0.0.0.0:*    users:(("tailscaled",pid=812,fd=33))\n', stderr: "" }));
    await expect(hostListeners({}, { run })).resolves.toEqual({ listeners: [{ protocol: "tcp", address: "100.64.0.10", port: 5001, scope: "address", process: { name: "tailscaled", pid: 812 } }] });
    // -p is the point: without it nothing says whose a socket is.
    expect(run).toHaveBeenCalledWith("/usr/bin/ss", ["-H", "-l", "-n", "-t", "-u", "-p"], expect.anything());
    expect(typeof tasks["host.listeners"]).toBe("function");
  });

  it("fails loudly rather than reporting a server with nothing listening", async () => {
    const run = vi.fn(async () => ({ ok: false, stdout: "", stderr: "Cannot open netlink socket: Address family not supported by protocol", code: 1 }));
    await expect(hostListeners({}, { run })).rejects.toThrow("ss could not list the listening sockets: Cannot open netlink socket");
  });
});
