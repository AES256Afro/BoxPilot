import { useCallback, useEffect, useState } from "react";

const sources = [
  { id: "boxpilot", label: "BoxPilot" },
  { id: "docker", label: "Docker" },
  { id: "tailscale", label: "Tailscale" },
  { id: "virtualization", label: "Virtualization" },
] as const;

type Entry = { timestamp: string | null; unit: string; priority: number; message: string };

export default function SystemLogs() {
  const [source, setSource] = useState("boxpilot");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/logs?source=${source}&limit=100`);
      const body = await response.json() as { entries?: Entry[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Logs are unavailable");
      setEntries(body.entries ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Logs are unavailable");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => { void refresh(); }, [refresh]);

  return <section className="panel log-panel"><div className="log-toolbar"><div className="log-source-tabs">{sources.map((item) => <button className={source === item.id ? "active" : ""} type="button" key={item.id} onClick={() => setSource(item.id)}>{item.label}</button>)}</div><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Loading..." : "Refresh"}</button></div>{error && <p className="form-error" role="alert">{error}</p>}{!loading && !error && entries.length === 0 ? <div className="log-empty">No entries were returned for this fixed, redacted source.</div> : entries.map((entry, index) => <div className="log-row" key={`${entry.timestamp}-${entry.unit}-${index}`}><time>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "unknown"}</time><span>{entry.unit}</span><code>{entry.message}</code></div>)}</section>;
}
