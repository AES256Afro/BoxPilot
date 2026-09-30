/* What the Network page reads: the topology, the capabilities, the ways to reach BoxPilot, and the tailnet. */

export interface TailscaleFacts {
  connected: boolean;
  dnsName: string | null;
  resolverPresent?: boolean;
  defaultDnsObserved?: boolean;
  overrideState?: string;
  address?: string | null;
  exitNodeAdvertised?: boolean | null;
  advertisedRoutes?: string[];
  approvedRoutes?: string[];
  lanSubnets?: string[];
}

export interface Topology {
  generatedAt: string;
  collectors: Record<string, boolean>;
  eligibleLanAddresses: Array<{ interface: string; address: string; cidr: string | null }>;
  defaultRoutes: Array<{ gateway: string; interface: string; protocol: string }>;
  defaultResolvers: string[];
  tailscale: TailscaleFacts;
  dnsListeners: Array<{ protocol: string; address: string; port: number; scope: string; interface: string | null }>;
  devices?: Array<{ address: string; mac: string; interface: string | null; state: string }>;
  deviceRoles?: Array<{ id: string; name: string; summary: string }>;
  mutationSupported: boolean;
}

export interface TlsCapability { provisioned: boolean; port: number; names?: string[]; ipAddresses?: string[]; fingerprint?: string | null; notAfter?: string | null; caFingerprint?: string | null; canProvision: boolean }
export interface NetworkCapability { bind: string; port: number; lan: boolean; canSet: boolean }

export interface ReachWay { id: string; label: string; url: string; scope: string; encrypted: boolean; trusted: boolean }
export interface Reachability { ways: ReachWay[]; onLan: boolean; tlsProvisioned: boolean; servePublished: boolean }

export interface TailnetNode {
  name: string; dnsName: string | null; address: string | null; os: string | null;
  online: boolean; lastSeen: string | null; exitNode: boolean; subnetRoutes: string[];
  direct: boolean | null; relay: string | null; isSelf: boolean;
}
export interface Tailnet { available: boolean; connected: boolean; self: TailnetNode | null; peers: TailnetNode[] }

/** One DNS server the router hands out, and whether it would still answer with this server off (M39.2). */
export interface ResilienceServer {
  address: string;
  role: "this-server" | "router" | "lan" | "public" | "tailscale";
  label: string;
  verdict: "depends" | "independent" | "unknown" | "broken" | "skipped";
  answering: boolean | null;
  resolving: boolean | null;
  blocking: boolean | null;
  note: string;
  forwards?: boolean | null;
  leansHere?: boolean;
}
export interface Rehearsal { router: string; app?: string | null; appName?: string | null; passed: boolean | null; answered?: number; total?: number; slowestMs?: number | null; at: string }
export interface OutageCheck { at: string; ok: boolean; checks: Array<{ id: string; ok: boolean; label: string; detail: string }>; outage?: { id: string; stoppedAt: string | null; backAt: string | null } }
/** Whether the house keeps its DNS while this server is off (GET /network/dns-resilience). */
export interface Resilience {
  state: "unknown" | "independent" | "resilient" | "unproven" | "single-point";
  status: "good" | "warning" | "danger" | "neutral" | "unknown";
  headline: string;
  detail: string;
  source: "dhcp" | "configured" | "none";
  via: string | null;
  servers: ResilienceServer[];
  router: string | null;
  skipsBlocking: boolean;
  rehearsal: Rehearsal | null;
  rehearsalStale: boolean;
  servesDns: boolean;
  checkedAt: string;
  lanAddress: string | null;
  gateway: string | null;
  afterOutage: OutageCheck | null;
}

export function isResilience(value: unknown): value is Resilience {
  const body = value as Partial<Resilience> | null;
  return Boolean(body && typeof body.state === "string" && typeof body.headline === "string" && Array.isArray(body.servers));
}

/** Whether a response has the shape the page reads, so a proxy's page or an older server is said as such. */
export function isTopology(value: unknown): value is Topology {
  const body = value as Partial<Topology> | null;
  return Boolean(body && Array.isArray(body.defaultRoutes) && Array.isArray(body.eligibleLanAddresses) && Array.isArray(body.defaultResolvers) && Array.isArray(body.dnsListeners) && body.tailscale && body.collectors);
}
