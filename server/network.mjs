import { execFile as execFileCallback } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const topologyIds = new Set(["flint2-edge-tplink-ap", "omada-edge-access-points", "single-router", "custom"]);
const dnsRoleIds = new Set(["current-external", "flint2-adguard-home", "pihole-on-host", "pihole-in-vm", "other"]);
/** Older clients and stored plans used a hostname-specific role id; accept it and normalize. */
const legacyDnsRoleAliases = { "pihole-on-bigbox": "pihole-on-host" };

export function normalizeDnsRole(value) {
  return typeof value === "string" && value in legacyDnsRoleAliases ? legacyDnsRoleAliases[value] : value;
}

function normalizeNetworkPlanInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.dnsRole !== "string") return value;
  const dnsRole = normalizeDnsRole(value.dnsRole);
  return dnsRole === value.dnsRole ? value : { ...value, dnsRole };
}
const interfacePattern = /^[A-Za-z0-9_.:-]{1,32}$/;

const routerCatalog = [
  {
    id: "glinet-flint-2",
    name: "GL.iNet Flint 2",
    roles: ["edge-router", "wireless-access-point", "adguard-home-host"],
    integration: "read-only-declaration",
    note: "BoxPilot can plan around Flint 2 and its AdGuard Home role. It does not accept router credentials or change the router in this release.",
    officialSource: "https://docs.gl-inet.com/router/en/4/interface_guide/adguardhome/",
  },
  {
    id: "omada-er707-m2",
    name: "Omada ER707-M2",
    roles: ["edge-router", "vpn-gateway"],
    integration: "read-only-declaration",
    note: "Controller-backed discovery and configuration are pending. Keep it out of the forwarding path unless it is intentionally the only edge router.",
    officialSource: "https://www.omadanetworks.com/us/business-networking/omada-router-wired-router/er707-m2/",
  },
  {
    id: "tp-link-archer-be400",
    name: "TP-Link Archer BE400 (BE6500 class)",
    roles: ["wireless-router", "wireless-access-point"],
    integration: "read-only-declaration",
    note: "BoxPilot records the intended router or access-point role but does not log in to or configure the device.",
    officialSource: "https://www.tp-link.com/us/home-networking/wifi-router/archer-be400/",
  },
];

const routerGuides = [
  {
    modelId: "glinet-flint-2",
    intendedRole: "Only edge router, NAT authority, DHCP authority, and optional AdGuard Home host",
    mode: "Router mode",
    officialSources: [
      { label: "Flint 2 user guide", url: "https://docs.gl-inet.com/router/en/4/user_guide/gl-mt6000/" },
      { label: "GL.iNet network modes", url: "https://docs.gl-inet.com/router/en/4/interface_guide/network_mode/" },
      { label: "GL.iNet AdGuard Home", url: "https://docs.gl-inet.com/router/en/4/interface_guide/adguardhome/" },
    ],
    steps: [
      "Export the current Flint 2 configuration, retain it away from this server, and record its checksum in BoxPilot before changing the forwarding path.",
      "Use Router mode only if Flint 2 is the selected edge. Connect its WAN to the modem or upstream handoff and its LAN to the home switch or access points.",
      "Confirm Flint 2 is the only device providing NAT and DHCP before connecting downstream wireless equipment.",
      "For the later AdGuard Home change window, open APPLICATIONS > AdGuard Home. Review the vendor warning about Handle Client Requests before enabling anything.",
    ],
    verify: [
      "From the router interface, confirm its LAN address equals the gateway This server observes.",
      "From two LAN clients, confirm the same default gateway and only one DHCP authority.",
      "Confirm ordinary internet access and the existing this server's Tailscale path before any DNS work.",
      "Keep the current independent DNS resolvers active until separate server-side and second-device DNS acceptance passes.",
    ],
    rollback: "Disconnect Flint 2 from the forwarding path or restore its retained configuration using the vendor interface. Restore the previously working edge router and independent resolver before troubleshooting AdGuard Home.",
  },
  {
    modelId: "tp-link-archer-be400",
    intendedRole: "Wireless access point only",
    mode: "Access Point mode",
    officialSources: [
      { label: "Archer BE400 user guide", url: "https://static.tp-link.com/upload/manual/2025/202505/20250514/1910013703_Archer%20BE400_UG_REV1.0.0.pdf" },
      { label: "TP-Link access-point mode guide", url: "https://www.tp-link.com/us/support/faq/3774/" },
    ],
    steps: [
      "Export the current TP-Link configuration, retain it away from this server, and record its checksum in BoxPilot.",
      "While connected locally, open tplinkwifi.net and choose Advanced > System > Operation Mode > Access Point, then save. The router reboots.",
      "After reboot, connect it by Ethernet to the Flint 2 LAN or the downstream switch, then reopen its management page and complete Advanced > Quick Setup for Wi-Fi.",
      "Do not configure a second WAN, NAT, DHCP server, DNS advertisement, or port-forwarding boundary on this access point.",
    ],
    verify: [
      "Confirm the TP-Link interface reports Access Point mode.",
      "Confirm a connected client receives its gateway and DHCP lease from the selected edge router, not the TP-Link.",
      "Record the TP-Link management address assigned by the edge router so it can be reached after the mode change.",
      "Confirm Wi-Fi, ordinary DNS, and access to this server before removing the prior wireless path.",
    ],
    rollback: "Use a wired local connection and the retained vendor instructions or configuration to restore the prior mode. Reconnect the old wireless path before diagnosing coverage or roaming.",
  },
  {
    modelId: "omada-er707-m2",
    intendedRole: "Disconnected standby or isolated lab gateway",
    mode: "Outside the production forwarding path",
    officialSources: [
      { label: "ER707-M2 support", url: "https://support.omadanetworks.com/en/product/er707-m2/v1/" },
      { label: "ER707-M2 installation guide", url: "https://static.tp-link.com/upload/manual/2025/202509/20250905/7100001295_ER707-M2_IG_REV1.30.0.pdf" },
    ],
    steps: [
      "Keep the ER707-M2 disconnected from the production WAN and LAN while Flint 2 is the selected edge router.",
      "If testing it in a lab, use an isolated client and choose either Standalone mode at omadaer.net or Controller mode. Do not mix ownership models.",
      "Remember that adopting the gateway into an Omada Controller can override its standalone configuration.",
      "Export and retain a configuration checkpoint before promoting it to the edge in a separate reviewed change window.",
    ],
    verify: [
      "Confirm no production client uses the ER707-M2 as its default gateway or DHCP server.",
      "Confirm no cable creates a second path between production LAN and WAN.",
      "If it is later promoted, first replace the topology plan so it is the only edge router and both Wi-Fi routers are access points.",
    ],
    rollback: "Disconnect the ER707-M2 from production and restore the previously working single edge router. Do not leave two DHCP or NAT authorities connected.",
  },
];

function readinessCheck(id, state, title, evidence, action) {
  return { id, state, title, evidence, action };
}

function buildRouterReadiness(topology, checkpointStatus) {
  const routeCollector = topology.collectors.routes === true;
  const route = topology.defaultRoutes.length === 1 ? topology.defaultRoutes[0] : null;
  const flintCheckpoint = checkpointStatus.latestByModel?.["glinet-flint-2"] ?? null;
  const checks = [
    routeCollector && route
      ? readinessCheck("gateway.observed", "verified", "One live default gateway", `${route.gateway} is observed on ${route.interface}. This confirms the address and path only, not the router model.`, "Confirm in the Flint 2 interface that its LAN address is the observed gateway." )
      : routeCollector
        ? readinessCheck("gateway.observed", "action-required", "One live default gateway", `${topology.defaultRoutes.length} live default routes were observed.`, "Restore one unambiguous default route before changing router roles.")
        : readinessCheck("gateway.observed", "unavailable", "One live default gateway", "The fixed default-route collector is unavailable.", "Repair the host route collector and refresh this page."),
    readinessCheck("gateway.identity", "operator-check", "Gateway model identity", route ? `${route.gateway} is observed, but BoxPilot does not inspect neighbor tables, MAC addresses, router pages, or credentials.` : "No gateway identity can be correlated without a live route.", "Compare the observed address with the LAN address shown in the Flint 2 interface."),
    flintCheckpoint
      ? readinessCheck("flint.checkpoint", "verified", "Flint 2 recovery checkpoint", `Checkpoint ${flintCheckpoint.id} records firmware ${flintCheckpoint.firmwareVersion}, ${flintCheckpoint.sizeBytes} bytes, and a browser-reported SHA-256 digest.`, "Keep the original configuration file available away from this server.")
      : readinessCheck("flint.checkpoint", "action-required", "Flint 2 recovery checkpoint", "No Flint 2 configuration checksum is recorded.", "Export the configuration, retain it externally, then hash and record it below."),
    readinessCheck("routing.single-authority", "operator-check", "One NAT and DHCP authority", "Host routes cannot prove which downstream devices are running DHCP or NAT.", "Confirm Flint 2 is the only production router and DHCP server."),
    readinessCheck("tplink.ap-mode", "operator-check", "TP-Link access-point mode", "BoxPilot does not log in to the TP-Link or claim its operating mode.", "Confirm Advanced > System > Operation Mode reports Access Point."),
    readinessCheck("omada.out-of-path", "operator-check", "ER707-M2 outside production", "BoxPilot performs no discovery or network probe against the Omada gateway.", "Confirm the ER707-M2 is disconnected from the production forwarding path."),
    topology.tailscale.connected
      ? readinessCheck("recovery.tailscale", "verified", "Private recovery access", `${topology.tailscale.dnsName ?? "This server"} reports a connected Tailscale state.`, "Keep console access available during physical router changes.")
      : readinessCheck("recovery.tailscale", "action-required", "Private recovery access", "This server does not report connected Tailscale state.", "Restore Tailscale and confirm console access before changing the edge router."),
  ];
  const counts = Object.fromEntries(["verified", "action-required", "operator-check", "unavailable"].map((state) => [state, checks.filter((item) => item.state === state).length]));
  return {
    generatedAt: topology.generatedAt,
    recommendedTopology: {
      id: "flint2-edge-tplink-ap",
      summary: topologyGuidance("flint2-edge-tplink-ap").summary,
      rationale: "This gives AdGuard Home a supported router host while keeping one NAT and DHCP boundary. The ER707-M2 remains useful as a cold spare or isolated lab gateway.",
    },
    alternateTopology: {
      id: "omada-edge-access-points",
      summary: topologyGuidance("omada-edge-access-points").summary,
      gate: "Choose this only in a separate migration plan. Flint 2 AdGuard Home is unavailable when Flint 2 runs as an access point, so DNS needs a different reviewed host.",
    },
    observedGateway: route ? { address: route.gateway, interface: route.interface, protocol: route.protocol, modelVerified: false, identityClaim: "address-observed-model-unverified" } : null,
    checks,
    counts,
    guides: routerGuides.map((guide) => ({ ...guide, checkpoint: checkpointStatus.latestByModel?.[guide.modelId] ?? null })),
    sourceReviewedAt: "2026-08-16",
    boundary: {
      credentialsAccepted: false,
      routerSessionsOpened: false,
      neighborDiscoveryPerformed: false,
      arbitraryTargetsProbed: false,
      configurationUploaded: false,
      routerMutationSupported: false,
      dhcpMutationSupported: false,
      dnsCutoverSupported: false,
      tailscaleMutationSupported: false,
    },
  };
}

async function fixedCommand(command, args, { timeout = 5000 } = {}) {
  try {
    const result = await execFile(command, args, {
      timeout,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout.trim() : "", code: error.code ?? null };
  }
}

function exactKeys(value, expected) {
  const keys = Object.keys(value ?? {}).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function safeInterface(value) {
  return typeof value === "string" && interfacePattern.test(value) ? value : null;
}

function parseDefaultRoutes(output) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((route) => {
      const gateway = net.isIP(route?.gateway) === 4 ? route.gateway : null;
      const device = safeInterface(route?.dev);
      if (route?.dst !== "default" || !gateway || !device) return [];
      return [{ gateway, interface: device, protocol: typeof route.protocol === "string" && route.protocol.length <= 24 ? route.protocol : "unknown" }];
    }).slice(0, 4);
  } catch {
    return [];
  }
}

function parseResolverStatus(output) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((link) => {
      const interfaceName = link.ifname === undefined ? "global" : safeInterface(link.ifname);
      if (!interfaceName) return [];
      const servers = Array.isArray(link.servers) ? link.servers.flatMap((server) => {
        const address = net.isIP(server?.addressString) ? server.addressString : null;
        if (!address) return [];
        return [{ address, port: Number.isSafeInteger(server.port) ? server.port : 53, accessible: server.accessible === true }];
      }).slice(0, 8) : [];
      return [{ interface: interfaceName, defaultRoute: link.defaultRoute === true, currentServer: net.isIP(link.currentServer?.addressString) ? link.currentServer.addressString : null, servers }];
    }).filter((link) => link.servers.length > 0).slice(0, 16);
  } catch {
    return [];
  }
}

function normalizeAddress(value) {
  let address = value;
  if (address.startsWith("[") && address.includes("]")) address = address.slice(1, address.indexOf("]"));
  const zone = address.indexOf("%");
  return zone >= 0 ? address.slice(0, zone) : address;
}

function parseDnsListeners(output, addresses) {
  const addressInterfaces = new Map(addresses.map((item) => [item.address, item.interface]));
  const listeners = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || !["tcp", "udp"].includes(fields[0])) continue;
    const endpoint = fields.at(-2);
    const separator = endpoint?.lastIndexOf(":") ?? -1;
    if (separator < 0 || endpoint.slice(separator + 1) !== "53") continue;
    const address = normalizeAddress(endpoint.slice(0, separator));
    let scope = "other";
    let interfaceName = addressInterfaces.get(address) ?? null;
    if (["*", "0.0.0.0", "::"].includes(address)) scope = "wildcard";
    else if (address === "::1" || address.startsWith("127.")) scope = "loopback";
    else if (interfaceName) scope = interfaceName.startsWith("virbr") || interfaceName.startsWith("docker") || interfaceName.startsWith("br-") ? "virtual" : "host-address";
    listeners.push({ protocol: fields[0], address, port: 53, scope, interface: interfaceName });
  }
  return listeners.sort((left, right) => `${left.address}:${left.protocol}`.localeCompare(`${right.address}:${right.protocol}`)).slice(0, 32);
}

function hostAddresses(getNetworkInterfaces) {
  return Object.entries(getNetworkInterfaces()).flatMap(([interfaceName, entries]) => (entries ?? []).flatMap((entry) => {
    const family = entry.family === 4 || entry.family === "IPv4" ? 4 : entry.family === 6 || entry.family === "IPv6" ? 6 : 0;
    if (!family || net.isIP(entry.address) !== family) return [];
    return [{ interface: interfaceName, address: entry.address, cidr: entry.cidr ?? null, family, internal: entry.internal === true }];
  }));
}

function parseIpAddresses(output) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((link) => {
      const interfaceName = safeInterface(link?.ifname);
      if (!interfaceName || !Array.isArray(link.addr_info)) return [];
      return link.addr_info.flatMap((entry) => {
        if (entry?.family !== "inet" || net.isIP(entry.local) !== 4 || !Number.isInteger(entry.prefixlen) || entry.prefixlen < 0 || entry.prefixlen > 32) return [];
        return [{ interface: interfaceName, address: entry.local, cidr: `${entry.local}/${entry.prefixlen}`, family: 4, internal: interfaceName === "lo" || entry.scope === "host" }];
      });
    }).slice(0, 64);
  } catch {
    return [];
  }
}

function eligibleLanAddresses(addresses) {
  return addresses.filter((item) => item.family === 4 && !item.internal
    && !item.interface.startsWith("tailscale") && !item.interface.startsWith("docker")
    && !item.interface.startsWith("virbr") && !item.interface.startsWith("br-") && !item.interface.startsWith("veth"));
}

function ipv4Number(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split(".").reduce((number, part) => ((number << 8) | Number(part)) >>> 0, 0);
}

function sameIpv4Subnet(address, cidr) {
  if (typeof cidr !== "string" || !cidr.includes("/")) return false;
  const [networkAddress, prefixValue] = cidr.split("/");
  const prefix = Number(prefixValue);
  const left = ipv4Number(address);
  const right = ipv4Number(networkAddress);
  if (left === null || right === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (left & mask) === (right & mask);
}

export function validateNetworkPlanInput(value) {
  const expected = ["dnsRole", "dnsServiceAddress", "emergencyResolverTested", "fallbackDnsAddress", "gatewayAddress", "routerBackupRecorded", "secondDeviceReady", "serverAddress", "tailscaleDnsOverride", "topology"];
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, expected)) return ["Network assessment accepts only the fixed topology and recovery fields"];
  const errors = [];
  if (!topologyIds.has(value.topology)) errors.push("Topology is unsupported");
  if (!dnsRoleIds.has(value.dnsRole)) errors.push("DNS role is unsupported");
  for (const field of ["gatewayAddress", "serverAddress", "dnsServiceAddress", "fallbackDnsAddress"]) {
    if (net.isIP(value[field]) !== 4) errors.push(`${field} must be an IPv4 address`);
  }
  for (const field of ["routerBackupRecorded", "emergencyResolverTested", "secondDeviceReady", "tailscaleDnsOverride"]) {
    if (typeof value[field] !== "boolean") errors.push(`${field} must be true or false`);
  }
  return errors;
}

function topologyGuidance(topology) {
  if (topology === "flint2-edge-tplink-ap") return {
    summary: "Keep Flint 2 as the only edge router, NAT, and DHCP server. Run the TP-Link as an access point and leave the ER707-M2 outside the forwarding path unless it later replaces Flint 2.",
    devices: ["Flint 2: edge router and optional AdGuard Home", "TP-Link BE400: access point only", "ER707-M2: disconnected standby or lab device"],
  };
  if (topology === "omada-edge-access-points") return {
    summary: "Keep the ER707-M2 as the only edge router, NAT, and DHCP server. Put both wireless routers in access-point or bridge roles to avoid double NAT.",
    devices: ["ER707-M2: edge router", "Flint 2: access point or separately justified DNS appliance", "TP-Link BE400: access point only"],
  };
  if (topology === "single-router") return { summary: "Keep exactly one device responsible for routing, NAT, and DHCP.", devices: ["Current gateway: router and DHCP", "Any downstream Wi-Fi device: access point or bridge only"] };
  return { summary: "Document one edge gateway and verify that every downstream router is intentionally bridged or isolated.", devices: ["Custom topology requires manual role verification"] };
}

export function createNetworkService({ store, runCommand = fixedCommand, getNetworkInterfaces = os.networkInterfaces } = {}) {
  async function inspect() {
    const [addressesResult, routesResult, resolversResult, listenersResult, tailscaleResult] = await Promise.all([
      runCommand("ip", ["-j", "-4", "address", "show"]),
      runCommand("ip", ["-j", "-4", "route", "show", "default"]),
      runCommand("resolvectl", ["status", "--json=short"]),
      runCommand("ss", ["-H", "-l", "-n", "-t", "-u"]),
      runCommand("tailscale", ["status", "--json"]),
    ]);
    const addresses = addressesResult.ok ? parseIpAddresses(addressesResult.stdout) : hostAddresses(getNetworkInterfaces);
    const defaultRoutes = routesResult.ok ? parseDefaultRoutes(routesResult.stdout) : [];
    const resolverLinks = resolversResult.ok ? parseResolverStatus(resolversResult.stdout) : [];
    const dnsListeners = listenersResult.ok ? parseDnsListeners(listenersResult.stdout, addresses) : [];
    let tailscale = { connected: false, dnsName: null };
    if (tailscaleResult.ok) {
      try {
        const parsed = JSON.parse(tailscaleResult.stdout);
        tailscale = { connected: parsed.BackendState === "Running", dnsName: typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName.replace(/\.$/, "") : null };
      } catch {
        tailscale = { connected: false, dnsName: null };
      }
    }
    const defaultResolvers = resolverLinks.filter((link) => link.defaultRoute || link.interface === "global").flatMap((link) => link.servers.map((server) => server.address));
    const tailscaleResolvers = resolverLinks.filter((link) => link.interface.startsWith("tailscale")).flatMap((link) => link.servers.map((server) => server.address));
    return {
      generatedAt: new Date().toISOString(),
      collectors: { addresses: addressesResult.ok, routes: routesResult.ok, resolvers: resolversResult.ok, listeners: listenersResult.ok, tailscale: tailscaleResult.ok },
      addresses,
      eligibleLanAddresses: eligibleLanAddresses(addresses),
      defaultRoutes,
      resolverLinks,
      defaultResolvers,
      tailscale: {
        ...tailscale,
        resolverPresent: tailscaleResolvers.includes("100.100.100.100"),
        defaultDnsObserved: defaultResolvers.includes("100.100.100.100"),
        overrideState: defaultResolvers.includes("100.100.100.100") ? "tailscale-default-observed" : "non-tailscale-default-observed",
      },
      dnsListeners,
      routerCatalog,
      mutationSupported: false,
    };
  }

  async function buildAssessment(rawInput) {
    const input = normalizeNetworkPlanInput(rawInput);
    const errors = validateNetworkPlanInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    const topology = await inspect();
    const blockers = [];
    const warnings = [];
    const route = topology.defaultRoutes.find((item) => item.gateway === input.gatewayAddress);
    const server = topology.eligibleLanAddresses.find((item) => item.address === input.serverAddress);
    if (!route) blockers.push({ id: "gateway-live-match", summary: "The declared gateway does not match a live default route" });
    if (!server) blockers.push({ id: "server-address-live-match", summary: "The declared server address is not an eligible live LAN address" });
    if (input.gatewayAddress === input.serverAddress) blockers.push({ id: "gateway-server-collision", summary: "The gateway and BoxPilot server cannot share an address" });
    if (input.dnsServiceAddress === input.fallbackDnsAddress) blockers.push({ id: "resolver-diversity", summary: "Primary and emergency resolver addresses must differ" });
    if (!input.routerBackupRecorded) blockers.push({ id: "router-checkpoint", summary: "Record or export the router configuration before a DNS change" });
    if (!input.emergencyResolverTested) blockers.push({ id: "emergency-resolver", summary: "Test the emergency resolver path before a DNS change" });
    if (!input.secondDeviceReady) blockers.push({ id: "second-device", summary: "Keep a second LAN device ready for independent DNS verification" });
    if (!topology.tailscale.connected) blockers.push({ id: "tailscale-access", summary: "Restore private Tailscale access before changing network-critical DNS" });
    if (input.tailscaleDnsOverride) warnings.push("Tailscale DNS override is declared on. A DNS appliance outage can affect tailnet clients until the control-plane nameserver is changed or override is disabled.");
    else warnings.push("Tailscale DNS override is declared off. BoxPilot will preserve that recovery boundary.");
    if (topology.tailscale.defaultDnsObserved !== input.tailscaleDnsOverride) warnings.push("The operator declaration and the host's observed default resolver path differ. Verify Tailscale DNS policy before cutover.");

    if (input.dnsRole === "flint2-adguard-home" && input.dnsServiceAddress !== input.gatewayAddress) blockers.push({ id: "flint-dns-address", summary: "Flint 2 AdGuard Home must be planned at the declared Flint gateway address" });
    if (input.dnsRole === "pihole-on-host" && input.dnsServiceAddress !== input.serverAddress) blockers.push({ id: "host-dns-address", summary: "Pi-hole on this server must use the declared live server LAN address" });
    if (input.dnsRole === "pihole-in-vm") {
      if (!server?.cidr || !sameIpv4Subnet(input.dnsServiceAddress, server.cidr)) blockers.push({ id: "vm-dns-subnet", summary: "The dedicated Pi-hole VM address must be inside the live server LAN subnet" });
      if ([input.serverAddress, input.gatewayAddress].includes(input.dnsServiceAddress)) blockers.push({ id: "vm-dns-address-collision", summary: "The dedicated Pi-hole VM address must differ from this server and the gateway" });
    }
    if (["pihole-on-host", "pihole-in-vm", "flint2-adguard-home"].includes(input.dnsRole) && net.isIP(input.fallbackDnsAddress) !== 4) blockers.push({ id: "fallback-dns", summary: "A valid emergency resolver is required" });
    if (input.dnsRole === "current-external" && topology.defaultResolvers.length && !topology.defaultResolvers.includes(input.dnsServiceAddress)) warnings.push("The declared primary external resolver is not one of the host's observed default resolvers.");
    if (input.dnsRole === "pihole-on-host") {
      const collision = topology.dnsListeners.some((listener) => listener.scope === "wildcard" || listener.address === input.serverAddress);
      if (collision) blockers.push({ id: "dns-listener-collision", summary: "A TCP or UDP port 53 listener already occupies the planned server LAN binding" });
      if (topology.dnsListeners.some((listener) => listener.scope === "loopback" || listener.scope === "virtual")) warnings.push("Loopback and virtual-network DNS listeners are present. A future adapter must bind only the reviewed server LAN address, not every interface.");
    }

    const guidance = topologyGuidance(input.topology);
    const output = {
      executable: false,
      readyForChangeWindow: blockers.length === 0,
      topology: guidance,
      observed: {
        gateway: route ?? null,
        server: server ?? null,
        defaultResolvers: topology.defaultResolvers,
        dnsListeners: topology.dnsListeners,
        tailscale: topology.tailscale,
      },
      dns: { role: input.dnsRole, primary: input.dnsServiceAddress, emergency: input.fallbackDnsAddress },
      blockers,
      warnings,
      changes: [
        "No router, host, Tailscale, DNS, firewall, DHCP, or application setting will be changed by this assessment",
        "Capture an external router checkpoint and keep the current resolver available",
        `Prepare ${input.dnsServiceAddress} as the proposed primary resolver only after its own backup and health gates pass`,
        "Test DNS from this server and a second LAN device before advertising the new resolver",
        `Keep ${input.fallbackDnsAddress} available while the new resolver proves stable`,
      ],
      recovery: [
        `Restore router DNS advertisement to ${input.fallbackDnsAddress}`,
        "Verify ordinary DNS from the second device without relying on this server",
        "Keep Tailscale DNS override off or restore its independent resolver before troubleshooting the new service",
        "Do not stop or delete the previous DNS service until the rollback window closes",
      ],
      routerMutationSupported: false,
      dnsCutoverSupported: false,
    };
    return output;
  }

  async function routerReadiness(checkpointStatus) {
    return buildRouterReadiness(await inspect(), checkpointStatus);
  }

  async function plan(rawInput, ownerId) {
    const input = normalizeNetworkPlanInput(rawInput);
    const output = await buildAssessment(input);
    return store.createPlan({ type: "network.dns.assessment", subjectId: input.topology, input, output, createdBy: ownerId });
  }

  async function validateAssessment(planId, ownerId, expectedDnsRole) {
    const assessment = store.getPlan(planId);
    if (!assessment || assessment.createdBy !== ownerId || assessment.type !== "network.dns.assessment") throw new Error("Network assessment not found");
    if (assessment.expired) throw new Error("Network assessment expired; refresh topology and create a new assessment");
    if (normalizeDnsRole(assessment.input.dnsRole) !== expectedDnsRole) throw new Error(`Network assessment must use the ${expectedDnsRole} DNS role`);
    if (assessment.output.readyForChangeWindow !== true || assessment.output.blockers?.length) throw new Error("Network assessment has unresolved recovery or topology blockers");
    const current = await buildAssessment(assessment.input);
    if (current.readyForChangeWindow !== true || JSON.stringify(current) !== JSON.stringify(assessment.output)) throw new Error("Live gateway, resolver, listener, address, Tailscale, or recovery evidence changed after the network assessment");
    return assessment;
  }

  async function validateAcceptanceBaseline(planId, ownerId, resolverAddress) {
    const assessment = store.getPlan(planId);
    if (!assessment || assessment.createdBy !== ownerId || assessment.type !== "network.dns.assessment") throw new Error("Linked network assessment was not found");
    if (normalizeDnsRole(assessment.input.dnsRole) !== "pihole-on-host") throw new Error("Linked network assessment is not for Pi-hole on this server");
    if (assessment.output.readyForChangeWindow !== true || assessment.output.blockers?.length) throw new Error("Linked network assessment did not pass its original recovery and topology gates");
    if (assessment.input.serverAddress !== resolverAddress || assessment.input.dnsServiceAddress !== resolverAddress) throw new Error("Managed Pi-hole no longer matches the reviewed resolver address");
    if (!assessment.input.routerBackupRecorded || !assessment.input.emergencyResolverTested || !assessment.input.secondDeviceReady) throw new Error("Linked network assessment is missing a required recovery declaration");
    if (assessment.input.dnsServiceAddress === assessment.input.fallbackDnsAddress) throw new Error("The independent emergency resolver must differ from Pi-hole");

    const topology = await inspect();
    if (!topology.defaultRoutes.some((route) => route.gateway === assessment.input.gatewayAddress)) throw new Error("The reviewed gateway no longer matches a live default route");
    if (!topology.eligibleLanAddresses.some((address) => address.address === resolverAddress)) throw new Error("The reviewed Pi-hole address is no longer a live eligible server LAN address");
    if (!topology.tailscale.connected) throw new Error("Private Tailscale recovery access is unavailable");
    if (topology.tailscale.defaultDnsObserved !== assessment.input.tailscaleDnsOverride) throw new Error("The observed Tailscale default-DNS boundary changed after staging");
    const matchingListeners = topology.dnsListeners.filter((listener) => listener.address === resolverAddress && listener.port === 53);
    if (!matchingListeners.some((listener) => listener.protocol === "tcp") || !matchingListeners.some((listener) => listener.protocol === "udp")) throw new Error("The exact reviewed Pi-hole TCP and UDP DNS listeners are not both present");
    if (topology.dnsListeners.some((listener) => listener.scope === "wildcard")) throw new Error("A wildcard DNS listener is present; BoxPilot cannot attribute the intended resolver safely");

    return {
      gatewayAddress: assessment.input.gatewayAddress,
      resolverAddress,
      fallbackDnsAddress: assessment.input.fallbackDnsAddress,
      tailscaleDnsOverride: assessment.input.tailscaleDnsOverride,
      tailscaleConnected: true,
      exactTcpListener: true,
      exactUdpListener: true,
      assessmentOriginallyReady: true,
    };
  }

  return { inspect, plan, routerReadiness, validateAssessment, validateAcceptanceBaseline };
}

export const networkInternals = { buildRouterReadiness, eligibleLanAddresses, hostAddresses, ipv4Number, parseDefaultRoutes, parseDnsListeners, parseIpAddresses, parseResolverStatus, routerCatalog, routerGuides, sameIpv4Subnet, topologyGuidance };
