import { useCallback, useEffect, useState } from "react";

/**
 * Settings → Where you're signed in (M19.4): every live session for this account, with where and
 * how it signed in, and a way to cut any of it off. "From where" and the device are best-effort
 * from the address and user agent recorded at sign-in, so they inform rather than prove.
 */
interface SessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  address: string | null;
  userAgent: string | null;
  method: string | null;
  elevated: boolean;
}

const methodLabels: Record<string, string> = {
  password: "Password", passkey: "Passkey", tailscale: "Tailscale", github: "GitHub", "recovery-code": "Recovery code", identity: "Identity",
};

function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const os = /Windows/.test(userAgent) ? "Windows"
    : /iPhone|iPad/.test(userAgent) ? "iOS"
    : /Mac OS X|Macintosh/.test(userAgent) ? "macOS"
    : /Android/.test(userAgent) ? "Android"
    : /Linux/.test(userAgent) ? "Linux" : null;
  const browser = /Edg\//.test(userAgent) ? "Edge"
    : /OPR\/|Opera/.test(userAgent) ? "Opera"
    : /Firefox\//.test(userAgent) ? "Firefox"
    : /Chrome\//.test(userAgent) ? "Chrome"
    : /Safari\//.test(userAgent) ? "Safari" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

function ago(iso: string | null): string {
  if (!iso) return "unknown";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export default function SessionsSettings({ csrfToken }: { csrfToken: string }) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/auth/sessions");
      if (!response.ok) throw new Error("Could not load sessions");
      const body = (await response.json()) as { currentId: string; sessions: SessionInfo[] };
      setSessions(body.sessions); setCurrentId(body.currentId);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not load sessions"); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (done: string, work: () => Promise<Response>) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await work();
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error((body as { error?: string }).error ?? "Request failed"); }
      setMessage(done); await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Request failed"); } finally { setBusy(false); }
  };

  const revoke = (id: string, label: string) => act(`Signed out ${label}.`, () => fetch(`/api/v1/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } }));
  const revokeOthers = () => act("Signed out everywhere else.", () => fetch("/api/v1/auth/sessions/revoke-others", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } }));

  const others = (sessions ?? []).filter((entry) => entry.id !== currentId).length;

  return (
    <section className="panel settings-panel">
      <header className="panel-header"><div><strong>Where you're signed in</strong><span>Every session on your account, and a way to cut any of it off</span></div></header>
      <div className="approval-settings">
        {sessions === null ? <p className="muted">Loading…</p> : sessions.length === 0 ? <p className="muted">No active sessions.</p> : (
          <div className="workload-list">
            {sessions.map((entry) => {
              const current = entry.id === currentId;
              const device = deviceLabel(entry.userAgent);
              return (
                <div className="workload session-row" key={entry.id}>
                  <div>
                    <strong>{device}{current && <span className="session-here"> · this device</span>}{entry.elevated && <span className="session-elevated"> · unlocked</span>}</strong>
                    <span>
                      {methodLabels[entry.method ?? ""] ?? "Signed in"}{entry.address ? ` from ${entry.address}` : ""} · active {ago(entry.lastSeenAt)} · since {new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {current
                    ? <span className="status-pill status-good">current</span>
                    : <button className="text-button" type="button" disabled={busy} onClick={() => void revoke(entry.id, device)}>Sign out</button>}
                </div>
              );
            })}
          </div>
        )}
        {others > 0 && (
          <div className="recovery-actions" style={{ marginTop: 8 }}>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void revokeOthers()}>Sign out everywhere else ({others})</button>
          </div>
        )}
        <p className="muted">BoxPilot alerts you through your notification target when your account signs in from an address it has not seen before.</p>
        {message && <p className="good-text">{message}</p>}
        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}
