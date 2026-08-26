import { useCallback, useEffect, useRef, useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";
import { readJson } from "./http";

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

type AppMeta = { name: string; icon: string | null; category: string };

const gib = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`);
const uptimeText = (seconds: number) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
};

/** Green up to ~70%, amber to ~90%, red beyond — a load worth noticing shows itself. */
const heat = (percent: number | null) => (percent === null ? "" : percent >= 90 ? " meter-hot" : percent >= 70 ? " meter-warm" : "");

const stateLabel: Record<string, string> = { running: "running", paused: "paused", exited: "stopped", created: "stopped", restarting: "restarting", absent: "not running" };

export default function PerformanceCenter({ csrfToken }: { csrfToken: string }) {
  const [perf, setPerf] = useState<Perf | null>(null);
  const [meta, setMeta] = useState<Record<string, AppMeta>>({});
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const { result } = await inspectOperation<Perf>("system.performance.inspect");
      setPerf(result);
      setError(null);
    } catch {
      setError("Could not read performance right now, retrying.");
    }
  }, []);

  // Names, icons and categories change only on install/uninstall, so fetch them once.
  useEffect(() => {
    fetch("/api/v1/catalog")
      .then((response) => readJson<{ applications: Array<{ manifest: { id: string; name: string; icon: string | null; category: string } }> }>(response))
      .then((data) => setMeta(Object.fromEntries((data.applications ?? []).map((entry) => [entry.manifest.id, { name: entry.manifest.name, icon: entry.manifest.icon, category: entry.manifest.category }]))))
      .catch(() => setMeta({}));
  }, []);

  // Poll every few seconds while the page is open; CPU% is a delta, so the first tick is a baseline.
  useEffect(() => {
    let live = true;
    const tick = async () => { if (!live) return; await poll(); if (live) timer.current = setTimeout(tick, 3000); };
    void tick();
    return () => { live = false; if (timer.current) clearTimeout(timer.current); };
  }, [poll]);

  const { start, dialog } = useOperation(csrfToken, () => void poll());

  const act = (id: string, action: string, title: string, preview: string) =>
    start({ operationId: "app.action", title, parameters: { id, action }, preview: <span>{preview}</span> });

  // Heaviest first, but the AI services — the biggest draw on this box — are pinned to the top so
  // they are always in view even when idle.
  const isAI = (id: string) => meta[id]?.category === "AI";
  const apps = [...(perf?.apps ?? [])].sort((a, b) => {
    if (isAI(a.id) !== isAI(b.id)) return isAI(a.id) ? -1 : 1;
    return b.cpuPercent - a.cpuPercent;
  });

  const cpuValue = perf?.cpu.usagePercent ?? null;
  const metrics = perf ? [
    { label: "CPU", value: cpuValue === null ? "measuring…" : `${cpuValue}%`, sub: `${perf.cpu.model.replace(/\s+\d+-Core Processor$/, "")} · ${perf.cpu.cores} threads`, percent: cpuValue ?? 0 },
    { label: "Memory", value: `${gib(perf.memory.usedBytes)} / ${gib(perf.memory.totalBytes)}`, sub: `${perf.memory.usedPercent}% used`, percent: perf.memory.usedPercent },
    { label: "Swap", value: perf.swap.totalBytes ? `${gib(perf.swap.usedBytes)} / ${gib(perf.swap.totalBytes)}` : "none", sub: perf.swap.totalBytes ? `${perf.swap.usedPercent}% used` : "no swap file", percent: perf.swap.usedPercent },
    { label: "Load average", value: `${perf.cpu.load1.toFixed(2)}`, sub: `${perf.cpu.load5.toFixed(2)} · ${perf.cpu.load15.toFixed(2)} (5m · 15m)`, percent: perf.cpu.loadPercent },
    ...perf.disks.slice(0, 2).map((disk) => ({ label: `Disk ${disk.mount}`, value: `${gib(disk.usedBytes)} / ${gib(disk.totalBytes)}`, sub: `${gib(disk.availableBytes)} free`, percent: disk.usedPercent })),
    ...(perf.temps.length ? [{ label: "Temperature", value: `${Math.max(...perf.temps.map((temp) => temp.celsius)).toFixed(0)}°C`, sub: perf.temps[0].label.split(":")[0], percent: Math.min(100, Math.round(Math.max(...perf.temps.map((temp) => temp.celsius)))) }] : []),
    { label: "Uptime", value: uptimeText(perf.uptimeSeconds), sub: "since boot", percent: 0 },
  ] : [];

  return (
    <div className="performance-center">
      {dialog}
      {error && <div className="auth-error" role="alert">{error}</div>}

      <div className="metric-grid">
        {metrics.map((metric) => (
          <article className="metric" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <div className={`meter${heat(metric.percent)}`} aria-label={`${metric.label}: ${metric.value}`}><i style={{ width: `${Math.min(100, metric.percent)}%` }} /></div>
            <small className="muted">{metric.sub}</small>
          </article>
        ))}
      </div>

      <section className="panel">
        <header className="panel-header">
          <div>
            <strong>What's running</strong>
            <span>Each app's live CPU and memory, heaviest first. Pause freezes a container without losing its memory; stop frees the memory. AI services are pinned to the top.</span>
          </div>
        </header>
        {!perf ? <p className="muted">Loading…</p> : apps.length === 0 ? <p className="muted">No apps are installed yet. Add some from the App catalog.</p> : (
          <table className="perf-table">
            <thead><tr><th>App</th><th>State</th><th className="num">CPU</th><th className="num">Memory</th><th>Controls</th></tr></thead>
            <tbody>
              {apps.map((app) => {
                const name = meta[app.id]?.name ?? app.id;
                const paused = app.state === "paused";
                const running = app.running && !paused;
                return (
                  <tr key={app.id}>
                    <td>{meta[app.id]?.icon && <span className="perf-icon">{meta[app.id]?.icon}</span>}{name}{isAI(app.id) && <span className="status-pill status-neutral perf-ai">AI</span>}</td>
                    <td><span className={`status-pill ${running ? "status-good" : paused ? "status-warning" : "status-neutral"}`}>{stateLabel[app.state] ?? app.state}</span></td>
                    <td className="num">{running || paused ? `${app.cpuPercent.toFixed(1)}%` : "—"}</td>
                    <td className="num">{running || paused ? gib(app.memBytes) : "—"}</td>
                    <td className="perf-controls">
                      {running && <>
                        <button className="text-button" type="button" onClick={() => act(app.id, "pause", `Pause ${name}`, `Freezes ${name}. It stops using the CPU but keeps its memory, and resumes instantly. Nothing is lost.`)}>Pause</button>
                        <button className="text-button" type="button" onClick={() => act(app.id, "restart", `Restart ${name}`, `Restarts ${name}.`)}>Restart</button>
                        <button className="text-button danger-text" type="button" onClick={() => act(app.id, "stop", `Stop ${name}`, `Stops ${name} and frees its memory. Its data is kept; starting it again is a cold start.`)}>Stop</button>
                      </>}
                      {paused && <>
                        <button className="text-button" type="button" onClick={() => act(app.id, "unpause", `Resume ${name}`, `Thaws ${name} exactly where it left off.`)}>Resume</button>
                        <button className="text-button danger-text" type="button" onClick={() => act(app.id, "stop", `Stop ${name}`, `Stops ${name} and frees its memory.`)}>Stop</button>
                      </>}
                      {!running && !paused && <button className="text-button" type="button" onClick={() => act(app.id, "start", `Start ${name}`, `Starts ${name}.`)}>Start</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {perf && !perf.statsAvailable && <p className="muted">Live CPU and memory per app need Docker's stats stream, which is not answering right now.</p>}
      </section>
    </div>
  );
}
