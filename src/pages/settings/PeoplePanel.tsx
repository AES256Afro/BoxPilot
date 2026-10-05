import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Field, Notice, Panel, SecretInput, Select, Table, Tag, TextInput, type TableColumn } from "../../ui";

/** People (M5.4): owners add operators and viewers, change roles, and disable accounts. Owner-only. */

interface Person { id: string; username: string; role: "owner" | "operator" | "viewer" | "disabled"; createdAt: string }

const roleHelp: Record<string, string> = {
  owner: "Everything, including settings, people, and high-risk approvals.",
  operator: "Stages and approves low- and medium-risk work; cannot change settings or approve high-risk jobs.",
  viewer: "Read-only: every page, no changes.",
};

const roles = [{ value: "owner", label: "owner" }, { value: "operator", label: "operator" }, { value: "viewer", label: "viewer" }];

export default function PeoplePanel({ csrfToken }: { csrfToken: string }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", newPassword: "", role: "operator", password: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/people");
      if (!response.ok) throw new Error("People are unavailable");
      const body = (await response.json()) as { people?: Person[] };
      setPeople(Array.isArray(body.people) ? body.people : []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "People are unavailable");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const headers = { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken };
  // Where a refusal is said: beside the form that asked. Adding someone is at the foot of the panel,
  // and its "user name taken" used to appear above the table, out of sight; its success said nothing.
  const [errorAt, setErrorAt] = useState<"list" | "confirm" | "add">("list");
  const [added, setAdded] = useState<string | null>(null);
  const call = async (method: string, url: string, body: unknown, at: "confirm" | "add") => {
    setBusy(true); setError(null); setAdded(null); setErrorAt(at);
    try {
      const response = await fetch(url, { method, headers, body: JSON.stringify(body) });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
      await load();
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Changing someone's role or disabling them needs the owner's password. That used to come from
   * window.prompt, which shows the password in clear text in a native dialog and freezes every
   * script on the page while it is open. The same masked field the rest of the product uses,
   * inline, instead.
   */
  // "enable": a disabled account given a role again (PUT, as a role change is), as disabling promises.
  const [pending, setPending] = useState<{ id: string; username: string; kind: "role" | "disable" | "enable"; role?: string; password: string } | null>(null);
  // What asked for the confirmation, so Cancel puts focus back there rather than on the page's body.
  const askedFrom = useRef<HTMLElement | null>(null);
  const ask = (next: NonNullable<typeof pending>) => { askedFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setPending(next); };
  const cancelPending = () => { setPending(null); setError(null); window.requestAnimationFrame(() => { if (askedFrom.current?.isConnected) askedFrom.current.focus(); }); };

  const confirmPending = async () => {
    if (!pending || !pending.password) return;
    const done = pending.kind === "role" || pending.kind === "enable"
      ? await call("PUT", `/api/v1/people/${pending.id}`, { role: pending.role, password: pending.password }, "confirm")
      : await call("DELETE", `/api/v1/people/${pending.id}`, { password: pending.password }, "confirm");
    if (done) setPending(null);
  };

  const list = people ?? [];
  const active = list.filter((person) => person.role !== "disabled");
  const counts = { owner: active.filter((person) => person.role === "owner").length, operator: active.filter((person) => person.role === "operator").length, viewer: active.filter((person) => person.role === "viewer").length };
  // "an operator", "an owner", "a viewer": the confirmation used to ask to make someone "a operator".
  const becomes = (role?: string) => (/^[aeiou]/.test(role ?? "") ? `an ${role}` : `a ${role}`);
  const columns: Array<TableColumn<Person>> = [
    { id: "user", header: "User", sortValue: (person) => person.username, cell: (person) => <code className="settings-user">{person.username}</code> },
    {
      id: "role", header: "Role", sortValue: (person) => person.role, cell: (person) => person.role === "disabled"
        ? <Tag>disabled</Tag>
        : <Select aria-label={`Role for ${person.username}`} options={roles} className="settings-role"
            value={pending?.id === person.id && pending.kind === "role" ? pending.role : person.role}
            onValueChange={(role) => ask({ id: person.id, username: person.username, kind: "role", role, password: "" })} />,
    },
    { id: "since", header: "Since", hideOnPhone: true, sortValue: (person) => person.createdAt, cell: (person) => new Date(person.createdAt).toLocaleDateString() },
    {
      id: "action", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "settings-cell-action", cell: (person) => person.role !== "disabled"
        ? <Button variant="ghost" className="settings-danger" disabled={busy} onClick={() => ask({ id: person.id, username: person.username, kind: "disable", password: "" })}>Disable</Button>
        : <Button variant="ghost" disabled={busy} aria-label={`Re-enable ${person.username}`} onClick={() => ask({ id: person.id, username: person.username, kind: "enable", role: "viewer", password: "" })}>Re-enable</Button>,
    },
  ];

  return (
    <Panel
      title="People"
      count={people ? list.length : undefined}
      meta={people ? <><b>{counts.owner}</b> owner{counts.owner === 1 ? "" : "s"} · <b>{counts.operator}</b> operator{counts.operator === 1 ? "" : "s"} · <b>{counts.viewer}</b> viewer{counts.viewer === 1 ? "" : "s"}</> : undefined}
      footer="Accounts are disabled rather than deleted, so their history stays attributable."
      className="settings-panel settings-panel--wide"
    >
      {error && errorAt === "list" && <div className="settings-body"><Notice tone="danger" live>{error}</Notice></div>}
      <Table caption="Accounts on this server" columns={columns} rows={list} rowKey={(person) => person.id} rowStatus={(person) => (person.role === "disabled" ? "neutral" : undefined)} empty={people === null ? "Reading…" : "No accounts."} />
      {pending && (
        <form className="settings-body settings-confirm" onSubmit={(event) => { event.preventDefault(); void confirmPending(); }}>
          <p className="settings-confirm__what">{pending.kind === "role" ? <>Make <strong>{pending.username}</strong> {becomes(pending.role)}?</>
            : pending.kind === "enable" ? <>Re-enable <strong>{pending.username}</strong>? They can sign in again, in the role chosen here.</>
              : <>Disable <strong>{pending.username}</strong>? They keep their history and can be re-enabled.</>}</p>
          <div className="settings-form settings-form--row">
            {pending.kind === "enable" && (
              <Field label="Role when re-enabled" hint={roleHelp[pending.role ?? "viewer"]}>
                <Select options={[roles[2], roles[1], roles[0]]} value={pending.role ?? "viewer"} onValueChange={(role) => setPending({ ...pending, role })} />
              </Field>
            )}
            <Field label="Your password, to confirm this change">
              <SecretInput autoComplete="current-password" value={pending.password} onValueChange={(password) => setPending({ ...pending, password })} autoFocus />
            </Field>
            <div className="settings-actions">
              <Button variant="primary" type="submit" disabled={busy || !pending.password}>{pending.kind === "role" ? `Make ${pending.username} ${becomes(pending.role)}` : pending.kind === "enable" ? `Re-enable ${pending.username} as ${becomes(pending.role)}` : `Disable ${pending.username}`}</Button>
              <Button variant="ghost" onClick={cancelPending}>Cancel</Button>
            </div>
          </div>
          {error && errorAt === "confirm" && <Notice tone="danger" live>{error}</Notice>}
        </form>
      )}
      <form className="settings-body settings-add" aria-label="Add a person" onSubmit={(event) => { event.preventDefault(); const who = form.username; const as = form.role; void call("POST", "/api/v1/people", form, "add").then((ok) => { if (ok) { setForm({ username: "", newPassword: "", role: "operator", password: "" }); setAdded(`${who} can sign in now, as ${becomes(as)}, with the password you set.`); } }); }}>
        <h3 className="settings-sub__title">Add a person</h3>
        <div className="settings-grid-form">
          <Field label="New user name" hint="Lower case, digits, dot, dash or underscore.">
            <TextInput mono autoComplete="off" spellCheck={false} autoCapitalize="off" value={form.username} onValueChange={(username) => setForm({ ...form, username })} required pattern="[a-z0-9][a-z0-9._-]{1,31}" />
          </Field>
          <Field label="New account password" hint="Theirs: twelve characters or more.">
            <SecretInput autoComplete="new-password" value={form.newPassword} onValueChange={(newPassword) => setForm({ ...form, newPassword })} minLength={12} required />
          </Field>
          <Field label="New account role" hint={roleHelp[form.role]}>
            <Select options={[roles[1], roles[2], roles[0]]} value={form.role} onValueChange={(role) => setForm({ ...form, role })} />
          </Field>
          <Field label="Your owner password">
            <SecretInput autoComplete="current-password" value={form.password} onValueChange={(password) => setForm({ ...form, password })} required />
          </Field>
        </div>
        <div className="settings-actions"><Button type="submit" busy={busy}>Add person</Button></div>
        {error && errorAt === "add" && <Notice tone="danger" live>{error}</Notice>}
        {added && <Notice tone="success" live onDismiss={() => setAdded(null)}>{added}</Notice>}
      </form>
    </Panel>
  );
}
