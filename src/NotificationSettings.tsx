import { useEffect, useState } from "react";

interface NotificationState { configured: boolean; kind: "ntfy" | "gotify" | "webhook" | null; url: string | null; topic: string | null; hasToken: boolean }

/**
 * Settings panel: where failed-job alerts go. ntfy and Gotify are both in the app catalog,
 * so the target can live on this very server.
 */
export default function NotificationSettings({ csrfToken }: { csrfToken: string }) {
  const [current, setCurrent] = useState<NotificationState | null>(null);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<"ntfy" | "gotify" | "webhook">("ntfy");
  const [url, setUrl] = useState("");
  const [topic, setTopic] = useState("boxpilot");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => fetch("/api/v1/settings/notifications").then((response) => response.json()).then((body: NotificationState) => setCurrent(body)).catch(() => setError("Could not read the notification settings"));
  useEffect(() => { void refresh(); }, []);

  const save = async (target: { kind: string; url: string; topic?: string; token?: string } | null) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/v1/settings/notifications", { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ target, password }) });
      const body = (await response.json()) as NotificationState & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save the notification target");
      setCurrent(body); setEditing(false); setPassword(""); setToken("");
      setMessage(target ? "Saved. Send a test to make sure it arrives." : "Notifications are off.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not save the notification target");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/v1/settings/notifications/test", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The test notification failed");
      setMessage("Test sent. Check your device.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The test notification failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel settings-panel">
      <header className="panel-header">
        <div><strong>Notifications</strong><span>Failed jobs push to your phone. Ntfy and Gotify are both in the app catalog</span></div>
        <span className={`status-pill ${current?.configured ? "status-good" : "status-neutral"}`}>{current?.configured ? `${current.kind} configured` : "Off"}</span>
      </header>
      <p className="muted">You get a push for: a failed job, a new BoxPilot release, and health changes on this server (root or any mounted disk over 85–90 % full, a disk with SMART problems, the UPS on battery or low, failed system services, a pending reboot, a container that is unhealthy or crash-looping, and a scheduled backup that has stopped running). Each condition is sent once when it appears and once when it clears; the watcher checks every 15 minutes.</p>
      <div className="notification-settings">
        {current?.configured && !editing && (
          <>
            <p>Failed jobs go to <code>{current.url}</code>{current.kind === "ntfy" && current.topic ? <> topic <code>{current.topic}</code></> : null}.</p>
            <div className="recovery-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={() => void test()}>Send a test</button>
              <button className="text-button" type="button" onClick={() => { setEditing(true); setKind(current.kind ?? "ntfy"); setUrl(current.url ?? ""); setTopic(current.topic ?? "boxpilot"); }}>Change</button>
            </div>
          </>
        )}
        {(!current?.configured || editing) && (
          <>
            <div className="recovery-actions">
              <select aria-label="Notification service" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                <option value="ntfy">ntfy</option>
                <option value="gotify">Gotify</option>
                <option value="webhook">Webhook</option>
              </select>
              <input aria-label="Server URL" placeholder={kind === "webhook" ? "https://example.net/hook" : "http://127.0.0.1:8093"} value={url} onChange={(event) => setUrl(event.target.value.trim())} />
              {kind === "ntfy" && <input aria-label="Topic" placeholder="topic" value={topic} onChange={(event) => setTopic(event.target.value.trim())} />}
              {kind !== "ntfy" && <input aria-label="Token" type="password" placeholder={kind === "gotify" ? "application token" : "bearer token (optional)"} value={token} onChange={(event) => setToken(event.target.value)} />}
              {kind === "ntfy" && <input aria-label="Token" type="password" placeholder="access token (optional)" value={token} onChange={(event) => setToken(event.target.value)} />}
            </div>
            <p className="muted">The address and any token are kept on this server so alerts can be sent while you are away, and they are included in BoxPilot's own database backups. Use a token scoped to sending notifications rather than one that can do more.</p>
            <div className="recovery-actions">
              <input aria-label="Owner password" type="password" autoComplete="current-password" placeholder="Owner password to confirm" value={password} onChange={(event) => setPassword(event.target.value)} />
              <button className="primary-button" type="button" disabled={busy || password.length < 12 || !url} onClick={() => void save({ kind, url, ...(kind === "ntfy" ? { topic } : {}), ...(token ? { token } : {}) })}>{busy ? "Saving..." : "Save"}</button>
              {current?.configured && <button className="secondary-button" type="button" disabled={busy || password.length < 12} onClick={() => void save(null)}>Turn off</button>}
              {editing && <button className="text-button" type="button" onClick={() => { setEditing(false); setPassword(""); }}>Cancel</button>}
            </div>
          </>
        )}
        {message && <p className="good-text">{message}</p>}
        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}
