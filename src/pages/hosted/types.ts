/* What the Hosted domains page reads (M42.2): GET /hosted-domains, and the names it may add. */

export type DomainState = "up" | "degraded" | "down" | "unknown";
export type DomainSource = "tunnel" | "cloudflared-config" | "proxy" | "catalog" | "manual";

export interface DomainDns { resolved: boolean; addresses: string[]; viaCloudflare: boolean; private: boolean; error: string | null }
export interface DomainCertificate { validTo: string | null; daysLeft: number | null; issuer: string | null; authorized: boolean; authorizationError?: string | null }
export interface DomainProbe { outcome: string; status: number | null; ms: number | null; error: string | null; server?: string | null; skipped?: string | null }
export interface DomainBackup { state: "ok" | "stale" | "never" | "none" | "unknown"; newestAt: string | null; scheduled: boolean; backups: number }

export interface HostedDomain {
  hostname: string;
  url: string;
  sources: DomainSource[];
  appId: string | null;
  appName: string | null;
  /** Where the tunnel sends visitors on this server: http://127.0.0.1:<port>, when known. */
  service: string | null;
  label: string | null;
  manual: boolean;
  wildcard: boolean;
  expect: "cloudflare" | "address" | "any";
  expectedAddress: string | null;
  state: DomainState;
  headline: string;
  /** What to do, in words, when the state is not up. */
  advice: string | null;
  problems: string[];
  dns: DomainDns | null;
  certificate: DomainCertificate | null;
  outside: DomainProbe | null;
  inside: DomainProbe | null;
  app: { installed: boolean; running: boolean | null } | null;
  backup: DomainBackup | null;
  uptime: { day: number | null; week: number | null; checks: number };
  checkedAt: string | null;
}

export interface TunnelFacts {
  installed: boolean;
  running: boolean;
  status: string | null;
  since: string | null;
  connections: number | null;
  lastProblem: string | null;
  cloudflare: { connected: boolean; tunnelName: string | null } | null;
}

export interface ManualEntry { hostname: string; service: string | null; appId: string | null; label: string | null; expectedAddress: string | null; addedAt: string | null; addedBy?: string | null }

export interface HostedStatus {
  domains: HostedDomain[];
  tunnel: TunnelFacts | null;
  checkedAt: string | null;
  checking: boolean;
  nextCheckAt: string | null;
  intervalMinutes: number;
  intervals: number[];
  manual: ManualEntry[];
  alertsTarget: boolean;
  problem: string | null;
}

/** Whether a response has the shape the page reads, so a proxy's page or an older server is said as such. */
export function isHostedStatus(value: unknown): value is HostedStatus {
  const body = value as Partial<HostedStatus> | null;
  return Boolean(body && Array.isArray(body.domains) && Array.isArray(body.intervals) && typeof body.intervalMinutes === "number");
}
