import { useState } from "react";
import { inspectOperation } from "../operations";
import { Button, CodeBlock, Panel, StatusChip, type Status } from "../ui";

interface Check { id: string; title: string; status: "pass" | "warning" | "fail" | "unknown"; detail: string; next: string | null }
interface Report { checkedAt: string; status: string; installedVersion?: string | null; checks: Check[] }

const checkStatus: Record<Check["status"], Status> = { pass: "good", warning: "warning", fail: "danger", unknown: "unknown" };
const checkWords: Record<Check["status"], string> = { pass: "pass", warning: "review", fail: "needs attention", unknown: "could not check" };

/** One check that did not pass, as a console row: what it is, what was found, and what to do. */
function CheckRow({ item }: { item: Check }) {
  return (
    <article className="rp-row" data-status={checkStatus[item.status]}>
      <div className="rp-row__body">
        <strong className="rp-row__title">{item.title}<StatusChip status={checkStatus[item.status]}>{checkWords[item.status]}</StatusChip></strong>
        <p className="rp-row__text">{item.detail}</p>
        {item.next && <p className="rp-row__text">{item.next}</p>}
      </div>
    </article>
  );
}

/**
 * BoxPilot's own installation (Repair's console): services, permissions, release files, room for
 * the database, and a separate read-only database check. Nothing runs until asked.
 */
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
  const databaseProblems = database?.checks.filter((item) => item.status !== "pass") ?? [];
  const meta = report ? `checked ${new Date(report.checkedAt).toLocaleTimeString()}` : "read on request";
  return (
    <Panel title="Installation" label="BoxPilot installation health" meta={meta}
      count={report ? { status: problems.length ? "warning" : "good", label: problems.length ? `${problems.length} to review` : "ok" } : undefined}
      actions={<>
        <Button onClick={() => void check()} busy={busy}>{busy ? "Checking installation..." : "Check BoxPilot installation"}</Button>
        <Button onClick={() => void checkDatabase()} busy={databaseBusy}>{databaseBusy ? "Checking database..." : "Check database"}</Button>
      </>}>
      {error && <p className="rp-note" data-tone="danger" role="alert">{error}</p>}
      {!report && !error && <p className="rp-quiet">Services, permissions, release files and room for the database. The database check is read-only, with a 15-second budget.</p>}
      {report && (
        <div aria-live="polite">
          <p className="rp-note" data-tone={problems.length ? "warning" : "good"}><strong>{problems.length ? `${problems.length} installation check${problems.length === 1 ? " needs" : "s need"} attention` : "Installation checks passed"}</strong><span>Checked {new Date(report.checkedAt).toLocaleString()}.</span></p>
          <div className="rp-rows">{problems.map((item) => <CheckRow key={item.id} item={item} />)}</div>
          <details className="rp-more rp-body"><summary>All installation checks</summary><ul>{report.checks.map((item) => <li key={item.id}>{item.title}: {item.status}. {item.detail}</li>)}</ul></details>
        </div>
      )}
      {databaseError && <p className="rp-note" data-tone="danger" role="alert">{databaseError}</p>}
      {database && (
        <div aria-live="polite">
          <p className="rp-note" data-tone={database.status === "ready" ? "good" : "warning"}><strong>{database.status === "ready" ? "Basic database checks passed" : database.status === "incomplete" ? "Database checks incomplete" : "Database checks need attention"}</strong><span>Checked {new Date(database.checkedAt).toLocaleString()}. They do not prove a backup restores: keep the database and its journals before any recovery.</span></p>
          <div className="rp-rows">{databaseProblems.map((item) => <CheckRow key={item.id} item={item} />)}</div>
          <details className="rp-more rp-body"><summary>Database evidence</summary><ul>{database.checks.map((item) => <li key={item.id}>{item.title}: {item.status}. {item.detail}</li>)}</ul></details>
          {onOpenBackups && <div className="rp-body"><Button variant="ghost" onClick={onOpenBackups}>Review database backups</Button></div>}
        </div>
      )}
      <details className="rp-more rp-body">
        <summary>If this web interface stops working</summary>
        <p className="rp-row__text">Connect to the server by SSH or its local console, then run:</p>
        <CodeBlock label="On the server">sudo sh /opt/boxpilot/scripts/boxpilot-doctor.sh --control-plane</CodeBlock>
        <p className="rp-row__text">Add <code>--database</code> for the bounded SQLite checks, or <code>--json</code> for a structured report. It works without either service and restarts or replaces nothing.</p>
      </details>
    </Panel>
  );
}
