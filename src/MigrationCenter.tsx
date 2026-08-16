import { useCallback, useEffect, useState } from "react";

type Source = {
  id: string;
  fingerprint: string;
  importedAt: string;
  source: { hostname: string; operatingSystem: string; architecture: string; kernel: string };
  capacity: { cpuCount: number; totalMemoryBytes: number; rootTotalBytes: number; rootFreeBytes: number };
  counts: { containers: number; images: number; networks: number; volumes: number; projects: number };
};

type CompatibilityPlan = {
  id: string;
  revision: string;
  output: { blockers: Array<{ id: string; summary: string }>; warnings: string[]; changes: string[]; readyForTransferPlanning: boolean; executable: false };
};

type MigrationBundle = {
  bundleId: string;
  workloadName: string;
  sourceFingerprint: string;
  sourceId: string | null;
  sourceHostname: string | null;
  createdAt: string;
  composeFile: string;
  contentRevision: string;
  fileCount: number;
  sensitiveFileCount: number;
  totalBytes: number;
  destinationState: "empty" | "resumable" | "completed";
  remainingBytes: number;
  verifiedBytes: number;
  executable: boolean;
  blockers: string[];
};

type InvalidBundle = { bundleId: string; reason: string };

type MigrationTransfer = {
  id: string;
  bundleId: string;
  sourceId: string;
  workloadName: string;
  destination: string;
  fileCount: number;
  sizeBytes: number;
  contentVerified: boolean;
  sourcePreserved: boolean;
  activationPerformed: boolean;
  createdAt: string;
};

type TransferPlan = {
  id: string;
  revision: string;
  output: {
    executable: boolean;
    workloadName: string;
    sourceHostname: string;
    composeFile: string;
    fileCount: number;
    sensitiveFileCount: number;
    totalBytes: number;
    remainingBytes: number;
    destinationState: string;
    blockers: string[];
    changes: string[];
    verification: string[];
    warnings: string[];
    recovery: string;
    sourcePreserved: true;
    activationPerformed: false;
  };
};

async function json<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

function bytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export default function MigrationCenter({ csrfToken }: { csrfToken: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [bundles, setBundles] = useState<MigrationBundle[]>([]);
  const [invalidBundles, setInvalidBundles] = useState<InvalidBundle[]>([]);
  const [transfers, setTransfers] = useState<MigrationTransfer[]>([]);
  const [manifest, setManifest] = useState("");
  const [compatibilityPlan, setCompatibilityPlan] = useState<CompatibilityPlan | null>(null);
  const [transferPlan, setTransferPlan] = useState<TransferPlan | null>(null);
  const [stagedJobId, setStagedJobId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [sourceBody, bundleBody] = await Promise.all([
        json<{ sources: Source[] }>(await fetch("/api/v1/migrations/sources")),
        json<{ bundles: MigrationBundle[]; invalidBundles: InvalidBundle[]; transfers: MigrationTransfer[] }>(await fetch("/api/v1/migrations/bundles")),
      ]);
      setSources(sourceBody.sources ?? []);
      setBundles(bundleBody.bundles ?? []);
      setInvalidBundles(bundleBody.invalidBundles ?? []);
      setTransfers(bundleBody.transfers ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Migration evidence is unavailable");
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
      const body = await json<{ plan: CompatibilityPlan }>(await fetch(`/api/v1/migrations/sources/${sourceId}/plans`, { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: "{}" }));
      setCompatibilityPlan(body.plan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Compatibility planning failed");
    } finally { setPending(false); }
  };

  const planBundleTransfer = async (bundleId: string) => {
    setPending(true);
    try {
      const body = await json<{ plan: TransferPlan }>(await fetch(`/api/v1/migrations/bundles/${bundleId}/transfer-plans`, { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: "{}" }));
      setTransferPlan(body.plan);
      setStagedJobId(null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Transfer planning failed");
    } finally { setPending(false); }
  };

  const stageTransfer = async () => {
    if (!transferPlan) return;
    setPending(true);
    try {
      const body = await json<{ job: { id: string } }>(await fetch(`/api/v1/migration-transfer-plans/${transferPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: transferPlan.revision }),
      }));
      setStagedJobId(body.job.id);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Transfer staging failed");
    } finally { setPending(false); }
  };

  return <div className="migration-live-grid">
    {error && <p className="form-error" role="alert">{error}</p>}

    <section className="panel migration-manifest-panel">
      <div><span className="eyebrow">Read-only source discovery</span><h3>Exchange a sanitized manifest</h3><p>Download this node&apos;s manifest from the source, then paste it into the destination. Import stores bounded discovery fields only and never contacts or changes the source.</p></div>
      <button className="secondary-button" type="button" onClick={() => void downloadManifest()} disabled={pending}>Download this server manifest</button>
      <label className="field-label" htmlFor="migration-manifest">Source manifest JSON</label>
      <textarea id="migration-manifest" value={manifest} onChange={(event) => setManifest(event.target.value)} placeholder="Paste boxpilot-migration-source-manifest.json" spellCheck="false" />
      <button className="primary-button" type="button" onClick={() => void importManifest()} disabled={pending || !manifest.trim()}>{pending ? "Validating..." : "Validate and import"}</button>
    </section>

    <section className="panel migration-sources-panel">
      <div className="section-heading"><div><span className="eyebrow">Durable source snapshots</span><h3>Imported sources</h3></div><button className="secondary-button" type="button" onClick={() => void refresh()}>Refresh all</button></div>
      {sources.length ? <div className="migration-source-list">{sources.map((source) => <article key={source.id}><div><strong>{source.source.hostname}</strong><span>{source.source.operatingSystem} | {source.source.architecture}</span><code>{source.fingerprint.slice(0, 24)}...</code></div><div><span>{source.counts.containers} containers</span><span>{source.counts.volumes} volumes</span><span>{source.counts.projects} projects</span></div><button className="secondary-button" type="button" onClick={() => void planCompatibility(source.id)} disabled={pending}>Plan compatibility</button></article>)}</div> : <p className="empty-state">No source manifest has been imported. Export one from a source BoxPilot node first.</p>}
    </section>

    {compatibilityPlan && <section className="panel migration-compatibility" aria-label="Migration compatibility plan">
      <div className="section-heading"><div><span className="eyebrow">Immutable compatibility plan {compatibilityPlan.revision}</span><h3>{compatibilityPlan.output.readyForTransferPlanning ? "Ready for bundle preparation" : "Compatibility blockers found"}</h3></div><span className="status-pill status-warning">Evidence only</span></div>
      <div className="backup-plan-columns"><div><strong>Required workflow</strong><ol>{compatibilityPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div><div><strong>Warnings</strong><ul>{compatibilityPlan.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div></div>
      {compatibilityPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker.id}><strong>{blocker.id}</strong><span>{blocker.summary}</span></div>)}
      <p className="plan-recovery">Compatibility planning cannot transfer data, change routes, stop the source, or delete anything.</p>
    </section>}

    <section className="panel migration-sources-panel" aria-label="Migration bundle inbox">
      <div className="section-heading"><div><span className="eyebrow">Root-only local handoff</span><h3>Verified transfer inbox</h3></div><span className="status-pill status-warning">Activation locked</span></div>
      <p>Create a checksummed bundle from the server terminal with the included pack tool. BoxPilot discovers only fixed inbox IDs and sanitized totals. File paths, secret contents, arbitrary source paths, commands, and destination paths never cross the browser API.</p>
      {bundles.length ? <div className="migration-source-list">{bundles.map((bundle) => <article key={bundle.bundleId}>
        <div><strong>{bundle.workloadName}</strong><span>{bundle.sourceHostname ?? "Source manifest not imported"} | {bundle.composeFile}</span><code>{bundle.contentRevision.slice(0, 24)}...</code></div>
        <div><span>{bundle.fileCount} files | {bytes(bundle.totalBytes)}</span><span>{bundle.sensitiveFileCount} sensitive-name matches</span><span>{bundle.destinationState}{bundle.destinationState === "resumable" ? ` | ${bytes(bundle.remainingBytes)} remaining` : ""}</span></div>
        <button className="secondary-button" type="button" onClick={() => void planBundleTransfer(bundle.bundleId)} disabled={pending || !bundle.executable}>{bundle.destinationState === "resumable" ? "Plan safe resume" : bundle.destinationState === "completed" ? "Transfer verified" : "Plan staged transfer"}</button>
        {bundle.blockers.map((blocker) => <span className="form-error" key={blocker}>{blocker}</span>)}
      </article>)}</div> : <p className="empty-state">No valid bundle is present in the fixed migration inbox.</p>}
      {invalidBundles.map((bundle) => <div className="notice warning-notice" key={bundle.bundleId}><strong>Invalid bundle {bundle.bundleId.slice(0, 8)}</strong><span>{bundle.reason}</span></div>)}
    </section>

    {transferPlan && <section className="panel migration-compatibility" aria-label="Migration transfer plan">
      <div className="section-heading"><div><span className="eyebrow">Immutable transfer plan {transferPlan.revision}</span><h3>Stage {transferPlan.output.workloadName} without activation</h3></div><span className="status-pill status-warning">Password approval required</span></div>
      <div className="backup-plan-columns"><div><strong>Exact changes</strong><ol>{transferPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div><div><strong>Verification</strong><ul>{transferPlan.output.verification.map((item) => <li key={item}>{item}</li>)}</ul></div></div>
      <p>{transferPlan.output.fileCount} files, {bytes(transferPlan.output.totalBytes)} total, {bytes(transferPlan.output.remainingBytes)} remaining. {transferPlan.output.sensitiveFileCount} file names match sensitive-data rules.</p>
      {transferPlan.output.warnings.map((warning) => <div className="notice warning-notice" key={warning}><span>{warning}</span></div>)}
      {transferPlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker}><strong>Blocked</strong><span>{blocker}</span></div>)}
      <p className="plan-recovery">{transferPlan.output.recovery}</p>
      <button className="primary-button" type="button" onClick={() => void stageTransfer()} disabled={pending || !transferPlan.output.executable || Boolean(stagedJobId)}>{stagedJobId ? "Transfer job staged" : pending ? "Revalidating..." : "Stage transfer for approval"}</button>
      {stagedJobId && <div className="notice"><strong>Job {stagedJobId.slice(0, 8)} is awaiting approval</strong><span>Open Operations, review the immutable steps, and re-enter the owner password. The transfer then runs in the background.</span></div>}
    </section>}

    <section className="panel migration-sources-panel" aria-label="Verified migration transfers">
      <div className="section-heading"><div><span className="eyebrow">Durable evidence</span><h3>Verified staged transfers</h3></div></div>
      {transfers.length ? <div className="migration-source-list">{transfers.map((transfer) => <article key={transfer.id}><div><strong>{transfer.workloadName}</strong><span>{transfer.fileCount} files | {bytes(transfer.sizeBytes)}</span><code>{transfer.destination}</code></div><div><span>{transfer.contentVerified ? "Checksums verified" : "Unverified"}</span><span>{transfer.sourcePreserved ? "Source preserved" : "Source unknown"}</span><span>{transfer.activationPerformed ? "Activated" : "Not activated"}</span></div></article>)}</div> : <p className="empty-state">No migration bundle has completed staged verification.</p>}
    </section>
  </div>;
}
