import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { openActivity } from "../activityEvents";
import { useOperation } from "../ApproveDialog";
import { countOf, sentenceList, type ViewName } from "../data";
import { readJson } from "../http";
import { inspectOperation, type Job } from "../operations";
import { TopBarSlot } from "../shell/TopBarSlot";
import { Button, MetricTile, Sparkline, StatusChip, Table, type RiskTier, type Status, type TableColumn } from "../ui";
import { useFacts, valuesOf } from "./facts";
import { elapsed, loadStatus, mountName, mountStatus, relativeTime, shortAge, size, uptime } from "./format";
import { NeedRow } from "./NeedRow";
import { buildNeeds, groupByTier, verdictFor, verdictSources, type Need } from "./needs";
import { backupMatrix, jobState, jobTarget, performanceFrom, pushSample, sampleFrom, shortReach, workloads, type BackupRow, type Performance, type RunState, type Sample, type WorkloadRow } from "./opsFacts";

/*
 * Ops (M33.3, ADR-004): the Command Center. The same facts as Home, at compact density and all at
 * once: a metric strip, what needs the owner grouped by the risk tier of its fix, the containers
 * with their numbers, the job queue and a backup matrix. Every fact Home shows is here, one click
 * from its page.
 *
 * The look (M33.7) is the study's Command Center: near-black (or paper, in light), hairlines, IBM
 * Plex Sans Condensed with every number in JetBrains Mono, amber for what to act on and cyan for
 * what is measured. Its name and host facts sit in the shell's compact bar, and the processor,
 * memory and hottest sensor draw a sparkline of the reads made while the page is open.
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

/**
 * Live CPU and memory, read again every few seconds while the page is open and visible, with the
 * reads so far kept for the sparklines (a rolling buffer that lives as long as the page does).
 */
function usePerformance(pollMs: number, now: () => number): { value: Performance | null; failed: boolean; samples: Sample[] } {
  const [state, setState] = useState<{ value: Performance | null; failed: boolean; samples: Sample[] }>({ value: null, failed: false, samples: [] });
  // The clock is read when a sample lands, not a reason to start polling over.
  const clock = useRef(now);
  clock.current = now;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        try {
          const { result } = await inspectOperation<PerformanceAnswer>("system.performance.inspect");
          const value = performanceFrom(result);
          if (live) setState((current) => ({ value, failed: false, samples: pushSample(current.samples, sampleFrom(value, clock.current())) }));
        } catch {
          if (live) setState((current) => ({ ...current, failed: true }));
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

/** "27.4%" as the figure and its unit, so the unit can be drawn smaller; words stay as they are. */
function figure(text: string): ReactNode {
  const match = /^(-?[\d.,]+)(\s?\S.*)$/.exec(text);
  return match ? <>{match[1]}<small>{match[2]}</small></> : text;
}

/**
 * A panel in the study's style: a small uppercase title with its count, and a line of facts on the
 * right. The heading names the region, count included, so a screen reader hears "Alerts, 1".
 */
function Panel({ title, count, meta, className, children }: { title: string; count?: { status: Status; label: string }; meta?: ReactNode; className: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className={`cc-panel ${className}`} aria-labelledby={headingId}>
      <header className="cc-panel__head">
        <h2 id={headingId}>
          <span>{title}</span>
          {count && <span className="cc-count ui-marked" data-status={count.status}><span className="ui-mark" aria-hidden="true" />{count.label}</span>}
        </h2>
        {meta && <p className="cc-panel__meta">{meta}</p>}
      </header>
      {children}
    </section>
  );
}

export default function Ops({ csrfToken, role, onNavigate, now = Date.now, pollMs = 5000 }: OpsProps) {
  const { facts, refresh } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const tiers = groupByTier(needs);
  const performance = usePerformance(pollMs, now);
  const history = useJobHistory();
  const { start, dialog } = useOperation(csrfToken, () => refresh());

  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "This server";
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const verdict = verdictFor(needs, { hostname, checking, unread });

  // A staged or failed job opens in Activity, where it can be approved, cancelled or dismissed (M36).
  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));
  const act = (need: Need) => {
    if (need.action) start({ operationId: need.action.operationId, title: need.action.title, parameters: need.action.parameters, preview: <span>{need.action.preview}</span> });
  };

  // ── The metric strip: the live read when it answers, the inventory's otherwise. ──
  const perf = performance.value;
  const samples = performance.samples;
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
    // Names only, as the study's table has them (M33.7): the emoji is Home's, on each app's square.
    { id: "name", header: "Name", cell: (row) => <button type="button" className="ops-link" title={row.name} onClick={() => (row.kind === "vm" ? onNavigate("virtualization") : onNavigate("catalog", { app: row.id }))}>{row.name}</button> },
    { id: "state", header: "State", cell: (row) => <StatusChip status={row.status}>{row.state}</StatusChip> },
    { id: "cpu", header: "CPU", numeric: true, cell: (row) => (row.cpuPercent === null ? "—" : <><span className="ops-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, row.cpuPercent)}%` }} /></span>{`${row.cpuPercent.toFixed(1)}%`}</>) },
    { id: "memory", header: "Memory", numeric: true, cell: (row) => (row.memBytes === null ? "—" : size(row.memBytes)) },
    { id: "reach", header: "Reach", hideOnPhone: true, cell: (row) => (row.reach === "—" ? "—" : <span className="cc-tag" data-reach={row.reach}>{row.reach}</span>) },
    { id: "port", header: "Port", numeric: true, hideOnPhone: true, cell: (row) => (row.port === null ? "—" : String(row.port)) },
  ];

  const jobColumns: Array<TableColumn<Job>> = [
    { id: "job", header: "Job", hideOnPhone: true, cell: (job) => <span className="ops-mono">#{job.id.slice(0, 6)}</span> },
    { id: "operation", header: "Operation", cell: (job) => <button type="button" className="ops-link ops-link--mono" onClick={() => onNavigate("repairs")} title={job.title}>{job.type.replace(/^op:/, "")}</button> },
    { id: "target", header: "Target", className: "ops-mono-cell", cell: (job) => jobTarget(job) },
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
    <div className="ops cc" data-density="compact">
      {dialog}
      <TopBarSlot inPlace>
        <div className="cc-crumb">
          <span className="cc-crumb__host">{hostname}</span>
          <span className="cc-crumb__sep" aria-hidden="true">/</span>
          <h1>Ops</h1>
          <span className="cc-kv">
            {inventory
              ? <>{inventory.operatingSystem} · up <b>{uptime(inventory.uptimeSeconds)}</b> · kernel <b>{inventory.kernel}</b> · boxpilot <b>{__BOXPILOT_VERSION__}</b></>
              : <>boxpilot <b>{__BOXPILOT_VERSION__}</b></>}
          </span>
        </div>
      </TopBarSlot>

      <div className="cc-status">
        <StatusChip status={verdict.status}>{verdict.label}</StatusChip>
        <p className="ops-verdict">{verdict.sentence}</p>
        <Button variant="ghost" onClick={() => refresh()}>Read again</Button>
      </div>

      <section className="ops-strip" aria-label="Load, memory, disks and network">
        <MetricTile label="CPU" value={cpu === null ? (inventory ? figure(`${inventory.loadPercent}%`) : "—") : figure(`${cpu.toFixed(1)}%`)}
          caption={perf ? `load ${perf.cpu.load1.toFixed(2)} · ${perf.cpu.cores} threads` : inventory ? `load ${inventory.load1.toFixed(2)} on ${inventory.cpuCount} cores` : performance.failed ? "Could not be read" : "Reading…"}
          status={cpu === null && !inventory ? "unknown" : loadStatus(cpu ?? inventory?.loadPercent, 80, 95)} bar={cpu === null && inventory ? { value: inventory.loadPercent } : undefined}
          graphic={<Sparkline values={samples.map((sample) => sample.cpu)} floor={10} />} onSelect={() => onNavigate("performance")} />
        <MetricTile label="Memory" value={perf ? figure(size(perf.memory.usedBytes)) : inventory ? figure(size(inventory.memoryUsed)) : "—"}
          caption={perf ? `of ${size(perf.memory.totalBytes)} · ${perf.memory.usedPercent}%` : inventory ? `of ${size(inventory.memoryTotal)} · ${inventory.memoryPercent}%` : "Reading…"}
          status={memoryPercent === null ? "unknown" : loadStatus(memoryPercent, 85, 95)} bar={!perf && memoryPercent !== null ? { value: memoryPercent } : undefined}
          graphic={<Sparkline values={samples.map((sample) => sample.memory)} floor={10} />} onSelect={() => onNavigate("performance")} />
        {mounts.slice(0, 2).map((mount) => (
          <MetricTile key={mount.target} label={mountName(mount.target)} value={mount.percent === null ? "—" : figure(`${mount.percent}%`)}
            caption={mount.total === null ? "Size not known" : `${size(mount.used)} of ${size(mount.total)}`} status={mountStatus(mount)}
            bar={mount.percent === null ? undefined : { value: mount.percent }} onSelect={() => onNavigate("storage")} />
        ))}
        {!inventory && <MetricTile label="Disks" value="—" caption={facts.inventory.state === "failed" ? "Could not be read" : "Reading…"} status="unknown" onSelect={() => onNavigate("storage")} />}
        <MetricTile label="Network" value={!tailscale ? "—" : tailscale.connected ? "Tailnet up" : tailscale.installed ? "Tailnet down" : "LAN only"}
          caption={lan ? `${lan.interface} ${lan.address}` : inventory ? "No LAN address" : "Reading…"}
          status={!tailscale ? "unknown" : tailscale.connected || !tailscale.installed ? "good" : "warning"} onSelect={() => onNavigate("network")} />
        <MetricTile label={hottest === null ? "Uptime" : "Hottest sensor"} value={hottest === null ? (inventory ? uptime(inventory.uptimeSeconds) : "—") : figure(`${Math.round(hottest)}°C`)}
          caption={hottest === null ? (inventory ? inventory.operatingSystem : "Reading…") : perf!.temps.find((temp) => temp.celsius === hottest)?.label.split(":")[0] ?? ""}
          status={hottest === null ? (inventory ? "neutral" : "unknown") : loadStatus(hottest, 80, 90)}
          graphic={hottest === null ? undefined : <Sparkline values={samples.map((sample) => sample.hottest)} floor={4} />} onSelect={() => onNavigate("performance")} />
      </section>

      <div className="ops-grid">
        <Panel className="ops-alerts" title="Alerts" count={{ status: worstLook, label: String(tiers.look.length) }} meta={tiers.look.length ? "each opens its page" : undefined}>
          {tiers.look.length === 0
            ? <p className="ops-quiet">{checking ? "Reading…" : unread.length ? `Not read: ${sentenceList(unread)}.` : "No alerts."}</p>
            : <ul className="need-list">{tiers.look.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={act} />)}</ul>}
        </Panel>

        <Panel className="ops-containers" title="Containers & VMs"
          count={facts.catalog.state === "failed" ? { status: "unknown", label: "not read" } : undefined}
          meta={values.catalog ? `${countOf(rows.filter((row) => row.kind === "app").length, "app")}, ${containersUp} up${values.vms ? ` · ${countOf(values.vms.domains.length, "VM")}` : ""}${perf && !perf.statsAvailable ? " · Docker's stats are not answering" : ""}` : undefined}>
          <Table caption="Containers and virtual machines" columns={workloadColumns} rows={rows} rowKey={(row) => row.id} rowStatus={(row) => row.status}
            empty={facts.catalog.state === "failed" ? "Which apps are installed could not be read." : values.catalog ? "No apps are installed yet." : "Reading…"} />
        </Panel>

        <Panel className="ops-inbox" title="Action inbox" count={{ status: inboxCount ? "warning" : "good", label: String(inboxCount) }}
          meta={<><b>L</b> one click · <b>M</b> preview · <b>H</b> password</>}>
          {inboxCount === 0 && <p className="ops-quiet">{checking ? "Reading…" : "Nothing waiting to be run."}</p>}
          {tierGroups.filter(([, list]) => list.length > 0).map(([tier, list]) => (
            <section key={tier} className="ops-tier" aria-label={`${tier} risk`}>
              <h3 className="ui-visually-hidden">{tierHeading[tier]}</h3>
              <ul className="need-list">{list.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={act} tier="lead" />)}</ul>
            </section>
          ))}
        </Panel>

        <Panel className="ops-jobs" title="Job queue" count={facts.jobs.state === "failed" ? { status: "unknown", label: "not read" } : undefined}
          meta={`${running} running · ${waiting} waiting for approval · ${failedToday} failed today`}>
          <Table caption="Recent jobs" columns={jobColumns} rows={queue} rowKey={(job) => job.id} rowStatus={(job) => jobState(job).status}
            empty={facts.jobs.state === "failed" ? "Job history could not be read." : values.jobs ? "No jobs yet." : "Reading…"} />
        </Panel>

        <Panel className="ops-backups" title="Backups" count={facts.protection.state === "failed" ? { status: "unknown", label: "not read" } : undefined}
          meta={<>{offBox ? (offBox.state === "ok" ? `off-box ${relativeTime(offBox.lastSyncAt, clock)}` : offBox.state === "none" ? "no off-box copy" : "off-box copy behind") : "off-box not read"} · database {database?.lastBackupAt ? relativeTime(database.lastBackupAt, clock) : database ? "never backed up" : "not read"}</>}>
          <Table caption="Backups of each app, with its last runs" columns={backupColumns} rows={matrix} rowKey={(row) => row.id} rowStatus={(row) => row.status}
            empty={facts.protection.state === "failed" ? "Which apps have backups could not be read." : values.protection ? "No app holds data to back up." : "Reading…"} />
        </Panel>
      </div>
    </div>
  );
}
