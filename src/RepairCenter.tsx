import { useCallback, useEffect, useMemo, useState } from "react";

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
  evidence: { jobs: unknown[]; applicationBackups: unknown[]; vmBackups: unknown[]; routerCheckpoints: unknown[]; migrationTransfers: unknown[]; fleet: { activeAgents: number; revokedAgents: number } };
  boundary: { mutationsPerformed: boolean; databaseCopied: boolean; backupDataIncluded: boolean; configurationFilesIncluded: boolean; credentialsIncluded: boolean; excluded: string[] };
  runbookMarkdown: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

export default function RepairCenter({ csrfToken }: { csrfToken: string }) {
  const [checks, setChecks] = useState<Prerequisite[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [recoveryKit, setRecoveryKit] = useState<RecoveryKit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRecoveryError(null);
    try {
      const [prerequisiteResult, jobResult, recoveryResult] = await Promise.allSettled([
        readJson<{ checks: Prerequisite[] }>(await fetch("/api/v1/operations/prerequisites")),
        readJson<{ jobs: Job[] }>(await fetch("/api/v1/jobs?limit=25")),
        readJson<RecoveryKit>(await fetch("/api/v1/operations/recovery-kit")),
      ]);
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
      {recoveryError && <div className="notice warning-notice" role="status"><strong>Recovery kit unavailable</strong><span>{recoveryError}. Prerequisite checks and durable jobs remain available.</span></div>}

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
            <span>{recoveryKit.evidence.applicationBackups.length} app backups</span>
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
              <div><small>{item.group}</small><strong>{item.name}</strong><p>{item.summary}</p>{item.repair && <em>{item.repair.description}</em>}</div>
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
              <button className="primary-button" type="button" onClick={() => void approve()} disabled={pending || password.length < 12}>{pending ? (["network.dns.acceptance.run", "virtualization.domain.export.create", "virtualization.export.backup.create", "virtualization.export.backup.restore-drill", "virtualization.backup.recovery.create"].includes(awaitingApproval.type) ? "Starting..." : "Running...") : "Approve and run"}</button>
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
