export interface Owner {
  id: string;
  username: string;
}

export interface AuthStatus {
  bootstrapRequired: boolean;
  authenticated: boolean;
  owner: Owner | null;
  csrfToken: string | null;
  expiresAt: string | null;
}

async function authRequest(path: string, body?: Record<string, string>): Promise<AuthStatus> {
  const response = await fetch(path, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : undefined);
  const result = await response.json() as AuthStatus & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Authentication request failed");
  return { ...result, bootstrapRequired: false };
}

export function fetchAuthStatus(): Promise<AuthStatus> {
  return authRequest("/api/v1/auth/status");
}

export function bootstrapOwner(username: string, password: string, bootstrapToken: string): Promise<AuthStatus> {
  return authRequest("/api/v1/auth/bootstrap", { username, password, bootstrapToken });
}

export function loginOwner(username: string, password: string): Promise<AuthStatus> {
  return authRequest("/api/v1/auth/login", { username, password });
}

export async function logoutOwner(csrfToken: string): Promise<void> {
  const response = await fetch("/api/v1/auth/logout", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } });
  if (!response.ok && response.status !== 204) throw new Error("Logout failed");
}
