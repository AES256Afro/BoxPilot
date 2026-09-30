import { useCallback, useEffect, useState } from "react";
import { useOperation } from "../../shell/ApproveDialog";
import { Button, EmptyState, Field, Notice, Panel, SecretInput, Table, TextInput, riskOf, type TableColumn } from "../../ui";

interface Credential { name: string; createdAt: string | null; updatedAt: string | null }

/**
 * Settings → Credentials (M13.7; owner only): tokens the HTTP step can send by name. Names and dates
 * are all this panel can ever show; a value goes in once through the ordinary secret machinery and
 * can only be replaced or removed, never read back. Saving and removing are operations, approved at
 * their tier through the approval dialog like any other.
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

  const removeCredential = (credential: Credential) => start({
    operationId: "credentials.remove",
    title: `Remove the credential ${credential.name}`,
    parameters: { name: credential.name },
    preview: <span>Requests that reference <code>{credential.name}</code> will refuse to run until it is saved again.</span>,
  });
  const columns: Array<TableColumn<Credential>> = [
    { id: "name", header: "Name", sortValue: (credential) => credential.name, cell: (credential) => <code className="settings-user">{credential.name}</code> },
    { id: "saved", header: "Saved", sortValue: (credential) => credential.updatedAt ?? "", cell: (credential) => (credential.updatedAt ? new Date(credential.updatedAt).toLocaleDateString() : "—") },
    {
      id: "action", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "settings-cell-action", cell: (credential) => (
        <Button risk={riskOf("credentials.remove")} onClick={() => removeCredential(credential)} aria-label={`Remove ${credential.name}`}>Remove</Button>
      ),
    },
  ];

  return (
    <Panel title="Credentials" count={credentials ? credentials.length : undefined} meta="used by the Send-an-HTTP-request step, by name" className="settings-panel settings-panel--wide"
      footer="Values live in a root-owned file on this server and are never shown again.">
      {dialog}
      {error && <div className="settings-body"><Notice tone="danger" live action={<Button onClick={() => { setError(null); void refresh(); }}>Try again</Button>}>{error}</Notice></div>}
      <Table
        caption="Saved credentials"
        columns={columns}
        rows={credentials ?? []}
        rowKey={(credential) => credential.name}
        empty={credentials === null ? "Reading…" : <EmptyState title="No credentials yet">Save a token below and HTTP-request steps can use it by name.</EmptyState>}
      />
      <form className="settings-body settings-add" aria-label="Save a credential" onSubmit={(event) => { event.preventDefault(); if (name && value) start({ operationId: "credentials.set", title: `Save the credential ${name}`, parameters: { name, value }, preview: <span>Saves the value under <code>{name}</code> in a root-owned file on this server. It never appears in a flow, a job record, or the database.</span> }); }}>
        <h3 className="settings-sub__title">Save a credential</h3>
        <div className="settings-grid-form">
          <Field label="Credential name" hint="Lower case; what a request step names it by.">
            <TextInput mono placeholder="e.g. ntfy-token" maxLength={32} value={name} onValueChange={(next) => setName(next.toLowerCase())} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Credential value" hint="The token itself. It cannot be read back once saved.">
            <SecretInput maxLength={4096} value={value} onValueChange={setValue} />
          </Field>
        </div>
        <div className="settings-actions"><Button type="submit" risk={riskOf("credentials.set")} disabled={!name || !value}>Save</Button></div>
      </form>
    </Panel>
  );
}
