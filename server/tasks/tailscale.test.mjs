import { describe, expect, it, vi } from "vitest";
import { tailscaleSet, validateRoutes } from "./tailscale.mjs";

function fakeRun({ setFails = false } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("/ip")) return { ok: true, stdout: JSON.stringify([{ dst: "default", dev: "eno1" }, { dst: "192.168.1.0/24", dev: "eno1", scope: "link" }, { dst: "172.17.0.0/16", dev: "docker0", scope: "link" }]), stderr: "" };
    if (binary.endsWith("tailscale") && args[0] === "set") return setFails ? { ok: false, stdout: "", stderr: "tailscale set: not logged in" } : { ok: true, stdout: "", stderr: "" };
    if (binary.endsWith("tailscale")) return { ok: true, stdout: JSON.stringify({ Self: { ExitNodeOption: true, DNSName: "bigbox.tail1234.ts.net." } }), stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}

describe("tailscale settings task", () => {
  it("validates routes", () => {
    expect(validateRoutes(["192.168.1.0/24", "10.0.0.0/8"])).toBeNull();
    expect(validateRoutes(["192.168.1.0"])).toContain("not an IPv4 subnet");
    expect(validateRoutes(["192.168.1.0/32"])).toContain("prefix 8-30");
    expect(validateRoutes(["100.64.0.0/10"])).toContain("cannot be advertised");
    expect(validateRoutes("x")).toContain("list");
  });

  it("enables forwarding, advertises the detected LAN and the exit node, and points at the admin console", async () => {
    const files = { writeFile: vi.fn(async () => {}) };
    const run = fakeRun();
    const result = await tailscaleSet({ exitNode: true, subnetRouter: true }, { run, files });
    expect(result).toEqual({ exitNode: true, routes: ["192.168.1.0/24"], exitNodeOption: true, dnsName: "bigbox.tail1234.ts.net", approvalNeeded: true, adminUrl: "https://login.tailscale.com/admin/machines" });
    expect(files.writeFile).toHaveBeenCalledWith("/etc/sysctl.d/99-boxpilot-tailscale.conf", expect.stringContaining("net.ipv4.ip_forward = 1"), { mode: 0o644 });
    expect(run).toHaveBeenCalledWith("/usr/sbin/sysctl", ["-p", "/etc/sysctl.d/99-boxpilot-tailscale.conf"], expect.anything());
    expect(run).toHaveBeenCalledWith(expect.stringContaining("tailscale"), ["set", "--advertise-exit-node=true", "--advertise-routes=192.168.1.0/24"], expect.anything());
  });

  it("withdraws everything without touching sysctl, and reports failures", async () => {
    const files = { writeFile: vi.fn(async () => {}) };
    const run = fakeRun();
    const result = await tailscaleSet({ exitNode: false, subnetRouter: false }, { run, files });
    expect(result).toMatchObject({ exitNode: false, routes: [], approvalNeeded: false });
    expect(files.writeFile).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(expect.stringContaining("tailscale"), ["set", "--advertise-exit-node=false", "--advertise-routes="], expect.anything());
    await expect(tailscaleSet({ subnetRouter: true, routes: ["10.0.0.0/8"] }, { run: fakeRun({ setFails: true }), files })).rejects.toThrow("not logged in");
    await expect(tailscaleSet({ routes: ["bad"] }, { run, files })).rejects.toThrow("Invalid routes");
  });
});
