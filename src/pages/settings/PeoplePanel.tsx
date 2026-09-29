import { useCallback, useEffect, useState } from "react";
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
  const call = async (method: string, url: string, body: unknown) => {
    setBusy(true); setError(null);
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
  const [pending, setPending] = useState<{ id: string; username: string; kind: "role" | "disable"; role?: string; password: string } | null>(null);

  const confirmPending = async () => {
    if (!pending || !pending.password) return;
    const done = pending.kind === "role"
      ? await call("PUT", `/api/v1/people/${pending.id}`, { role: pending.role, password: pending.password })
      : await call("DELETE", `/api/v1/people/${pending.id}`, { password: pending.password });
    if (done) setPending(null);
  };

  const list = people ?? [];
  const active = list.filter((person) => person.role !== "disabled");
  const counts = { owner: active.filter((person) => person.role === "owner").length, operator: active.filter((person) => person.role === "operator").length, viewer: active.filter((person) => person.role === "viewer").length };
  const becomes = (role?: string) => (role === "owner" ? "an owner" : `a ${role}`);
  const columns: Array<TableColumn<Person>> = [
    { id: "user", header: "User", sortValue: (person) => person.username, cell: (person) => <code className="settings-user">{person.username}</code> },
    {
      id: "role", header: "Role", sortValue: (person) => person.role, cell: (person) => person.role === "disabled"
        ? <Tag>disabled</Tag>
        : <Select aria-label={`Role for ${person.username}`} options={roles} className="settings-role"
            value={pending?.id === person.id && pending.kind === "role" ? pending.role : person.role}
            onValueChange={(role) => setPending({ id: person.id, username: person.username, kind: "role", role, password: "" })} />,
    },
    { id: "since", header: "Since", hideOnPhone: true, sortValue: (person) => person.createdAt, cell: (person) => new Date(person.createdAt).toLocaleDateString() },
    {
      id: "action", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "settings-cell-action", cell: (person) => person.role !== "disabled"
        ? <Button variant="ghost" className="settings-danger" disabled={busy} onClick={() => setPending({ id: person.id, username: person.username, kind: "disable", password: "" })}>Disable</Button>
        : null,
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
      {error && <div className="settings-body"><Notice tone="danger" live>{error}</Notice></div>}
      <Table caption="Accounts on this server" columns={columns} rows={list} rowKey={(person) => person.id} rowStatus={(person) => (person.role === "disabled" ? "neutral" : undefined)} empty={people === null ? "Reading…" : "No accounts."} />
      {pending && (
        <form className="settings-body settings-confirm" onSubmit={(event) => { event.preventDefault(); void confirmPending(); }}>
          <p className="settings-confirm__what">{pending.kind === "role" ? <>Make <strong>{pending.username}</strong> {becomes(pending.role)}?</> : <>Disable <strong>{pending.username}</strong>? They keep their history and can be re-enabled.</>}</p>
          <div className="settings-form settings-form--row">
            <Field label="Your password, to confirm this change">
              <SecretInput autoComplete="current-password" value={pending.password} onValueChange={(password) => setPending({ ...pending, password })} autoFocus />
            </Field>
            <div className="settings-actions">
              <Button variant="primary" type="submit" disabled={busy || !pending.password}>{pending.kind === "role" ? `Make ${pending.username} ${becomes(pending.role)}` : `Disable ${pending.username}`}</Button>
              <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            </div>
          </div>
        </form>
      )}
      <form className="settings-body settings-add" aria-label="Add a person" onSubmit={(event) => { event.preventDefault(); void call("POST", "/api/v1/people", form).then((ok) => { if (ok) setForm({ username: "", newPassword: "", role: "operator", password: "" }); }); }}>
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
      </form>
    </Panel>
  );
}
