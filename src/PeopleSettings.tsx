import { useCallback, useEffect, useState } from "react";

/** People (M5.4): owners add operators and viewers, change roles, and disable accounts. Owner-only. */

interface Person { id: string; username: string; role: "owner" | "operator" | "viewer" | "disabled"; createdAt: string }

const roleHelp: Record<string, string> = {
  owner: "Everything, including settings, people, and high-risk approvals.",
  operator: "Stages and approves low- and medium-risk work; cannot change settings or approve high-risk jobs.",
  viewer: "Read-only: every page, no changes.",
};

export default function PeopleSettings({ csrfToken }: { csrfToken: string }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", newPassword: "", role: "operator", password: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/people");
      if (!response.ok) throw new Error("People are unavailable");
      setPeople(((await response.json()) as { people: Person[] }).people);
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

  return (
    <section className="panel">
      <header className="panel-header"><div><strong>People</strong><span>Who can sign in and what they may do. Accounts are disabled rather than deleted so their history stays attributable.</span></div></header>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <div className="table-scroll">
        <table>
          <thead><tr><th>User</th><th>Role</th><th>Since</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {(people ?? []).map((person) => (
              <tr key={person.id}>
                <td>{person.username}</td>
                <td>
                  {person.role === "disabled" ? <span className="status-pill status-neutral">disabled</span> : (
                    <select aria-label={`Role for ${person.username}`} value={pending?.id === person.id && pending.kind === "role" ? pending.role : person.role} onChange={(event) => setPending({ id: person.id, username: person.username, kind: "role", role: event.target.value, password: "" })}>
                      <option value="owner">owner</option><option value="operator">operator</option><option value="viewer">viewer</option>
                    </select>
                  )}
                </td>
                <td>{new Date(person.createdAt).toLocaleDateString()}</td>
                <td>{person.role !== "disabled" && <button className="text-button danger-text" type="button" disabled={busy} onClick={() => setPending({ id: person.id, username: person.username, kind: "disable", password: "" })}>Disable</button>}</td>
              </tr>
            ))}
            {people && people.length === 0 && <tr><td colSpan={4}>No accounts.</td></tr>}
          </tbody>
        </table>
      </div>
      {pending && (
        <form className="recovery-actions" onSubmit={(event) => { event.preventDefault(); void confirmPending(); }}>
          <span>{pending.kind === "role" ? <>Make <strong>{pending.username}</strong> {pending.role === "owner" ? "an owner" : `a ${pending.role}`}?</> : <>Disable <strong>{pending.username}</strong>? They keep their history and can be re-enabled.</>}</span>
          <input aria-label="Your password, to confirm this change" type="password" placeholder="your password" autoComplete="current-password" value={pending.password} onChange={(event) => setPending({ ...pending, password: event.target.value })} autoFocus />
          <button className="secondary-button" type="submit" disabled={busy || !pending.password}>{pending.kind === "role" ? `Make ${pending.username} ${pending.role === "owner" ? "an owner" : `a ${pending.role}`}` : `Disable ${pending.username}`}</button>
          <button className="text-button" type="button" onClick={() => setPending(null)}>Cancel</button>
        </form>
      )}
      <form className="recovery-actions" onSubmit={(event) => { event.preventDefault(); void call("POST", "/api/v1/people", form).then((ok) => { if (ok) setForm({ username: "", newPassword: "", role: "operator", password: "" }); }); }}>
        <input aria-label="New user name" placeholder="user name" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required pattern="[a-z0-9][a-z0-9._-]{1,31}" />
        <input aria-label="New account password" type="password" placeholder="their password (12+)" autoComplete="new-password" value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} minLength={12} required />
        <select aria-label="New account role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}><option value="operator">operator</option><option value="viewer">viewer</option><option value="owner">owner</option></select>
        <input aria-label="Your owner password" type="password" placeholder="your password" autoComplete="current-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required />
        <button className="secondary-button" type="submit" disabled={busy}>Add person</button>
      </form>
      <p className="muted people-help">{roleHelp[form.role]}</p>
    </section>
  );
}
