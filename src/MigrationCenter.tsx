import { useCallback, useEffect, useState } from "react";

type Source = {
  id: string;
  fingerprint: string;
  importedAt: string;
  source: { hostname: string; operatingSystem: string; architecture: string; kernel: string };
  capacity: { cpuCount: number; totalMemoryBytes: number; rootTotalBytes: number; rootFreeBytes: number };
  counts: { containers: number; images: number; networks: number; volumes: number; projects: number };
};

type Plan = { id: string; revision: string; output: { blockers: Array<{ id: string; summary: string }>; warnings: string[]; changes: string[]; readyForTransferPlanning: boolean; executable: false } };

async function json<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

export default function MigrationCenter({ csrfToken }: { csrfToken: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [manifest, setManifest] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const body = await json<{ sources: Source[] }>(await fetch("/api/v1/migrations/sources"));
      setSources(body.sources ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Migration sources are unavailable");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const downloadManifest = async () => {
    setPending(true);
    try {
      const body = await json<Record<string, unknown>>(await fetch("/api/v1/migrations/export-manifest"));
      const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "boxpilot-migration-source-manifest.json";
      anchor.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manifest export failed");
    } finally { setPending(false); }
  };

  const importManifest = async () => {
    setPending(true);
    try {
      const parsed = JSON.parse(manifest) as Record<string, unknown>;
      await json(await fetch("/api/v1/migrations/sources/import", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify(parsed) }));
      setManifest("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manifest import failed");
    } finally { setPending(false); }
  };

  const planCompatibility = async (sourceId: string) => {
    setPending(true);
    try {
      const body = await json<{ plan: Plan }>(await fetch(`/api/v1/migrations/sources/${sourceId}/plans`, { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: "{}" }));
      setPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Compatibility planning failed");
    } finally { setPending(false); }
  };

  return <div className="migration-live-grid">
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="panel migration-manifest-panel"><div><span className="eyebrow">Read-only source discovery</span><h3>Exchange a sanitized manifest</h3><p>Download this BoxPilot node's manifest from the source, then paste it into the destination. Import stores only the bounded discovery fields and never contacts or changes the source.</p></div><button className="secondary-button" type="button" onClick={() => void downloadManifest()} disabled={pending}>Download this server manifest</button><label className="field-label" htmlFor="migration-manifest">Source manifest JSON</label><textarea id="migration-manifest" value={manifest} onChange={(event) => setManifest(event.target.value)} placeholder="Paste boxpilot-migration-source-manifest.json" spellCheck="false" /><button className="primary-button" type="button" onClick={() => void importManifest()} disabled={pending || !manifest.trim()}>{pending ? "Validating..." : "Validate and import"}</button></section>
    <section className="panel migration-sources-panel"><div className="section-heading"><div><span className="eyebrow">Durable source snapshots</span><h3>Imported sources</h3></div><button className="secondary-button" type="button" onClick={() => void refresh()}>Refresh</button></div>{sources.length ? <div className="migration-source-list">{sources.map((source) => <article key={source.id}><div><strong>{source.source.hostname}</strong><span>{source.source.operatingSystem} | {source.source.architecture}</span><code>{source.fingerprint.slice(0, 24)}...</code></div><div><span>{source.counts.containers} containers</span><span>{source.counts.volumes} volumes</span><span>{source.counts.projects} projects</span></div><button className="secondary-button" type="button" onClick={() => void planCompatibility(source.id)} disabled={pending}>Plan compatibility</button></article>)}</div> : <p className="empty-state">No source manifest has been imported. Export one from a source BoxPilot node first.</p>}</section>
    {plan && <section className="panel migration-compatibility" aria-label="Migration compatibility plan"><div className="section-heading"><div><span className="eyebrow">Immutable compatibility plan {plan.revision}</span><h3>{plan.output.readyForTransferPlanning ? "Ready for transfer adapter selection" : "Compatibility blockers found"}</h3></div><span className="status-pill status-warning">Transfer locked</span></div><div className="backup-plan-columns"><div><strong>Required future workflow</strong><ol>{plan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div><div><strong>Warnings</strong><ul>{plan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div></div>{plan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker.id}><strong>{blocker.id}</strong><span>{blocker.summary}</span></div>)}<p className="plan-recovery">This release cannot transfer data, change routes, stop the source, or delete anything. The compatibility plan is evidence only.</p></section>}
  </div>;
}
