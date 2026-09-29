import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOperation } from "../../ApproveDialog";
import { countOf } from "../../data";
import { formatBytes } from "../../formatBytes";
import { readJson } from "../../http";
import { loadStatus } from "../../home/format";
import { inspectOperation } from "../../operations";
import { Button, KeyValue, MetricTile, Notice, PageHeader, Panel, StatusChip, Table, Tag, appHue, initials, mayStart, riskOf, type Status, type TableColumn } from "../../ui";
import "./performance.css";

/*
 * Performance (M33.11), "Metrics" in the dock: how hard this server is working and what is working
 * it, read again every few seconds while the page is open. Facts first: the verdict names the
 * busiest measure, the strip has each one with its bar, then every app's live CPU and memory with
 * the controls to pause, stop or restart it right where the cost shows, then each filesystem and
 * sensor. Rebuilt in the console on the kit with every feature the Classic page had.
 */

interface Perf {
  generatedAt: string;
  cpu: { model: string; cores: number; usagePercent: number | null; perCore: number[]; load1: number; load5: number; load15: number; loadPercent: number };
  memory: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number };
  swap: { totalBytes: number; usedBytes: number; usedPercent: number };
  uptimeSeconds: number;
  temps: Array<{ label: string; celsius: number }>;
  disks: Array<{ mount: string; fstype: string; totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number }>;
  statsAvailable: boolean;
  apps: Array<{ id: string; state: string; running: boolean; cpuPercent: number; memBytes: number; containers: number }>;
}
type AppRow = Perf["apps"][number];
type Disk = Perf["disks"][number];
type AppMeta = { name: string; icon: string | null; category: string };

const uptimeText = (seconds: number) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
};
const stateLabel: Record<string, string> = { running: "running", paused: "paused", exited: "stopped", created: "stopped", restarting: "restarting", absent: "not running" };
const stateStatus = (app: AppRow): Status => (app.state === "paused" ? "warning" : app.state === "restarting" ? "danger" : app.running ? "good" : "neutral");
const worse = (a: Status, b: Status) => { const rank: Record<Status, number> = { danger: 4, warning: 3, unknown: 2, neutral: 1, good: 0 }; return rank[b] > rank[a] ? b : a; };

/** Each measure's status: the thresholds Ops uses, so both pages call the same load the same thing. */
const cpuStatus = (percent: number | null) => loadStatus(percent, 80, 95);
const memoryStatus = (percent: number) => loadStatus(percent, 85, 95);
const diskStatus = (percent: number) => loadStatus(percent, 85, 95);
const tempStatus = (celsius: number) => loadStatus(celsius, 80, 90);

/** An app's colour square, as Home draws it: its emoji, or its initials. */
function AppSquare({ id, name, icon }: { id: string; name: string; icon: string | null }) {
  return <span className="performance-square" data-hue={appHue(id)} data-emoji={icon ? true : undefined} aria-hidden="true">{icon ?? initials(name)}</span>;
}

export interface PerformancePageProps {
  csrfToken: string;
  /** Who is signed in: a viewer sees the numbers and no controls. */
  role?: string;
  /** How often the numbers are read again while the page is open. */
  pollMs?: number;
}

export default function PerformancePage({ csrfToken, role = "owner", pollMs = 3000 }: PerformancePageProps) {
  const [perf, setPerf] = useState<Perf | null>(null);
  const [meta, setMeta] = useState<Record<string, AppMeta>>({});
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const { result } = await inspectOperation<Perf>("system.performance.inspect");
      setPerf({ ...result, temps: result.temps ?? [], disks: result.disks ?? [], apps: result.apps ?? [] });
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Performance could not be read");
    }
  }, []);

  // Names, icons and categories change only on install and uninstall, so they are read once.
  useEffect(() => {
    fetch("/api/v1/catalog?view=summary")
      .then((response) => readJson<{ applications: Array<{ manifest: { id: string; name: string; icon: string | null; category: string } }> }>(response))
      .then((data) => setMeta(Object.fromEntries((data.applications ?? []).map((entry) => [entry.manifest.id, { name: entry.manifest.name, icon: entry.manifest.icon, category: entry.manifest.category }]))))
      .catch(() => setMeta({}));
  }, []);

  // Read every few seconds while the page is open and in view; CPU% is a delta, so the first read
  // is a baseline. A hidden tab asks for nothing and catches up when it is looked at again.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (!live) return;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") await poll();
      if (live) timer.current = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => { live = false; if (timer.current) clearTimeout(timer.current); };
  }, [poll, pollMs]);

  const { start, dialog } = useOperation(csrfToken, () => void poll());
  const canAct = mayStart(role, "app.action");
  const act = (id: string, action: string, title: string, preview: string) => start({ operationId: "app.action", title, parameters: { id, action }, preview: <span>{preview}</span> });

  // Heaviest first, but the AI services, the biggest draw on a box that has them, are pinned to the
  // top so they are always in view even when idle.
  const isAI = useCallback((id: string) => meta[id]?.category === "AI", [meta]);
  const apps = useMemo(() => [...(perf?.apps ?? [])].sort((a, b) => {
    if (isAI(a.id) !== isAI(b.id)) return isAI(a.id) ? -1 : 1;
    return b.cpuPercent - a.cpuPercent;
  }), [perf, isAI]);
  const nameOf = (id: string) => meta[id]?.name ?? id;

  // ── The verdict: the busiest measure, named. ──
  const cpu = perf?.cpu.usagePercent ?? null;
  const hottest = perf?.temps.length ? Math.max(...perf.temps.map((temp) => temp.celsius)) : null;
  const measures: Array<{ name: string; status: Status; words: string }> = perf ? [
    { name: "CPU", status: cpuStatus(cpu), words: `CPU ${cpu ?? "—"}%` },
    { name: "memory", status: memoryStatus(perf.memory.usedPercent), words: `Memory ${perf.memory.usedPercent}%` },
    ...perf.disks.map((disk) => ({ name: disk.mount, status: diskStatus(disk.usedPercent), words: `${disk.mount} ${disk.usedPercent}% full` })),
    ...(hottest === null ? [] : [{ name: "temperature", status: tempStatus(hottest), words: `${Math.round(hottest)}°C` }]),
  ] : [];
  const worst = measures.reduce<Status>((current, measure) => (measure.status === "unknown" ? current : worse(current, measure.status)), "good");
  const culprits = measures.filter((measure) => measure.status === worst && worst !== "good");
  const verdict = !perf
    ? { status: "unknown" as const, label: error ? "Not read" : "Reading…" }
    : culprits.length ? { status: worst, label: culprits.length === 1 ? culprits[0].words : `${culprits[0].words} · ${culprits.length - 1} more` }
      : cpu === null ? { status: "neutral" as const, label: "Measuring" } : { status: "good" as const, label: "Normal load" };
  const running = apps.filter((app) => app.running && app.state !== "paused").length;

  const columns: Array<TableColumn<AppRow>> = [
    {
      id: "app", header: "App", sortValue: (app) => nameOf(app.id), cell: (app) => (
        <span className="performance-app">
          <AppSquare id={app.id} name={nameOf(app.id)} icon={meta[app.id]?.icon ?? null} />
          <span className="performance-app__name">{nameOf(app.id)}</span>
          {isAI(app.id) && <Tag tone="info">AI</Tag>}
          {app.containers > 1 && <span className="performance-app__count">{countOf(app.containers, "container")}</span>}
        </span>
      ),
    },
    { id: "state", header: "State", sortValue: (app) => stateLabel[app.state] ?? app.state, cell: (app) => <StatusChip status={stateStatus(app)}>{stateLabel[app.state] ?? app.state}</StatusChip> },
    { id: "cpu", header: "CPU", numeric: true, sortValue: (app) => (app.running ? app.cpuPercent : null), cell: (app) => (app.running ? <><span className="performance-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, app.cpuPercent)}%` }} /></span>{`${app.cpuPercent.toFixed(1)}%`}</> : "—") },
    { id: "memory", header: "Memory", numeric: true, sortValue: (app) => (app.running ? app.memBytes : null), cell: (app) => (app.running ? formatBytes(app.memBytes) : "—") },
    ...(canAct ? [{
      id: "controls", header: <span className="ui-visually-hidden">Controls</span>, label: "Controls", className: "performance-actions-cell", cell: (app: AppRow) => {
        const name = nameOf(app.id);
        const paused = app.state === "paused";
        const up = app.running && !paused;
        const risk = riskOf("app.action");
        return (
          <span className="performance-actions">
            {up && <>
              <Button risk={risk} aria-label={`Pause ${name}`} onClick={() => act(app.id, "pause", `Pause ${name}`, `Freezes ${name}. It stops using the CPU but keeps its memory, and resumes instantly. Nothing is lost.`)}>Pause</Button>
              <Button risk={risk} aria-label={`Restart ${name}`} onClick={() => act(app.id, "restart", `Restart ${name}`, `Restarts ${name}.`)}>Restart</Button>
              <Button risk={risk} aria-label={`Stop ${name}`} onClick={() => act(app.id, "stop", `Stop ${name}`, `Stops ${name} and frees its memory. Its data is kept; starting it again is a cold start.`)}>Stop</Button>
            </>}
            {paused && <>
              <Button risk={risk} aria-label={`Resume ${name}`} onClick={() => act(app.id, "unpause", `Resume ${name}`, `Thaws ${name} exactly where it left off.`)}>Resume</Button>
              <Button risk={risk} aria-label={`Stop ${name}`} onClick={() => act(app.id, "stop", `Stop ${name}`, `Stops ${name} and frees its memory.`)}>Stop</Button>
            </>}
            {!up && !paused && <Button risk={risk} aria-label={`Start ${name}`} onClick={() => act(app.id, "start", `Start ${name}`, `Starts ${name}.`)}>Start</Button>}
          </span>
        );
      },
    }] : []),
  ];

  const diskColumns: Array<TableColumn<Disk>> = [
    { id: "mount", header: "Mounted at", sortValue: (disk) => disk.mount, cell: (disk) => <code className="performance-mount">{disk.mount}</code> },
    { id: "type", header: "Type", hideOnPhone: true, cell: (disk) => disk.fstype },
    { id: "used", header: "Used", numeric: true, sortValue: (disk) => disk.usedPercent, cell: (disk) => <><span className="performance-bar" data-status={diskStatus(disk.usedPercent)} aria-hidden="true"><i style={{ width: `${Math.min(100, disk.usedPercent)}%` }} /></span>{`${disk.usedPercent}%`}</> },
    { id: "size", header: "Size", numeric: true, hideOnPhone: true, sortValue: (disk) => disk.totalBytes, cell: (disk) => `${formatBytes(disk.usedBytes)} of ${formatBytes(disk.totalBytes)}` },
    { id: "free", header: "Free", numeric: true, sortValue: (disk) => disk.availableBytes, cell: (disk) => formatBytes(disk.availableBytes) },
  ];

  return (
    <div className="performance-page">
      {dialog}
      <PageHeader
        title="Performance"
        status={verdict}
        meta={perf ? <>up <b>{uptimeText(perf.uptimeSeconds)}</b> · <b>{perf.cpu.cores}</b> threads · load <b>{perf.cpu.load1.toFixed(2)}</b> · <b>{running}</b> of {countOf(apps.length, "app")} running · read every {Math.round(pollMs / 1000)} s</> : undefined}
        about={<>
          <p>How hard this server is working, and what is working it. The numbers are read again every few seconds while this page is open.</p>
          <p>Pause freezes an app without losing its memory and resumes it instantly; Stop frees the memory, and starting it again is a cold start. AI services stay at the top of the list, busy or not.</p>
        </>}
      />

      {error && <Notice tone={perf ? "warning" : "danger"} live title="Performance could not be read just now">{error.replace(/\.?$/, ".")} It is read again every few seconds.</Notice>}

      <section className="performance-strip" aria-label="Processor, memory, disks and temperature">
        {perf ? <>
          <MetricTile label="CPU" value={cpu === null ? "measuring…" : `${cpu}%`} caption={`${perf.cpu.model.replace(/\s+\d+-Core Processor$/, "")} · ${perf.cpu.cores} threads`} status={cpu === null ? "neutral" : cpuStatus(cpu)} bar={{ value: cpu ?? 0, label: "CPU in use" }} />
          <MetricTile label="Memory" value={formatBytes(perf.memory.usedBytes)} caption={`of ${formatBytes(perf.memory.totalBytes)} · ${perf.memory.usedPercent}% used`} status={memoryStatus(perf.memory.usedPercent)} bar={{ value: perf.memory.usedPercent, label: "Memory in use" }} />
          <MetricTile label="Swap" value={perf.swap.totalBytes ? formatBytes(perf.swap.usedBytes) : "none"} caption={perf.swap.totalBytes ? `of ${formatBytes(perf.swap.totalBytes)} · ${perf.swap.usedPercent}% used` : "no swap file"} status={perf.swap.totalBytes ? loadStatus(perf.swap.usedPercent, 50, 80) : "neutral"} bar={perf.swap.totalBytes ? { value: perf.swap.usedPercent, label: "Swap in use" } : undefined} />
          <MetricTile label="Load average" value={perf.cpu.load1.toFixed(2)} caption={`${perf.cpu.load5.toFixed(2)} · ${perf.cpu.load15.toFixed(2)} (5m · 15m)`} status={loadStatus(perf.cpu.loadPercent, 80, 95)} bar={{ value: perf.cpu.loadPercent, label: "Load against the processor's threads" }} />
          {perf.disks.slice(0, 2).map((disk) => (
            <MetricTile key={disk.mount} label={`Disk ${disk.mount}`} value={formatBytes(disk.usedBytes)} caption={`of ${formatBytes(disk.totalBytes)} · ${formatBytes(disk.availableBytes)} free`} status={diskStatus(disk.usedPercent)} bar={{ value: disk.usedPercent, label: `${disk.mount} used` }} />
          ))}
          {hottest !== null && <MetricTile label="Temperature" value={`${hottest.toFixed(0)}°C`} caption={(perf.temps.find((temp) => temp.celsius === hottest) ?? perf.temps[0]).label.split(":")[0]} status={tempStatus(hottest)} bar={{ value: Math.min(100, Math.round(hottest)), label: "Hottest sensor" }} />}
          <MetricTile label="Uptime" value={uptimeText(perf.uptimeSeconds)} caption="since boot" />
        </> : (
          <MetricTile label="CPU and memory" value="—" caption={error ? "Could not be read" : "Reading…"} status="unknown" />
        )}
      </section>

      <Panel className="performance-apps" title="What's running" count={perf ? apps.length : undefined} meta={perf ? <><b>{running}</b> running · heaviest first{Object.values(meta).some((entry) => entry.category === "AI") ? " · AI pinned" : ""}</> : undefined}>
        {perf && !perf.statsAvailable && <Notice tone="info" className="performance-note" title="Live CPU and memory per app are not answering">They come from Docker's stats stream, which is not answering right now. The states and controls still work.</Notice>}
        <Table
          caption="Each app's live CPU and memory"
          columns={columns}
          rows={apps}
          rowKey={(app) => app.id}
          rowStatus={(app) => (app.state === "restarting" ? "danger" : app.state === "paused" ? "warning" : undefined)}
          empty={!perf ? (error ? "The apps could not be read." : "Reading…") : "No apps are installed yet. Add some from the App catalog."}
        />
      </Panel>

      {perf && perf.disks.length > 0 && (
        <Panel className="performance-disks" title="Filesystems" count={perf.disks.length} meta={`${perf.disks.filter((disk) => diskStatus(disk.usedPercent) !== "good").length} filling up`}>
          <Table caption="Each filesystem's use" columns={diskColumns} rows={perf.disks} rowKey={(disk) => disk.mount} rowStatus={(disk) => { const status = diskStatus(disk.usedPercent); return status === "good" ? undefined : status; }} />
        </Panel>
      )}

      {perf && perf.temps.length > 0 && (
        <Panel padded className="performance-sensors" title="Sensors" count={perf.temps.length} meta={hottest !== null ? `hottest ${hottest.toFixed(0)}°C` : undefined}>
          <KeyValue layout="columns" items={perf.temps.map((temp, index) => ({ id: `${temp.label}-${index}`, label: temp.label, value: `${temp.celsius.toFixed(0)}°C`, mono: true, status: tempStatus(temp.celsius) }))} />
        </Panel>
      )}
    </div>
  );
}
