import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNetworkService, networkInternals, validateNetworkPlanInput } from "./network.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const routes = JSON.stringify([{ dst: "default", gateway: "192.168.8.1", dev: "eno1", protocol: "static" }]);
const ipAddresses = JSON.stringify([
  { ifname: "eno1", addr_info: [{ family: "inet", local: "192.168.8.10", prefixlen: 24, scope: "global" }] },
  { ifname: "virbr0", addr_info: [{ family: "inet", local: "192.168.122.1", prefixlen: 24, scope: "global" }] },
  { ifname: "tailscale0", addr_info: [{ family: "inet", local: "100.64.0.10", prefixlen: 32, scope: "global" }] },
]);
const resolvers = JSON.stringify([
  { negativeTrustAnchors: [], resolvConfMode: "stub" },
  { ifname: "eno1", ifindex: 2, defaultRoute: true, currentServer: { addressString: "94.140.14.49" }, servers: [{ addressString: "94.140.14.49", port: 53, accessible: true }, { addressString: "94.140.14.59", port: 53, accessible: true }] },
  { ifname: "tailscale0", ifindex: 3, defaultRoute: false, servers: [{ addressString: "100.100.100.100", port: 53, accessible: true }] },
]);
const listeners = "udp UNCONN 0 0 192.168.122.1:53 0.0.0.0:*\ntcp LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*";
const tailscale = JSON.stringify({ BackendState: "Running", Self: { DNSName: "bigbox.example.ts.net." } });

function interfaces() {
  return {
    eno1: [{ address: "192.168.8.10", family: "IPv4", internal: false, cidr: "192.168.8.10/24" }],
    virbr0: [{ address: "192.168.122.1", family: "IPv4", internal: false, cidr: "192.168.122.1/24" }],
    tailscale0: [{ address: "100.64.0.10", family: "IPv4", internal: false, cidr: "100.64.0.10/32" }],
  };
}

function command() {
  return vi.fn(async (binary, args) => {
    if (binary === "ip" && args.includes("address")) return { ok: true, stdout: ipAddresses };
    if (binary === "ip") return { ok: true, stdout: routes };
    if (binary === "resolvectl") return { ok: true, stdout: resolvers };
    if (binary === "ss") return { ok: true, stdout: listeners };
    if (binary === "tailscale") return { ok: true, stdout: tailscale };
    return { ok: false, stdout: "" };
  });
}

function input(overrides = {}) {
  return {
    topology: "flint2-edge-tplink-ap",
    dnsRole: "current-external",
    gatewayAddress: "192.168.8.1",
    serverAddress: "192.168.8.10",
    dnsServiceAddress: "94.140.14.49",
    fallbackDnsAddress: "94.140.14.59",
    routerBackupRecorded: true,
    emergencyResolverTested: true,
    secondDeviceReady: true,
    tailscaleDnsOverride: false,
    ...overrides,
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-network-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const token = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(token.token, { username: "operator", passwordHash: "hash" });
  const runCommand = command();
  return { store, owner, runCommand, service: createNetworkService({ store, runCommand, getNetworkInterfaces: interfaces }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("network topology and DNS assessment", () => {
  it("returns sanitized fixed-command topology without neighbor MAC addresses or router credentials", async () => {
    const { store, runCommand, service } = await fixture();
    const result = await service.inspect();
    expect(result).toMatchObject({
      eligibleLanAddresses: [{ interface: "eno1", address: "192.168.8.10", cidr: "192.168.8.10/24" }],
      defaultRoutes: [{ gateway: "192.168.8.1", interface: "eno1", protocol: "static" }],
      defaultResolvers: ["94.140.14.49", "94.140.14.59"],
      tailscale: { connected: true, resolverPresent: true, defaultDnsObserved: false, overrideState: "non-tailscale-default-observed" },
      mutationSupported: false,
    });
    expect(result.dnsListeners).toEqual(expect.arrayContaining([
      { protocol: "udp", address: "192.168.122.1", port: 53, scope: "virtual", interface: "virbr0" },
      { protocol: "tcp", address: "127.0.0.53", port: 53, scope: "loopback", interface: null },
    ]));
    expect(runCommand.mock.calls).toEqual([
      ["ip", ["-j", "-4", "address", "show"]],
      ["ip", ["-j", "-4", "route", "show", "default"]],
      ["resolvectl", ["status", "--json=short"]],
      ["ss", ["-H", "-l", "-n", "-t", "-u"]],
      ["tailscale", ["status", "--json"]],
    ]);
    expect(JSON.stringify(result)).not.toContain("lladdr");
    store.close();
  });

  it("creates an attributable assessment while keeping all network mutation disabled", async () => {
    const { store, owner, service } = await fixture();
    const plan = await service.plan(input(), owner.id);
    expect(plan.type).toBe("network.dns.assessment");
    expect(plan.output).toMatchObject({ executable: false, readyForChangeWindow: true, routerMutationSupported: false, dnsCutoverSupported: false, blockers: [] });
    expect(plan.output.topology.summary).toContain("Flint 2 as the only edge router");
    expect(plan.output.observed.defaultResolvers).toEqual(["94.140.14.49", "94.140.14.59"]);
    store.close();
  });

  it("blocks unsafe DNS change windows and rejects arbitrary targets or commands", async () => {
    const { store, owner, service } = await fixture();
    const plan = await service.plan(input({
      dnsRole: "pihole-in-vm",
      dnsServiceAddress: "192.168.9.50",
      fallbackDnsAddress: "192.168.9.50",
      routerBackupRecorded: false,
      emergencyResolverTested: false,
      secondDeviceReady: false,
      tailscaleDnsOverride: true,
    }), owner.id);
    expect(plan.output.readyForChangeWindow).toBe(false);
    expect(plan.output.blockers.map((item) => item.id)).toEqual(expect.arrayContaining(["router-checkpoint", "emergency-resolver", "second-device", "resolver-diversity", "vm-dns-subnet"]));
    expect(plan.output.warnings.join(" ")).toContain("Tailscale DNS override is declared on");
    expect(validateNetworkPlanInput({ ...input(), command: "reboot" })).toContain("Network assessment accepts only the fixed topology and recovery fields");
    expect(validateNetworkPlanInput(input({ gatewayAddress: "../../etc" }))).toContain("gatewayAddress must be an IPv4 address");
    store.close();
  });

  it("does not confuse loopback or libvirt DNS with the reviewed Bigbox LAN binding", async () => {
    const { store, owner, service } = await fixture();
    const plan = await service.plan(input({ dnsRole: "pihole-on-bigbox", dnsServiceAddress: "192.168.8.10" }), owner.id);
    expect(plan.output.readyForChangeWindow).toBe(true);
    expect(plan.output.blockers.map((item) => item.id)).not.toContain("dns-listener-collision");
    expect(plan.output.warnings.join(" ")).toContain("Loopback and virtual-network DNS listeners are present");
    store.close();
  });

  it("degrades unavailable collectors without inventing topology", async () => {
    const { store } = await fixture();
    const service = createNetworkService({ store, runCommand: vi.fn(async () => ({ ok: false, stdout: "permission denied" })), getNetworkInterfaces: () => ({}) });
    const result = await service.inspect();
    expect(result).toMatchObject({ collectors: { addresses: false, routes: false, resolvers: false, listeners: false, tailscale: false }, defaultRoutes: [], defaultResolvers: [], dnsListeners: [], mutationSupported: false });
    expect(result.tailscale.connected).toBe(false);
    store.close();
  });

  it("parses only safe route and resolver data and checks IPv4 subnets", () => {
    expect(networkInternals.parseDefaultRoutes('[{"dst":"default","gateway":"192.168.8.1","dev":"eno1"},{"dst":"default","gateway":"bad","dev":"eno1;reboot"}]')).toEqual([{ gateway: "192.168.8.1", interface: "eno1", protocol: "unknown" }]);
    expect(networkInternals.parseResolverStatus("not-json")).toEqual([]);
    expect(networkInternals.parseIpAddresses('[{"ifname":"eno1","address":"not-returned","addr_info":[{"family":"inet","local":"192.168.8.10","prefixlen":24,"scope":"global"}]}]')).toEqual([{ interface: "eno1", address: "192.168.8.10", cidr: "192.168.8.10/24", family: 4, internal: false }]);
    expect(networkInternals.sameIpv4Subnet("192.168.8.50", "192.168.8.10/24")).toBe(true);
    expect(networkInternals.sameIpv4Subnet("192.168.9.50", "192.168.8.10/24")).toBe(false);
  });
});
