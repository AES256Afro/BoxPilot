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
  github: { configured: boolean; linkedLogins: string[] };
}

export function fetchIdentityOptions(): Promise<IdentityOptions> {
  return fetch("/api/v1/auth/identity").then(async (response) => {
    const body = (await response.json()) as IdentityOptions & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not read sign-in options");
    return body;
  });
}

export function loginWithTailscale(password?: string): Promise<AuthStatus> {
  return authRequest("/api/v1/auth/tailscale", password ? { password } : {}).then((result) => ({ ...result, bootstrapRequired: false }));
}

export interface GithubFlow { flowId: string; userCode: string; verificationUri: string; expiresIn: number; intervalSeconds: number }

export async function startGithubSignIn(): Promise<GithubFlow> {
  const response = await fetch("/api/v1/auth/github/start", { method: "POST" });
  const body = (await response.json()) as GithubFlow & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Could not start GitHub sign-in");
  return body;
}

export async function pollGithubSignIn(flowId: string): Promise<{ status: string; error?: string | null; session?: AuthStatus; linked?: boolean; login?: string; githubLogins?: string[] }> {
  const response = await fetch("/api/v1/auth/github/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flowId }) });
  const body = (await response.json()) as { status: string; error?: string | null; session?: AuthStatus; linked?: boolean; login?: string; githubLogins?: string[] };
  if (!response.ok && !body.status) throw new Error(body.error ?? "GitHub sign-in failed");
  return body;
}
