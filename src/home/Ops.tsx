import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openActivity, openNotifications } from "../activityEvents";
import { useCheckAgain } from "./useCheckAgain";
import { useNeedActions } from "./useNeedActions";
import { countOf, sentenceList, type ViewName } from "../data";
import { useJobHistory, useMergedJobs } from "./jobHistory";
import { inspectOperation, type Job } from "../operations";
import { Button, KeyValue, MetricStrip, MetricTile, PageHeader, Panel, Sparkline, StatusChip, Table, type RiskTier, type Status, type TableColumn } from "../ui";
import { useFacts, valuesOf, type ServiceFact, type SmartDiskFact } from "./facts";
import { elapsed, loadStatus, mountName, mountStatus, relativeTime, shortAge, size, uptime } from "./format";
import { checklistSummary, diskDetail, diskHealth, serviceState, smartSummary, smartUnreadReason, upsSummary } from "./hostFacts";
import { NeedRow } from "./NeedRow";
import { AgentsGlance } from "../pages/agents/AgentsGlance";
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
 *
 * M33.8 retired the Classic overview, so what it showed and Home did not is here: each drive's
 * SMART health, the key services, the UPS and the setup checklist. The header and panels are the
 * kit's PageHeader and Panel, the pattern every console page follows.
 */

export interface OpsProps {
  csrfToken: string;
  role: string;
  onNavigate: (view: ViewName, options?: { app?: string; tab?: string }) => void;
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

const tierHeading: Record<RiskTier, string> = { high: "Password and typed confirmation", medium: "Preview, then confirm", low: "One click" };

const runWords: Record<RunState, string> = { ok: "Completed", failed: "Failed", running: "Running", waiting: "Waiting for approval" };

/** "27.4%" as the figure and its unit, so the unit can be drawn smaller; words stay as they are. */
function figure(text: string): ReactNode {
  const match = /^(-?[\d.,]+)(\s?\S.*)$/.exec(text);
  return match ? <>{match[1]}<small>{match[2]}</small></> : text;
}


export default function Ops({ csrfToken, role, onNavigate, now = Date.now, pollMs = 5000 }: OpsProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const tiers = groupByTier(needs);
  const performance = usePerformance(pollMs, now);
  // More of the history than the live feed keeps, for the backup matrix (shared with Today, M25.3).
  const { jobs: history } = useJobHistory();
  // Every button in the alerts and the inbox, Repair's fixes included, run as Repair runs them (M35).
  const { act, runs, dialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const runOf = (need: Need) => (need.finding ? runs[need.finding.id] : undefined);
  const again = useCheckAgain(refresh);

  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "This server";
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const verdict = verdictFor(needs, { hostname, checking, unread });

  // A staged or failed job opens in Activity, where it can be approved, cancelled or dismissed (M36).
  // What BoxPilot could not tell anyone is read in the notification centre, which says what it was.
  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));

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
  // The live feed is newer than the one-off read, so its copy of a job wins.
  const jobs = useMergedJobs(history, liveJobs);
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

  // ── The host's own facts, from the Classic overview (M33.8). ──
  const smart = inventory?.smart ?? null;
  const smartCount = smartSummary(smart);
  const diskColumns: Array<TableColumn<SmartDiskFact>> = [
    { id: "drive", header: "Drive", cell: (disk) => <button type="button" className="ops-link ops-link--mono" onClick={() => onNavigate("storage")} title={diskDetail(disk)}>{disk.device.replace(/^\/dev\//, "")}</button> },
    { id: "health", header: "Health", cell: (disk) => { const health = diskHealth(disk); return <StatusChip status={health.status} title={diskDetail(disk)}>{health.label}</StatusChip>; } },
    { id: "temp", header: "Temp", numeric: true, cell: (disk) => (disk.temperature === null ? "—" : `${disk.temperature}°C`) },
    { id: "wear", header: "Wear", numeric: true, hideOnPhone: true, cell: (disk) => (disk.wear === null ? "—" : `${disk.wear}%`) },
    { id: "errors", header: "Errors", numeric: true, cell: (disk) => (disk.mediaErrors === null ? "—" : String(disk.mediaErrors)) },
  ];
  const keyServices = inventory?.services ?? [];
  const servicesDown = keyServices.filter((service) => serviceState(service).status === "danger").length;
  const serviceColumns: Array<TableColumn<ServiceFact>> = [
    { id: "unit", header: "Unit", cell: (service) => <button type="button" className="ops-link ops-link--mono" onClick={() => onNavigate("services")} title={service.unit}>{service.unit.replace(/\.service$/, "")}</button> },
    { id: "state", header: "State", cell: (service) => { const state = serviceState(service); return <StatusChip status={state.status}>{state.label}</StatusChip>; } },
    { id: "boot", header: "Boot", hideOnPhone: true, cell: (service) => service.enabled || "—" },
  ];
  const ups = inventory?.ups ?? null;
  const power = upsSummary(ups);
  const setup = checklistSummary(values.checklist);

  const tierGroups: Array<[RiskTier, Need[]]> = [["high", tiers.high], ["medium", tiers.medium], ["low", tiers.low]];
  const inboxCount = tiers.high.length + tiers.medium.length + tiers.low.length;
  const worstLook: Status = tiers.look.some((need) => need.severity === "danger") ? "danger" : tiers.look.some((need) => need.severity === "warning") ? "warning" : tiers.look.length ? "neutral" : checking ? "unknown" : "good";
  const containersUp = rows.filter((row) => row.kind === "app" && row.status !== "danger" && row.state !== "paused").length;

  return (
    <div className="ops cc" data-density="compact">
      {dialog}
      <PageHeader
        title="Ops"
        host={inventory?.hostname ?? null}
        status={{ status: verdict.status, label: verdict.label }}
        summary={verdict.sentence}
        actions={<>{again.said}<Button variant="ghost" busy={again.checking} onClick={again.run}>{again.checking ? "Reading…" : "Read again"}</Button></>}
        barFacts={inventory
          ? <>{inventory.operatingSystem} · up <b>{uptime(inventory.uptimeSeconds)}</b> · kernel <b>{inventory.kernel}</b> · boxpilot <b>{__BOXPILOT_VERSION__}</b></>
          : <>boxpilot <b>{__BOXPILOT_VERSION__}</b></>}
      />

      <MetricStrip label="Load, memory, disks and network" className="ops-strip">
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
      </MetricStrip>

      <div className="ops-grid">
        <Panel className="ops-alerts" title="Alerts" count={{ status: worstLook, label: String(tiers.look.length) }} meta={tiers.look.length ? "each opens its page" : undefined}>
          {tiers.look.length === 0
            ? <p className="ops-quiet">{checking ? "Reading…" : unread.length ? `Not read: ${sentenceList(unread)}.` : "No alerts."}</p>
            : <ul className="need-list">{tiers.look.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={act} run={runOf(need)} />)}</ul>}
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
              <ul className="need-list">{list.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={act} tier="lead" run={runOf(need)} />)}</ul>
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

        {/* What the Classic overview showed and Ops now does (M33.8): each drive's health, the key
            services, the UPS and the setup checklist. */}
        <Panel className="ops-disks" title="Disks" count={inventory ? smartCount : undefined}
          meta={smart?.readAt ? `read ${relativeTime(smart.readAt, clock)}${smart.stale ? " · stale" : ""}` : undefined}>
          {smart?.available && smart.disks.length > 0
            ? <Table caption="Each drive's health" columns={diskColumns} rows={smart.disks} rowKey={(disk) => disk.device} rowStatus={(disk) => diskHealth(disk).status} />
            : <p className="ops-quiet">{!inventory ? (facts.inventory.state === "failed" ? "The drives could not be read." : "Reading…") : smart?.available ? "No drive reported its health." : smartUnreadReason(smart)}</p>}
        </Panel>

        <Panel className="ops-services" title="Key services" count={servicesDown ? { status: "danger", label: `${servicesDown} down` } : undefined}
          meta={inventory ? `${keyServices.length - servicesDown} of ${keyServices.length} running` : undefined}>
          <Table caption="Key system services" columns={serviceColumns} rows={keyServices} rowKey={(service) => service.unit} rowStatus={(service) => serviceState(service).status}
            empty={!inventory ? (facts.inventory.state === "failed" ? "The services could not be read." : "Reading…") : "This server named no key services."} />
        </Panel>

        <Panel padded className="ops-power" title="Power" count={inventory ? { status: power.status, label: power.label } : undefined}>
          <p className="ops-power__headline">{inventory ? power.headline : facts.inventory.state === "failed" ? "The UPS could not be read." : "Reading…"}</p>
          {ups?.available && (
            <KeyValue layout="rows" items={[
              { id: "charge", label: "Battery", value: ups.charge === null ? "—" : `${ups.charge}%`, mono: true },
              { id: "runtime", label: "Runtime", value: ups.runtimeSeconds === null ? "—" : elapsed(ups.runtimeSeconds * 1000), mono: true },
              { id: "load", label: "Load", value: ups.load === null ? "—" : `${ups.load}%`, mono: true },
              { id: "status", label: "Status", value: ups.tokens.join(" ") || "—", mono: true },
            ]} />
          )}
          {inventory && !ups?.configured && <Button variant="ghost" onClick={() => onNavigate("system")}>Set up a UPS on System</Button>}
        </Panel>

        <Panel className="ops-setup" title="Setup" count={values.checklist ? { status: setup.status, label: setup.label } : undefined}
          meta={values.checklist ? "essentials in place" : undefined}>
          {!values.checklist
            ? <p className="ops-quiet">{facts.checklist.state === "failed" ? "The setup checklist could not be read." : "Reading…"}</p>
            : values.checklist.items.length === 0 ? <p className="ops-quiet">Nothing to set up.</p>
              : (
                <ul className="ops-checklist">
                  {values.checklist.items.map((item) => {
                    const state = item.done ? "done" : item.known === false ? "unchecked" : "todo";
                    return (
                      <li key={item.id} className="ops-checklist__item ui-marked" data-state={state} data-status={item.done ? "good" : item.known === false ? "unknown" : "neutral"}>
                        <span className="ui-mark" aria-hidden="true" />
                        <span className="ops-checklist__words">
                          <span className="ops-checklist__title">{item.title}{item.optional ? <span className="ops-dim"> · optional</span> : null}</span>
                          <span className="ops-checklist__detail">{item.known === false ? "Could not be checked just now." : item.detail}</span>
                        </span>
                        <span className="ops-checklist__state">{state === "done" ? "done" : state === "unchecked" ? "not checked" : "to do"}</span>
                        {!item.done && item.known !== false && <Button variant="ghost" aria-label={`Open: ${item.title}`} onClick={() => onNavigate(item.view)}>Open</Button>}
                      </li>
                    );
                  })}
                </ul>
              )}
        </Panel>
        <AgentsGlance variant="ops" role={role} onOpen={() => onNavigate("agents")} now={now} />
      </div>
    </div>
  );
}
