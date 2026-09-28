import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useOperation } from "../ApproveDialog";
import { countOf, sentenceList, type ViewName } from "../data";
import { readJson } from "../http";
import { inspectOperation, type Job } from "../operations";
import { Button, Card, MetricTile, RiskTag, Section, StatusChip, Table, type RiskTier, type Status, type TableColumn } from "../ui";
import { useFacts, valuesOf } from "./facts";
import { elapsed, loadStatus, mountName, mountStatus, relativeTime, shortAge, size, uptime } from "./format";
import { NeedRow } from "./NeedRow";
import { buildNeeds, groupByTier, verdictFor, verdictSources, type Need } from "./needs";
import { backupMatrix, jobState, jobTarget, performanceFrom, shortReach, workloads, type BackupRow, type Performance, type RunState, type WorkloadRow } from "./opsFacts";

/*
 * Ops (M33.3, ADR-004): the Command Center. The same facts as Home, at compact density and all at
 * once: a metric strip, what needs the owner grouped by the risk tier of its fix, the containers
 * with their numbers, the job queue and a backup matrix. Every fact Home shows is here, one click
 * from its page.
 */

export interface OpsProps {
  csrfToken: string;
  role: string;
  onNavigate: (view: ViewName, options?: { app?: string }) => void;
  now?: () => number;
  /** How often the metric strip is read again while Ops is open. */
  pollMs?: number;
}

type PerformanceAnswer = unknown;

/** Live CPU and memory, read again every few seconds while the page is open and visible. */
function usePerformance(pollMs: number): { value: Performance | null; failed: boolean } {
  const [state, setState] = useState<{ value: Performance | null; failed: boolean }>({ value: null, failed: false });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        try {
          const { result } = await inspectOperation<PerformanceAnswer>("system.performance.inspect");
          if (live) setState({ value: performanceFrom(result), failed: false });
        } catch {
          if (live) setState((current) => ({ value: current.value, failed: true }));
        }
      }
      if (live) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [pollMs]);
  return state;
}

/** More of the job history than the live feed keeps, for the backup matrix: read once. */
function useJobHistory(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/v1/jobs?limit=200").then((response) => readJson<{ jobs?: Job[] }>(response))
      .then((body) => { if (live && Array.isArray(body?.jobs)) setJobs(body.jobs); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return jobs;
}

const tierHeading: Record<RiskTier, string> = { high: "Password and typed confirmation", medium: "Preview, then confirm", low: "One click" };

const runWords: Record<RunState, string> = { ok: "Completed", failed: "Failed", running: "Running", waiting: "Waiting for approval" };

function Panel({ title, status, summary, actions, className, children }: { title: string; status?: { status: Status; label: ReactNode }; summary?: ReactNode; actions?: ReactNode; className: string; children: ReactNode }) {
  return (
    <Card flush className={`ops-panel ${className}`}>
      <Section title={title} status={status} summary={summary} actions={actions}>{children}</Section>
    </Card>
  );
}

export default function Ops({ csrfToken, role, onNavigate, now = Date.now, pollMs = 5000 }: OpsProps) {
  const { facts, refresh } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const tiers = groupByTier(needs);
  const performance = usePerformance(pollMs);
  const history = useJobHistory();
  const { start, dialog } = useOperation(csrfToken, () => refresh());

  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "This server";
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const verdict = verdictFor(needs, { hostname, checking, unread });

  const open = (need: Need) => onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined);
  const act = (need: Need) => {
    if (need.action) start({ operationId: need.action.operationId, title: need.action.title, parameters: need.action.parameters, preview: <span>{need.action.preview}</span> });
  };

  // ── The metric strip: the live read when it answers, the inventory's otherwise. ──
  const perf = performance.value;
  const cpu = perf?.cpu.usagePercent ?? null;
  const memoryPercent = perf?.memory.usedPercent ?? inventory?.memoryPercent ?? null;
  const hottest = perf?.temps.length ? Math.max(...perf.temps.map((temp) => temp.celsius)) : null;
  const mounts = inventory?.mounts ?? [];
  const tailscale = inventory?.tailscale ?? null;
  const lan = inventory?.addresses.find((address) => address.interface !== "tailscale0" && /^\d+\.\d+\.\d+\.\d+$/.test(address.address)) ?? null;

  // ── Containers, jobs and backups, from the same facts. ──
  const apps = values.catalog?.apps ?? [];
  const rows = workloads(apps, perf, values.vms, shortReach);
  const liveJobs = values.jobs ?? [];
  const jobs = useMemo(() => {
    // The live feed is newer than the one-off read, so its copy of a job wins.
    const byId = new Map<string, Job>([...history, ...liveJobs].map((job) => [job.id, job]));
    return [...byId.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }, [history, liveJobs]);
  const queue = jobs.slice(0, 8);
  const running = jobs.filter((job) => job.state === "applying" || job.state === "verifying").length;
  const waiting = jobs.filter((job) => job.state === "awaiting_approval").length;
  const failedToday = jobs.filter((job) => job.state === "failed" && job.createdAt && clock - Date.parse(job.createdAt) < 86_400_000).length;
  const matrix = backupMatrix({ protection: values.protection, jobs, apps, now: clock });
  const offBox = values.offBox?.verdict ?? null;
  const database = values.database;

  const workloadColumns: Array<TableColumn<WorkloadRow>> = [
    { id: "name", header: "Name", cell: (row) => <button type="button" className="ops-link" title={row.name} onClick={() => (row.kind === "vm" ? onNavigate("virtualization") : onNavigate("catalog", { app: row.id }))}>{row.icon && <span className="ops-icon" aria-hidden="true">{row.icon}</span>}{row.name}</button> },
    { id: "state", header: "State", cell: (row) => <StatusChip status={row.status}>{row.state}</StatusChip> },
    { id: "cpu", header: "CPU", numeric: true, cell: (row) => (row.cpuPercent === null ? "—" : <><span className="ops-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, row.cpuPercent)}%` }} /></span>{`${row.cpuPercent.toFixed(1)}%`}</>) },
    { id: "memory", header: "Memory", numeric: true, cell: (row) => (row.memBytes === null ? "—" : size(row.memBytes)) },
    { id: "reach", header: "Reach", hideOnPhone: true, cell: (row) => row.reach },
    { id: "port", header: "Port", numeric: true, hideOnPhone: true, cell: (row) => (row.port === null ? "—" : String(row.port)) },
  ];

  const jobColumns: Array<TableColumn<Job>> = [
    { id: "job", header: "Job", hideOnPhone: true, cell: (job) => <span className="ops-mono">#{job.id.slice(0, 6)}</span> },
    { id: "operation", header: "Operation", cell: (job) => <button type="button" className="ops-link" onClick={() => onNavigate("repairs")} title={job.title}>{job.type.replace(/^op:/, "")}</button> },
    { id: "target", header: "Target", cell: (job) => jobTarget(job) },
    { id: "state", header: "State", cell: (job) => { const state = jobState(job); return <StatusChip status={state.status}>{state.label}</StatusChip>; } },
    { id: "started", header: "Started", numeric: true, cell: (job) => shortAge(job.createdAt, clock) ?? "—" },
    { id: "took", header: "Took", numeric: true, hideOnPhone: true, cell: (job) => {
      const from = Date.parse(job.createdAt ?? "");
      if (!Number.isFinite(from)) return "—";
      if (job.state === "applying" || job.state === "verifying") return elapsed(clock - from);
      const to = Date.parse(job.updatedAt ?? "");
      return job.state === "awaiting_approval" || !Number.isFinite(to) ? "—" : elapsed(to - from);
    } },
  ];

  const backupColumns: Array<TableColumn<BackupRow>> = [
    { id: "app", header: "App", cell: (row) => <button type="button" className="ops-link" onClick={() => onNavigate("backups")}>{row.name}</button> },
    { id: "runs", header: "Last runs", label: "Last runs, newest first", cell: (row) => (
      <span className="ops-runs">
        {row.runs.length === 0 ? <span className="ops-dim"><span aria-hidden="true">—</span><span className="ui-visually-hidden">No runs recorded</span></span> : row.runs.map((run) => (
          <span key={run.jobId} className="ops-run" data-run={run.state} title={`${runWords[run.state]} ${relativeTime(run.at, clock) ?? ""}`.trim()}>
            <span className="ui-mark" aria-hidden="true" /><span className="ui-visually-hidden">{`${runWords[run.state]} ${relativeTime(run.at, clock) ?? ""}. `}</span>
          </span>
        ))}
      </span>
    ) },
    { id: "newest", header: "Newest", numeric: true, cell: (row) => (row.backups === 0 ? "never" : shortAge(row.newestAt, clock) ?? "—") },
    { id: "drill", header: "Drill", hideOnPhone: true, cell: (row) => (!row.drill ? <span className="ops-dim">—</span> : <StatusChip status={row.drill.verified ? "good" : "danger"}>{row.drill.verified ? "passed" : "failed"}</StatusChip>) },
    { id: "summary", header: "Verdict", cell: (row) => <StatusChip status={row.status}>{row.summary}</StatusChip> },
  ];

  const tierGroups: Array<[RiskTier, Need[]]> = [["high", tiers.high], ["medium", tiers.medium], ["low", tiers.low]];
  const inboxCount = tiers.high.length + tiers.medium.length + tiers.low.length;
  const worstLook: Status = tiers.look.some((need) => need.severity === "danger") ? "danger" : tiers.look.some((need) => need.severity === "warning") ? "warning" : tiers.look.length ? "neutral" : checking ? "unknown" : "good";
  const containersUp = rows.filter((row) => row.kind === "app" && row.status !== "danger" && row.state !== "paused").length;

  return (
    <div className="ops" data-density="compact">
      {dialog}
      <header className="ops-head">
        <h1>Ops</h1>
        <StatusChip status={verdict.status}>{verdict.label}</StatusChip>
        <span className="ops-kv">
          {inventory ? <><b>{inventory.hostname}</b> · {inventory.operatingSystem} · kernel {inventory.kernel} · up {uptime(inventory.uptimeSeconds)} · BoxPilot {__BOXPILOT_VERSION__}</> : `BoxPilot ${__BOXPILOT_VERSION__}`}
        </span>
        <Button variant="ghost" onClick={() => refresh()}>Read again</Button>
      </header>
      <p className="ops-verdict">{verdict.sentence}</p>

      <section className="ops-strip" aria-label="Load, memory, disks and network">
        <MetricTile label="CPU" value={cpu === null ? (inventory ? `${inventory.loadPercent}%` : "—") : `${cpu.toFixed(1)}%`}
          caption={perf ? `load ${perf.cpu.load1.toFixed(2)} · ${perf.cpu.cores} threads` : inventory ? `load ${inventory.load1.toFixed(2)} on ${inventory.cpuCount} cores` : performance.failed ? "Could not be read" : "Reading…"}
          status={cpu === null && !inventory ? "unknown" : loadStatus(cpu ?? inventory?.loadPercent, 80, 95)} bar={cpu !== null || inventory ? { value: cpu ?? inventory?.loadPercent ?? 0 } : undefined} onSelect={() => onNavigate("performance")} />
        <MetricTile label="Memory" value={perf ? size(perf.memory.usedBytes) : inventory ? size(inventory.memoryUsed) : "—"}
          caption={perf ? `of ${size(perf.memory.totalBytes)} · ${perf.memory.usedPercent}%` : inventory ? `of ${size(inventory.memoryTotal)} · ${inventory.memoryPercent}%` : "Reading…"}
          status={memoryPercent === null ? "unknown" : loadStatus(memoryPercent, 85, 95)} bar={memoryPercent === null ? undefined : { value: memoryPercent }} onSelect={() => onNavigate("performance")} />
        {mounts.slice(0, 2).map((mount) => (
          <MetricTile key={mount.target} label={mountName(mount.target)} value={mount.percent === null ? "—" : `${mount.percent}%`}
            caption={mount.total === null ? "Size not known" : `${size(mount.used)} of ${size(mount.total)}`} status={mountStatus(mount)}
            bar={mount.percent === null ? undefined : { value: mount.percent }} onSelect={() => onNavigate("storage")} />
        ))}
        {!inventory && <MetricTile label="Disks" value="—" caption={facts.inventory.state === "failed" ? "Could not be read" : "Reading…"} status="unknown" onSelect={() => onNavigate("storage")} />}
        <MetricTile label="Network" value={!tailscale ? "—" : tailscale.connected ? "Tailnet up" : tailscale.installed ? "Tailnet down" : "LAN only"}
          caption={lan ? `${lan.interface} ${lan.address}` : inventory ? "No LAN address" : "Reading…"}
          status={!tailscale ? "unknown" : tailscale.connected || !tailscale.installed ? "good" : "warning"} onSelect={() => onNavigate("network")} />
        <MetricTile label={hottest === null ? "Uptime" : "Hottest sensor"} value={hottest === null ? (inventory ? uptime(inventory.uptimeSeconds) : "—") : `${Math.round(hottest)}°C`}
          caption={hottest === null ? (inventory ? inventory.operatingSystem : "Reading…") : perf!.temps.find((temp) => temp.celsius === hottest)?.label.split(":")[0] ?? ""}
          status={hottest === null ? (inventory ? "neutral" : "unknown") : loadStatus(hottest, 80, 90)} onSelect={() => onNavigate("performance")} />
      </section>

      <div className="ops-grid">
        <Panel className="ops-alerts" title="Alerts" status={{ status: worstLook, label: String(tiers.look.length) }} summary={tiers.look.length ? "Nothing to run from here: each opens its page." : undefined}>
          {tiers.look.length === 0
            ? <p className="ops-quiet">{checking ? "Reading…" : unread.length ? `Not read: ${sentenceList(unread)}.` : "No alerts."}</p>
            : <ul className="need-list">{tiers.look.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={act} />)}</ul>}
        </Panel>

        <Panel className="ops-containers" title="Containers and VMs"
          summary={values.catalog ? `${countOf(rows.filter((row) => row.kind === "app").length, "app")}, ${containersUp} up${values.vms ? ` · ${countOf(values.vms.domains.length, "VM")}` : ""}${perf && !perf.statsAvailable ? " · Docker's stats are not answering" : ""}` : undefined}
          status={facts.catalog.state === "failed" ? { status: "unknown", label: "Not read" } : undefined}>
          <Table caption="Containers and virtual machines" columns={workloadColumns} rows={rows} rowKey={(row) => row.id} rowStatus={(row) => row.status}
            empty={facts.catalog.state === "failed" ? "Which apps are installed could not be read." : values.catalog ? "No apps are installed yet." : "Reading…"} />
        </Panel>

        <Panel className="ops-inbox" title="Action inbox" status={{ status: inboxCount ? "warning" : "good", label: String(inboxCount) }} summary="Each button shows its tier; approving it is the same dialog as everywhere else.">
          {inboxCount === 0 && <p className="ops-quiet">{checking ? "Reading…" : "Nothing waiting to be run."}</p>}
          {tierGroups.filter(([, list]) => list.length > 0).map(([tier, list]) => (
            <section key={tier} className="ops-tier" aria-label={`${tier} risk`}>
              <h3 className="ops-tier__head"><RiskTag risk={tier} /><span>{tierHeading[tier]}</span></h3>
              <ul className="need-list">{list.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={act} />)}</ul>
            </section>
          ))}
        </Panel>

        <Panel className="ops-jobs" title="Job queue" summary={`${running} running · ${waiting} waiting for approval · ${failedToday} failed today`}
          status={facts.jobs.state === "failed" ? { status: "unknown", label: "Not read" } : undefined}>
          <Table caption="Recent jobs" columns={jobColumns} rows={queue} rowKey={(job) => job.id} rowStatus={(job) => jobState(job).status}
            empty={facts.jobs.state === "failed" ? "Job history could not be read." : values.jobs ? "No jobs yet." : "Reading…"} />
        </Panel>

        <Panel className="ops-backups" title="Backups"
          summary={<>{offBox ? (offBox.state === "ok" ? `Off this server ${relativeTime(offBox.lastSyncAt, clock)}` : offBox.state === "none" ? "No copy off this server" : "The off-box copy is behind") : "Off-box copy not read"} · database {database?.lastBackupAt ? relativeTime(database.lastBackupAt, clock) : database ? "never backed up" : "not read"}</>}
          status={facts.protection.state === "failed" ? { status: "unknown", label: "Not read" } : undefined}>
          <Table caption="Backups of each app, with its last runs" columns={backupColumns} rows={matrix} rowKey={(row) => row.id} rowStatus={(row) => row.status}
            empty={facts.protection.state === "failed" ? "Which apps have backups could not be read." : values.protection ? "No app holds data to back up." : "Reading…"} />
        </Panel>
      </div>
    </div>
  );
}
