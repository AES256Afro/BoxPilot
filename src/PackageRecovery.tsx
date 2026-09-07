import { useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface Report {
  checkedAt: string;
  status: "healthy" | "needs-repair" | "busy" | "unknown";
  repairAvailable: boolean;
  locks: { available: boolean; holders: Array<{ file: string; pid: number | null }> };
  audit: { ok: boolean; detail: string } | null;
  simulation: { ok: boolean; detail: string } | null;
}
const titles = { healthy: "Package state is healthy", "needs-repair": "Package configuration needs repair", busy: "Another package manager is running", unknown: "Package checks could not finish" };

export default function PackageRecovery({ csrfToken }: { csrfToken: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function check() {
    setBusy(true); setError(null); setReport(null);
    try { setReport((await inspectOperation<Report>("apt.health.inspect")).result); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not check package recovery"); }
    finally { setBusy(false); }
  }
  const { start, dialog } = useOperation(csrfToken, () => { void check(); });
  return <section className="panel package-recovery">
    <header className="panel-header"><div><strong>Interrupted package recovery</strong><span>Check this when updates or software installs stop partway through.</span></div><button className="secondary-button" type="button" disabled={busy} onClick={() => void check()}>{busy ? "Checking packages..." : "Check package recovery"}</button></header>
    <p>The check reads package state and previews dependency repair. It runs only when requested.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {report && <div aria-live="polite">
      <p><strong>{titles[report.status]}</strong> <span>Checked {new Date(report.checkedAt).toLocaleString()}</span></p>
      {report.status === "busy" && <p>Let the active update finish, then check again. {report.locks.holders.map((lock) => `${lock.file}${lock.pid ? ` (process ${lock.pid})` : ""}`).join(", ")}</p>}
      {report.status === "unknown" && <p>{report.locks.available ? "Review the check details, then try again." : "Kernel lock ownership could not be read. Restore access to the host diagnostics, then check again."}</p>}
      {(report.audit?.detail || report.simulation?.detail) && <details><summary>Package check details</summary>{report.audit?.detail && <pre>{report.audit.detail}</pre>}{report.simulation?.detail && <pre>{report.simulation.detail}</pre>}</details>}
      {report.repairAvailable && <button className="primary-button" type="button" onClick={() => start({ operationId: "apt.repair", title: "Repair interrupted packages", parameters: {}, preview: <span>Finishes pending package configuration and installs missing dependencies. Package scripts may restart services. The repair stops if APT needs to remove packages, then checks the final package state. Existing package-manager locks remain in place.</span> })}>Review package repair</button>}
    </div>}
    {dialog}
  </section>;
}
