import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inspectOperation } from "./operations";

interface Sources { groups: Array<{ id: string; label: string }>; units: Array<{ unit: string; description: string; active: string }>; containers: Array<{ name: string; state: string; image: string }>; dockerAvailable: boolean }
type Kind = "group" | "unit" | "container";

/** Logs: any journal group, systemd unit, or container — tail, time window, filter, follow, download. */
export default function SystemLogs({ csrfToken = "" }: { csrfToken?: string }) {
  const [sources, setSources] = useState<Sources | null>(null);
  const [kind, setKind] = useState<Kind>("group");
  const [target, setTarget] = useState("boxpilot");
  const [lines, setLines] = useState(300);
  const [since, setSince] = useState("");
  const [filter, setFilter] = useState("");
  // One journalctl run per keystroke would hammer the host; read after typing pauses.
  const [appliedFilter, setAppliedFilter] = useState("");
  const [follow, setFollow] = useState(false);
  const [entries, setEntries] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const pre = useRef<HTMLPreElement | null>(null);
  const readSequence = useRef(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedFilter(filter), 300);
    return () => window.clearTimeout(timer);
  }, [filter]);

  useEffect(() => { inspectOperation<Sources>("logs.sources").then(({ result }) => setSources(result)).catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Could not list log sources")); }, []);

  const read = useCallback(async () => {
    if (!target) return;
    const sequence = (readSequence.current += 1);
    setLoading(true);
    try {
      const parameters: Record<string, unknown> = { kind, target, lines };
      if (since.trim()) parameters.since = since.trim();
      if (appliedFilter.trim()) parameters.filter = appliedFilter.trim();
      const response = await fetch("/api/v1/operations/logs.read/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters }) });
      const body = (await response.json()) as { result?: { lines: string[] }; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not read logs");
      if (sequence !== readSequence.current) return; // a newer read already answered
      setEntries(body.result?.lines ?? []); setError(null);
    } catch (requestError) {
      if (sequence === readSequence.current) setError(requestError instanceof Error ? requestError.message : "Could not read logs");
    } finally {
      if (sequence === readSequence.current) setLoading(false);
    }
  }, [csrfToken, kind, target, lines, since, appliedFilter]);

  useEffect(() => { void read(); }, [read]);
  useEffect(() => { if (!follow) return undefined; const timer = window.setInterval(() => { void read(); }, 5000); return () => window.clearInterval(timer); }, [follow, read]);
  useEffect(() => { if (follow && pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [entries, follow]);

  const unitOptions = useMemo(() => (sources?.units ?? []).filter((unit) => !pick || unit.unit.toLowerCase().includes(pick.toLowerCase())).slice(0, 200), [sources, pick]);
  const select = (nextKind: Kind, nextTarget: string) => { setKind(nextKind); setTarget(nextTarget); };
  const download = () => {
    const blob = new Blob([entries.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${target.replace(/[^A-Za-z0-9._-]/g, "_")}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`; anchor.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="logs-center">
      <section className="panel">
        <div className="log-toolbar">
          <div className="log-source-tabs">
            {(sources?.groups ?? [{ id: "boxpilot", label: "BoxPilot" }]).map((group) => <button key={group.id} className={kind === "group" && target === group.id ? "active" : ""} type="button" onClick={() => select("group", group.id)}>{group.label}</button>)}
          </div>
          <div className="recovery-actions">
            <input aria-label="Find a unit" placeholder="Find a unit…" value={pick} onChange={(event) => setPick(event.target.value)} list="log-units" onKeyDown={(event) => { if (event.key === "Enter" && unitOptions[0]) select("unit", unitOptions[0].unit); }} />
            <datalist id="log-units">{unitOptions.map((unit) => <option key={unit.unit} value={unit.unit}>{unit.description}</option>)}</datalist>
            <button className="secondary-button" type="button" disabled={!unitOptions.some((unit) => unit.unit === pick)} onClick={() => select("unit", pick)}>Open unit</button>
            {sources?.dockerAvailable && (
              <select aria-label="Container" value={kind === "container" ? target : ""} onChange={(event) => event.target.value && select("container", event.target.value)}>
                <option value="">Container…</option>
                {sources.containers.map((container) => <option key={container.name} value={container.name}>{container.name} ({container.state})</option>)}
              </select>
            )}
          </div>
        </div>
        <div className="log-toolbar">
          <div className="recovery-actions">
            <span className="muted">Showing <code>{kind === "group" ? (sources?.groups.find((group) => group.id === target)?.label ?? target) : target}</code></span>
            <select aria-label="Lines" value={lines} onChange={(event) => setLines(Number.parseInt(event.target.value, 10))}>{[100, 300, 1000, 2000].map((count) => <option key={count} value={count}>{count} lines</option>)}</select>
            <select aria-label="Since" value={since} onChange={(event) => setSince(event.target.value)}><option value="">any time</option><option value="15m">last 15 min</option><option value="1h">last hour</option><option value="6h">last 6 hours</option><option value="1d">last day</option><option value="7d">last 7 days</option></select>
            <input aria-label="Filter" placeholder="Filter text…" value={filter} onChange={(event) => setFilter(event.target.value)} />
            <label className="cloud-vm-check"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow</label>
            <button className="secondary-button" type="button" onClick={() => void read()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
            <button className="text-button" type="button" onClick={download} disabled={entries.length === 0}>Download</button>
          </div>
        </div>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <pre ref={pre} className="app-logs log-output" aria-label="Log output">{entries.length ? entries.join("\n") : loading ? "Loading…" : "No entries."}</pre>
      </section>
    </div>
  );
}
