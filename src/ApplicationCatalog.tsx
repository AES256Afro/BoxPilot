import { useCallback, useEffect, useState } from "react";

interface ApplicationManifest {
  id: string;
  name: string;
  category: string;
  description: string;
  execution: "enabled" | "planning-only";
  risk: string;
  targets: string[];
  image: { version: string; digestPinned: boolean };
  artifact?: { repository: string; releaseTag: string; releaseCommitSha: string; name: string; sizeBytes: number; digest: string; locallyVerifiedByBoxPilot: boolean };
  integrity: string;
  live: {
    installed: boolean; state: string; healthy?: boolean; detail: string; kind?: string | null; version?: string | null; port?: number | null;
    listener?: string; healthIdentityVerified?: boolean; risks?: string[];
    native?: { candidateCount: number }; docker?: { available: boolean; candidateCount: number };
    provenance?: { status: string; checkedAt: string | null };
    boundary?: { mutationPerformed: boolean; environmentRead: boolean; databaseOpened: boolean; secretRead: boolean; arbitraryPathAccepted?: boolean };
    webUrl?: string | null; secretRetrievalCommand?: string; backup?: { state: string; verifiedAt: string | null };
  };
}

interface KeelDiscovery {
  installed: boolean; state: string; healthy: boolean; detail: string; kind: string | null; version: string | null; port: number;
  listener: string; healthIdentityVerified: boolean; risks: string[];
  native: { candidateCount: number }; docker: { available: boolean; candidateCount: number };
  boundary: { mutationPerformed: boolean; environmentRead: boolean; databaseOpened: boolean; secretRead: boolean; arbitraryPathAccepted?: boolean };
}

interface ApplicationPlan {
  id: string;
  subjectId: string;
  revision: string;
  input: { target: string; hostPort: number; networkAssessmentId?: string | null; lanAddress?: string | null };
  output: {
    executable: boolean;
    changes: string[];
    blockers: Array<{ id: string; summary: string; repair: { description?: string } | null }>;
    warnings: string[];
    recovery: { summary: string; preservesData: boolean };
    image: { version: string; digestPinned: boolean };
    artifact?: { repository: string; releaseTag: string; releaseCommitSha: string; name: string; sizeBytes: number; digest: string; githubReportedDigestMatched?: boolean; locallyVerifiedByBoxPilot: boolean } | null;
    lanAddress?: string | null;
    networkAssessmentId?: string | null;
    discovery?: KeelDiscovery | null;
  };
  expiresAt: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

export default function ApplicationCatalog({ csrfToken, onInspectCompose, onOpenRepair, networkAssessmentId, onOpenNetwork }: { csrfToken: string; onInspectCompose: () => void; onOpenRepair: () => void; networkAssessmentId?: string | null; onOpenNetwork?: () => void }) {
  const [applications, setApplications] = useState<ApplicationManifest[]>([]);
  const [selected, setSelected] = useState<ApplicationManifest | null>(null);
  const [target, setTarget] = useState("docker");
  const [hostPort, setHostPort] = useState(3001);
  const [plan, setPlan] = useState<ApplicationPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const body = await readJson<{ applications: ApplicationManifest[] }>(await fetch("/api/v1/applications"));
      setApplications(body.applications);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Application catalog unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const openPlanner = (application: ApplicationManifest) => {
    setSelected(application);
    setTarget(application.targets[0]);
    setHostPort(application.id === "pi-hole" ? 8080 : application.id === "keel" ? 3000 : application.live.port ?? 3001);
    setPlan(null);
    setError(null);
    setMessage(null);
  };

  const generatePlan = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = await readJson<{ plan: ApplicationPlan }>(await fetch(`/api/v1/applications/${selected.id}/plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ target, hostPort, ...(selected.id === "pi-hole" ? { networkAssessmentId } : {}) }),
      }));
      setPlan(body.plan);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to generate application plan");
    } finally {
      setSubmitting(false);
    }
  };

  const stagePlan = async () => {
    if (!plan) return;
    setSubmitting(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/application-plans/${plan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: plan.revision }),
      }));
      setMessage("Deployment job staged. Open Repair Center to review, reauthenticate, apply, and verify it.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to stage deployment");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && applications.length === 0) return <section className="vm-loading">Loading curated application manifests...</section>;

  return (
    <div className="catalog-page">
      {error && !selected && <div className="auth-error" role="alert">{error}</div>}
      <div className="app-grid">
        {applications.map((application) => (
          <article className="app-card" key={application.id}>
            <div className="app-card-top">
              <span className="app-initials">{application.name.slice(0, 2).toUpperCase()}</span>
              <span className={`status-pill status-${application.live.installed ? application.live.healthy ? "good" : "warning" : application.execution === "enabled" ? "neutral" : "warning"}`}>{application.live.installed ? application.live.state : application.execution === "enabled" ? "Available" : "Plan only"}</span>
            </div>
            <span className="app-category">{application.category} | adapter {application.image.version}</span>
            <h3>{application.name}</h3>
            <p>{application.description}</p>
            <span className="app-live-detail">{application.live.detail}</span>
            {application.live.webUrl && <a className="app-live-detail" href={application.live.webUrl} target="_blank" rel="noreferrer">Open LAN interface</a>}
            {application.live.secretRetrievalCommand && application.live.installed && <span className="app-live-detail">Password from Bigbox terminal: <code>{application.live.secretRetrievalCommand}</code></span>}
            {application.live.backup && <span className={`app-live-detail ${application.live.backup.state === "verified" ? "good-text" : application.live.backup.state === "required" ? "warning-text" : ""}`}>Backup: {application.live.backup.state === "verified" ? `restore verified ${new Date(application.live.backup.verifiedAt ?? "").toLocaleDateString()}` : application.live.backup.state}</span>}
            <button type="button" className="secondary-button" onClick={() => openPlanner(application)}>{application.live.installed ? "Review deployment" : "Plan deployment"}</button>
          </article>
        ))}
        <article className="app-card">
          <div className="app-card-top"><span className="app-initials">CS</span><span className="status-pill status-neutral">Dry scan</span></div>
          <span className="app-category">Custom Compose</span>
          <h3>Custom stack</h3>
          <p>Paste Compose YAML and inspect obvious privileges, broad mounts, devices, and socket risks without deploying it.</p>
          <button type="button" className="secondary-button" onClick={onInspectCompose}>Open dry-run inspector</button>
        </article>
      </div>

      {selected && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelected(null)}>
          <section className="modal app-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="app-plan-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header"><div><span className="eyebrow">Curated adapter</span><h2 id="app-plan-title">Plan {selected.name}</h2></div><button className="icon-button" type="button" onClick={() => setSelected(null)} aria-label="Close application planner">X</button></header>
            <div className="manifest-proof"><span>Manifest integrity</span><code>{selected.integrity}</code><span>{selected.artifact ? "Release asset digest pinned; local verification not implemented" : selected.image.digestPinned ? "Image digest pinned" : "Version tag pinned; digest resolution pending"}</span></div>
            {selected.id === "pi-hole" && <div className={`notice ${networkAssessmentId ? "" : "warning-notice"}`}><strong>{networkAssessmentId ? "Network assessment linked" : "Network assessment required"}</strong><span>{networkAssessmentId ?? "Generate a ready Pi-hole on Bigbox assessment in Network Center before staging."}</span>{!networkAssessmentId && onOpenNetwork && <button className="text-button" type="button" onClick={onOpenNetwork}>Open Network Center</button>}</div>}
            {selected.id === "keel" && <>
              <div className="notice warning-notice"><strong>Discovery only</strong><span>BoxPilot can now inspect fixed native-user-service and Docker evidence and bind a plan to the reviewed Keel 1.2.5 release. It still cannot download, extract, install, start, claim, back up, restore, import, adopt, or expose Keel.</span></div>
              <div className="keel-discovery-proof">
                <strong>Current Bigbox evidence</strong>
                <span>State: {selected.live.state} | type: {selected.live.kind ?? "none"} | version: {selected.live.version ?? "not detected"}</span>
                <span>Port 3000 listener: {selected.live.listener ?? "unknown"} | Keel health identity: {selected.live.healthIdentityVerified ? "verified" : "not verified"}</span>
                <span>Native candidates: {selected.live.native?.candidateCount ?? 0} | Docker candidates: {selected.live.docker?.candidateCount ?? 0} | release metadata: {selected.live.provenance?.status ?? "unknown"}</span>
                {(selected.live.risks?.length ?? 0) > 0 && <span className="warning-text">Review: {selected.live.risks?.join(", ")}</span>}
                <span className="good-text">Read-only boundary: no .env, database, or secret read; no user-supplied path; no service or container change</span>
              </div>
            </>}
            <div className="app-plan-fields">
              <label>Deployment target<select value={target} onChange={(event) => { setTarget(event.target.value); setPlan(null); }}>{selected.targets.map((item) => <option key={item} value={item}>{item === "virtual-machine" ? "Dedicated virtual machine" : item === "native-service" ? "Native service on Bigbox" : "Docker on Bigbox"}</option>)}</select></label>
              {target !== "virtual-machine" && <label>{selected.id === "pi-hole" ? "LAN web port" : "Loopback web port"}<input type="number" min="1024" max="65535" value={hostPort} onChange={(event) => { setHostPort(Number(event.target.value)); setPlan(null); }} /></label>}
            </div>
            <button className="primary-button" type="button" onClick={() => void generatePlan()} disabled={submitting}>{submitting ? "Inspecting host..." : "Generate live plan"}</button>

            {plan && <div className="application-plan-result">
              <div className={`notice ${plan.output.executable ? "" : "warning-notice"}`}><strong>{plan.output.executable ? "Ready to stage" : "Planning result"}</strong><span>Revision {plan.revision} | expires {new Date(plan.expiresAt).toLocaleTimeString()}</span></div>
              <div><strong>Proposed changes</strong><ol>{plan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
              {plan.output.artifact && <div className="keel-artifact-proof"><strong>Pinned release artifact</strong><span>{plan.output.artifact.repository} {plan.output.artifact.releaseTag} at <code>{plan.output.artifact.releaseCommitSha.slice(0, 12)}</code></span><span>{plan.output.artifact.name} | {(plan.output.artifact.sizeBytes / (1024 * 1024)).toFixed(1)} MiB</span><code>{plan.output.artifact.digest}</code><span className="warning-text">GitHub metadata matched: {plan.output.artifact.githubReportedDigestMatched ? "yes" : "no"} | verified from local bytes: no</span></div>}
              {plan.output.discovery && <div className="keel-discovery-proof"><strong>Plan-time discovery</strong><span>{plan.output.discovery.detail}</span><span>Listener: {plan.output.discovery.listener} | health identity: {plan.output.discovery.healthIdentityVerified ? "verified" : "not verified"}</span><span>Native candidates: {plan.output.discovery.native.candidateCount} | Docker candidates: {plan.output.discovery.docker.candidateCount}</span>{plan.output.discovery.risks.length > 0 && <span className="warning-text">Review: {plan.output.discovery.risks.join(", ")}</span>}</div>}
              {plan.output.blockers.length > 0 && <div className="plan-blockers"><strong>Blockers</strong>{plan.output.blockers.map((blocker) => <span key={blocker.id}>{blocker.summary}{blocker.repair?.description ? `: ${blocker.repair.description}` : ""}</span>)}</div>}
              {plan.output.warnings.length > 0 && <div className="plan-warnings"><strong>Warnings</strong>{plan.output.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
              <p className="plan-recovery"><strong>Recovery:</strong> {plan.output.recovery.summary}</p>
              {selected.id === "pi-hole" && plan.output.lanAddress && <div className="notice"><strong>Staging address</strong><span>DNS {plan.output.lanAddress}:53 TCP/UDP | web http://{plan.output.lanAddress}:{plan.input.hostPort}/admin/</span><span>Router, client, DHCP, and Tailscale DNS changes remain locked. Backup status will be required after staging.</span></div>}
              {plan.output.executable && !message && <button className="primary-button" type="button" onClick={() => void stagePlan()} disabled={submitting}>Stage for approval</button>}
            </div>}
            {error && <div className="auth-error" role="alert">{error}</div>}
            {message && <div className="notice"><strong>Job ready</strong><span>{message}</span><button className="text-button" type="button" onClick={onOpenRepair}>Open Repair Center</button></div>}
          </section>
        </div>
      )}
    </div>
  );
}
