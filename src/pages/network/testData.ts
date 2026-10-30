import { vi } from "vitest";

/*
 * One fictional network for the Network page's tests (M33.10): the routes the page reads, and a
 * fetch that answers them, stages every operation it is asked to and records what it was sent.
 * Addresses are from the documentation ranges or placeholders; nothing here is a real host.
 */

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const now = () => Date.parse("2026-08-16T12:00:00.000Z");

export const topology = {
  generatedAt: "2026-08-16T00:00:00Z",
  collectors: { addresses: true, routes: true, resolvers: true, listeners: true, tailscale: true },
  eligibleLanAddresses: [{ interface: "eno1", address: "192.168.1.10", cidr: "192.168.1.10/24" }],
  defaultRoutes: [{ gateway: "192.168.1.1", interface: "eno1", protocol: "static" }],
  defaultResolvers: ["94.140.14.49", "94.140.14.59"],
  tailscale: { connected: true, dnsName: "homebox.example.ts.net", address: "100.64.0.5", resolverPresent: true, defaultDnsObserved: false, overrideState: "non-tailscale-default-observed", exitNodeAdvertised: false, advertisedRoutes: [] as string[], approvedRoutes: [] as string[], lanSubnets: ["192.168.1.0/24"] },
  dnsListeners: [{ protocol: "tcp", address: "127.0.0.53", port: 53, scope: "loopback", interface: null }],
  devices: [{ address: "192.168.1.50", mac: "aa:bb:cc:dd:ee:ff", interface: "eno1", state: "REACHABLE" }],
  deviceRoles: [
    { id: "edge-router", name: "Edge router", summary: "The one device doing NAT and DHCP for the LAN." },
    { id: "access-point", name: "Access point", summary: "Wireless coverage bridged to the edge router." },
  ],
  mutationSupported: false,
};

export const capabilities = { network: { bind: "127.0.0.1", port: 8787, lan: false, canSet: true }, tls: { provisioned: false, port: 8443, canProvision: true } };

export const reachability = {
  ways: [
    { id: "loopback", label: "On this server", url: "http://127.0.0.1:8787", scope: "Only from the server itself", encrypted: false, trusted: true },
    { id: "lan-tls", label: "On your LAN, encrypted", url: "https://homebox.lan:8443", scope: "Devices on your network", encrypted: true, trusted: false },
  ],
  onLan: false, tlsProvisioned: true, servePublished: false,
};

export const tailnet = {
  available: true, connected: true,
  self: { name: "homebox", dnsName: "homebox.example.ts.net", address: "100.64.0.5", os: "linux", online: true, lastSeen: null, exitNode: false, subnetRoutes: [], direct: null, relay: null, isSelf: true },
  peers: [
    { name: "laptop", dnsName: "laptop.example.ts.net", address: "100.64.0.7", os: "macOS", online: true, lastSeen: null, exitNode: false, subnetRoutes: [], direct: true, relay: null, isSelf: false },
    { name: "phone", dnsName: "phone.example.ts.net", address: "100.64.0.9", os: "android", online: false, lastSeen: "2026-08-16T09:00:00.000Z", exitNode: false, subnetRoutes: [], direct: false, relay: "sfo", isSelf: false },
  ],
};

/** Whether the house keeps its DNS with this server off (M39.2): by default, it does. */
export const resilience = {
  state: "resilient", status: "good",
  headline: "Your network keeps working when homebox is off",
  detail: "192.168.1.30 (another device on your network) answers lookups on its own, so devices still resolve names while this server is off.",
  source: "dhcp", via: "systemd-networkd", dhcpServer: "192.168.1.1",
  servers: [
    { address: "192.168.1.10", role: "this-server", label: "this server", verdict: "depends", answering: true, resolving: true, blocking: true, error: null, note: "Goes when homebox goes." },
    { address: "192.168.1.30", role: "lan", label: "another device on your network", verdict: "independent", answering: true, resolving: true, blocking: true, error: null, note: "Answers on its own, and blocks too." },
  ],
  router: null, skipsBlocking: false, rehearsal: null, rehearsalStale: false, servesDns: true,
  checkedAt: "2026-08-16T11:58:00.000Z", lanAddress: "192.168.1.10", gateway: "192.168.1.1", afterOutage: null,
};

/** The router passing lookups here, nobody having rehearsed it: what the rehearsal is for. */
export const unproven = {
  ...resilience, state: "unproven", status: "warning",
  headline: "Not known yet whether your network keeps working when homebox is off",
  detail: "Devices ask your router at 192.168.1.1, and the router passes their lookups to the DNS server here. Whether it falls back to another resolver when this server is off can only be seen by trying: rehearse it.",
  servers: [{ address: "192.168.1.1", role: "router", label: "your router", verdict: "unknown", leansHere: true, forwards: true, answering: true, resolving: true, blocking: true, error: null, note: "Passes lookups to the DNS server here." }],
  router: "192.168.1.1",
};

/** The house going down with this server: the lease names nothing else. */
export const singlePoint = {
  ...resilience, state: "single-point", status: "danger",
  headline: "If homebox goes down, every device on your network loses the internet",
  detail: "Your router hands out 192.168.1.10 (this server) as the only DNS server, so every lookup in the house goes to the DNS server here.",
  servers: [resilience.servers[0]],
};

export const catalogSummary = { applications: [{ manifest: { id: "pi-hole", name: "Pi-hole" }, live: { installed: true, container: { running: true }, urls: [{ host: 8084 }] } }], host: { lanAddress: "192.168.1.10", tailscaleDnsName: "homebox.example.ts.net" } };

const job = (id: string, risk: string) => ({ job: { id: `job-${id}`, type: `op:${id}`, title: id, state: "awaiting_approval", risk, error: null, result: null, steps: [], approvals: [] }, approval: { tier: risk, passwordRequired: risk === "high", elevated: false, mode: "tiered", reason: `${risk} risk` } });
const tiers: Record<string, string> = { "network.wake": "low", "dns.fallback.rehearse": "medium" };

/** An answer for a route: a body, a Response, or a function of the request's body. */
export type Answer = unknown | Response | ((body: unknown) => Response);

/**
 * The routes the page reads, with any overridden; every staged operation is recorded by its id,
 * and every read-only run (dns.blocker.verify) answers from `routes` by its path.
 */
export function mockFetch(routes: Record<string, Answer> = {}, staged: Record<string, unknown> = {}) {
  const table: Record<string, Answer> = {
    "/api/v1/network/topology": topology,
    "/api/v1/capabilities": capabilities,
    "/api/v1/network/reachability": reachability,
    "/api/v1/network/tailnet": tailnet,
    "/api/v1/network/dns-resilience": resilience,
    "/api/v1/network/dns-resilience?fresh=1": resilience,
    "/api/v1/catalog?view=summary": catalogSummary,
    ...routes,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url in table) {
      const answer = table[url];
      if (answer instanceof Response) return answer.clone();
      if (typeof answer === "function") return (answer as (body: unknown) => Response)(init?.body ? JSON.parse(String(init.body)) : null);
      return json(answer);
    }
    const match = url.match(/\/operations\/([a-z0-9.-]+)\/jobs$/);
    if (match) { staged[match[1]] = JSON.parse(String(init?.body)); return json(job(match[1], tiers[match[1]] ?? "medium"), 201); }
    return json({ error: `unexpected ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
