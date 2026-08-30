import { execFile as execFileCallback } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const topologyIds = new Set(["edge-router-with-access-points", "alternate-edge-router", "single-router", "custom"]);
const dnsRoleIds = new Set(["current-external", "router-hosted-resolver", "pihole-on-host", "pihole-in-vm", "other"]);
/** Older clients and stored plans used a hostname-specific role id; accept it and normalize. */
const legacyDnsRolePattern = /^pihole-on-(?!host$)[a-z0-9-]+$/;

export function normalizeDnsRole(value) {
  return typeof value === "string" && legacyDnsRolePattern.test(value) ? "pihole-on-host" : value;
}

function normalizeNetworkPlanInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.dnsRole !== "string") return value;
  const dnsRole = normalizeDnsRole(value.dnsRole);
  return dnsRole === value.dnsRole ? value : { ...value, dnsRole };
}
const interfacePattern = /^[A-Za-z0-9_.:-]{1,32}$/;

/** Roles the owner assigns to their own hardware. BoxPilot plans around the role, not a model. */
const deviceRoles = [
  {
    id: "edge-router",
    name: "Edge router",
    summary: "The one device doing NAT and DHCP for the LAN. Its address is the default gateway this server observes, and its configuration checkpoint is the recovery path if a change goes wrong.",
  },
  {
    id: "access-point",
    name: "Access point",
    summary: "Wireless coverage bridged to the edge router. Switch it to access-point mode in its own admin page so it does not add a second NAT boundary or a competing DHCP server.",
  },
  {
    id: "spare-or-lab",
    name: "Spare or lab device",
    summary: "A router kept out of the forwarding path as a cold spare or on an isolated lab network until a reviewed change window promotes it.",
  },
];

const deviceRoleIds = new Set(deviceRoles.map((role) => role.id));
const labelMaximum = 64;

/** Owner-typed labels (device names, firmware strings) stay short printable text, never a payload. */
function safeLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.replace(/\p{C}/gu, " ").trim().replace(/\s+/g, " ");
  return label.length > 0 && label.length <= labelMaximum ? label : null;
}

function declaredDevices(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const name = safeLabel(entry?.name);
    return name && deviceRoleIds.has(entry?.role) ? [{ name, role: entry.role }] : [];
  }).slice(0, 8);
}

function namesInRole(devices, role) {
  return devices.filter((device) => device.role === role).map((device) => device.name);
}

const roleGuides = [
  {
    roleId: "edge-router",
    intendedRole: "The only NAT authority, DHCP authority, and LAN gateway",
    mode: "Router mode",
    steps: [
      "Export the current configuration from the router's own admin page, keep the file away from this server, and record its checksum in BoxPilot before changing the forwarding path.",
      "Connect its WAN port to the modem or upstream handoff and its LAN port to the switch or the access points.",
      "Confirm it is the only device offering NAT and DHCP before connecting downstream wireless equipment.",
      "Leave DNS advertisement as it is; a resolver change belongs in its own reviewed change window.",
    ],
    verify: [
      "In the router's admin page, confirm its LAN address is the gateway this server observes.",
      "From two LAN clients, confirm the same default gateway and a single DHCP server.",
      "Confirm ordinary internet access and this server's Tailscale path before any DNS work.",
      "Keep the current independent resolvers active until server-side and second-device DNS acceptance both pass.",
    ],
    rollback: "Restore the retained configuration from the router's own admin page, or put the previous edge router back in the path. Bring the independent resolver back before troubleshooting anything else.",
  },
  {
    roleId: "access-point",
    intendedRole: "Wireless coverage only",
    mode: "Access-point mode",
    steps: [
      "Export the current configuration from the device's own admin page, keep the file away from this server, and record its checksum in BoxPilot.",
      "While connected to it locally, put the second router into access-point mode in its own admin page and save. Most consumer routers reboot into the new mode.",
      "After the reboot, connect it by Ethernet to the edge router's LAN or the downstream switch, then reopen its admin page and set up Wi-Fi.",
      "Leave WAN, NAT, DHCP, DNS advertisement, and port forwarding switched off on this device.",
    ],
    verify: [
      "Confirm the device's own admin page reports access-point or bridge mode.",
      "Confirm a client connected to it receives its gateway and DHCP lease from the edge router.",
      "Record the management address the edge router assigned it so it stays reachable after the mode change.",
      "Confirm Wi-Fi, ordinary DNS, and access to this server before removing the previous wireless path.",
    ],
    rollback: "Use a wired local connection and the retained configuration to restore the previous mode. Reconnect the old wireless path before diagnosing coverage or roaming.",
  },
  {
    roleId: "spare-or-lab",
    intendedRole: "Cold spare or isolated lab gateway",
    mode: "Outside the production forwarding path",
    steps: [
      "Keep it disconnected from the production WAN and LAN while another device is the edge router.",
      "For lab work, put it on an isolated client and network so its DHCP server cannot answer production clients.",
      "Export and retain a configuration checkpoint before promoting it to the edge in a separate reviewed change window.",
    ],
    verify: [
      "Confirm no production client uses it as a default gateway or DHCP server.",
      "Confirm no cable creates a second path between the production LAN and WAN.",
      "Before promoting it, replace the topology plan so it becomes the only edge router and every other wireless device becomes an access point.",
    ],
    rollback: "Disconnect it from production and restore the previously working single edge router. Two NAT or DHCP authorities on one LAN break name resolution in ways that are hard to diagnose.",
  },
];

function readinessCheck(id, state, title, evidence, action) {
  return { id, state, title, evidence, action };
}

function buildRouterReadiness(topology, checkpointStatus, declaration) {
  const checkpoints = checkpointStatus?.latestByRole ?? {};
  const devices = declaredDevices(declaration);
  const edgeNames = namesInRole(devices, "edge-router");
  const edgeRouter = edgeNames.join(" and ") || "your edge router";
  const routeCollector = topology.collectors.routes === true;
  const route = topology.defaultRoutes.length === 1 ? topology.defaultRoutes[0] : null;
  const edgeCheckpoint = checkpoints["edge-router"] ?? null;
  const checkpointDevice = safeLabel(edgeCheckpoint?.deviceName) ?? edgeRouter;
  const checkpointFirmware = safeLabel(edgeCheckpoint?.firmwareVersion) ?? "an unrecorded version";
  const checks = [
    routeCollector && route
      ? readinessCheck("gateway.observed", "verified", "One live default gateway", `${route.gateway} is observed on ${route.interface}. That is the address and the path; it does not identify a router model.`, `Confirm in the admin page of ${edgeRouter} that its LAN address is the observed gateway.`)
      : routeCollector
        ? readinessCheck("gateway.observed", "action-required", "One live default gateway", `${topology.defaultRoutes.length} live default routes were observed.`, "Restore one unambiguous default route before changing router roles.")
        : readinessCheck("gateway.observed", "unavailable", "One live default gateway", "The fixed default-route collector is unavailable.", "Repair the host route collector and refresh this page."),
    readinessCheck("gateway.identity", "operator-check", "Gateway identity", route ? `${route.gateway} answers as the gateway. An address does not identify a router model, so the device behind it is whatever you declare it to be.` : "No gateway identity can be correlated without a live route.", `Compare the observed address with the LAN address shown in the admin page of ${edgeRouter}.`),
    edgeCheckpoint
      ? readinessCheck("edge.checkpoint", "verified", "Edge router recovery checkpoint", `Checkpoint ${edgeCheckpoint.id} records ${checkpointDevice} on firmware ${checkpointFirmware}, ${edgeCheckpoint.sizeBytes} bytes, and a browser-computed SHA-256 digest.`, "Keep the original configuration file available away from this server.")
      : readinessCheck("edge.checkpoint", "action-required", "Edge router recovery checkpoint", `No configuration checksum is recorded for ${edgeRouter}.`, "Export the configuration, retain it externally, then hash and record it below."),
    readinessCheck("routing.single-authority", "operator-check", "One NAT and DHCP authority", "Host routes cannot show which downstream devices are running DHCP or NAT.", `Confirm ${edgeRouter} is the only device on the LAN doing NAT and handing out DHCP leases.`),
    topology.tailscale.connected
      ? readinessCheck("recovery.tailscale", "verified", "Private recovery access", `${topology.tailscale.dnsName ?? "This server"} reports a connected Tailscale state.`, "Keep console access available during physical router changes.")
      : readinessCheck("recovery.tailscale", "action-required", "Private recovery access", "This server does not report connected Tailscale state.", "Restore Tailscale and confirm console access before changing the edge router."),
  ];
  const accessPoints = namesInRole(devices, "access-point");
  if (accessPoints.length) checks.push(readinessCheck("access-point.mode", "operator-check", "Access-point mode", `You declared ${accessPoints.join(", ")} as access points. Their operating mode is only visible in their own admin pages.`, "Confirm each one reports access-point or bridge mode, with its DHCP server switched off."));
  const spares = namesInRole(devices, "spare-or-lab");
  if (spares.length) checks.push(readinessCheck("spare.out-of-path", "operator-check", "Spare devices out of the path", `You declared ${spares.join(", ")} as spare or lab devices.`, "Confirm each one is disconnected from the production forwarding path or sits on an isolated lab network."));
  const counts = Object.fromEntries(["verified", "action-required", "operator-check", "unavailable"].map((state) => [state, checks.filter((item) => item.state === state).length]));
  return {
    generatedAt: topology.generatedAt,
    roles: deviceRoles,
    declaredDevices: devices,
    recommendedTopology: {
      id: "edge-router-with-access-points",
      summary: topologyGuidance("edge-router-with-access-points").summary,
      rationale: "One NAT and DHCP boundary is the shape that stays diagnosable, and it leaves every other router useful as an access point or a cold spare.",
    },
    alternateTopology: {
      id: "alternate-edge-router",
      summary: topologyGuidance("alternate-edge-router").summary,
      gate: "Plan this as its own change window: the outgoing edge router has to drop to access-point mode first, and anything it hosted needs a new home before the swap.",
    },
    observedGateway: route ? { address: route.gateway, interface: route.interface, protocol: route.protocol } : null,
    checks,
    counts,
    guides: roleGuides.map((guide) => ({ ...guide, checkpoint: checkpoints[guide.roleId] ?? null })),
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
  if (topology === "edge-router-with-access-points") return {
    summary: "One router at the edge, everything else as access points. The edge router is the only NAT and DHCP authority; a second router that keeps its own WAN adds double NAT, and a second DHCP server hands clients the wrong gateway.",
    devices: ["Edge router: NAT, DHCP, and the LAN gateway", "Second router: access point only, no WAN and no DHCP", "Spare or lab device: out of the production forwarding path"],
  };
  if (topology === "alternate-edge-router") return {
    summary: "A different device at the edge. It becomes the only NAT and DHCP authority, and the router it replaces drops to access-point or bridge mode. Leaving both routing creates double NAT and competing DHCP servers on one LAN.",
    devices: ["New edge router: NAT, DHCP, and the LAN gateway", "Previous edge router: access point or bridge only", "Any other wireless device: access point only"],
  };
  if (topology === "single-router") return { summary: "Keep exactly one device responsible for routing, NAT, and DHCP.", devices: ["Current gateway: router and DHCP", "Any downstream Wi-Fi device: access point or bridge only"] };
  return { summary: "Document one edge gateway and verify that every downstream router is intentionally bridged or isolated.", devices: ["Custom topology requires manual role verification"] };
}

const macPattern = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

/** `ip -j neigh show`: resolved IPv4 neighbours with a hardware address, newest state first. */
export function parseNeighbors(stdout) {
  let entries;
  try { entries = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(entries)) return [];
  const order = { REACHABLE: 0, DELAY: 1, PROBE: 2, STALE: 3 };
  return entries
    .filter((entry) => typeof entry?.dst === "string" && net.isIP(entry.dst) === 4 && typeof entry.lladdr === "string" && macPattern.test(entry.lladdr))
    .map((entry) => ({ address: entry.dst, mac: entry.lladdr.toLowerCase(), interface: typeof entry.dev === "string" ? entry.dev : null, state: (Array.isArray(entry.state) ? entry.state[0] : String(entry.state ?? "")).toUpperCase() || "UNKNOWN" }))
    .filter((entry) => entry.state in order)
    .sort((left, right) => (order[left.state] - order[right.state]) || left.address.localeCompare(right.address, undefined, { numeric: true }));
}

/**
 * `tailscale status --json` with peers: every device on the owner's tailnet, reduced to what the
 * Network page shows. Keys and endpoint details stay out; names, addresses, and roles come through.
 */
export function parseTailnetPeers(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return { connected: false, self: null, peers: [] }; }
  const ipv4 = (value) => typeof value === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(value);
  const shape = (node, isSelf) => ({
    name: typeof node.DNSName === "string" && node.DNSName ? node.DNSName.split(".")[0] : (node.HostName ?? "unknown"),
    dnsName: typeof node.DNSName === "string" ? node.DNSName.replace(/\.$/, "") : null,
    address: (node.TailscaleIPs ?? []).find(ipv4) ?? null,
    os: typeof node.OS === "string" ? node.OS : null,
    online: isSelf ? true : Boolean(node.Online),
    lastSeen: typeof node.LastSeen === "string" && !node.LastSeen.startsWith("0001-") ? node.LastSeen : null,
    exitNode: Boolean(node.ExitNodeOption),
    // Approved subnet routes this node serves (its own /32 addresses are not routes).
    subnetRoutes: (node.PrimaryRoutes ?? []).filter((entry) => typeof entry === "string" && !entry.includes(":")),
    // A peer with a current direct address talks peer-to-peer; otherwise traffic bounces off a relay.
    direct: isSelf ? null : Boolean(node.CurAddr),
    relay: typeof node.Relay === "string" && node.Relay ? node.Relay : null,
    isSelf,
  });
  const self = parsed.Self ? shape(parsed.Self, true) : null;
  const peers = Object.values(parsed.Peer ?? {}).map((peer) => shape(peer, false))
    .sort((left, right) => (Number(right.online) - Number(left.online)) || left.name.localeCompare(right.name));
  return { connected: parsed.BackendState === "Running", self, peers };
}

export function createNetworkService({ store, runCommand = fixedCommand, getNetworkInterfaces = os.networkInterfaces } = {}) {
  /** The whole tailnet as this server sees it (read-only; runs unprivileged). */
  async function tailnet() {
    const result = await runCommand("tailscale", ["status", "--json"]);
    if (!result.ok) return { available: false, connected: false, self: null, peers: [] };
    return { available: true, ...parseTailnetPeers(result.stdout) };
  }

  async function inspect() {
    const [addressesResult, routesResult, resolversResult, listenersResult, tailscaleResult, neighborsResult, prefsResult, allRoutesResult] = await Promise.all([
      runCommand("ip", ["-j", "-4", "address", "show"]),
      runCommand("ip", ["-j", "-4", "route", "show", "default"]),
      runCommand("resolvectl", ["status", "--json=short"]),
      runCommand("ss", ["-H", "-l", "-n", "-t", "-u"]),
      runCommand("tailscale", ["status", "--json", "--peers=false"]),
      runCommand("ip", ["-j", "-4", "neigh", "show"]),
      runCommand("tailscale", ["debug", "prefs"]),
      runCommand("ip", ["-j", "-4", "route", "show"]),
    ]);
    const devices = neighborsResult.ok ? parseNeighbors(neighborsResult.stdout) : [];
    const addresses = addressesResult.ok ? parseIpAddresses(addressesResult.stdout) : hostAddresses(getNetworkInterfaces);
    const defaultRoutes = routesResult.ok ? parseDefaultRoutes(routesResult.stdout) : [];
    const resolverLinks = resolversResult.ok ? parseResolverStatus(resolversResult.stdout) : [];
    const dnsListeners = listenersResult.ok ? parseDnsListeners(listenersResult.stdout, addresses) : [];
    let tailscale = { connected: false, dnsName: null, address: null, exitNodeAdvertised: null, advertisedRoutes: [], approvedRoutes: [], lanSubnets: [] };
    if (tailscaleResult.ok) {
      try {
        const parsed = JSON.parse(tailscaleResult.stdout);
        const ipv4 = (value) => typeof value === "string" && /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(value);
        tailscale = {
          ...tailscale,
          connected: parsed.BackendState === "Running",
          dnsName: typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName.replace(/\.$/, "") : null,
          address: (parsed.TailscaleIPs ?? parsed.Self?.TailscaleIPs ?? []).find(ipv4) ?? null,
          exitNodeAdvertised: Boolean(parsed.Self?.ExitNodeOption),
          // AllowedIPs carries the node's own addresses plus every route the admin approved.
          approvedRoutes: (parsed.Self?.AllowedIPs ?? []).filter((entry) => ipv4(entry) && !entry.startsWith("100.") && !entry.endsWith("/32")),
        };
      } catch {
        tailscale = { ...tailscale, connected: false, dnsName: null };
      }
    }
    if (prefsResult.ok) {
      try { const prefs = JSON.parse(prefsResult.stdout); tailscale.advertisedRoutes = (prefs.AdvertiseRoutes ?? []).filter((entry) => typeof entry === "string" && !entry.includes(":") && entry !== "0.0.0.0/0"); if (typeof prefs.AdvertiseExitNode === "boolean") tailscale.exitNodeAdvertised = tailscale.exitNodeAdvertised || prefs.AdvertiseExitNode; } catch { /* prefs are optional */ }
    }
    if (allRoutesResult.ok) {
      try {
        tailscale.lanSubnets = [...new Set(JSON.parse(allRoutesResult.stdout)
          .filter((route) => route.scope === "link" && typeof route.dst === "string" && route.dst.includes("/") && !/^(tailscale|docker|br-|virbr|veth|lo)/.test(route.dev ?? ""))
          .map((route) => route.dst))];
      } catch { /* optional */ }
    }
    const defaultResolvers = resolverLinks.filter((link) => link.defaultRoute || link.interface === "global").flatMap((link) => link.servers.map((server) => server.address));
    const tailscaleResolvers = resolverLinks.filter((link) => link.interface.startsWith("tailscale")).flatMap((link) => link.servers.map((server) => server.address));
    return {
      generatedAt: new Date().toISOString(),
      collectors: { addresses: addressesResult.ok, routes: routesResult.ok, resolvers: resolversResult.ok, listeners: listenersResult.ok, tailscale: tailscaleResult.ok, neighbors: neighborsResult.ok },
      addresses,
      devices,
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
      deviceRoles,
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

    if (input.dnsRole === "router-hosted-resolver" && input.dnsServiceAddress !== input.gatewayAddress) blockers.push({ id: "router-dns-address", summary: "A resolver hosted on the edge router must be planned at the declared gateway address" });
    if (input.dnsRole === "pihole-on-host" && input.dnsServiceAddress !== input.serverAddress) blockers.push({ id: "host-dns-address", summary: "Pi-hole on this server must use the declared live server LAN address" });
    if (input.dnsRole === "pihole-in-vm") {
      if (!server?.cidr || !sameIpv4Subnet(input.dnsServiceAddress, server.cidr)) blockers.push({ id: "vm-dns-subnet", summary: "The dedicated Pi-hole VM address must be inside the live server LAN subnet" });
      if ([input.serverAddress, input.gatewayAddress].includes(input.dnsServiceAddress)) blockers.push({ id: "vm-dns-address-collision", summary: "The dedicated Pi-hole VM address must differ from this server and the gateway" });
    }
    if (["pihole-on-host", "pihole-in-vm", "router-hosted-resolver"].includes(input.dnsRole) && net.isIP(input.fallbackDnsAddress) !== 4) blockers.push({ id: "fallback-dns", summary: "A valid emergency resolver is required" });
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

  async function routerReadiness(checkpointStatus, declaration) {
    return buildRouterReadiness(await inspect(), checkpointStatus, declaration);
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

  return { inspect, tailnet, plan, routerReadiness, validateAssessment, validateAcceptanceBaseline };
}

export const networkInternals = { buildRouterReadiness, declaredDevices, deviceRoles, eligibleLanAddresses, hostAddresses, ipv4Number, parseDefaultRoutes, parseDnsListeners, parseIpAddresses, parseResolverStatus, roleGuides, safeLabel, sameIpv4Subnet, topologyGuidance };
