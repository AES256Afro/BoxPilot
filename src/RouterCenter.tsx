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
type Flint2Assertions = { adguardHomeEnabled: boolean; emergencyResolverTested: boolean; handleClientRequestsReviewed: boolean; routerModeConfirmed: boolean; singleDhcpAuthorityConfirmed: boolean; vpnPolicyImpactReviewed: boolean };
type Flint2AcceptanceStatus = {
  observedGateway: { gateway: string; interface: string; protocol: string } | null;
  checkpoint: RouterCheckpoint | null;
  acceptances: Array<{ id: string; resolverAddress: string; checkpointId: string; checks: Array<{ protocol: string; name: string; latencyMs?: number }>; passed: boolean; createdAt: string }>;
  secondDeviceEvidence: Array<{ id: string; agentId: string; passed: boolean; receivedAt: string; result: { resolverAddress: string; routerAcceptanceId: string; checks: Array<{ passed: boolean }>; secondDeviceTested: boolean; modelIdentityVerified: boolean; gatewayMatchedByAgentContract: boolean } }>;
  sourceReviewedAt: string;
  officialSources: string[];
  boundary: { credentialsAccepted: boolean; routerSessionOpened: boolean; arbitraryTargetAccepted: boolean; routerMutationSupported: boolean; dnsCutoverSupported: boolean };
};
type Flint2Plan = {
  id: string; revision: string; expiresAt: string;
  output: { executable: boolean; routerModel: string; resolverAddress: string | null; checkpointId: string | null; checkpointFirmware: string | null; blockers: Array<{ id: string; summary: string }>; tests: Array<{ id: string; protocol: string; name: string; port: number }>; vendorWarnings: string[]; changes: string[]; recovery: string };
};

const initialFlint2Assertions: Flint2Assertions = { adguardHomeEnabled: false, emergencyResolverTested: false, handleClientRequestsReviewed: false, routerModeConfirmed: false, singleDhcpAuthorityConfirmed: false, vpnPolicyImpactReviewed: false };

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
  const [flint2Status, setFlint2Status] = useState<Flint2AcceptanceStatus | null>(null);
  const [flint2Assertions, setFlint2Assertions] = useState<Flint2Assertions>(initialFlint2Assertions);
  const [flint2Plan, setFlint2Plan] = useState<Flint2Plan | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextReadiness, nextFlint2Status] = await Promise.all([
        readJson<RouterStatus>(await fetch("/api/v1/network/router-checkpoints")),
        readJson<RouterReadiness>(await fetch("/api/v1/network/router-readiness")),
        readJson<Flint2AcceptanceStatus>(await fetch("/api/v1/network/flint2-adguard-acceptance")),
      ]);
      setStatus(nextStatus);
      setReadiness(nextReadiness);
      setFlint2Status(nextFlint2Status);
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

  const createFlint2Plan = async () => {
    setSubmitting(true); setError(null); setMessage(null);
    try {
      const result = await readJson<{ plan: Flint2Plan }>(await fetch("/api/v1/network/flint2-adguard-acceptance/plans", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify(flint2Assertions) }));
      setFlint2Plan(result.plan);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to create Flint 2 acceptance plan"); }
    finally { setSubmitting(false); }
  };

  const stageFlint2Plan = async () => {
    if (!flint2Plan) return;
    setSubmitting(true); setError(null); setMessage(null);
    try {
      await readJson(await fetch(`/api/v1/network/flint2-adguard-acceptance/plans/${flint2Plan.id}/stage`, { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ revision: flint2Plan.revision }) }));
      setFlint2Plan(null); setFlint2Assertions(initialFlint2Assertions); setMessage("Flint 2 DNS acceptance staged. Open Repair Center to review the job and re-enter the owner password."); await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to stage Flint 2 acceptance"); }
    finally { setSubmitting(false); }
  };

  if ((!status || !readiness || !flint2Status) && loading) return <section className="vm-loading">Loading router readiness evidence...</section>;
  if (!status || !readiness || !flint2Status) return <p className="form-error" role="alert">{error}</p>;

  return (
    <div className="router-center">
      <section className="readiness">
        <div><strong>{status.checkpoints.length} router checkpoint{status.checkpoints.length === 1 ? "" : "s"}</strong><span>Only SHA-256, size, model, firmware, attribution, and time are stored</span></div>
        <div className="readiness-actions"><span className="status-pill status-good">No file upload</span><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button></div>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <div className="notice"><strong>Router workflow updated</strong><span>{message}</span></div>}

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

      <section className="panel router-checkpoint-form flint2-acceptance">
        <header className="panel-header"><div><strong>Flint 2 AdGuard Home direct acceptance</strong><span>Guided declarations, immutable plan, owner-password approval, fixed gateway DNS tests</span></div><span className="status-pill status-warning">No router writes</span></header>
        <div className="notice"><strong>Observed target only</strong><span>{flint2Status.observedGateway ? `${flint2Status.observedGateway.gateway} via ${flint2Status.observedGateway.interface}` : "One live gateway is not available"}. BoxPilot does not accept an address or claim the physical model. {flint2Status.checkpoint ? `Checkpoint ${flint2Status.checkpoint.id} covers firmware ${flint2Status.checkpoint.firmwareVersion}.` : "Record a retained Flint 2 checkpoint first."}</span></div>
        <div className="flint2-declarations">
          {([
            ["routerModeConfirmed", "Flint 2 shows Router mode; it is the selected edge router."],
            ["singleDhcpAuthorityConfirmed", "Flint 2 is the only production NAT and DHCP authority."],
            ["adguardHomeEnabled", "APPLICATIONS > AdGuard Home is enabled and applied locally."],
            ["handleClientRequestsReviewed", "I reviewed Handle Client Requests and its client-policy impact."],
            ["vpnPolicyImpactReviewed", "I reviewed VPN and upstream-DNS interaction before testing."],
            ["emergencyResolverTested", "The independent emergency resolver works from a LAN device."],
          ] as Array<[keyof Flint2Assertions, string]>).map(([key, label]) => <label className="router-retention" key={key}><input type="checkbox" checked={flint2Assertions[key]} onChange={(event) => setFlint2Assertions((current) => ({ ...current, [key]: event.target.checked }))} /> {label}</label>)}
        </div>
        <div className="network-plan-actions"><button className="primary-button" type="button" onClick={() => void createFlint2Plan()} disabled={submitting || Object.values(flint2Assertions).some((value) => !value)}>{submitting ? "Inspecting..." : "Review fixed DNS acceptance"}</button><span>Four fixed queries only. No login, credential, router session, address field, arbitrary hostname, DHCP change, DNS cutover, or client setting.</span></div>
        {flint2Plan && <div className="flint2-plan">
          <div><span className="eyebrow">Immutable acceptance plan</span><strong>{flint2Plan.output.routerModel} at {flint2Plan.output.resolverAddress ?? "unavailable"}</strong><small>Revision {flint2Plan.revision} | expires {new Date(flint2Plan.expiresAt).toLocaleString()}</small></div>
          {flint2Plan.output.blockers.length > 0 && <ul className="dns-acceptance-limitations">{flint2Plan.output.blockers.map((blocker) => <li key={`${blocker.id}-${blocker.summary}`}>{blocker.summary}</li>)}</ul>}
          <div className="network-lock">{flint2Plan.output.tests.map((test) => <span className="status-pill status-good" key={test.id}>{test.protocol.toUpperCase()} {test.name}:53</span>)}</div>
          <ul className="dns-acceptance-limitations">{flint2Plan.output.vendorWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <div className="recovery-boundary"><strong>No-change recovery</strong><span>{flint2Plan.output.recovery}</span></div>
          <div className="network-plan-actions"><button className="secondary-button" type="button" onClick={() => setFlint2Plan(null)} disabled={submitting}>Discard plan</button><button className="primary-button" type="button" onClick={() => void stageFlint2Plan()} disabled={submitting || !flint2Plan.output.executable}>{submitting ? "Staging..." : "Stage for password approval"}</button></div>
        </div>}
        <div className="flint2-evidence"><strong>{flint2Status.acceptances.length} passing direct gateway acceptance record{flint2Status.acceptances.length === 1 ? "" : "s"}</strong>{flint2Status.acceptances.slice(0, 5).map((item) => <span key={item.id}>{new Date(item.createdAt).toLocaleString()} | {item.resolverAddress} | {item.checks.length} fixed checks | model not remotely attested</span>)}</div>
        <div className="flint2-evidence"><strong>{flint2Status.secondDeviceEvidence.length} passing signed second-device record{flint2Status.secondDeviceEvidence.length === 1 ? "" : "s"}</strong>{flint2Status.secondDeviceEvidence.slice(0, 5).map((item) => <span key={item.id}>{new Date(item.receivedAt).toLocaleString()} | {item.result.resolverAddress} | linked acceptance {item.result.routerAcceptanceId} | model not remotely attested</span>)}</div>
        <div className="router-sources"><span>GL.iNet sources reviewed {flint2Status.sourceReviewedAt}</span>{flint2Status.officialSources.map((source, index) => <a href={source} target="_blank" rel="noreferrer" key={source}>{index === 0 ? "AdGuard Home guide" : "Network mode guide"}</a>)}</div>
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
