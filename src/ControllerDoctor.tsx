import { useState } from "react";
import { inspectOperation } from "./operations";
interface Check { id: string; title: string; status: "pass" | "warning" | "fail" | "unknown"; detail: string; next: string | null }
interface Report { checkedAt: string; status: string; installedVersion: string | null; checks: Check[] }
export default function ControllerDoctor() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function check() {
    setBusy(true); setError(null); setReport(null);
    try {
      const result = (await inspectOperation<Report>("system.controller.inspect")).result;
      if (!result || !Array.isArray(result.checks)) throw new Error("The installation check returned incomplete data. Check that both services run the same BoxPilot release.");
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
    <details><summary>If this web interface stops working</summary><p>Connect to the Ubuntu server by SSH or its local console, then run:</p><pre>sudo sh /opt/boxpilot/scripts/boxpilot-doctor.sh --control-plane</pre><p>This independent doctor reads diagnostic metadata and checks both services. It does not change files or restart services. Add <code>--json</code> for a structured report.</p></details>
  </section>;
}
