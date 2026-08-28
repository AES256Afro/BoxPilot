import { useCallback, useEffect, useState } from "react";

/**
 * Settings → Single sign-on (M19.3): register the apps that may offer "Sign in with BoxPilot", and
 * hand back what they need to be configured. Clients use authorization-code + PKCE, so there is no
 * client secret — an app needs only the issuer URL and its client id.
 */
interface OidcClient { id: string; name: string; redirectUris: string[]; createdAt: string }
interface ClientsView { issuer: string; discovery: string; clients: OidcClient[] }

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export default function OidcSettings({ csrfToken }: { csrfToken: string }) {
  const [view, setView] = useState<ClientsView | null>(null);
  const [name, setName] = useState("");
  const [redirects, setRedirects] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headers = { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken };

  const refresh = useCallback(async () => {
    try { setView(await json<ClientsView>(await fetch("/api/v1/oidc/clients"))); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not load single sign-on"); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const register = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const redirectUris = redirects.split(/[\n,]+/).map((uri) => uri.trim()).filter(Boolean);
      await json(await fetch("/api/v1/oidc/clients", { method: "POST", headers, body: JSON.stringify({ name, redirectUris }) }));
      setMessage(`Registered ${name}.`); setName(""); setRedirects(""); await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not register the app"); } finally { setBusy(false); }
  };

  const remove = async (client: OidcClient) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      await json(await fetch(`/api/v1/oidc/clients/${encodeURIComponent(client.id)}`, { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } }));
      setMessage(`Removed ${client.name}.`); await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not remove the app"); } finally { setBusy(false); }
  };

  const copy = (value: string) => void navigator.clipboard?.writeText(value);

  return (
    <section className="panel settings-panel">
      <header className="panel-header"><div><strong>Single sign-on</strong><span>Let your apps offer "Sign in with BoxPilot" instead of their own passwords</span></div></header>
      <div className="approval-settings">
        {view && (
          <div className="approval-option" style={{ cursor: "default" }}><span aria-hidden="true">🔐</span><div>
            <strong>Point your app at BoxPilot</strong>
            <span>Most apps ask for one URL. Give them this, and choose authorization code with PKCE (no client secret).</span>
            <div className="recovery-actions" style={{ marginTop: 8 }}>
              <code style={{ wordBreak: "break-all" }}>{view.discovery}</code>
              <button className="text-button" type="button" onClick={() => copy(view.discovery)}>Copy</button>
            </div>
            <span className="muted">If an app asks for the issuer instead, it is <code>{view.issuer}</code>. Register the app below to get its client id.</span>
          </div></div>
        )}

        <div className="approval-option" style={{ cursor: "default" }}><span aria-hidden="true">➕</span><div>
          <strong>Register an app</strong>
          <span>Give it a name and the redirect URL(s) it will send people back to after signing in (one per line). The app's own docs call this the redirect or callback URL.</span>
          <label className="field" style={{ marginTop: 8 }}>App name<input aria-label="App name" placeholder="e.g. Grafana" maxLength={64} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field">Redirect URLs<textarea aria-label="Redirect URLs" rows={2} placeholder="https://grafana.example/login/generic_oauth" value={redirects} onChange={(event) => setRedirects(event.target.value)} /></label>
          <div className="recovery-actions" style={{ marginTop: 8 }}>
            <button className="primary-button" type="button" disabled={busy || !name.trim() || !redirects.trim()} onClick={() => void register()}>Register app</button>
          </div>
        </div></div>

        {view?.clients.length ? (
          <div className="workload-list">
            {view.clients.map((client) => (
              <div className="workload" key={client.id}>
                <div style={{ minWidth: 0 }}>
                  <strong>{client.name}</strong>
                  <span>client id <code style={{ wordBreak: "break-all" }}>{client.id}</code> · {client.redirectUris.length} redirect URL{client.redirectUris.length === 1 ? "" : "s"}</span>
                </div>
                <button className="text-button" type="button" onClick={() => copy(client.id)}>Copy id</button>
                <button className="text-button" type="button" disabled={busy} onClick={() => void remove(client)}>Remove</button>
              </div>
            ))}
          </div>
        ) : view ? <p className="muted">No apps registered yet.</p> : null}

        {message && <p className="good-text">{message}</p>}
        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}
