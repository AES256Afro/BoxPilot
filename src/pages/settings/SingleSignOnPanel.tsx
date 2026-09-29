import { useCallback, useEffect, useState } from "react";
import { Button, CodeBlock, CopyButton, EmptyState, Field, Notice, Panel, Table, TextInput, Textarea, type TableColumn } from "../../ui";

/**
 * Settings → Single sign-on (M19.3; owner only): register the apps that may offer "Sign in with
 * BoxPilot", and hand back what they need to be configured. Clients use authorization-code + PKCE,
 * so there is no client secret — an app needs only the issuer URL and its client id.
 */
interface OidcClient { id: string; name: string; redirectUris: string[]; createdAt: string }
interface ClientsView { issuer: string; discovery: string; clients: OidcClient[]; status?: { ready: boolean; detail: string | null } }

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export default function SingleSignOnPanel({ csrfToken }: { csrfToken: string }) {
  const [view, setView] = useState<ClientsView | null>(null);
  const [name, setName] = useState("");
  const [redirects, setRedirects] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headers = { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken };

  const refresh = useCallback(async () => {
    try {
      const body = await json<Partial<ClientsView>>(await fetch("/api/v1/oidc/clients"));
      setView({ issuer: body.issuer ?? "", discovery: body.discovery ?? "", clients: Array.isArray(body.clients) ? body.clients : [], status: body.status });
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not load single sign-on"); }
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

  const columns: Array<TableColumn<OidcClient>> = [
    { id: "name", header: "App", sortValue: (client) => client.name, cell: (client) => <strong className="settings-user">{client.name}</strong> },
    { id: "id", header: "Client id", cell: (client) => <code className="settings-id">{client.id}</code> },
    { id: "redirects", header: "Redirects", numeric: true, hideOnPhone: true, cell: (client) => client.redirectUris.length },
    {
      id: "action", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "settings-cell-action", cell: (client) => (
        <span className="settings-cell-buttons">
          <CopyButton value={client.id} label="Copy id" name={`${client.name}'s client id`} />
          <Button variant="ghost" disabled={busy} onClick={() => void remove(client)} aria-label={`Remove ${client.name}`}>Remove</Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <Panel
        title="Sign in with BoxPilot"
        count={view?.status ? { status: view.status.ready ? "good" : "danger", label: view.status.ready ? "ready" : "not ready" } : undefined}
        meta="authorization code with PKCE; no client secret"
        padded
        className="settings-panel"
      >
        {view?.status?.ready === false && <Notice tone="danger" live title="Single sign-on is not ready">{view.status.detail}</Notice>}
        {view ? (
          <>
            <p className="settings-quiet">Most apps ask for one URL: give them this one.</p>
            <CodeBlock label="Discovery URL">{view.discovery}</CodeBlock>
            <p className="settings-quiet">If an app asks for the issuer instead, it is <code>{view.issuer}</code>. Register the app below to get its client id.</p>
          </>
        ) : !error && <p className="settings-quiet">Reading…</p>}
      </Panel>

      <Panel title="Apps" count={view ? view.clients.length : undefined} className="settings-panel settings-panel--wide">
        <Table
          caption="Apps that sign in with BoxPilot"
          columns={columns}
          rows={view?.clients ?? []}
          rowKey={(client) => client.id}
          empty={view ? <EmptyState title={'No apps use "Sign in with BoxPilot" yet'}>Register one below.</EmptyState> : "Reading…"}
        />
        <form className="settings-body settings-add" aria-label="Register an app" onSubmit={(event) => { event.preventDefault(); if (name.trim() && redirects.trim()) void register(); }}>
          <h3 className="settings-sub__title">Register an app</h3>
          <div className="settings-grid-form">
            <Field label="App name">
              <TextInput placeholder="e.g. Grafana" maxLength={64} value={name} onValueChange={setName} />
            </Field>
            <Field label="Redirect URLs" hint="Where the app sends people back after they sign in, one per line. Its docs call it the redirect or callback URL.">
              <Textarea mono rows={2} placeholder="https://grafana.example/login/generic_oauth" value={redirects} onValueChange={setRedirects} spellCheck={false} />
            </Field>
          </div>
          <div className="settings-actions"><Button variant="primary" type="submit" disabled={busy || !name.trim() || !redirects.trim()}>Register app</Button></div>
          {message && <Notice tone="success" live>{message}</Notice>}
          {error && <Notice tone="danger" live>{error}</Notice>}
        </form>
      </Panel>
    </>
  );
}
