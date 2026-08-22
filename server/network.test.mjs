import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNetworkService, networkInternals, parseNeighbors, validateNetworkPlanInput } from "./network.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const routes = JSON.stringify([{ dst: "default", gateway: "192.168.1.1", dev: "eno1", protocol: "static" }]);
const ipAddresses = JSON.stringify([
  { ifname: "eno1", addr_info: [{ family: "inet", local: "192.168.1.10", prefixlen: 24, scope: "global" }] },
  { ifname: "virbr0", addr_info: [{ family: "inet", local: "192.168.122.1", prefixlen: 24, scope: "global" }] },
  { ifname: "tailscale0", addr_info: [{ family: "inet", local: "100.64.0.10", prefixlen: 32, scope: "global" }] },
]);
const resolvers = JSON.stringify([
  { negativeTrustAnchors: [], resolvConfMode: "stub" },
  { ifname: "eno1", ifindex: 2, defaultRoute: true, currentServer: { addressString: "94.140.14.49" }, servers: [{ addressString: "94.140.14.49", port: 53, accessible: true }, { addressString: "94.140.14.59", port: 53, accessible: true }] },
  { ifname: "tailscale0", ifindex: 3, defaultRoute: false, servers: [{ addressString: "100.100.100.100", port: 53, accessible: true }] },
]);
const listeners = "udp UNCONN 0 0 192.168.122.1:53 0.0.0.0:*\ntcp LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*";
const tailscale = JSON.stringify({ BackendState: "Running", Self: { DNSName: "homebox.example.ts.net." } });

function interfaces() {
  return {
    eno1: [{ address: "192.168.1.10", family: "IPv4", internal: false, cidr: "192.168.1.10/24" }],
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
    topology: "edge-router-with-access-points",
    dnsRole: "current-external",
    gatewayAddress: "192.168.1.1",
    serverAddress: "192.168.1.10",
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
  it("returns fixed-command topology and the neighbour table without router credentials", async () => {
    const { store, runCommand, service } = await fixture();
    const result = await service.inspect();
    expect(result).toMatchObject({
      eligibleLanAddresses: [{ interface: "eno1", address: "192.168.1.10", cidr: "192.168.1.10/24" }],
      defaultRoutes: [{ gateway: "192.168.1.1", interface: "eno1", protocol: "static" }],
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
      ["tailscale", ["status", "--json", "--peers=false"]],
      ["ip", ["-j", "-4", "neigh", "show"]],
      ["tailscale", ["debug", "prefs"]],
      ["ip", ["-j", "-4", "route", "show"]],
    ]);
    expect(Array.isArray(result.devices)).toBe(true);
    store.close();
  });

  it("parses resolved IPv4 neighbours with hardware addresses, reachable first", () => {
    const devices = parseNeighbors(JSON.stringify([
      { dst: "192.168.1.20", dev: "eno1", lladdr: "AA:BB:CC:DD:EE:02", state: ["STALE"] },
      { dst: "192.168.1.3", dev: "eno1", lladdr: "aa:bb:cc:dd:ee:01", state: ["REACHABLE"] },
      { dst: "192.168.1.99", dev: "eno1", state: ["FAILED"] },
      { dst: "fe80::1", dev: "eno1", lladdr: "aa:bb:cc:dd:ee:03", state: ["REACHABLE"] },
      { dst: "192.168.1.7", dev: "eno1", lladdr: "not-a-mac", state: ["REACHABLE"] },
    ]));
    expect(devices).toEqual([
      { address: "192.168.1.3", mac: "aa:bb:cc:dd:ee:01", interface: "eno1", state: "REACHABLE" },
      { address: "192.168.1.20", mac: "aa:bb:cc:dd:ee:02", interface: "eno1", state: "STALE" },
    ]);
    expect(parseNeighbors("not json")).toEqual([]);
  });

  it("correlates the observed gateway with role guidance without claiming device identity", async () => {
    const { store, service } = await fixture();
    const declaration = [{ name: "Hall router", role: "edge-router" }, { name: "Loft AP", role: "access-point" }, { name: "Bench box", role: "spare-or-lab" }];
    const result = await service.routerReadiness({ latestByRole: { "edge-router": null } }, declaration);
    expect(result).toMatchObject({
      recommendedTopology: { id: "edge-router-with-access-points" },
      alternateTopology: { id: "alternate-edge-router" },
      observedGateway: { address: "192.168.1.1", interface: "eno1" },
      counts: { verified: 2, "action-required": 1, "operator-check": 4, unavailable: 0 },
      declaredDevices: declaration,
    });
    expect(result).not.toHaveProperty("boundary");
    expect(result.roles.map((role) => role.id)).toEqual(["edge-router", "access-point", "spare-or-lab"]);
    expect(result.checks.find((check) => check.id === "gateway.observed")?.evidence).toContain("does not identify a router model");
    expect(result.checks.find((check) => check.id === "gateway.identity")?.state).toBe("operator-check");
    expect(result.checks.find((check) => check.id === "edge.checkpoint")?.state).toBe("action-required");
    expect(result.checks.find((check) => check.id === "access-point.mode")?.evidence).toContain("Loft AP");
    expect(result.checks.find((check) => check.id === "spare.out-of-path")?.evidence).toContain("Bench box");
    expect(result.guides).toHaveLength(3);
    expect(result.guides.find((guide) => guide.roleId === "access-point")?.steps.join(" ")).toContain("access-point mode in its own admin page");
    // Guidance is written for any consumer router, so it links to no vendor's documentation.
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
    expect(result).not.toHaveProperty("addresses");
    expect(result).not.toHaveProperty("resolverLinks");
    expect(result).not.toHaveProperty("dnsListeners");
    expect(result.observedGateway).not.toHaveProperty("macAddress");
    expect(result.observedGateway).not.toHaveProperty("vendor");
    store.close();
  });

  it("names the owner's own device in checkpoint evidence and rejects unusable labels", async () => {
    const { store, service } = await fixture();
    const checkpoint = { id: "router-checkpoint-one", deviceName: "Hall router", firmwareVersion: "1.4.0", checksumSha256: "a".repeat(64), sizeBytes: 4096, createdAt: "2026-08-15T00:00:00.000Z" };
    const result = await service.routerReadiness({ latestByRole: { "edge-router": checkpoint } }, [{ name: "Hall router", role: "edge-router" }]);
    expect(result.checks.find((check) => check.id === "edge.checkpoint")).toMatchObject({ state: "verified" });
    expect(result.checks.find((check) => check.id === "edge.checkpoint")?.evidence).toContain("Hall router on firmware 1.4.0");
    expect(result.checks.find((check) => check.id === "gateway.identity")).toMatchObject({ state: "operator-check" });
    expect(result.guides.find((guide) => guide.roleId === "edge-router")?.checkpoint).toEqual(checkpoint);

    // Free-text labels are capped and stripped of control characters; anything left over is not a name.
    expect(networkInternals.safeLabel("  Hall\u0000 router  ")).toBe("Hall router");
    expect(networkInternals.safeLabel("x".repeat(65))).toBe(null);
    expect(networkInternals.declaredDevices([{ name: "Hall router", role: "edge-router" }, { name: "", role: "edge-router" }, { name: "Loft AP", role: "not-a-role" }]))
      .toEqual([{ name: "Hall router", role: "edge-router" }]);
    const unnamed = await service.routerReadiness({ latestByRole: { "edge-router": { ...checkpoint, deviceName: "x".repeat(65) } } });
    expect(unnamed.checks.find((check) => check.id === "edge.checkpoint")?.evidence).toContain("your edge router on firmware");
    store.close();
  });

  it("creates an attributable assessment while keeping all network mutation disabled", async () => {
    const { store, owner, runCommand, service } = await fixture();
    const plan = await service.plan(input(), owner.id);
    expect(plan.type).toBe("network.dns.assessment");
    expect(plan.output).toMatchObject({ executable: false, readyForChangeWindow: true, routerMutationSupported: false, dnsCutoverSupported: false, blockers: [] });
    expect(plan.output.topology.summary).toContain("One router at the edge, everything else as access points");
    expect(plan.output.observed.defaultResolvers).toEqual(["94.140.14.49", "94.140.14.59"]);
    await expect(service.validateAssessment(plan.id, owner.id, "current-external")).resolves.toMatchObject({ id: plan.id });
    await expect(service.validateAssessment(plan.id, "different-owner", "current-external")).rejects.toThrow("not found");
    await expect(service.validateAssessment(plan.id, owner.id, "pihole-on-host")).rejects.toThrow("must use");
    runCommand.mockImplementation(async (binary, args) => {
      if (binary === "ip" && args.includes("address")) return { ok: true, stdout: ipAddresses };
      if (binary === "ip") return { ok: true, stdout: routes };
      if (binary === "resolvectl") return { ok: true, stdout: JSON.stringify([{ ifname: "eno1", defaultRoute: true, servers: [{ addressString: "1.1.1.1", port: 53, accessible: true }] }]) };
      if (binary === "ss") return { ok: true, stdout: listeners };
      return { ok: true, stdout: tailscale };
    });
    await expect(service.validateAssessment(plan.id, owner.id, "current-external")).rejects.toThrow("changed after");
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

  it("accepts the legacy hostname-specific DNS role id and normalizes it", async () => {
    const { store, owner, service } = await fixture();
    const plan = await service.plan(input({ dnsRole: "pihole-on-homebox", dnsServiceAddress: "192.168.1.10" }), owner.id);
    expect(plan.input.dnsRole).toBe("pihole-on-host");
    expect(plan.output.dns.role).toBe("pihole-on-host");
    await expect(service.validateAssessment(plan.id, owner.id, "pihole-on-host")).resolves.toMatchObject({ id: plan.id });
    expect(validateNetworkPlanInput(input({ dnsRole: "pihole-on-homebox" }))).toContain("DNS role is unsupported");
    store.close();
  });

  it("does not confuse loopback or libvirt DNS with the reviewed server LAN binding", async () => {
    const { store, owner, service } = await fixture();
    const plan = await service.plan(input({ dnsRole: "pihole-on-host", dnsServiceAddress: "192.168.1.10" }), owner.id);
    expect(plan.output.readyForChangeWindow).toBe(true);
    expect(plan.output.blockers.map((item) => item.id)).not.toContain("dns-listener-collision");
    expect(plan.output.warnings.join(" ")).toContain("Loopback and virtual-network DNS listeners are present");
    store.close();
  });

  it("revalidates a post-staging acceptance baseline with exact managed DNS listeners", async () => {
    const { store, owner, runCommand, service } = await fixture();
    const plan = await service.plan(input({ dnsRole: "pihole-on-host", dnsServiceAddress: "192.168.1.10" }), owner.id);
    runCommand.mockImplementation(async (binary, args) => {
      if (binary === "ip" && args.includes("address")) return { ok: true, stdout: ipAddresses };
      if (binary === "ip") return { ok: true, stdout: routes };
      if (binary === "resolvectl") return { ok: true, stdout: resolvers };
      if (binary === "ss") return { ok: true, stdout: `${listeners}\nudp UNCONN 0 0 192.168.1.10:53 0.0.0.0:*\ntcp LISTEN 0 4096 192.168.1.10:53 0.0.0.0:*` };
      return { ok: true, stdout: tailscale };
    });
    await expect(service.validateAcceptanceBaseline(plan.id, owner.id, "192.168.1.10")).resolves.toMatchObject({
      gatewayAddress: "192.168.1.1",
      resolverAddress: "192.168.1.10",
      exactTcpListener: true,
      exactUdpListener: true,
      assessmentOriginallyReady: true,
    });
    await expect(service.validateAcceptanceBaseline(plan.id, owner.id, "192.168.1.11")).rejects.toThrow("no longer matches");
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
    expect(networkInternals.parseDefaultRoutes('[{"dst":"default","gateway":"192.168.1.1","dev":"eno1"},{"dst":"default","gateway":"bad","dev":"eno1;reboot"}]')).toEqual([{ gateway: "192.168.1.1", interface: "eno1", protocol: "unknown" }]);
    expect(networkInternals.parseResolverStatus("not-json")).toEqual([]);
    expect(networkInternals.parseIpAddresses('[{"ifname":"eno1","address":"not-returned","addr_info":[{"family":"inet","local":"192.168.1.10","prefixlen":24,"scope":"global"}]}]')).toEqual([{ interface: "eno1", address: "192.168.1.10", cidr: "192.168.1.10/24", family: 4, internal: false }]);
    expect(networkInternals.sameIpv4Subnet("192.168.1.50", "192.168.1.10/24")).toBe(true);
    expect(networkInternals.sameIpv4Subnet("192.168.9.50", "192.168.1.10/24")).toBe(false);
  });
});
