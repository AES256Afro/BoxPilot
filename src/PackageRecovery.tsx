import { useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";
import { Button, Panel, riskOf, type Status } from "./ui";

interface Report {
  checkedAt: string;
  status: "healthy" | "needs-repair" | "busy" | "unknown";
  repairAvailable: boolean;
  locks: { available: boolean; holders: Array<{ file: string; pid: number | null }> };
  audit: { ok: boolean; detail: string } | null;
  simulation: { ok: boolean; detail: string } | null;
}
const titles = { healthy: "Package state is healthy", "needs-repair": "Package configuration needs repair", busy: "Another package manager is running", unknown: "Package checks could not finish" };
const tones: Record<Report["status"], Status> = { healthy: "good", "needs-repair": "warning", busy: "warning", unknown: "unknown" };

/** Packages left half-installed by an interrupted update, checked and repaired from Repair's console. */
export default function PackageRecovery({ csrfToken }: { csrfToken: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function check() {
    setBusy(true); setError(null); setReport(null);
    try {
      const result = (await inspectOperation<Report>("apt.health.inspect")).result;
      if (!result || !Object.hasOwn(titles, result.status) || !Array.isArray(result.locks?.holders)) throw new Error("The package check returned incomplete data. Check that both services run the same BoxPilot release.");
      setReport(result);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not check package recovery"); }
    finally { setBusy(false); }
  }
  const { start, dialog } = useOperation(csrfToken, () => { void check(); });
  return (
    <Panel title="Packages" label="Interrupted package recovery" meta={report ? `checked ${new Date(report.checkedAt).toLocaleTimeString()}` : "read on request"}
      count={report ? { status: tones[report.status], label: report.status.replace("-", " ") } : undefined}
      actions={<Button onClick={() => void check()} busy={busy}>{busy ? "Checking packages..." : "Check package recovery"}</Button>}>
      {error && <p className="rp-note" data-tone="danger" role="alert">{error}</p>}
      {!report && !error && <p className="rp-quiet">For an update or install that stopped partway: reads package state and previews the dependency repair.</p>}
      {report && (
        <div aria-live="polite" className="rp-rows">
          <article className="rp-row" data-status={tones[report.status]}>
            <div className="rp-row__body">
              <strong className="rp-row__title">{titles[report.status]}</strong>
              {report.status === "busy" && <p className="rp-row__text">Let the active update finish, then check again. {report.locks.holders.map((lock) => `${lock.file}${lock.pid ? ` (process ${lock.pid})` : ""}`).join(", ")}</p>}
              {report.status === "unknown" && <p className="rp-row__text">{report.locks.available ? "Review the check details, then try again." : "Kernel lock ownership could not be read. Restore access to the host diagnostics, then check again."}</p>}
              {(report.audit?.detail || report.simulation?.detail) && <details className="rp-more"><summary>Package check details</summary>{report.audit?.detail && <pre className="rp-pre">{report.audit.detail}</pre>}{report.simulation?.detail && <pre className="rp-pre">{report.simulation.detail}</pre>}</details>}
            </div>
            {report.repairAvailable && (
              <div className="rp-row__act">
                <Button variant="primary" risk={riskOf("apt.repair")} onClick={() => start({ operationId: "apt.repair", title: "Repair interrupted packages", parameters: {}, preview: <span>Finishes pending package configuration and installs missing dependencies. Package scripts may restart services. The repair stops if APT needs to remove packages, then checks the final package state. Existing package-manager locks remain in place.</span> })}>Review package repair</Button>
              </div>
            )}
          </article>
        </div>
      )}
      {dialog}
    </Panel>
  );
}
