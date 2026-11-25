/* What the Firewall page reads: /api/v1/firewall/overview and fail2ban.inspect. */

/** `source`: the address a rule is limited to, when it is (anywhere when absent). */
export interface FirewallRule { destination?: string | null; deletable?: boolean; action?: string; protocol?: string; port?: number | null; app?: string | null; direction?: string; interface?: string | null; source?: string | null; comment?: string | null; family?: string; raw?: string }
/** `sshPorts`: the ports sshd listens on, from sshd -T; null when they could not be read. */
export interface FirewallReport { installed: boolean; enabled: boolean | null; defaults: { incoming: string | null; outgoing: string | null; routed: string | null } | null; rules: FirewallRule[]; sshPorts?: number[] | null }
/** `kind` says what the port is for; SSH can be on more than one port. */
export interface ProtectedRule { port: number; protocol: string; label: string; reason: string; allow: boolean; kind?: "ssh" | "tailscale" | "web" | "tls" }
export interface Profile { id: string; name: string; recommended: boolean; summary: string; detail: string; defaults: { incoming: string; outgoing: string }; rules: Array<{ action: string; port: number; protocol: string; comment?: string | null }>; lockServices?: boolean }
export interface Service { id: string; name: string; hint: string; ports: Array<{ port: number; protocol: string }> }
export interface Advice { id: string; level: "action" | "warn" | "info"; title: string; detail: string; focus?: "profiles" | "install" | "fail2ban" | "network"; operationId?: string; parameters?: Record<string, unknown>; actionLabel?: string }
export interface CurrentProfile { id: string; services: string[]; sshRateLimit: boolean; appliedAt: string | null }
export interface Overview {
  report: FirewallReport | null;
  reportError: string | null;
  web: { port: number; lanExposed: boolean };
  protected: ProtectedRule[];
  profiles: Profile[];
  services: Service[];
  current: CurrentProfile | null;
  advice: Advice[];
  /** Where a new rule may let traffic in from (M90): this LAN's range when the server knows it, and the tailnet's two. */
  sources?: { lan: string | null; tailnet: string[] };
}
/** A rule a profile apply deletes (M90), from the plan built against the rules in place. */
export interface ClosedRule { action: string; port: number; protocol: string; source: string | null; comment: string | null }
export interface PlanStep { args: string[]; label: string; tolerateFailure?: boolean; removes?: ClosedRule }
/** `notes`: what the plan kept back and why, such as rules that could be SSH's when its port is unknown. */
export interface Plan { profile: { id: string; name: string }; services: string[]; steps: PlanStep[]; notes?: string[] }

export interface Fail2banState {
  installed: boolean;
  running: boolean | null;
  configured: boolean;
  config: { managed: boolean; maxRetry: number | null; findTimeMinutes: number | null; banTimeMinutes: number | null; ignoreLan: boolean; ignore: string[]; sshd: boolean };
  currentlyBanned: number | null;
  totalBanned: number | null;
  /** Which addresses are banned now (the first 500); null when the jail could not be read. */
  bannedAddresses?: string[] | null;
}

/** A port as ufw writes it: 8096/tcp, or 53 for both protocols. */
export const spec = (port: number, protocol?: string | null) => `${port}${protocol && protocol !== "any" ? `/${protocol}` : ""}`;
