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

/** Whether a response has the shape the page reads, so a proxy's page or an older server is said as such. */
export function isTopology(value: unknown): value is Topology {
  const body = value as Partial<Topology> | null;
  return Boolean(body && Array.isArray(body.defaultRoutes) && Array.isArray(body.eligibleLanAddresses) && Array.isArray(body.defaultResolvers) && Array.isArray(body.dnsListeners) && body.tailscale && body.collectors);
}
