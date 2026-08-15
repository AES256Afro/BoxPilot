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
  integrity: string;
  live: { installed: boolean; state: string; detail: string; port?: number | null; backup?: { state: string; verifiedAt: string | null } };
}

interface ApplicationPlan {
  id: string;
  subjectId: string;
  revision: string;
  input: { target: string; hostPort: number };
  output: {
    executable: boolean;
    changes: string[];
    blockers: Array<{ id: string; summary: string; repair: { description?: string } | null }>;
    warnings: string[];
    recovery: { summary: string; preservesData: boolean };
    image: { version: string; digestPinned: boolean };
  };
  expiresAt: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

export default function ApplicationCatalog({ csrfToken, onInspectCompose, onOpenRepair }: { csrfToken: string; onInspectCompose: () => void; onOpenRepair: () => void }) {
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
    setHostPort(application.id === "pi-hole" ? 8080 : application.live.port ?? 3001);
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
        body: JSON.stringify({ target, hostPort }),
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
              <span className={`status-pill status-${application.live.installed ? "good" : application.execution === "enabled" ? "neutral" : "warning"}`}>{application.live.installed ? application.live.state : application.execution === "enabled" ? "Available" : "Plan only"}</span>
            </div>
            <span className="app-category">{application.category} | adapter {application.image.version}</span>
            <h3>{application.name}</h3>
            <p>{application.description}</p>
            <span className="app-live-detail">{application.live.detail}</span>
            {application.live.backup && <span className={`app-live-detail ${application.live.backup.state === "verified" ? "good-text" : "warning-text"}`}>Backup: {application.live.backup.state === "verified" ? `restore verified ${new Date(application.live.backup.verifiedAt ?? "").toLocaleDateString()}` : application.live.backup.state}</span>}
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
            <div className="manifest-proof"><span>Manifest integrity</span><code>{selected.integrity}</code><span>{selected.image.digestPinned ? "Image digest pinned" : "Version tag pinned; digest resolution pending"}</span></div>
            <div className="app-plan-fields">
              <label>Deployment target<select value={target} onChange={(event) => { setTarget(event.target.value); setPlan(null); }}>{selected.targets.map((item) => <option key={item} value={item}>{item === "virtual-machine" ? "Dedicated virtual machine" : "Docker on Bigbox"}</option>)}</select></label>
              {target === "docker" && <label>Loopback web port<input type="number" min="1024" max="65535" value={hostPort} onChange={(event) => { setHostPort(Number(event.target.value)); setPlan(null); }} /></label>}
            </div>
            <button className="primary-button" type="button" onClick={() => void generatePlan()} disabled={submitting}>{submitting ? "Inspecting host..." : "Generate live plan"}</button>

            {plan && <div className="application-plan-result">
              <div className={`notice ${plan.output.executable ? "" : "warning-notice"}`}><strong>{plan.output.executable ? "Ready to stage" : "Planning result"}</strong><span>Revision {plan.revision} | expires {new Date(plan.expiresAt).toLocaleTimeString()}</span></div>
              <div><strong>Proposed changes</strong><ol>{plan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
              {plan.output.blockers.length > 0 && <div className="plan-blockers"><strong>Blockers</strong>{plan.output.blockers.map((blocker) => <span key={blocker.id}>{blocker.summary}{blocker.repair?.description ? `: ${blocker.repair.description}` : ""}</span>)}</div>}
              {plan.output.warnings.length > 0 && <div className="plan-warnings"><strong>Warnings</strong>{plan.output.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
              <p className="plan-recovery"><strong>Recovery:</strong> {plan.output.recovery.summary}</p>
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
