import { useState } from "react";
import { inspectOperation } from "./operations";
interface Check { id: string; title: string; status: "pass" | "warning" | "fail" | "unknown"; detail: string; next: string | null }
interface Report { checkedAt: string; status: string; installedVersion?: string | null; checks: Check[] }
export default function ControllerDoctor({ onOpenBackups }: { onOpenBackups?: () => void } = {}) {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [database, setDatabase] = useState<Report | null>(null);
  const [databaseBusy, setDatabaseBusy] = useState(false);
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  async function checkDatabase() {
    setDatabaseBusy(true); setDatabaseError(null); setDatabase(null);
    try {
      const result = (await inspectOperation<Report>("controller.database.inspect")).result;
      if (!result || !Array.isArray(result.checks) || !result.checks.length) throw new Error("The database check returned incomplete data. Check that both services run the same release.");
      setDatabase(result);
    } catch (reason) { setDatabaseError(reason instanceof Error ? reason.message : "The database check could not finish"); }
    finally { setDatabaseBusy(false); }
  }
  async function check() {
    setBusy(true); setError(null); setReport(null);
    try {
      const result = (await inspectOperation<Report>("system.controller.inspect")).result;
      if (!result || !Array.isArray(result.checks) || !result.checks.length) throw new Error("The installation check returned incomplete data. Check that both services run the same BoxPilot release.");
      setReport(result);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not inspect the installation"); }
    finally { setBusy(false); }
  }
  const problems = report?.checks.filter((item) => item.status !== "pass") ?? [];
  return <section className="panel controller-doctor">
    <header className="panel-header"><div><strong>BoxPilot installation health</strong><span>Check services, permissions, release files and room for the database.</span></div><button className="secondary-button" type="button" disabled={busy} onClick={() => void check()}>{busy ? "Checking installation..." : "Check BoxPilot installation"}</button></header>
    {error && <p className="error" role="alert">{error}</p>}
    {report && <div aria-live="polite"><p><strong>{problems.length ? `${problems.length} installation check${problems.length === 1 ? " needs" : "s need"} attention` : "Installation checks passed"}</strong>. Checked {new Date(report.checkedAt).toLocaleString()}.</p>{problems.map((item) => <article key={item.id}><strong>{item.title}: {item.status === "unknown" ? "could not check" : item.status === "warning" ? "review" : "needs attention"}</strong><p>{item.detail}</p>{item.next && <p>{item.next}</p>}</article>)}<details><summary>All installation checks</summary><ul>{report.checks.map((item) => <li key={item.id}><strong>{item.title}</strong>: {item.status}. {item.detail}</li>)}</ul></details></div>}
    <div className="controller-database-check"><button className="secondary-button" type="button" disabled={databaseBusy} onClick={() => void checkDatabase()}>{databaseBusy ? "Checking database..." : "Check database"}</button><p>Optional read-only SQLite checks with a 15-second budget. Runs separately so the helper can keep answering.</p>
      {databaseError && <p role="alert">{databaseError}</p>}
      {database && <div aria-live="polite"><p><strong>{database.status === "ready" ? "Basic database checks passed" : database.status === "incomplete" ? "Database checks incomplete" : "Database checks need attention"}</strong>. Checked {new Date(database.checkedAt).toLocaleString()}.</p>{database.checks.filter((item) => item.status !== "pass").map((item) => <article key={item.id}><strong>{item.title}</strong><p>{item.detail}</p>{item.next && <p>{item.next}</p>}</article>)}<details><summary>Database evidence</summary><ul>{database.checks.map((item) => <li key={item.id}><strong>{item.title}</strong>: {item.status}. {item.detail}</li>)}</ul></details><p>These checks do not establish backup or release compatibility. Preserve the database and its journals before attempting recovery.</p></div>}
    </div>
    {database && onOpenBackups && <div><button className="secondary-button" type="button" onClick={onOpenBackups}>Review database backups</button></div>}
    <details><summary>If this web interface stops working</summary><p>Connect to the Ubuntu server by SSH or its local console, then run:</p><pre>sudo sh /opt/boxpilot/scripts/boxpilot-doctor.sh --control-plane</pre><p>Add <code>--database</code> for the bounded SQLite checks, or <code>--json</code> for a structured report. The doctor works independently of both services and performs no restart or database replacement.</p></details>
  </section>;
}
