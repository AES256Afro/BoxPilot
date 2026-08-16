// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createLibvirtFoundationHelper, libvirtFoundationInternals } from "./libvirt-foundation-helper.mjs";

const canonicalNetwork = `<network><name>default</name><forward mode='nat'/><bridge name='virbr0'/><ip address='192.168.122.1' netmask='255.255.255.0'><dhcp><range start='192.168.122.2' end='192.168.122.254'/></dhcp></ip></network>`;
const canonicalPool = `<pool type='dir'><name>default</name><target><path>/var/lib/libvirt/images</path></target></pool>`;

function metadata({ directory = false, symbolicLink = false } = {}) {
  return { isDirectory: () => directory, isSymbolicLink: () => symbolicLink };
}

function readyRun() {
  return vi.fn(async (binary, args) => {
    const operation = args.at(-1);
    if (binary.endsWith("virsh") && operation === "uri") return { ok: true, stdout: "qemu:///system", stderr: "" };
    if (binary.endsWith("virsh") && args.includes("net-info")) return { ok: true, stdout: "Active: yes\nPersistent: yes\nAutostart: yes\nBridge: virbr0", stderr: "" };
    if (binary.endsWith("virsh") && args.includes("net-dumpxml")) return { ok: true, stdout: canonicalNetwork, stderr: "" };
    if (binary.endsWith("virsh") && args.includes("pool-info")) return { ok: true, stdout: "State: running\nPersistent: yes\nAutostart: yes", stderr: "" };
    if (binary.endsWith("virsh") && args.includes("pool-dumpxml")) return { ok: true, stdout: canonicalPool, stderr: "" };
    if (binary.endsWith("systemctl")) return { ok: true, stdout: "", stderr: "" };
    return { ok: false, stdout: "", stderr: "not found" };
  });
}

describe("libvirt foundation helper", () => {
  it("recognizes only the canonical active autostart network and pool as ready", async () => {
    const helper = createLibvirtFoundationHelper({
      run: readyRun(),
      statFile: async (target) => metadata({ directory: target.endsWith("/images") }),
      loadRoutes: async () => "Iface\tDestination\n",
      loadDevices: async () => "Inter-| Receive\nvirbr0: 0 0 0\n",
    });
    const result = await helper.inspect();
    expect(result).toMatchObject({ ready: true, planAvailable: false, conflicts: [], network: { exists: true, active: true, autostart: true, compatible: true }, pool: { exists: true, active: true, autostart: true, compatible: true } });
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.boundary).toMatchObject({ otherNetworksChanged: false, otherPoolsChanged: false, virtualMachineCreated: false, browserResourceAccepted: false, mutationPerformed: false });
  });

  it("offers fixed initialization only when missing resources have no bridge, route, or target conflict", async () => {
    const missingRun = vi.fn(async (binary, args) => binary.endsWith("virsh") && args.at(-1) === "uri"
      ? { ok: true, stdout: "qemu:///system", stderr: "" }
      : { ok: false, stdout: "", stderr: "not found" });
    const absent = Object.assign(new Error("missing"), { code: "ENOENT" });
    const helper = createLibvirtFoundationHelper({ run: missingRun, statFile: async () => { throw absent; }, loadRoutes: async () => "Iface\tDestination\n", loadDevices: async () => "Inter-| Receive\nlo: 0 0 0\n" });
    await expect(helper.inspect()).resolves.toMatchObject({ ready: false, planAvailable: true, changes: [
      "Define the fixed default NAT network", "Start the fixed default NAT network", "Enable default network autostart",
      "Define the fixed default directory storage pool", "Start the fixed default storage pool", "Enable default pool autostart",
    ] });

    const conflict = createLibvirtFoundationHelper({ run: missingRun, statFile: async () => { throw absent; }, loadRoutes: async () => "virbr0\t007AA8C0\n", loadDevices: async () => "Inter-| Receive\nlo: 0 0 0\n" });
    await expect(conflict.inspect()).resolves.toMatchObject({ planAvailable: false, conflicts: ["The fixed 192.168.122.0/24 subnet already has a host route"] });
  });

  it("pins the revision, writes a short-lived marker, starts only the static unit, and verifies readiness", async () => {
    let initialized = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("systemctl")) { initialized = true; return { ok: true, stdout: "", stderr: "" }; }
      if (binary.endsWith("virsh") && args.at(-1) === "uri") return { ok: true, stdout: "qemu:///system", stderr: "" };
      if (!initialized) return { ok: false, stdout: "", stderr: "not found" };
      if (args.includes("net-info")) return { ok: true, stdout: "Active: yes\nPersistent: yes\nAutostart: yes\nBridge: virbr0", stderr: "" };
      if (args.includes("net-dumpxml")) return { ok: true, stdout: canonicalNetwork, stderr: "" };
      if (args.includes("pool-info")) return { ok: true, stdout: "State: running\nPersistent: yes\nAutostart: yes", stderr: "" };
      if (args.includes("pool-dumpxml")) return { ok: true, stdout: canonicalPool, stderr: "" };
      return { ok: false, stdout: "", stderr: "not found" };
    });
    const writeApproval = vi.fn();
    const clearApproval = vi.fn();
    const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });
    const helper = createLibvirtFoundationHelper({
      run,
      writeApproval,
      clearApproval,
      now: () => new Date("2026-08-16T12:00:00.000Z"),
      loadRoutes: async () => "Iface\tDestination\n",
      loadDevices: async () => initialized ? "Inter-| Receive\nvirbr0: 0 0 0\n" : "Inter-| Receive\nlo: 0 0 0\n",
      statFile: async (target) => {
        if (!initialized) throw missingError;
        return metadata({ directory: target.endsWith("/images"), symbolicLink: target.includes("/sys/class/net") });
      },
    });
    const missing = await helper.inspect();
    const foundationId = "123e4567-e89b-42d3-a456-426614174000";
    await expect(helper.initialize({ foundationId, expectedRevision: missing.revision })).resolves.toMatchObject({ initialized: true, foundationId, ready: true, network: { created: true, started: true, autostartEnabled: true }, pool: { created: true, started: true, autostartEnabled: true } });
    expect(writeApproval).toHaveBeenCalledWith({ approvedAt: "2026-08-16T12:00:00.000Z", expectedRevision: missing.revision, foundationId });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["start", "boxpilot-libvirt-foundation.service"], { timeout: 300000 });
    expect(clearApproval).toHaveBeenCalledTimes(2);
  });

  it("rejects noncanonical fixed-resource XML", () => {
    expect(libvirtFoundationInternals.canonicalNetworkXml(canonicalNetwork.replace("mode='nat'", "mode='bridge'"))).toBe(false);
    expect(libvirtFoundationInternals.canonicalPoolXml(canonicalPool.replace("/var/lib/libvirt/images", "/srv/vms"))).toBe(false);
  });
});
