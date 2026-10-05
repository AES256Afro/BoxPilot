/* What the Firewall page reads: /api/v1/firewall/overview and fail2ban.inspect. */

/** `source`: the address a rule is limited to, when it is (anywhere when absent). */
export interface FirewallRule { action?: string; protocol?: string; port?: number | null; app?: string | null; direction?: string; interface?: string | null; source?: string | null; comment?: string | null; family?: string; raw?: string }
export interface FirewallReport { installed: boolean; enabled: boolean | null; defaults: { incoming: string | null; outgoing: string | null; routed: string | null } | null; rules: FirewallRule[] }
export interface ProtectedRule { port: number; protocol: string; label: string; reason: string; allow: boolean }
export interface Profile { id: string; name: string; recommended: boolean; summary: string; detail: string; defaults: { incoming: string; outgoing: string }; rules: Array<{ action: string; port: number; protocol: string; comment?: string | null }>; lockServices?: boolean }
export interface Service { id: string; name: string; hint: string; ports: Array<{ port: number; protocol: string }> }
export interface Advice { id: string; level: "action" | "warn" | "info"; title: string; detail: string; focus?: "profiles" | "install" | "fail2ban"; operationId?: string; parameters?: Record<string, unknown>; actionLabel?: string }
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
}
export interface Plan { profile: { id: string; name: string }; services: string[]; steps: Array<{ args: string[]; label: string; tolerateFailure?: boolean }> }

export interface Fail2banState {
  installed: boolean;
  running: boolean | null;
  configured: boolean;
  config: { managed: boolean; maxRetry: number | null; findTimeMinutes: number | null; banTimeMinutes: number | null; ignoreLan: boolean; ignore: string[]; sshd: boolean };
  currentlyBanned: number | null;
  totalBanned: number | null;
}

/** A port as ufw writes it: 8096/tcp, or 53 for both protocols. */
export const spec = (port: number, protocol?: string | null) => `${port}${protocol && protocol !== "any" ? `/${protocol}` : ""}`;
