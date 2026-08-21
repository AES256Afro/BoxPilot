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

  const askPassword = () => window.prompt("Your owner password:") ?? "";

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
                    <select aria-label={`Role for ${person.username}`} value={person.role} onChange={(event) => { const password = askPassword(); if (password) void call("PUT", `/api/v1/people/${person.id}`, { role: event.target.value, password }); }}>
                      <option value="owner">owner</option><option value="operator">operator</option><option value="viewer">viewer</option>
                    </select>
                  )}
                </td>
                <td>{new Date(person.createdAt).toLocaleDateString()}</td>
                <td>{person.role !== "disabled" && <button className="text-button danger-text" type="button" disabled={busy} onClick={() => { const password = askPassword(); if (password) void call("DELETE", `/api/v1/people/${person.id}`, { password }); }}>Disable</button>}</td>
              </tr>
            ))}
            {people && people.length === 0 && <tr><td colSpan={4}>No accounts.</td></tr>}
          </tbody>
        </table>
      </div>
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
