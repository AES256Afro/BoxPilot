import { readJson } from "./http";

export interface Owner {
  id: string;
  username: string;
  role?: "owner" | "operator" | "viewer" | "disabled";
}

export interface AuthStatus {
  bootstrapRequired: boolean;
  authenticated: boolean;
  owner: Owner | null;
  csrfToken: string | null;
  expiresAt: string | null;
  /** ISO time until which high-risk approvals need no password (set by a recent password entry). */
  elevatedUntil?: string | null;
}

/** An auth failure with the server's machine-readable code (e.g. device_password_required). */
export class AuthError extends Error {
  code: string | null;
  username: string | null;
  constructor(message: string, code: string | null = null, username: string | null = null) { super(message); this.code = code; this.username = username; }
}

async function authRequest(path: string, body?: Record<string, string>): Promise<AuthStatus> {
  const response = await fetch(path, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : undefined);
  const result = await response.json().catch(() => ({})) as AuthStatus & { error?: string; code?: string; username?: string };
  if (!response.ok) throw new AuthError(result.error ?? "Authentication request failed", result.code ?? null, result.username ?? null);
  return result;
}

/*
 * Why this browser is looking at the sign-in page (M36). Sessions live in BoxPilot's database and
 * survive a restart or an update; they end after twelve hours, or when ended from elsewhere (a
 * password change, "sign out everywhere else", a role change). The page used to go back to signing
 * in without a word, which after an update looked as if the update had signed the owner out. Only
 * the session's end time is remembered here, per browser, and signing out forgets it.
 */
const sessionMark = "boxpilot:signed-in-until";

export type SignedOutReason = "expired" | "ended";

export function rememberSession(status: AuthStatus | null): void {
  try { if (status?.authenticated && status.expiresAt) window.localStorage.setItem(sessionMark, status.expiresAt); } catch { /* private window: nothing to say later */ }
}

export function forgetSession(): void {
  try { window.localStorage.removeItem(sessionMark); } catch { /* nothing kept */ }
}

/** Whether a session this browser had ran out (its twelve hours were up) or was ended elsewhere; null if it had none. */
export function signedOutReason(now = Date.now()): SignedOutReason | null {
  let until: string | null = null;
  try { until = window.localStorage.getItem(sessionMark); } catch { return null; }
  if (!until) return null;
  const at = Date.parse(until);
  return Number.isFinite(at) && at <= now + 60_000 ? "expired" : "ended";
}

/** Said when an API answer shows the session has gone, so the page can go to sign-in and say why. */
export const sessionEndedEvent = "boxpilot:session-ended";

export function fetchAuthStatus(): Promise<AuthStatus> {
  return authRequest("/api/v1/auth/status");
}

export function bootstrapOwner(username: string, password: string, bootstrapToken: string): Promise<AuthStatus> {
  return authRequest("/api/v1/auth/bootstrap", { username, password, bootstrapToken })
    .then((result) => ({ ...result, bootstrapRequired: false }));
}

export function loginOwner(username: string, password: string): Promise<AuthStatus> {
  return authRequest("/api/v1/auth/login", { username, password })
    .then((result) => ({ ...result, bootstrapRequired: false }));
}

export async function logoutOwner(csrfToken: string): Promise<void> {
  const response = await fetch("/api/v1/auth/logout", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } });
  if (!response.ok && response.status !== 204) throw new Error("Logout failed");
}

/** Drop the elevated window early so high-risk approvals ask for the password again. */
export async function dropElevation(csrfToken: string): Promise<void> {
  const response = await fetch("/api/v1/auth/elevate", { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } });
  if (!response.ok && response.status !== 204) throw new Error("Could not lock the session");
}

export interface IdentityOptions {
  tailscale: { available: boolean; login: string | null; displayName: string | null; node: string | null; linked: boolean };
  github: { configured: boolean };
  passkey?: { registered: boolean };
}

export function fetchIdentityOptions(): Promise<IdentityOptions> {
  return fetch("/api/v1/auth/identity").then(async (response) => {
    return readJson<IdentityOptions>(response);
  });
}

export function loginWithTailscale(password?: string): Promise<AuthStatus> {
  return authRequest("/api/v1/auth/tailscale", password ? { password } : {}).then((result) => ({ ...result, bootstrapRequired: false }));
}

export interface GithubFlow { flowId: string; userCode: string; verificationUri: string; expiresIn: number; intervalSeconds: number }

export async function startGithubSignIn(): Promise<GithubFlow> {
  const response = await fetch("/api/v1/auth/github/start", { method: "POST" });
  const body = (await response.json().catch(() => ({}))) as GithubFlow & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Could not start GitHub sign-in");
  return body;
}

export async function pollGithubSignIn(flowId: string): Promise<{ status: string; error?: string | null; session?: AuthStatus; linked?: boolean; login?: string; githubLogins?: string[] }> {
  const response = await fetch("/api/v1/auth/github/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flowId }) });
  const body = (await response.json().catch(() => ({}))) as { status: string; error?: string | null; session?: AuthStatus; linked?: boolean; login?: string; githubLogins?: string[] };
  if (!response.ok && !body.status) throw new Error(body.error ?? "GitHub sign-in failed");
  return body;
}
