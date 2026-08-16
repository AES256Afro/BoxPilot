import { useCallback, useEffect, useMemo, useState } from "react";
import type { ViewName } from "./data";

interface Prerequisite {
  id: string;
  group: string;
  name: string;
  status: "ready" | "missing" | "conflict" | "repairable";
  summary: string;
  repair: { kind: string; description: string } | null;
}

interface JobStep {
  name: string;
  state: string;
  detail: string;
  createdAt: string;
}

interface Job {
  id: string;
  title: string;
  type: string;
  state: string;
  risk: string;
  error: string | null;
  steps: JobStep[];
  recovery: { reason?: string; manual?: string };
}

interface RecoveryKit {
  schemaVersion: number;
  generatedAt: string;
  product: { name: string; version: string };
  summary: { status: string; verified: number; actionRequired: number; operatorChecks: number; notApplicable: number; total: number };
  checks: Array<{ id: string; state: "verified" | "action-required" | "operator-check" | "not-applicable" | "unavailable"; title: string; evidence: string; action: string }>;
  evidence: { jobs: unknown[]; controllerBackups: unknown[]; controllerProtections?: unknown[]; controllerRetentionRuns?: unknown[]; applicationBackups: unknown[]; applicationProtections?: unknown[]; vmBackups: unknown[]; routerCheckpoints: unknown[]; migrationTransfers: unknown[]; fleet: { activeAgents: number; revokedAgents: number } };
  boundary: { mutationsPerformed: boolean; databaseCopied: boolean; backupDataIncluded: boolean; configurationFilesIncluded: boolean; credentialsIncluded: boolean; excluded: string[] };
  runbookMarkdown: string;
}

interface ActionNotice {
  id: string;
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  summary: string;
  evidence: string[];
  recommendation: { view: ViewName; title: string; steps: string[] };
  boundary: { mutationPerformed: boolean; automaticFixAvailable: boolean; commandsIncluded: boolean; secretsIncluded: boolean; logsIncluded: boolean };
}

interface ActionCenter {
  generatedAt: string;
  sourceStatus: "ready" | "unavailable";
  summary: { critical: number; warning: number; info: number; total: number };
  notices: ActionNotice[];
  boundary: { mutationPerformed: boolean; automaticRepair: boolean; persistence: boolean; browserNotifications: boolean; externalDelivery: boolean; credentialsIncluded: boolean; arbitraryLogsIncluded: boolean };
}

interface SmartRepairPlan {
  id: string;
  revision: string;
  expiresAt: string;
  output: {
    package: "smartmontools";
    selectedVersion: string;
    currentState: string;
    action: string;
    networkAccess: boolean;
    aptUpdatePerformed: boolean;
    arbitraryPackageSelection: boolean;
    automaticRollback: boolean;
    recovery: string;
  };
}

interface ResticRepairPlan {
  id: string;
  revision: string;
  expiresAt: string;
  output: {
    package: "restic";
    selectedVersion: string;
    currentState: string;
    action: string;
    networkAccess: boolean;
    aptUpdatePerformed: boolean;
    arbitraryPackageSelection: boolean;
    automaticRollback: boolean;
    storageSetupPerformed: boolean;
    recovery: string;
  };
}

interface AptRefreshPlan {
  id: string;
  revision: string;
  expiresAt: string;
  output: {
    currentState: string;
    currentUpdatedAt: string | null;
    currentAgeHours: number | null;
    action: string;
    networkAccess: boolean;
    aptUpdatePerformed: boolean;
    packageInstallPerformed: boolean;
    packageUpgradePerformed: boolean;
    packageRemovalPerformed: boolean;
    arbitraryCommandAccepted: boolean;
    automaticRollback: boolean;
    recovery: string;
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

export default function RepairCenter({ csrfToken, onNavigate = () => undefined }: { csrfToken: string; onNavigate?: (view: ViewName) => void }) {
  const [checks, setChecks] = useState<Prerequisite[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [recoveryKit, setRecoveryKit] = useState<RecoveryKit | null>(null);
  const [actionCenter, setActionCenter] = useState<ActionCenter | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [smartRepairPlan, setSmartRepairPlan] = useState<SmartRepairPlan | null>(null);
  const [resticRepairPlan, setResticRepairPlan] = useState<ResticRepairPlan | null>(null);
  const [aptRefreshPlan, setAptRefreshPlan] = useState<AptRefreshPlan | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRecoveryError(null);
    setActionError(null);
    try {
      const [prerequisiteResult, jobResult, recoveryResult, actionResult] = await Promise.allSettled([
        readJson<{ checks: Prerequisite[] }>(await fetch("/api/v1/operations/prerequisites")),
        readJson<{ jobs: Job[] }>(await fetch("/api/v1/jobs?limit=25")),
        readJson<RecoveryKit>(await fetch("/api/v1/operations/recovery-kit")),
        readJson<ActionCenter>(await fetch("/api/v1/operations/action-center")),
      ]);
      if (actionResult.status === "fulfilled") setActionCenter(actionResult.value);
      else {
        setActionCenter(null);
        setActionError(actionResult.reason instanceof Error ? actionResult.reason.message : "Action Center unavailable");
      }
      if (prerequisiteResult.status === "rejected") throw prerequisiteResult.reason;
      if (jobResult.status === "rejected") throw jobResult.reason;
      setChecks(prerequisiteResult.value.checks);
      setJobs(jobResult.value.jobs);
      if (recoveryResult.status === "fulfilled") setRecoveryKit(recoveryResult.value);
      else {
        setRecoveryKit(null);
        setRecoveryError(recoveryResult.reason instanceof Error ? recoveryResult.reason.message : "Recovery kit unavailable");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to inspect prerequisites");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!jobs.some((job) => ["applying", "verifying"].includes(job.state))) return undefined;
    const interval = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(interval);
  }, [jobs, refresh]);

  const awaitingApproval = useMemo(() => jobs.find((job) => job.state === "awaiting_approval"), [jobs]);

  const createCanary = async () => {
    setPending(true);
    setError(null);
    try {
      await readJson(await fetch("/api/v1/operations/canary", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } }));
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create canary job");
    } finally {
      setPending(false);
    }
  };

  const createSmartRepairPlan = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await readJson<{ plan: SmartRepairPlan }>(await fetch("/api/v1/prerequisite-repairs/smartmontools/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({}),
      }));
      setSmartRepairPlan(result.plan);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create the smartmontools repair plan");
    } finally {
      setPending(false);
    }
  };

  const stageSmartRepairPlan = async () => {
    if (!smartRepairPlan) return;
    setPending(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/prerequisite-repair-plans/${smartRepairPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: smartRepairPlan.revision }),
      }));
      setSmartRepairPlan(null);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to stage the smartmontools repair plan");
    } finally {
      setPending(false);
    }
  };

  const createResticRepairPlan = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await readJson<{ plan: ResticRepairPlan }>(await fetch("/api/v1/prerequisite-repairs/restic/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({}),
      }));
      setResticRepairPlan(result.plan);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create the restic repair plan");
    } finally {
      setPending(false);
    }
  };

  const stageResticRepairPlan = async () => {
    if (!resticRepairPlan) return;
    setPending(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/prerequisite-repair-plans/${resticRepairPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: resticRepairPlan.revision }),
      }));
      setResticRepairPlan(null);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to stage the restic repair plan");
    } finally {
      setPending(false);
    }
  };

  const createAptRefreshPlan = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await readJson<{ plan: AptRefreshPlan }>(await fetch("/api/v1/prerequisite-repairs/apt-metadata/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({}),
      }));
      setAptRefreshPlan(result.plan);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create the APT metadata refresh plan");
    } finally {
      setPending(false);
    }
  };

  const stageAptRefreshPlan = async () => {
    if (!aptRefreshPlan) return;
    setPending(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/prerequisite-repair-plans/${aptRefreshPlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: aptRefreshPlan.revision }),
      }));
      setAptRefreshPlan(null);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to stage the APT metadata refresh plan");
    } finally {
      setPending(false);
    }
  };

  const approve = async () => {
    if (!awaitingApproval) return;
    setPending(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/jobs/${awaitingApproval.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ password }),
      }));
      setPassword("");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Job approval failed");
    } finally {
      setPending(false);
    }
  };

  const ready = checks.filter((item) => item.status === "ready").length;

  const downloadRecoveryKit = (format: "json" | "markdown") => {
    if (!recoveryKit) return;
    const contents = format === "json" ? `${JSON.stringify(recoveryKit, null, 2)}\n` : recoveryKit.runbookMarkdown;
    const url = URL.createObjectURL(new Blob([contents], { type: format === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = format === "json" ? "boxpilot-recovery-kit.json" : "boxpilot-recovery-runbook.md";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="repair-page">
      <section className="repair-readiness">
        <div><span className="eyebrow">Live prerequisite inventory</span><strong>{loading ? "Inspecting Bigbox..." : `${ready} of ${checks.length} checks ready`}</strong><p>Missing and conflicting requirements are reported independently, so one failed collector does not hide the others.</p></div>
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Inspecting..." : "Run inspection"}</button>
      </section>

      {error && <div className="auth-error" role="alert">{error}</div>}
      {smartRepairPlan && (
        <section className="panel prerequisite-repair-plan">
          <header className="panel-header"><div><span className="eyebrow">Exact prerequisite repair plan</span><strong>smartmontools {smartRepairPlan.output.selectedVersion}</strong><span>Revision {smartRepairPlan.revision} | expires {new Date(smartRepairPlan.expiresAt).toLocaleString()}</span></div><span className="status-pill status-warning">system package</span></header>
          <div className="prerequisite-repair-grid">
            <div><span>Current state</span><strong>{smartRepairPlan.output.currentState}</strong></div>
            <div><span>Network access</span><strong>{smartRepairPlan.output.networkAccess ? "Required for the fixed APT install" : "Not required"}</strong></div>
            <div><span>APT update</span><strong>{smartRepairPlan.output.aptUpdatePerformed ? "Planned" : "Not permitted"}</strong></div>
            <div><span>Automatic removal</span><strong>{smartRepairPlan.output.automaticRollback ? "Planned" : "Never"}</strong></div>
          </div>
          <p>{smartRepairPlan.output.action}</p>
          <div className="recovery-boundary"><strong>Fixed boundary</strong><span>No package name, repository, command, argument, disk, mount, or SMART setting comes from the browser. {smartRepairPlan.output.recovery}</span></div>
          <footer className="recovery-actions"><button className="secondary-button" type="button" onClick={() => setSmartRepairPlan(null)} disabled={pending}>Discard plan</button><button className="primary-button" type="button" onClick={() => void stageSmartRepairPlan()} disabled={pending}>{pending ? "Staging..." : "Stage exact repair for password approval"}</button></footer>
        </section>
      )}
      {resticRepairPlan && (
        <section className="panel prerequisite-repair-plan">
          <header className="panel-header"><div><span className="eyebrow">Exact prerequisite repair plan</span><strong>restic {resticRepairPlan.output.selectedVersion}</strong><span>Revision {resticRepairPlan.revision} | expires {new Date(resticRepairPlan.expiresAt).toLocaleString()}</span></div><span className="status-pill status-warning">system package</span></header>
          <div className="prerequisite-repair-grid">
            <div><span>Current state</span><strong>{resticRepairPlan.output.currentState}</strong></div>
            <div><span>Network access</span><strong>{resticRepairPlan.output.networkAccess ? "Required for the fixed APT install" : "Not required"}</strong></div>
            <div><span>APT update</span><strong>{resticRepairPlan.output.aptUpdatePerformed ? "Planned" : "Not permitted"}</strong></div>
            <div><span>Storage setup</span><strong>{resticRepairPlan.output.storageSetupPerformed ? "Planned" : "Separate terminal step"}</strong></div>
          </div>
          <p>{resticRepairPlan.output.action}</p>
          <div className="recovery-boundary"><strong>Fixed boundary</strong><span>No package name, repository, password, command, argument, mount, backup target, or retention rule comes from the browser. Installation does not mount a disk, create a recovery key, initialize a repository, or start a backup. {resticRepairPlan.output.recovery}</span></div>
          <footer className="recovery-actions"><button className="secondary-button" type="button" onClick={() => setResticRepairPlan(null)} disabled={pending}>Discard plan</button><button className="primary-button" type="button" onClick={() => void stageResticRepairPlan()} disabled={pending}>{pending ? "Staging..." : "Stage exact repair for password approval"}</button></footer>
        </section>
      )}
      {aptRefreshPlan && (
        <section className="panel prerequisite-repair-plan">
          <header className="panel-header"><div><span className="eyebrow">Exact prerequisite repair plan</span><strong>APT metadata refresh</strong><span>Revision {aptRefreshPlan.revision} | expires {new Date(aptRefreshPlan.expiresAt).toLocaleString()}</span></div><span className="status-pill status-warning">package metadata</span></header>
          <div className="prerequisite-repair-grid">
            <div><span>Current state</span><strong>{aptRefreshPlan.output.currentState}{aptRefreshPlan.output.currentAgeHours !== null ? ` (${aptRefreshPlan.output.currentAgeHours} hours old)` : ""}</strong></div>
            <div><span>Previous timestamp</span><strong>{aptRefreshPlan.output.currentUpdatedAt ? new Date(aptRefreshPlan.output.currentUpdatedAt).toLocaleString() : "Unavailable"}</strong></div>
            <div><span>Fixed APT update</span><strong>{aptRefreshPlan.output.aptUpdatePerformed ? "Required" : "Not planned"}</strong></div>
            <div><span>Package changes</span><strong>{aptRefreshPlan.output.packageInstallPerformed || aptRefreshPlan.output.packageUpgradePerformed || aptRefreshPlan.output.packageRemovalPerformed ? "Planned" : "None permitted"}</strong></div>
          </div>
          <p>{aptRefreshPlan.output.action}</p>
          <div className="recovery-boundary"><strong>Fixed boundary</strong><span>The browser supplies no package, repository, command, option, or target. The static root unit runs only apt-get update --error-on=any and verifies the installed package database is unchanged. {aptRefreshPlan.output.recovery}</span></div>
          <footer className="recovery-actions"><button className="secondary-button" type="button" onClick={() => setAptRefreshPlan(null)} disabled={pending}>Discard plan</button><button className="primary-button" type="button" onClick={() => void stageAptRefreshPlan()} disabled={pending}>{pending ? "Staging..." : "Stage metadata refresh for password approval"}</button></footer>
        </section>
      )}
      {recoveryError && <div className="notice warning-notice" role="status"><strong>Recovery kit unavailable</strong><span>{recoveryError}. Prerequisite checks and durable jobs remain available.</span></div>}
      {actionError && <div className="notice warning-notice" role="status"><strong>Action Center unavailable</strong><span>{actionError}. No all-clear state is being claimed.</span></div>}

      {actionCenter && (
        <section className="panel action-center">
          <header className="panel-header">
            <div><span className="eyebrow">Local Action Center</span><strong>Prioritized evidence and guided next steps</strong><span>Generated {new Date(actionCenter.generatedAt).toLocaleString()} | {actionCenter.sourceStatus === "ready" ? "Recovery evidence available" : "Evidence unavailable, failed closed"}</span></div>
            <div className="action-counts"><span className="action-critical">{actionCenter.summary.critical} critical</span><span className="action-warning">{actionCenter.summary.warning} warning</span><span>{actionCenter.summary.info} info</span></div>
          </header>
          <div className="action-list">
            {actionCenter.notices.map((item) => (
              <article className={`action-card action-${item.severity}`} key={item.id}>
                <div className="action-card-heading"><div><span>{item.category}</span><strong>{item.title}</strong></div><span className={`status-pill status-${item.severity === "critical" || item.severity === "warning" ? "warning" : "neutral"}`}>{item.severity}</span></div>
                <p>{item.summary}</p>
                <div className="action-evidence"><strong>Why this appears</strong>{item.evidence.map((evidence) => <span key={evidence}>{evidence}</span>)}</div>
                <ol>{item.recommendation.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                <footer><span>No automatic fix, command, credential, or log payload.</span><button className="secondary-button" type="button" onClick={() => onNavigate(item.recommendation.view)}>{item.recommendation.title}</button></footer>
              </article>
            ))}
          </div>
          <div className="recovery-boundary"><strong>Guidance only</strong><span>Action Center is regenerated from sanitized evidence. It stores no notification state, sends nothing externally, and cannot install, repair, schedule, run a command, or mutate the host.</span></div>
        </section>
      )}

      {recoveryKit && (
        <section className="panel recovery-kit">
          <header className="panel-header">
            <div><span className="eyebrow">Secret-free disaster recovery kit</span><strong>Recovery readiness and ordered runbook</strong><span>Generated {new Date(recoveryKit.generatedAt).toLocaleString()} | BoxPilot {recoveryKit.product.version}</span></div>
            <span className={`status-pill status-${recoveryKit.summary.actionRequired > 0 ? "warning" : "neutral"}`}>{recoveryKit.summary.status.replaceAll("-", " ")}</span>
          </header>
          <div className="recovery-summary">
            <span><strong>{recoveryKit.summary.verified}</strong>verified</span>
            <span><strong>{recoveryKit.summary.actionRequired}</strong>action required</span>
            <span><strong>{recoveryKit.summary.operatorChecks}</strong>operator checks</span>
            <span><strong>{recoveryKit.summary.notApplicable}</strong>not applicable</span>
          </div>
          <div className="recovery-check-grid">
            {recoveryKit.checks.map((item) => (
              <article key={item.id} className={`recovery-check recovery-${item.state}`}>
                <div><strong>{item.title}</strong><span>{item.state.replaceAll("-", " ")}</span></div>
                <p>{item.evidence}</p>
                <small>{item.action}</small>
              </article>
            ))}
          </div>
          <div className="recovery-evidence-strip">
            <span>{recoveryKit.evidence.controllerBackups.length} controller backups</span>
            <span>{recoveryKit.evidence.controllerProtections?.length ?? 0} independently protected</span>
            <span>{recoveryKit.evidence.controllerRetentionRuns?.length ?? 0} controller retention runs</span>
            <span>{recoveryKit.evidence.applicationBackups.length} app backups</span>
            <span>{recoveryKit.evidence.applicationProtections?.length ?? 0} protected app snapshots</span>
            <span>{recoveryKit.evidence.vmBackups.length} VM backups</span>
            <span>{recoveryKit.evidence.routerCheckpoints.length} router checkpoints</span>
            <span>{recoveryKit.evidence.migrationTransfers.length} staged migrations</span>
            <span>{recoveryKit.evidence.fleet.activeAgents} active agents</span>
          </div>
          <div className="recovery-boundary"><strong>Evidence, not a backup</strong><span>No credential, database, application data, router configuration, backup payload, agent key, signature, or arbitrary log is included. Generating or downloading this kit performs no host mutation.</span></div>
          <footer className="recovery-actions"><button className="secondary-button" type="button" onClick={() => downloadRecoveryKit("json")}>Download evidence JSON</button><button className="secondary-button" type="button" onClick={() => downloadRecoveryKit("markdown")}>Download recovery runbook</button></footer>
        </section>
      )}

      <div className="repair-layout">
        <section className="panel repair-checks">
          <header className="panel-header"><div><strong>Prerequisites</strong><span>Read-only live checks</span></div></header>
          {checks.map((item) => (
            <article className="repair-check" key={item.id}>
              <span className={`repair-state repair-${item.status}`}>{item.status}</span>
              <div><small>{item.group}</small><strong>{item.name}</strong><p>{item.summary}</p>{item.repair && <em>{item.repair.description}</em>}{item.id === "storage.smartmontools" && item.repair?.kind === "approved" && <button className="secondary-button repair-plan-button" type="button" onClick={() => void createSmartRepairPlan()} disabled={pending || smartRepairPlan !== null || resticRepairPlan !== null || aptRefreshPlan !== null}>Review exact repair</button>}{item.id === "backup.restic" && item.repair?.kind === "approved" && <button className="secondary-button repair-plan-button" type="button" onClick={() => void createResticRepairPlan()} disabled={pending || smartRepairPlan !== null || resticRepairPlan !== null || aptRefreshPlan !== null}>Review restic repair</button>}{item.id === "host.apt-metadata" && item.repair?.kind === "approved" && <button className="secondary-button repair-plan-button" type="button" onClick={() => void createAptRefreshPlan()} disabled={pending || smartRepairPlan !== null || resticRepairPlan !== null || aptRefreshPlan !== null}>Review metadata refresh</button>}</div>
            </article>
          ))}
        </section>

        <aside className="panel helper-canary">
          <span className="eyebrow">{awaitingApproval ? "Approval desk" : "Operations Core canary"}</span>
          <h3>{awaitingApproval ? awaitingApproval.title : "Prove the restricted helper"}</h3>
          <p>{awaitingApproval ? "Review the recorded preflight and recovery steps below, then reauthenticate to execute this exact typed job." : "This job uses the real durable workflow and local Unix socket. Its allowlisted operation cannot mutate the host."}</p>
          {awaitingApproval && <p className="job-recovery"><strong>{awaitingApproval.risk} risk:</strong> {awaitingApproval.recovery.reason ?? "Follow the recorded recovery instructions if verification fails."}</p>}
          {!awaitingApproval ? (
            <button className="primary-button" type="button" onClick={() => void createCanary()} disabled={pending}>Create verification job</button>
          ) : (
            <div className="approval-box">
              <strong>Approval required</strong>
              <span>Re-enter your owner password. It is verified in memory and never stored in the job.</span>
              <input aria-label="Approval password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              <button className="primary-button" type="button" onClick={() => void approve()} disabled={pending || password.length < 12}>{pending ? (["prerequisite.smartmontools.install", "prerequisite.restic.install", "prerequisite.apt-metadata.refresh", "application.keel.artifact.acquire", "application.keel.stage", "application.keel.install", "application.keel.backup", "controller.database.backup", "controller.database.backup.protect", "application.backup.protect", "application.pi-hole.backup", "network.dns.acceptance.run", "virtualization.domain.export.create", "virtualization.export.backup.create", "virtualization.export.backup.restore-drill", "virtualization.backup.recovery.create"].includes(awaitingApproval.type) ? "Starting..." : "Running...") : "Approve and run"}</button>
            </div>
          )}
        </aside>
      </div>

      <section className="panel job-history">
        <header className="panel-header"><div><strong>Durable jobs</strong><span>Plans, approvals, execution, and verification survive service restarts</span></div></header>
        {jobs.length === 0 ? <div className="log-empty">No Operations Core jobs have been created.</div> : jobs.map((job) => (
          <details className="job-row" key={job.id} open={job === jobs[0]}>
            <summary><div><strong>{job.title}</strong><span>{job.risk} risk | {job.steps.length} recorded steps</span></div><span className={`status-pill status-${job.state === "completed" ? "good" : job.state === "failed" ? "warning" : "neutral"}`}>{job.state.replaceAll("_", " ")}</span></summary>
            <div className="job-steps">{job.steps.map((step, index) => <div key={`${step.createdAt}-${index}`}><span>{step.state}</span><strong>{step.name}</strong><p>{step.detail}</p></div>)}</div>
            {job.error && <p className="job-error">{job.error}</p>}
            {job.recovery.manual && <p className="job-recovery"><strong>Recovery:</strong> {job.recovery.manual}</p>}
          </details>
        ))}
      </section>
    </div>
  );
}
