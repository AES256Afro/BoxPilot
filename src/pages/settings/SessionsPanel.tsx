import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Panel, StatusChip, Table, Tag, type TableColumn } from "../../ui";

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

export function deviceLabel(userAgent: string | null): string {
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

export default function SessionsPanel({ csrfToken }: { csrfToken: string }) {
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
      setSessions(Array.isArray(body.sessions) ? body.sessions : []); setCurrentId(body.currentId ?? null);
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
  const columns: Array<TableColumn<SessionInfo>> = [
    {
      id: "device", header: "Device", sortValue: (entry) => deviceLabel(entry.userAgent), cell: (entry) => (
        <span className="settings-session">
          <span>{deviceLabel(entry.userAgent)}</span>
          {entry.id === currentId && <Tag tone="accent">this device</Tag>}
          {entry.elevated && <Tag tone="warning" title="High-risk approvals skip the password in this session for now">unlocked</Tag>}
        </span>
      ),
    },
    { id: "method", header: "How", sortValue: (entry) => entry.method ?? "", cell: (entry) => methodLabels[entry.method ?? ""] ?? "Signed in" },
    { id: "address", header: "From", hideOnPhone: true, cell: (entry) => entry.address ?? "—" },
    { id: "seen", header: "Active", sortValue: (entry) => -Date.parse(entry.lastSeenAt ?? "") || 0, cell: (entry) => ago(entry.lastSeenAt) },
    { id: "since", header: "Since", hideOnPhone: true, sortValue: (entry) => entry.createdAt, cell: (entry) => new Date(entry.createdAt).toLocaleString() },
    {
      id: "action", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "settings-cell-action", cell: (entry) => entry.id === currentId
        ? <StatusChip status="good">current</StatusChip>
        : <Button variant="ghost" disabled={busy} onClick={() => void revoke(entry.id, deviceLabel(entry.userAgent))} aria-label={`Sign out ${deviceLabel(entry.userAgent)}`}>Sign out</Button>,
    },
  ];

  return (
    <Panel
      title="Where you're signed in"
      count={sessions ? sessions.length : undefined}
      meta={sessions ? <><b>{others}</b> other{others === 1 ? "" : "s"}</> : undefined}
      actions={others > 0 ? <Button disabled={busy} onClick={() => void revokeOthers()}>Sign out everywhere else ({others})</Button> : undefined}
      footer="A sign-in from an address this account has not used before is sent to your notification target."
      className="settings-panel settings-panel--wide"
    >
      <Table
        caption="Sessions on your account"
        columns={columns}
        rows={sessions ?? []}
        rowKey={(entry) => entry.id}
        empty={sessions === null ? "Loading…" : "No active sessions."}
      />
      {(message || error) && (
        <div className="settings-body">
          {message && <Notice tone="success" live>{message}</Notice>}
          {error && <Notice tone="danger" live>{error}</Notice>}
        </div>
      )}
    </Panel>
  );
}
