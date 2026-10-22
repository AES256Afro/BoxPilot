import { describe, expect, it, vi } from "vitest";
import { createLibvirtFoundationHelper, libvirtFoundationInternals } from "./libvirt-foundation-helper.mjs";

const canonicalNetwork = `<network><name>default</name><forward mode='nat'/><bridge name='virbr0'/><ip address='192.168.122.1' netmask='255.255.255.0'><dhcp><range start='192.168.122.2' end='192.168.122.254'/></dhcp></ip></network>`;
const canonicalPool = `<pool type='dir'><name>default</name><target><path>/var/lib/libvirt/images</path></target></pool>`;

const absent = Object.assign(new Error("missing"), { code: "ENOENT" });
const dnsConflict = "Another DNS server listens on every address on port 53, so the default network's dnsmasq cannot start; bind that server to one interface first";
const anyV6 = "0".repeat(32);
const socketHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops";
/** A /proc/net socket table with one row per [localAddress, state] pair, in the kernel's column layout. */
const socketTable = (...rows) => [socketHeader, ...rows.map(([local, state], index) => `   ${index}: ${local} ${local.replace(/:[0-9A-F]{4}$/i, ":0000")} ${state} 00000000:00000000 00:00000000 00000000     0        0 12345 2 0000000000000000 0`), ""].join("\n");
const quietSockets = { loadUdpSockets: async () => socketTable(), loadUdp6Sockets: async () => socketTable(), loadTcpSockets: async () => socketTable(), loadTcp6Sockets: async () => socketTable() };

/** libvirt reachable, no fixed resource defined and nothing on port 53, unless a loader or a network (net-info and net-dumpxml answers) is given. */
function bareHost({ network = null, ...loaders } = {}) {
  const run = vi.fn(async (binary, args) => {
    if (!binary.endsWith("virsh")) return { ok: false, stdout: "", stderr: "not found" };
    if (args.at(-1) === "uri") return { ok: true, stdout: "qemu:///system", stderr: "" };
    if (network && args.includes("net-info")) return { ok: true, stdout: network.info, stderr: "" };
    if (network && args.includes("net-dumpxml")) return { ok: true, stdout: network.xml, stderr: "" };
    return { ok: false, stdout: "", stderr: "not found" };
  });
  return createLibvirtFoundationHelper({ run, statFile: async () => { throw absent; }, loadRoutes: async () => "Iface\tDestination\n", loadDevices: async () => "Inter-| Receive\nlo: 0 0 0\n", ...quietSockets, ...loaders });
}

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
    expect(run.mock.calls.filter(([binary]) => binary.endsWith("systemctl"))).toHaveLength(1); // a successful start is not followed by systemctl show
    expect(clearApproval).toHaveBeenCalledTimes(2);
  });

  it("rejects noncanonical fixed-resource XML", () => {
    expect(libvirtFoundationInternals.canonicalNetworkXml(canonicalNetwork.replace("mode='nat'", "mode='bridge'"))).toBe(false);
    expect(libvirtFoundationInternals.canonicalPoolXml(canonicalPool.replace("/var/lib/libvirt/images", "/srv/vms"))).toBe(false);
  });

  it.each([
    ["core-dump", "Result=core-dump\nExecMainCode=3\nExecMainStatus=5", "The fixed libvirt foundation service's process died (signal 5) before the script ran; no libvirt resource was changed"],
    ["exit-code", "Result=exit-code\nExecMainCode=1\nExecMainStatus=1", "The fixed libvirt foundation service failed and requested automatic rollback (exit status 1)"],
    ["timeout", "Result=timeout\nExecMainCode=2\nExecMainStatus=15", "The fixed libvirt foundation service ran out of time and systemd stopped it before it finished"],
    ["signal", "Result=signal\nExecMainCode=2\nExecMainStatus=9", "The fixed libvirt foundation service's process was killed by signal 9 before it finished"],
    ["start-limit-hit", "Result=start-limit-hit\nExecMainCode=0\nExecMainStatus=0", "The fixed libvirt foundation service failed and requested automatic rollback"],
    ["(unreadable)", null, "The fixed libvirt foundation service failed and requested automatic rollback"],
  ])("tells the owner what a failed unit start with Result=%s means", async (_result, shown, message) => {
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("systemctl") && args[0] === "start") return { ok: false, stdout: "", stderr: "Job for boxpilot-libvirt-foundation.service failed.", code: 1 };
      if (binary.endsWith("systemctl") && args[0] === "show") return shown === null ? { ok: false, stdout: "", stderr: "Failed to get properties: Connection timed out", code: 1 } : { ok: true, stdout: shown, stderr: "" };
      if (binary.endsWith("virsh") && args.at(-1) === "uri") return { ok: true, stdout: "qemu:///system", stderr: "" };
      return { ok: false, stdout: "", stderr: "not found" };
    });
    const clearApproval = vi.fn();
    const helper = createLibvirtFoundationHelper({ run, writeApproval: vi.fn(), clearApproval, statFile: async () => { throw absent; }, loadRoutes: async () => "Iface\tDestination\n", loadDevices: async () => "Inter-| Receive\nlo: 0 0 0\n", ...quietSockets });
    const missing = await helper.inspect();
    await expect(helper.initialize({ foundationId: "123e4567-e89b-42d3-a456-426614174000", expectedRevision: missing.revision })).rejects.toThrow(new Error(message));
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["show", "boxpilot-libvirt-foundation.service", "-p", "Result", "-p", "ExecMainCode", "-p", "ExecMainStatus"], { timeout: 10000 });
    expect(run.mock.calls.filter(([binary]) => binary.endsWith("systemctl")).map(([, args]) => args[0])).toEqual(["start", "show"]);
    expect(clearApproval).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["UDP on every IPv4 address", { loadUdpSockets: async () => socketTable(["00000000:0035", "07"]) }],
    ["TCP on every IPv4 address", { loadTcpSockets: async () => socketTable(["00000000:0035", "0A"]) }],
    ["UDP on every IPv6 address", { loadUdp6Sockets: async () => socketTable([`${anyV6}:0035`, "07"]) }],
    ["TCP on every IPv6 address", { loadTcp6Sockets: async () => socketTable([`${anyV6}:0035`, "0A"]) }],
  ])("refuses a plan while another DNS server listens over %s and the network would need port 53", async (_where, loaders) => {
    const result = await bareHost(loaders).inspect();
    expect(result).toMatchObject({ planAvailable: false, dnsListenerOnEveryAddress: true, conflicts: [dnsConflict] });
    expect(result.revision).not.toBe((await bareHost().inspect()).revision);
  });

  it("ignores DNS servers bound to one address, other ports, and sockets that are not listening", async () => {
    const quiet = await bareHost().inspect();
    const result = await bareHost({
      loadUdpSockets: async () => socketTable(["0100007F:0035", "07"], ["00000000:0043", "07"]),
      loadUdp6Sockets: async () => socketTable(["0000000000000000FFFF00000A00000A:0035", "07"]),
      loadTcpSockets: async () => socketTable(["0A00000A:0035", "0A"], ["00000000:0035", "01"]),
      loadTcp6Sockets: async () => socketTable([`${anyV6}:0035`, "01"]),
    }).inspect();
    expect(result).toMatchObject({ planAvailable: true, dnsListenerOnEveryAddress: false, conflicts: [] });
    expect(result.revision).toBe(quiet.revision);
  });

  it("treats a socket table it cannot read as empty", async () => {
    const result = await bareHost({ loadUdpSockets: async () => { throw absent; }, loadTcpSockets: async () => { throw absent; } }).inspect();
    expect(result).toMatchObject({ planAvailable: true, dnsListenerOnEveryAddress: false, conflicts: [] });
  });

  it("does not flag the port while the default network is already active", async () => {
    const network = { info: "Active: yes\nPersistent: yes\nAutostart: no\nBridge: virbr0", xml: canonicalNetwork };
    const result = await bareHost({ network, loadUdpSockets: async () => socketTable(["00000000:0035", "07"]) }).inspect();
    expect(result).toMatchObject({ planAvailable: true, dnsListenerOnEveryAddress: true, conflicts: [], network: { exists: true, active: true, dnsEnabled: true } });
    expect(result.changes).toContain("Enable default network autostart");
  });

  it("does not flag the port when the default network is defined with its own DNS off", async () => {
    const network = { info: "Active: no\nPersistent: yes\nAutostart: no\nBridge: virbr0", xml: canonicalNetwork.replace("<ip address=", "<dns enable='no'/><ip address=") };
    const result = await bareHost({ network, loadUdpSockets: async () => socketTable(["00000000:0035", "07"]), loadTcpSockets: async () => socketTable(["00000000:0035", "0A"]) }).inspect();
    expect(result).toMatchObject({ planAvailable: true, dnsListenerOnEveryAddress: true, conflicts: [], network: { exists: true, active: false, compatible: true, dnsEnabled: false } });
    expect(result.changes).toContain("Start the fixed default NAT network");
  });

  it("flags the port for a defined, inactive network whose DNS is on", async () => {
    const network = { info: "Active: no\nPersistent: yes\nAutostart: no\nBridge: virbr0", xml: canonicalNetwork };
    const result = await bareHost({ network, loadUdpSockets: async () => socketTable(["00000000:0035", "07"]) }).inspect();
    expect(result).toMatchObject({ planAvailable: false, conflicts: [dnsConflict], network: { exists: true, active: false, dnsEnabled: true } });
  });
});
