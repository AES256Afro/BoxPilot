import { useState } from "react";
import { readJson } from "./http";

interface ProcessSnapshot {
  checkedAt: string;
  version: string;
  processMemory: { rss: number; heapUsed: number; external: number };
  cpu: { percentOfOneCore: number | null; intervalMs: number | null };
  eventLoopBusyPercent: number | null;
  cgroup: { available: boolean; fileCacheBytes: number | null; anonymousBytes: number | null; oomKills: number | null };
}
interface RuntimeReport {
  web: ProcessSnapshot | null;
  helper: ProcessSnapshot | null;
  helperAvailable: boolean;
  transport: { active: number; completed: number; failed: number } | null;
}
const bytes = (value: number | null | undefined) => value == null ? "Unavailable" : `${(value / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
const percent = (value: number | null | undefined) => value == null ? "Check again for a CPU interval" : `${value.toFixed(2)}%`;

export default function RuntimeHealth() {
  const [report, setReport] = useState<RuntimeReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function check() {
    if (busy) return;
    setBusy(true); setError(null);
    try { setReport(await readJson<RuntimeReport>(await fetch("/api/v1/diagnostics/runtime"))); }
    catch { setError("Resource readings could not be refreshed. Any readings below are from the previous check."); }
    finally { setBusy(false); }
  }
  const web = report?.web; const helper = report?.helper;
  return <section className="panel runtime-health">
    <header className="panel-header"><div><strong>BoxPilot's own resource use</strong><span>Check the web service and helper without starting a disk scan.</span></div><button type="button" className="secondary-button" disabled={busy} onClick={() => void check()}>{busy ? "Checking resources..." : "Check resource use"}</button></header>
    {error && <p role="alert">{error}</p>}
    {report && <>
      {!report.helperAvailable && <p role="status">The helper did not answer. Available web-service readings are shown below.</p>}
      <div className="table-scroll"><table><thead><tr><th>Measurement</th><th>Web service</th><th>Helper</th></tr></thead><tbody>
        <tr><th>Process memory (RSS)</th><td>{bytes(web?.processMemory.rss)}</td><td>{bytes(helper?.processMemory.rss)}</td></tr>
        <tr><th>JavaScript heap used</th><td>{bytes(web?.processMemory.heapUsed)}</td><td>{bytes(helper?.processMemory.heapUsed)}</td></tr>
        <tr><th>External buffers</th><td>{bytes(web?.processMemory.external)}</td><td>{bytes(helper?.processMemory.external)}</td></tr>
        <tr><th>Linux file cache</th><td>{bytes(web?.cgroup.fileCacheBytes)}</td><td>{bytes(helper?.cgroup.fileCacheBytes)}</td></tr>
        <tr><th>Anonymous memory</th><td>{bytes(web?.cgroup.anonymousBytes)}</td><td>{bytes(helper?.cgroup.anonymousBytes)}</td></tr>
        <tr><th>CPU, percent of one core</th><td>{percent(web?.cpu.percentOfOneCore)}</td><td>{helper ? percent(helper.cpu.percentOfOneCore) : "Unavailable"}</td></tr>
        <tr><th>Out-of-memory kills in this service group</th><td>{web?.cgroup.oomKills ?? "Unavailable"}</td><td>{helper?.cgroup.oomKills ?? "Unavailable"}</td></tr>
        <tr><th>Version</th><td>{web?.version ?? "Unavailable"}</td><td>{helper?.version ?? "Unavailable"}</td></tr>
        <tr><th>Checked</th><td>{web ? new Date(web.checkedAt).toLocaleString() : "Unavailable"}</td><td>{helper ? new Date(helper.checkedAt).toLocaleString() : "Unavailable"}</td></tr>
      </tbody></table></div>
      <p>Linux can reclaim file cache when applications need memory. These measurements overlap, so do not add them together. A memory leak needs a trend across comparable workloads; one large reading does not prove one.</p>
      {report.transport && <p>{report.transport.active} helper requests active; {report.transport.completed} completed and {report.transport.failed} failed since the web service started.</p>}
    </>}
  </section>;
}
