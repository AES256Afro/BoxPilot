import { useCallback, useEffect, useState } from "react";
import { useOperation } from "./ApproveDialog";

interface Credential { name: string; createdAt: string | null; updatedAt: string | null }

/**
 * Settings panel: tokens the HTTP step can send by name (M13.7). Names and dates are all this
 * panel can ever show; a value goes in once through the ordinary secret machinery and can only
 * be replaced or removed, never read back.
 */
export default function CredentialsPanel({ csrfToken }: { csrfToken: string }) {
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => fetch("/api/v1/operations/credentials.inspect/inspect")
    .then((response) => response.json())
    .then((body: { result?: { credentials: Credential[] } }) => setCredentials(body.result?.credentials ?? []))
    .catch(() => setError("Could not read the credential names")), []);
  useEffect(() => { void refresh(); }, [refresh]);
  const { start, dialog } = useOperation(csrfToken, () => { setName(""); setValue(""); void refresh(); });

  return (
    <section className="panel">
      <header className="panel-header"><div><strong>Credentials</strong><span>Tokens the Send-an-HTTP-request step can use by name. Values live in a root-owned file on this server and are never shown again.</span></div></header>
      {error && <div className="auth-error" role="alert">{error}</div>}
      {credentials === null ? <p className="muted">Reading…</p> : credentials.length === 0 ? <p className="muted">Nothing saved yet.</p> : (
        <ul className="credential-list">
          {credentials.map((credential) => (
            <li key={credential.name}>
              <code>{credential.name}</code>
              <span className="muted">saved {credential.updatedAt ? new Date(credential.updatedAt).toLocaleDateString() : ""}</span>
              <button className="text-button" type="button" onClick={() => start({ operationId: "credentials.remove", title: `Remove the credential ${credential.name}`, parameters: { name: credential.name }, preview: <span>Requests that reference <code>{credential.name}</code> will refuse to run until it is saved again.</span> })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className="recovery-actions" onSubmit={(event) => { event.preventDefault(); if (name && value) start({ operationId: "credentials.set", title: `Save the credential ${name}`, parameters: { name, value }, preview: <span>Saves the value under <code>{name}</code> in a root-owned file on this server. It never appears in a flow, a job record, or the database.</span> }); }}>
        <input aria-label="Credential name" placeholder="name, e.g. ntfy-token" maxLength={32} value={name} onChange={(event) => setName(event.target.value.toLowerCase())} />
        <input aria-label="Credential value" placeholder="the token itself" type="password" maxLength={4096} value={value} onChange={(event) => setValue(event.target.value)} />
        <button className="secondary-button" type="submit" disabled={!name || !value}>Save</button>
      </form>
      {dialog}
    </section>
  );
}
