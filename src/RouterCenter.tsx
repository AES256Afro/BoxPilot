import { useCallback, useEffect, useState } from "react";

type RouterModel = { id: string; name: string; roles: string[]; officialSource: string };
type RouterCheckpoint = {
  id: string;
  modelId: string;
  firmwareVersion: string;
  checksumSha256: string;
  sizeBytes: number;
  hashOrigin: string;
  configurationUploaded: boolean;
  fileRetainedByOperator: boolean;
  createdAt: string;
};
type RouterStatus = {
  catalog: RouterModel[];
  checkpoints: RouterCheckpoint[];
  latestByModel: Record<string, RouterCheckpoint | null>;
  boundary: { hashing: string; configurationUploaded: boolean; credentialsAccepted: boolean; routerSessionOpened: boolean; routerMutationSupported: boolean; dnsCutoverSupported: boolean; maximumFileBytes: number };
  limitations: string[];
};
type RouterReadinessCheck = { id: string; state: "verified" | "action-required" | "operator-check" | "unavailable"; title: string; evidence: string; action: string };
type RouterGuide = {
  modelId: string;
  intendedRole: string;
  mode: string;
  officialSources: { label: string; url: string }[];
  steps: string[];
  verify: string[];
  rollback: string;
  checkpoint: RouterCheckpoint | null;
};
type RouterReadiness = {
  generatedAt: string;
  recommendedTopology: { id: string; summary: string; rationale: string };
  alternateTopology: { id: string; summary: string; gate: string };
  observedGateway: { address: string; interface: string; protocol: string; modelVerified: false; identityClaim: string } | null;
  checks: RouterReadinessCheck[];
  counts: Record<RouterReadinessCheck["state"], number>;
  guides: RouterGuide[];
  sourceReviewedAt: string;
  boundary: { credentialsAccepted: boolean; routerSessionsOpened: boolean; neighborDiscoveryPerformed: boolean; arbitraryTargetsProbed: boolean; configurationUploaded: boolean; routerMutationSupported: boolean; dhcpMutationSupported: boolean; dnsCutoverSupported: boolean; tailscaleMutationSupported: boolean };
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

export async function hashRouterBackup(file: Pick<File, "arrayBuffer" | "size">, digest = (data: ArrayBuffer) => crypto.subtle.digest("SHA-256", data)) {
  if (!Number.isSafeInteger(file.size) || file.size < 64 || file.size > 64 * 1024 * 1024) throw new Error("Router backup must be between 64 bytes and 64 MiB");
  const result = new Uint8Array(await digest(await file.arrayBuffer()));
  if (result.length !== 32) throw new Error("Browser SHA-256 returned an unexpected digest length");
  return [...result].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBytes(value: number) {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export default function RouterCenter({ csrfToken }: { csrfToken: string }) {
  const [status, setStatus] = useState<RouterStatus | null>(null);
  const [readiness, setReadiness] = useState<RouterReadiness | null>(null);
  const [modelId, setModelId] = useState("glinet-flint-2");
  const [firmwareVersion, setFirmwareVersion] = useState("");
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [retained, setRetained] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextReadiness] = await Promise.all([
        readJson<RouterStatus>(await fetch("/api/v1/network/router-checkpoints")),
        readJson<RouterReadiness>(await fetch("/api/v1/network/router-readiness")),
      ]);
      setStatus(nextStatus);
      setReadiness(nextReadiness);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Router checkpoints are unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const recordCheckpoint = async () => {
    if (!backupFile) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const checksumSha256 = await hashRouterBackup(backupFile);
      const body = await readJson<{ checkpoint: RouterCheckpoint }>(await fetch("/api/v1/network/router-checkpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ modelId, firmwareVersion, checksumSha256, sizeBytes: backupFile.size, fileRetainedByOperator: retained }),
      }));
      setMessage(`Checkpoint ${body.checkpoint.id} recorded. The configuration file never left this browser.`);
      setBackupFile(null);
      setRetained(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to record router checkpoint");
    } finally {
      setSubmitting(false);
    }
  };

  if ((!status || !readiness) && loading) return <section className="vm-loading">Loading router readiness evidence...</section>;
  if (!status || !readiness) return <p className="form-error" role="alert">{error}</p>;

  return (
    <div className="router-center">
      <section className="readiness">
        <div><strong>{status.checkpoints.length} router checkpoint{status.checkpoints.length === 1 ? "" : "s"}</strong><span>Only SHA-256, size, model, firmware, attribution, and time are stored</span></div>
        <div className="readiness-actions"><span className="status-pill status-good">No file upload</span><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button></div>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <div className="notice"><strong>Checkpoint recorded</strong><span>{message}</span></div>}

      <section className="panel router-topology">
        <header className="panel-header"><strong>Recommended production topology</strong><span>Live gateway address, operator-verified device identity</span></header>
        <div className="router-topology-summary">
          <div><span className="eyebrow">Recommended</span><strong>Flint 2 edge | TP-Link access point | ER707-M2 standby</strong><p>{readiness.recommendedTopology.summary}</p><small>{readiness.recommendedTopology.rationale}</small></div>
          <div className="router-observed-gateway"><span>Bigbox observes</span><strong>{readiness.observedGateway ? `${readiness.observedGateway.address} via ${readiness.observedGateway.interface}` : "No unambiguous gateway"}</strong><small>Address observed. Router model not verified.</small></div>
        </div>
        <details><summary>Alternate: ER707-M2 as the only edge router</summary><p>{readiness.alternateTopology.summary}</p><small>{readiness.alternateTopology.gate}</small></details>
      </section>

      <section className="panel router-readiness-panel">
        <header className="panel-header"><strong>Integration readiness</strong><span>{readiness.counts.verified} verified | {readiness.counts["action-required"]} action required | {readiness.counts["operator-check"]} operator checks</span></header>
        <div className="router-readiness-grid">{readiness.checks.map((check) => <article className={`router-readiness-check router-check-${check.state}`} key={check.id}>
          <div><strong>{check.title}</strong><span className={`status-pill ${check.state === "verified" ? "status-good" : check.state === "action-required" ? "status-danger" : "status-warning"}`}>{check.state.replace("-", " ")}</span></div>
          <p>{check.evidence}</p><small>{check.action}</small>
        </article>)}</div>
      </section>

      <section className="panel router-boundary">
        <header className="panel-header"><strong>Router integration boundary</strong><span>Recovery evidence before API access</span></header>
        <div className="network-lock"><span className="status-pill status-good">Browser-local SHA-256</span><span className="status-pill status-good">Credentials rejected</span><span className="status-pill status-warning">Router writes locked</span><span className="status-pill status-warning">DNS cutover locked</span></div>
        <p>BoxPilot hashes a backup selected from this browser and sends only metadata. It never uploads the configuration, logs in to the router, opens a router session, or claims the backup can be restored.</p>
      </section>

      <div className="router-model-grid">{status.catalog.map((model) => {
        const latest = status.latestByModel[model.id];
        return <article className="panel router-model" key={model.id}><span className="eyebrow">{model.roles.join(" | ")}</span><strong>{model.name}</strong><span>{latest ? `Checkpoint ${new Date(latest.createdAt).toLocaleString()} on firmware ${latest.firmwareVersion}` : "No checkpoint recorded"}</span><a href={model.officialSource} target="_blank" rel="noreferrer">Official documentation</a></article>;
      })}</div>

      <section className="router-guide-list" aria-label="Router role guides">{readiness.guides.map((guide) => {
        const model = status.catalog.find((item) => item.id === guide.modelId);
        return <details className="panel router-guide" key={guide.modelId} open={guide.modelId === "glinet-flint-2"}>
          <summary><span><span className="eyebrow">{guide.mode}</span><strong>{model?.name ?? guide.modelId}</strong><small>{guide.intendedRole}</small></span><span className={`status-pill ${guide.checkpoint ? "status-good" : "status-warning"}`}>{guide.checkpoint ? "Checkpoint recorded" : "Checkpoint needed"}</span></summary>
          <div className="router-guide-columns"><div><strong>Operator steps</strong><ol>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol></div><div><strong>Verify before proceeding</strong><ol>{guide.verify.map((step) => <li key={step}>{step}</li>)}</ol></div></div>
          <div className="router-rollback"><strong>Rollback</strong><span>{guide.rollback}</span></div>
          <div className="router-sources"><span>Vendor sources reviewed {readiness.sourceReviewedAt}</span>{guide.officialSources.map((source) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>{source.label}</a>)}</div>
        </details>;
      })}</section>

      <section className="panel router-checkpoint-form">
        <header className="panel-header"><strong>Record a configuration checkpoint</strong><span>Maximum 64 MiB, file stays on this device</span></header>
        <div className="network-form-grid">
          <label>Router model<select value={modelId} onChange={(event) => setModelId(event.target.value)}>{status.catalog.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
          <label>Firmware version<input value={firmwareVersion} onChange={(event) => setFirmwareVersion(event.target.value)} maxLength={64} placeholder="Example: 4.8.2" /></label>
          <label className="router-file">Router backup file<input type="file" onChange={(event) => setBackupFile(event.target.files?.[0] ?? null)} /><span>{backupFile ? `${backupFile.name} | ${formatBytes(backupFile.size)} | local only` : "Choose the backup exported from the router"}</span></label>
        </div>
        <label className="router-retention"><input type="checkbox" checked={retained} onChange={(event) => setRetained(event.target.checked)} /> I retained the original configuration backup outside BoxPilot and understand this checksum is not a restore test.</label>
        <div className="network-plan-actions"><button className="primary-button" type="button" disabled={!backupFile || !retained || !/^[A-Za-z0-9][A-Za-z0-9._()+ -]{0,63}$/.test(firmwareVersion) || submitting} onClick={() => void recordCheckpoint()}>{submitting ? "Hashing locally..." : "Hash locally and record metadata"}</button><span>No filename, file content, password, address, session cookie, or router setting is sent.</span></div>
      </section>

      <section className="panel table-panel">
        <header className="panel-header"><strong>Checkpoint ledger</strong><span>Attributable metadata, newest first</span></header>
        <div className="table-scroll"><table><thead><tr><th>Created</th><th>Model</th><th>Firmware</th><th>Size</th><th>SHA-256</th><th>File uploaded</th></tr></thead><tbody>{status.checkpoints.length ? status.checkpoints.map((checkpoint) => <tr key={checkpoint.id}><td>{new Date(checkpoint.createdAt).toLocaleString()}</td><td>{status.catalog.find((model) => model.id === checkpoint.modelId)?.name ?? checkpoint.modelId}</td><td>{checkpoint.firmwareVersion}</td><td>{formatBytes(checkpoint.sizeBytes)}</td><td><code>{checkpoint.checksumSha256.slice(0, 16)}...</code></td><td className="good-text">No</td></tr>) : <tr><td colSpan={6}>No router backup metadata has been recorded.</td></tr>}</tbody></table></div>
        <ul className="dns-acceptance-limitations">{status.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
      </section>
    </div>
  );
}
