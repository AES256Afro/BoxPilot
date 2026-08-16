import { useCallback, useEffect, useState } from "react";

interface ApplicationManifest {
  id: string;
  name: string;
  category: string;
  description: string;
  execution: "enabled" | "planning-only" | "staging-enabled";
  risk: string;
  targets: string[];
  image: { version: string; digestPinned: boolean };
  artifact?: { repository: string; releaseTag: string; releaseCommitSha: string; name: string; sizeBytes: number; digest: string; locallyVerifiedByBoxPilot: boolean };
  integrity: string;
  live: {
    installed: boolean; state: string; healthy?: boolean; detail: string; kind?: string | null; version?: string | null; port?: number | null;
    listener?: string; healthIdentityVerified?: boolean; risks?: string[];
    native?: { candidateCount: number }; docker?: { available: boolean; candidateCount: number };
    artifact?: { state: string; readyToAcquire: boolean; artifactPresent: boolean; locallyVerified: boolean; partialPresent: boolean; acquiredAt?: string | null; detail: string };
    archive?: { state: string; safeToExtract: boolean; artifactLocallyVerified: boolean; memberCount: number; expectedMemberCount?: number; counts?: { regular: number; directory: number; symbolicLink: number; hardLink: number; blockDevice: number; characterDevice: number; fifo: number; extension: number; unknown: number }; risks: string[]; detail: string };
    staging?: { state: string; staged: boolean; readyToStage: boolean; version?: string | null; sourceMemberCount?: number; partialCount?: number; stagedAt?: string | null; detail: string };
    installation?: { state: string; installed: boolean; readyToInstall: boolean; releaseVersion?: string | null; serviceActive: boolean; serviceEnabled: boolean; healthy: boolean; listener: string; installedAt?: string | null; databasePresent?: boolean; managedSecretKeyPresent?: boolean; claim: { state: string; terminalRequired: boolean }; detail: string };
    loginProof?: { state: string; verified: boolean; verifiedAt?: string | null; releaseVersion?: string | null; ownerRouteVerified?: boolean; logoutVerified?: boolean; currentStateMatched?: boolean; terminalOnly?: boolean; credentialsStored: boolean; sessionStored: boolean; secondFactorRequired?: boolean; detail: string };
    provenance?: { status: string; checkedAt: string | null };
    boundary?: { mutationPerformed: boolean; environmentRead: boolean; databaseOpened: boolean; secretRead: boolean; arbitraryPathAccepted?: boolean };
    webUrl?: string | null; secretRetrievalCommand?: string; backup?: { state: string; verifiedAt: string | null };
    lifecycle?: { installed: boolean; managed: boolean; state: string; running: boolean; healthy: boolean; lanAddress?: string | null; port: number | null; dnsTcpBound?: boolean; dnsUdpBound?: boolean; revision: string | null; allowedActions: Array<"start" | "stop" | "restart">; detail: string };
    privateAccess?: { connected: boolean; published: boolean; tailnetOnly: boolean; conflict: boolean; dnsName: string | null; port: number | null; url: string | null; revision: string | null; allowedActions: Array<"publish" | "unpublish">; detail: string };
  };
}

interface ApplicationLifecyclePlan {
  id: string;
  revision: string;
  input: { applicationId: "uptime-kuma" | "pi-hole"; action: "start" | "stop" | "restart"; expectedRevision: string };
  output: {
    executable: true;
    applicationId: "uptime-kuma" | "pi-hole";
    applicationName: string;
    label: string;
    current: { state: string; healthy: boolean; port: number; lanAddress: string | null; dnsTcpBound: boolean; dnsUdpBound: boolean };
    desired: { state: string; healthy: boolean; port: number; lanAddress: string | null; dnsTcpBound: boolean; dnsUdpBound: boolean };
    changes: string[];
    recovery: string;
    boundaries: string[];
  };
}

interface ApplicationPrivateAccessPlan {
  id: string;
  revision: string;
  input: { applicationId: "uptime-kuma"; action: "publish" | "unpublish"; expectedRevision: string };
  output: {
    executable: true;
    applicationId: "uptime-kuma";
    applicationName: string;
    action: "publish" | "unpublish";
    current: { published: boolean; tailnetOnly: boolean; url: string | null; port: number };
    desired: { published: boolean; tailnetOnly: boolean; url: string | null; port: number };
    changes: string[];
    recovery: string;
    boundaries: string[];
  };
}

interface KeelArtifactPlan {
  id: string;
  revision: string;
  input: { acquisitionId: string; expectedArtifactState: string };
  output: {
    executable: boolean;
    currentState: string;
    partialPresent: boolean;
    provenanceMatched: boolean;
    artifact: { releaseTag: string; releaseCommitSha: string; name: string; sizeBytes: number; digest: string };
    changes: string[];
    blockers: Array<{ id: string; summary: string; repair: { description?: string } | null }>;
    recovery: { summary: string };
  };
  expiresAt: string;
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
  input: { target: string; hostPort: number; networkAssessmentId?: string | null; lanAddress?: string | null; keelAction?: "stage" | "install"; stageId?: string; installId?: string };
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
    archiveInspection?: ApplicationManifest["live"]["archive"];
    stagingInspection?: ApplicationManifest["live"]["staging"];
    installationInspection?: ApplicationManifest["live"]["installation"];
    keelAction?: "stage" | "install";
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
  const [artifactPlan, setArtifactPlan] = useState<KeelArtifactPlan | null>(null);
  const [lifecyclePlan, setLifecyclePlan] = useState<ApplicationLifecyclePlan | null>(null);
  const [privateAccessPlan, setPrivateAccessPlan] = useState<ApplicationPrivateAccessPlan | null>(null);
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
    setArtifactPlan(null);
    setLifecyclePlan(null);
    setPrivateAccessPlan(null);
    setError(null);
    setMessage(null);
  };

  const generateLifecyclePlan = async (application: ApplicationManifest, action: "start" | "stop" | "restart") => {
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const body = await readJson<{ plan: ApplicationLifecyclePlan }>(await fetch(`/api/v1/applications/${application.id}/action-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ action }),
      }));
      setSelected(application);
      setLifecyclePlan(body.plan);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to generate application lifecycle plan");
    } finally {
      setSubmitting(false);
    }
  };

  const stageLifecyclePlan = async () => {
    if (!lifecyclePlan) return;
    setSubmitting(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/application-action-plans/${lifecyclePlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: lifecyclePlan.revision }),
      }));
      setMessage(`${lifecyclePlan.output.label} job staged. Open Repair Center to review, reauthenticate, and execute the exact managed-container action.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to stage application lifecycle action");
    } finally {
      setSubmitting(false);
    }
  };

  const generatePrivateAccessPlan = async (application: ApplicationManifest, action: "publish" | "unpublish") => {
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const body = await readJson<{ plan: ApplicationPrivateAccessPlan }>(await fetch(`/api/v1/applications/${application.id}/private-access-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ action }),
      }));
      setSelected(application);
      setPrivateAccessPlan(body.plan);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to generate private access plan");
    } finally {
      setSubmitting(false);
    }
  };

  const stagePrivateAccessPlan = async () => {
    if (!privateAccessPlan) return;
    setSubmitting(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/application-private-access-plans/${privateAccessPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: privateAccessPlan.revision }),
      }));
      setMessage("Private access job staged. Open Repair Center to review the exact tailnet-only route, reauthenticate, and apply it.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to stage private access action");
    } finally {
      setSubmitting(false);
    }
  };

  const generateArtifactPlan = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body = await readJson<{ plan: KeelArtifactPlan }>(await fetch("/api/v1/applications/keel/artifact-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({}),
      }));
      setArtifactPlan(body.plan);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to generate Keel artifact plan");
    } finally {
      setSubmitting(false);
    }
  };

  const stageArtifactPlan = async () => {
    if (!artifactPlan) return;
    setSubmitting(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/keel-artifact-plans/${artifactPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: artifactPlan.revision }),
      }));
      setMessage("Keel artifact job staged. Open Repair Center to reauthenticate and run the fixed local verification workflow.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to stage Keel artifact acquisition");
    } finally {
      setSubmitting(false);
    }
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
      setMessage(selected?.id === "keel"
        ? plan.output.keelAction === "install"
          ? "Keel 1.2.6 private install job created. Open Repair Center to review the state-preserving rollback, reauthenticate, activate, and health-check it."
          : "Keel 1.2.6 inert staging job created. Open Repair Center to review the no-install boundary, reauthenticate, extract, and verify it."
        : "Deployment job staged. Open Repair Center to review, reauthenticate, apply, and verify it.");
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
              <span className={`status-pill status-${application.live.installed ? application.live.healthy ? "good" : "warning" : application.execution === "planning-only" ? "warning" : "neutral"}`}>{application.live.installed ? application.live.state : application.execution === "staging-enabled" ? application.live.installation?.readyToInstall ? "Install available" : application.live.staging?.staged ? "Staged" : "Staging available" : application.execution === "enabled" ? "Available" : "Plan only"}</span>
            </div>
            <span className="app-category">{application.category} | adapter {application.image.version}</span>
            <h3>{application.name}</h3>
            <p>{application.description}</p>
            <span className="app-live-detail">{application.live.detail}</span>
            {application.live.webUrl && <a className="app-live-detail" href={application.live.webUrl} target="_blank" rel="noreferrer">Open LAN interface</a>}
            {application.live.privateAccess?.published && application.live.privateAccess.url && <a className="app-live-detail good-text" href={application.live.privateAccess.url} target="_blank" rel="noreferrer">Open private Tailscale interface</a>}
            {application.id === "uptime-kuma" && application.live.installed && application.live.privateAccess && <span className={`app-live-detail ${application.live.privateAccess.published ? "good-text" : application.live.privateAccess.conflict ? "warning-text" : ""}`}>{application.live.privateAccess.detail}</span>}
            {application.live.secretRetrievalCommand && application.live.installed && <span className="app-live-detail">Password from Bigbox terminal: <code>{application.live.secretRetrievalCommand}</code></span>}
            {application.live.backup && <span className={`app-live-detail ${application.live.backup.state === "verified" ? "good-text" : application.live.backup.state === "required" ? "warning-text" : ""}`}>Backup: {application.live.backup.state === "verified" ? `restore verified ${new Date(application.live.backup.verifiedAt ?? "").toLocaleDateString()}` : application.live.backup.state}</span>}
            {application.id === "keel" && application.live.loginProof?.verified && <span className="app-live-detail good-text">Owner login and logout proved {new Date(application.live.loginProof.verifiedAt ?? "").toLocaleDateString()}</span>}
            {["uptime-kuma", "pi-hole"].includes(application.id) && application.live.installed ? (
              <div className="app-lifecycle-actions">
                {application.live.lifecycle?.managed
                  ? application.live.lifecycle.allowedActions.map((action) => <button type="button" className="secondary-button" key={action} onClick={() => void generateLifecyclePlan(application, action)} disabled={submitting}>{action === "start" ? "Plan start" : action === "stop" ? "Plan stop" : "Plan restart"}</button>)
                  : <span className="warning-text">Lifecycle actions locked: {application.live.lifecycle?.detail ?? "exact managed identity unavailable"}</span>}
              </div>
            ) : <button type="button" className="secondary-button" onClick={() => openPlanner(application)}>{application.live.installed ? "Review deployment" : application.execution === "staging-enabled" ? application.live.installation?.readyToInstall ? "Plan private install" : "Plan safe staging" : "Plan deployment"}</button>}
            {application.id === "uptime-kuma" && application.live.installed && application.live.privateAccess && (
              <div className="app-lifecycle-actions">
                {application.live.privateAccess.allowedActions.map((action) => <button type="button" className="secondary-button" key={action} onClick={() => void generatePrivateAccessPlan(application, action)} disabled={submitting}>{action === "publish" ? "Plan private access" : "Plan remove private access"}</button>)}
                {application.live.privateAccess.conflict && <span className="warning-text">Private access locked because this HTTPS port has an unmanaged Tailscale route.</span>}
              </div>
            )}
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

      {selected && !lifecyclePlan && !privateAccessPlan && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelected(null)}>
          <section className="modal app-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="app-plan-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header"><div><span className="eyebrow">Curated adapter</span><h2 id="app-plan-title">Plan {selected.name}</h2></div><button className="icon-button" type="button" onClick={() => setSelected(null)} aria-label="Close application planner">X</button></header>
            <div className="manifest-proof"><span>Manifest integrity</span><code>{selected.integrity}</code><span>{selected.artifact ? selected.live.artifact?.locallyVerified ? "Release asset digest pinned and verified from complete local bytes" : "Release asset digest pinned; approved local verification available" : selected.image.digestPinned ? "Image digest pinned" : "Version tag pinned; digest resolution pending"}</span></div>
            {selected.id === "pi-hole" && <div className={`notice ${networkAssessmentId ? "" : "warning-notice"}`}><strong>{networkAssessmentId ? "Network assessment linked" : "Network assessment required"}</strong><span>{networkAssessmentId ?? "Generate a ready Pi-hole on Bigbox assessment in Network Center before staging."}</span>{!networkAssessmentId && onOpenNetwork && <button className="text-button" type="button" onClick={onOpenNetwork}>Open Network Center</button>}</div>}
            {selected.id === "keel" && <>
              <div className="notice"><strong>Guarded native lifecycle enabled</strong><span>Keel 1.2.6 is pinned to its public release commit, size, and digest. BoxPilot uses separate approvals for staging, install, backup, recovery rehearsal, promotion, and rollback. Claim and owner-login proof stay in a Bigbox terminal; registration changes, Tailscale exposure, import, adoption, and updates remain separate.</span></div>
              <div className="keel-discovery-proof">
                <strong>Current Bigbox evidence</strong>
                <span>State: {selected.live.state} | type: {selected.live.kind ?? "none"} | version: {selected.live.version ?? "not detected"}</span>
                <span>Port 3000 listener: {selected.live.listener ?? "unknown"} | Keel health identity: {selected.live.healthIdentityVerified ? "verified" : "not verified"}</span>
                <span>Native candidates: {selected.live.native?.candidateCount ?? 0} | Docker candidates: {selected.live.docker?.candidateCount ?? 0} | release metadata: {selected.live.provenance?.status ?? "unknown"}</span>
                {(selected.live.risks?.length ?? 0) > 0 && <span className="warning-text">Review: {selected.live.risks?.join(", ")}</span>}
                <span className="good-text">Read-only boundary: no .env, database, or secret read; no user-supplied path; no service or container change</span>
              </div>
              <div className="keel-artifact-proof">
                <strong>Read-only membership inspection</strong>
                <span>State: {selected.live.archive?.state ?? "unknown"} | safe to extract: {selected.live.archive?.safeToExtract ? "yes" : "no"} | members inspected: {selected.live.archive?.memberCount ?? 0}{selected.live.archive?.expectedMemberCount ? ` / ${selected.live.archive.expectedMemberCount}` : ""}</span>
                <span>{selected.live.archive?.detail ?? "Archive inspection evidence is unavailable"}</span>
                {(selected.live.archive?.risks?.length ?? 0) > 0 && <span className="warning-text">Blocked risks: {selected.live.archive?.risks.join(", ")}</span>}
                <span className="good-text">No extraction, member names, link targets, or member contents are returned</span>
              </div>
              <div className="keel-artifact-proof">
                <strong>Inert release staging</strong>
                <span>State: {selected.live.staging?.state ?? "unknown"} | staged: {selected.live.staging?.staged ? "yes" : "no"} | ready: {selected.live.staging?.readyToStage ? "yes" : "no"} | interrupted partials: {selected.live.staging?.partialCount ?? 0}</span>
                <span>{selected.live.staging?.detail ?? "Staging evidence is unavailable"}</span>
                {selected.live.staging?.stagedAt && <span className="good-text">Verified {new Date(selected.live.staging.stagedAt).toLocaleString()}</span>}
              </div>
              <div className="keel-artifact-proof">
                <strong>Private native service</strong>
                <span>State: {selected.live.installation?.state ?? "unknown"} | installed: {selected.live.installation?.installed ? "yes" : "no"} | ready to install: {selected.live.installation?.readyToInstall ? "yes" : "no"}</span>
                <span>Service: {selected.live.installation?.serviceActive ? "active" : "inactive"} | enabled at boot: {selected.live.installation?.serviceEnabled ? "yes" : "no"} | health: {selected.live.installation?.healthy ? "verified" : "not verified"}</span>
                <span>{selected.live.installation?.detail ?? "Installation evidence is unavailable"}</span>
                {selected.live.installation?.installedAt && <span className="good-text">Installed {new Date(selected.live.installation.installedAt).toLocaleString()}</span>}
                {selected.live.installation?.installed && <><span className="good-text">Private access: from your computer run <code>ssh -N -L 3000:127.0.0.1:3000 bigbox@bigbox</code>, then open <code>http://127.0.0.1:3000</code>.</span><span>After registering, copy Keel's one-use claim token, SSH to Bigbox as your normal administrator, and run <code>sudo -k /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-keel-claim.mjs 'PASTE_TOKEN'</code>. The fixed handoff rechecks the install, asks for fresh sudo, drops to the keel account, and never sends the token to BoxPilot.</span></>}
              </div>
              <div className="keel-artifact-proof">
                <strong>Terminal-only instance-owner login proof</strong>
                <span>State: {selected.live.loginProof?.state ?? "unavailable"} | current database: {selected.live.loginProof?.currentStateMatched ? "matched" : "not matched"} | owner route: {selected.live.loginProof?.ownerRouteVerified ? "verified" : "not verified"} | forced logout: {selected.live.loginProof?.logoutVerified ? "verified" : "not verified"}</span>
                <span>{selected.live.loginProof?.detail ?? "Owner-login proof evidence is unavailable"}</span>
                {selected.live.loginProof?.verifiedAt && <span className="good-text">Verified {new Date(selected.live.loginProof.verifiedAt).toLocaleString()} with no BoxPilot credential or session storage</span>}
                {selected.live.installation?.installed && !selected.live.loginProof?.verified && <span>After claim, run <code>sudo -k /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-keel-owner-login-proof.mjs</code> from your normal Bigbox administrator account. Email and hidden password stay inside a short-lived unprivileged terminal worker. Security-key accounts are reported as incomplete and must be verified in the browser.</span>}
              </div>
              <div className="keel-artifact-proof">
                <strong>Root-only artifact gate</strong>
                <span>State: {selected.live.artifact?.state ?? "unknown"} | local bytes verified: {selected.live.artifact?.locallyVerified ? "yes" : "no"} | interrupted partial: {selected.live.artifact?.partialPresent ? "yes" : "no"}</span>
                <span>{selected.live.artifact?.detail ?? "Artifact evidence is unavailable"}</span>
                {selected.live.artifact?.acquiredAt && <span className="good-text">Verified {new Date(selected.live.artifact.acquiredAt).toLocaleString()}</span>}
                {!selected.live.artifact?.locallyVerified && <button className="secondary-button" type="button" onClick={() => void generateArtifactPlan()} disabled={submitting}>{submitting ? "Revalidating release..." : "Plan fixed artifact acquisition"}</button>}
              </div>
              {artifactPlan && <div className="application-plan-result">
                <div className={`notice ${artifactPlan.output.executable ? "" : "warning-notice"}`}><strong>{artifactPlan.output.executable ? "Artifact ready to stage" : "Artifact acquisition blocked"}</strong><span>Revision {artifactPlan.revision} | expires {new Date(artifactPlan.expiresAt).toLocaleTimeString()}</span></div>
                <div className="keel-artifact-proof"><strong>{artifactPlan.output.artifact.name}</strong><span>{(artifactPlan.output.artifact.sizeBytes / (1024 * 1024)).toFixed(1)} MiB | {artifactPlan.output.artifact.releaseTag} at <code>{artifactPlan.output.artifact.releaseCommitSha.slice(0, 12)}</code></span><code>{artifactPlan.output.artifact.digest}</code><span>Current state: {artifactPlan.output.currentState} | GitHub metadata matched: {artifactPlan.output.provenanceMatched ? "yes" : "no"}</span></div>
                <div><strong>Bounded changes</strong><ol>{artifactPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
                {artifactPlan.output.blockers.length > 0 && <div className="plan-blockers"><strong>Blockers</strong>{artifactPlan.output.blockers.map((blocker) => <span key={blocker.id}>{blocker.summary}{blocker.repair?.description ? `: ${blocker.repair.description}` : ""}</span>)}</div>}
                <p className="plan-recovery"><strong>Recovery:</strong> {artifactPlan.output.recovery.summary}</p>
                {artifactPlan.output.executable && !message && <button className="primary-button" type="button" onClick={() => void stageArtifactPlan()} disabled={submitting}>Stage artifact verification for approval</button>}
              </div>}
            </>}
            <div className="app-plan-fields">
              <label>Deployment target<select value={target} onChange={(event) => { setTarget(event.target.value); setPlan(null); }}>{selected.targets.map((item) => <option key={item} value={item}>{item === "virtual-machine" ? "Dedicated virtual machine" : item === "native-service" ? "Native service on Bigbox" : "Docker on Bigbox"}</option>)}</select></label>
              {target !== "virtual-machine" && <label>{selected.id === "pi-hole" ? "LAN web port" : "Loopback web port"}<input type="number" min="1024" max="65535" value={hostPort} disabled={selected.id === "keel"} onChange={(event) => { setHostPort(Number(event.target.value)); setPlan(null); }} /></label>}
            </div>
            <button className="primary-button" type="button" onClick={() => void generatePlan()} disabled={submitting}>{submitting ? "Inspecting host..." : "Generate live plan"}</button>

            {plan && <div className="application-plan-result">
              <div className={`notice ${plan.output.executable ? "" : "warning-notice"}`}><strong>{plan.output.executable ? plan.output.keelAction === "install" ? "Ready for install approval" : "Ready to stage" : "Planning result"}</strong><span>Revision {plan.revision} | expires {new Date(plan.expiresAt).toLocaleTimeString()}</span></div>
              <div><strong>Proposed changes</strong><ol>{plan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
              {plan.output.artifact && <div className="keel-artifact-proof"><strong>Pinned release artifact</strong><span>{plan.output.artifact.repository} {plan.output.artifact.releaseTag} at <code>{plan.output.artifact.releaseCommitSha.slice(0, 12)}</code></span><span>{plan.output.artifact.name} | {(plan.output.artifact.sizeBytes / (1024 * 1024)).toFixed(1)} MiB</span><code>{plan.output.artifact.digest}</code><span className={plan.output.artifact.locallyVerifiedByBoxPilot ? "good-text" : "warning-text"}>GitHub metadata matched: {plan.output.artifact.githubReportedDigestMatched ? "yes" : "no"} | verified from local bytes: {plan.output.artifact.locallyVerifiedByBoxPilot ? "yes" : "no"}</span></div>}
              {plan.output.discovery && <div className="keel-discovery-proof"><strong>Plan-time discovery</strong><span>{plan.output.discovery.detail}</span><span>Listener: {plan.output.discovery.listener} | health identity: {plan.output.discovery.healthIdentityVerified ? "verified" : "not verified"}</span><span>Native candidates: {plan.output.discovery.native.candidateCount} | Docker candidates: {plan.output.discovery.docker.candidateCount}</span>{plan.output.discovery.risks.length > 0 && <span className="warning-text">Review: {plan.output.discovery.risks.join(", ")}</span>}</div>}
              {plan.output.archiveInspection && <div className="keel-artifact-proof"><strong>Plan-time archive gate</strong><span>State: {plan.output.archiveInspection.state} | safe to extract: {plan.output.archiveInspection.safeToExtract ? "yes" : "no"} | members: {plan.output.archiveInspection.memberCount}</span><span>{plan.output.archiveInspection.detail}</span>{plan.output.archiveInspection.risks.length > 0 && <span className="warning-text">Blocked risks: {plan.output.archiveInspection.risks.join(", ")}</span>}</div>}
              {plan.output.stagingInspection && <div className="keel-artifact-proof"><strong>Plan-time staging boundary</strong><span>State: {plan.output.stagingInspection.state} | ready to stage: {plan.output.stagingInspection.readyToStage ? "yes" : "no"} | existing partials: {plan.output.stagingInspection.partialCount ?? 0}</span><span>{plan.output.stagingInspection.detail}</span><span className="good-text">{plan.output.keelAction === "install" ? "The exact staged tree is the only release that can be activated" : "No service, state, account, registration, listener, or application process is created"}</span></div>}
              {plan.output.installationInspection && <div className="keel-artifact-proof"><strong>Plan-time install boundary</strong><span>State: {plan.output.installationInspection.state} | ready: {plan.output.installationInspection.readyToInstall ? "yes" : "no"} | fixed listener: 127.0.0.1:3000</span><span>{plan.output.installationInspection.detail}</span><span className="good-text">Claim, registration, Tailscale Serve, firewall, DNS, DHCP, and router state remain unchanged</span></div>}
              {plan.output.blockers.length > 0 && <div className="plan-blockers"><strong>Blockers</strong>{plan.output.blockers.map((blocker) => <span key={blocker.id}>{blocker.summary}{blocker.repair?.description ? `: ${blocker.repair.description}` : ""}</span>)}</div>}
              {plan.output.warnings.length > 0 && <div className="plan-warnings"><strong>Warnings</strong>{plan.output.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
              <p className="plan-recovery"><strong>Recovery:</strong> {plan.output.recovery.summary}</p>
              {selected.id === "pi-hole" && plan.output.lanAddress && <div className="notice"><strong>Staging address</strong><span>DNS {plan.output.lanAddress}:53 TCP/UDP | web http://{plan.output.lanAddress}:{plan.input.hostPort}/admin/</span><span>Router, client, DHCP, and Tailscale DNS changes remain locked. Backup status will be required after staging.</span></div>}
              {plan.output.executable && !message && <button className="primary-button" type="button" onClick={() => void stagePlan()} disabled={submitting}>{selected.id === "keel" ? plan.output.keelAction === "install" ? "Stage private install for approval" : "Stage inert release for approval" : "Stage for approval"}</button>}
            </div>}
            {error && <div className="auth-error" role="alert">{error}</div>}
            {message && <div className="notice"><strong>Job ready</strong><span>{message}</span><button className="text-button" type="button" onClick={onOpenRepair}>Open Repair Center</button></div>}
          </section>
        </div>
      )}
      {selected && lifecyclePlan && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal app-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="application-lifecycle-title">
            <header className="modal-header"><div><span className="eyebrow">Immutable managed-container action</span><h2 id="application-lifecycle-title">{lifecyclePlan.output.label} {lifecyclePlan.output.applicationName}</h2></div><button className="icon-button" type="button" onClick={() => { setLifecyclePlan(null); setSelected(null); setMessage(null); setError(null); }} aria-label="Close application lifecycle plan">X</button></header>
            <dl className="vm-plan-summary">
              <div><dt>Current state</dt><dd>{lifecyclePlan.output.current.state}</dd></div>
              <div><dt>Desired state</dt><dd>{lifecyclePlan.output.desired.state}</dd></div>
              <div><dt>{lifecyclePlan.output.applicationId === "pi-hole" ? "Private LAN" : "Loopback port"}</dt><dd>{lifecyclePlan.output.applicationId === "pi-hole" ? lifecyclePlan.output.current.lanAddress : lifecyclePlan.output.current.port}</dd></div>
              <div><dt>{lifecyclePlan.output.applicationId === "pi-hole" ? "Web port" : "Persistent data"}</dt><dd>{lifecyclePlan.output.applicationId === "pi-hole" ? lifecyclePlan.output.current.port : "Preserved"}</dd></div>
            </dl>
            <div className="application-plan-result"><div><strong>Exact changes</strong><ol>{lifecyclePlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div></div>
            <div className="plan-warnings"><strong>Locked boundaries</strong>{lifecyclePlan.output.boundaries.map((boundary) => <span key={boundary}>{boundary}</span>)}</div>
            <p className="plan-recovery"><strong>Recovery:</strong> {lifecyclePlan.output.recovery}</p>
            <p className="vm-action-revision">Plan revision <code>{lifecyclePlan.revision}</code>. Exact container identity and state are checked again before staging and after password approval.</p>
            {error && <div className="auth-error" role="alert">{error}</div>}
            {message
              ? <div className="notice"><strong>Job ready</strong><span>{message}</span><button className="text-button" type="button" onClick={onOpenRepair}>Open Repair Center</button></div>
              : <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => { setLifecyclePlan(null); setSelected(null); }}>Cancel</button><button type="button" className="primary-button" onClick={() => void stageLifecyclePlan()} disabled={submitting}>{submitting ? "Revalidating..." : "Stage for password approval"}</button></div>}
          </section>
        </div>
      )}
      {selected && privateAccessPlan && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal app-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="application-private-access-title">
            <header className="modal-header"><div><span className="eyebrow">Private Tailscale route</span><h2 id="application-private-access-title">{privateAccessPlan.input.action === "publish" ? "Publish" : "Remove"} {privateAccessPlan.output.applicationName} access</h2></div><button className="icon-button" type="button" onClick={() => { setPrivateAccessPlan(null); setSelected(null); setMessage(null); setError(null); }} aria-label="Close private access plan">X</button></header>
            <dl className="vm-plan-summary">
              <div><dt>Current route</dt><dd>{privateAccessPlan.output.current.published ? "Tailnet only" : "Not published"}</dd></div>
              <div><dt>Desired route</dt><dd>{privateAccessPlan.output.desired.published ? "Tailnet only" : "Not published"}</dd></div>
              <div><dt>HTTPS port</dt><dd>{privateAccessPlan.output.desired.port}</dd></div>
              <div><dt>Private URL</dt><dd>{privateAccessPlan.output.desired.url ?? "Removed"}</dd></div>
            </dl>
            <div className="application-plan-result"><div><strong>Exact changes</strong><ol>{privateAccessPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div></div>
            <div className="plan-warnings"><strong>Locked boundaries</strong>{privateAccessPlan.output.boundaries.map((boundary) => <span key={boundary}>{boundary}</span>)}</div>
            <p className="plan-recovery"><strong>Recovery:</strong> {privateAccessPlan.output.recovery}</p>
            <p className="vm-action-revision">Plan revision <code>{privateAccessPlan.revision}</code>. The managed application and complete non-application Serve configuration are checked again before staging and after approval.</p>
            {error && <div className="auth-error" role="alert">{error}</div>}
            {message
              ? <div className="notice"><strong>Job ready</strong><span>{message}</span><button className="text-button" type="button" onClick={onOpenRepair}>Open Repair Center</button></div>
              : <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => { setPrivateAccessPlan(null); setSelected(null); }}>Cancel</button><button type="button" className="primary-button" onClick={() => void stagePrivateAccessPlan()} disabled={submitting}>{submitting ? "Revalidating..." : "Stage for password approval"}</button></div>}
          </section>
        </div>
      )}
    </div>
  );
}
