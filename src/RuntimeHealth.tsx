import { useState } from "react";
import { readJson } from "./http";
import { Button, Panel, Table, type TableColumn } from "./ui";

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

interface Row { id: string; label: string; web: string; helper: string }

/** BoxPilot's own resource use, the web service beside the helper, read only when asked (Repair's console). */
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
  const rows: Row[] = report ? [
    { id: "rss", label: "Process memory (RSS)", web: bytes(web?.processMemory.rss), helper: bytes(helper?.processMemory.rss) },
    { id: "heap", label: "JavaScript heap used", web: bytes(web?.processMemory.heapUsed), helper: bytes(helper?.processMemory.heapUsed) },
    { id: "external", label: "External buffers", web: bytes(web?.processMemory.external), helper: bytes(helper?.processMemory.external) },
    { id: "cache", label: "Linux file cache", web: bytes(web?.cgroup.fileCacheBytes), helper: bytes(helper?.cgroup.fileCacheBytes) },
    { id: "anon", label: "Anonymous memory", web: bytes(web?.cgroup.anonymousBytes), helper: bytes(helper?.cgroup.anonymousBytes) },
    { id: "cpu", label: "CPU, percent of one core", web: percent(web?.cpu.percentOfOneCore), helper: helper ? percent(helper.cpu.percentOfOneCore) : "Unavailable" },
    { id: "oom", label: "Out-of-memory kills", web: String(web?.cgroup.oomKills ?? "Unavailable"), helper: String(helper?.cgroup.oomKills ?? "Unavailable") },
    { id: "version", label: "Version", web: web?.version ?? "Unavailable", helper: helper?.version ?? "Unavailable" },
    { id: "checked", label: "Checked", web: web ? new Date(web.checkedAt).toLocaleString() : "Unavailable", helper: helper ? new Date(helper.checkedAt).toLocaleString() : "Unavailable" },
  ] : [];
  const columns: Array<TableColumn<Row>> = [
    { id: "what", header: "Measurement", cell: (row) => row.label, className: "rp-cell-wrap" },
    { id: "web", header: "Web", numeric: true, cell: (row) => row.web },
    { id: "helper", header: "Helper", numeric: true, cell: (row) => row.helper },
  ];
  return (
    <Panel title="Resource use" label="BoxPilot's own resource use" meta={report ? (report.helperAvailable ? "web and helper" : "web only") : "read on request"}
      actions={<Button onClick={() => void check()} busy={busy}>{busy ? "Checking resources..." : "Check resource use"}</Button>}>
      {error && <p className="rp-note" data-tone="danger" role="alert">{error}</p>}
      {!report && !error && <p className="rp-quiet">The web service's and the helper's own memory and CPU, without starting a disk scan.</p>}
      {report && <>
        {!report.helperAvailable && <p className="rp-note" data-tone="warning" role="status">The helper did not answer. Available web-service readings are shown below.</p>}
        <Table caption="BoxPilot's own resource use" columns={columns} rows={rows} rowKey={(row) => row.id} />
        <p className="rp-quiet">
          These overlap, so do not add them up; Linux reclaims file cache when apps need memory, and a leak needs a trend, not one reading.
          {report.transport ? ` ${report.transport.active} helper requests active; ${report.transport.completed} completed and ${report.transport.failed} failed since the web service started.` : ""}
        </p>
      </>}
    </Panel>
  );
}
