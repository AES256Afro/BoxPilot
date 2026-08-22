import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";
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

interface ApprovalPolicy { confirmText?: string | null;
  tier: "low" | "medium" | "high";
  passwordRequired: boolean;
  elevated: boolean;
  mode: "tiered" | "always-password";
  reason: string;
}

const tierCopy: Record<ApprovalPolicy["tier"], { label: string; description: string }> = {
  low: { label: "Low risk", description: "One click. The action is audited and reversible." },
  medium: { label: "Medium risk", description: "Confirm to run. Review the preflight and recovery steps below first." },
  high: { label: "High risk", description: "Re-enter your owner password. It is verified in memory and never stored in the job." },
};

interface RecoveryKit {
  schemaVersion: number;
  generatedAt: string;
  product: { name: string; version: string };
  summary: { status: string; verified: number; actionRequired: number; operatorChecks: number; notApplicable: number; total: number };
  checks: Array<{ id: string; state: "verified" | "action-required" | "operator-check" | "not-applicable" | "unavailable"; title: string; evidence: string; action: string }>;
  evidence: { jobs: unknown[]; controllerBackups: unknown[]; controllerProtections?: unknown[]; controllerRetentionRuns?: unknown[]; applications?: unknown[]; virtualMachines?: unknown[]; vmBackups?: unknown[]; prerequisites?: unknown[] };
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
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy | null>(null);
  const [pending, setPending] = useState(false);
  const [canaryResult, setCanaryResult] = useState<string | null>(null);

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
    let busy = false;
    const interval = window.setInterval(() => { if (busy) return; busy = true; void refresh().finally(() => { busy = false; }); }, 10_000);
    return () => window.clearInterval(interval);
  }, [jobs, refresh]);

  const awaitingApproval = useMemo(() => jobs.find((job) => job.state === "awaiting_approval"), [jobs]);

  useEffect(() => {
    if (!awaitingApproval) { setApprovalPolicy(null); return; }
    let cancelled = false;
    fetch(`/api/v1/jobs/${awaitingApproval.id}/approval`)
      .then((response) => (response.ok ? response.json() : null))
      .then((policy: ApprovalPolicy | null) => { if (!cancelled) setApprovalPolicy(policy); })
      .catch(() => { if (!cancelled) setApprovalPolicy(null); });
    return () => { cancelled = true; };
  }, [awaitingApproval]);

  const { start: startOperation, dialog: operationDialog } = useOperation(csrfToken, () => { void refresh(); });

  // One generic review flow: read the live pinned versions from the registry inspect,
  // then stage the matching install through the shared risk-tiered dialog.
  const repairDefinitions: Record<string, { inspect: string; install: string; describe: (result: Record<string, unknown>) => { title: string; parameters: Record<string, unknown>; preview: ReactNode } }> = {
    "storage.smartmontools": {
      inspect: "prerequisite.smartmontools.inspect", install: "prerequisite.smartmontools.install",
      describe: (result) => ({ title: `Install smartmontools ${result.selectedVersion}`, parameters: { expectedVersion: result.selectedVersion }, preview: <span>Installs <code>smartmontools {String(result.selectedVersion)}</code> from the configured Ubuntu source. The job re-checks the pinned version before it runs.</span> }),
    },
    "backup.restic": {
      inspect: "prerequisite.restic.inspect", install: "prerequisite.restic.install",
      describe: (result) => ({ title: `Install restic ${result.selectedVersion}`, parameters: { expectedVersion: result.selectedVersion }, preview: <span>Installs <code>restic {String(result.selectedVersion)}</code>. Repository setup stays a separate step.</span> }),
    },
    "containers.docker": {
      inspect: "prerequisite.docker.inspect", install: "prerequisite.docker.install",
      describe: (result) => ({ title: `Install Docker Engine ${result.selectedVersion}`, parameters: { expectedVersion: result.selectedVersion }, preview: <span>Installs Ubuntu's <code>docker.io {String(result.selectedVersion)}</code> and starts the service. Existing compatible Docker providers are never replaced.</span> }),
    },
    "virtualization.libvirt": {
      inspect: "prerequisite.virtualization.inspect", install: "prerequisite.virtualization.install",
      describe: (result) => ({ title: "Install KVM, QEMU, and libvirt", parameters: { expectedPackages: result.candidatePackages }, preview: <span>Installs the fixed Ubuntu bundle at its current exact versions: {Object.entries(result.candidatePackages as Record<string, string>).map(([name, version]) => `${name} ${version}`).join(", ")}.</span> }),
    },
    "host.apt-metadata": {
      inspect: "prerequisite.apt-metadata.inspect", install: "prerequisite.apt-metadata.refresh",
      describe: (result) => ({ title: "Refresh APT metadata", parameters: { expectedUpdatedAt: result.updatedAt ?? null }, preview: <span>Runs the fixed <code>apt-get update</code>; no package is installed, upgraded, or removed.</span> }),
    },
  };

  const reviewRepair = async (checkId: string) => {
    const definition = repairDefinitions[checkId];
    if (!definition) return;
    setPending(true);
    setError(null);
    try {
      const { result } = await inspectOperation<Record<string, unknown>>(definition.inspect);
      startOperation({ operationId: definition.install, ...definition.describe(result) });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to inspect the prerequisite");
    } finally {
      setPending(false);
    }
  };

  const runCanary = async () => {
    setPending(true);
    setError(null);
    setCanaryResult(null);
    try {
      const { result } = await inspectOperation<{ helperVersion: string }>("canary.verify");
      setCanaryResult(`The helper answered over its socket: version ${result.helperVersion}. No host state was touched.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The helper did not answer");
    } finally {
      setPending(false);
    }
  };

  const [confirmTyped, setConfirmTyped] = useState("");
  const approve = async () => {
    if (!awaitingApproval) return;
    setPending(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/jobs/${awaitingApproval.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify(password ? { password } : {}),
      }));
      if (password) window.dispatchEvent(new Event("boxpilot:auth-changed"));
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
        <div><span className="eyebrow">Live prerequisite inventory</span><strong>{loading ? "Inspecting this server..." : `${ready} of ${checks.length} checks ready`}</strong><p>Missing and conflicting requirements are reported independently, so one failed collector does not hide the others.</p></div>
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Inspecting..." : "Run inspection"}</button>
      </section>

      {error && <div className="auth-error" role="alert">{error}</div>}
      {operationDialog}
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
            <span>{recoveryKit.evidence.applications?.length ?? 0} installed apps</span>
            <span>{recoveryKit.evidence.vmBackups?.length ?? 0} VM backups</span>
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
              <div><small>{item.group}</small><strong>{item.name}</strong><p>{item.summary}</p>{item.repair && <em>{item.repair.description}</em>}{item.repair?.kind === "approved" && repairDefinitions[item.id] && <button className="secondary-button repair-plan-button" type="button" onClick={() => void reviewRepair(item.id)} disabled={pending}>Review exact repair</button>}</div>
            </article>
          ))}
        </section>

        <aside className="panel helper-canary">
          <span className="eyebrow">{awaitingApproval ? "Approval desk" : "Operations Core canary"}</span>
          <h3>{awaitingApproval ? awaitingApproval.title : "Prove the restricted helper"}</h3>
          <p>{awaitingApproval ? "Review the recorded preflight and recovery steps below, then approve this exact typed job." : "This job uses the real durable workflow and local Unix socket. Its allowlisted operation cannot mutate the host."}</p>
          {awaitingApproval && <p className="job-recovery"><strong>{awaitingApproval.risk} risk:</strong> {awaitingApproval.recovery.reason ?? "Follow the recorded recovery instructions if verification fails."}</p>}
          {!awaitingApproval ? (
            <>
              <button className="primary-button" type="button" onClick={() => void runCanary()} disabled={pending}>{pending ? "Verifying..." : "Verify the helper"}</button>
              {canaryResult && <p className="good-text">{canaryResult}</p>}
            </>
          ) : (
            <div className="approval-box">
              {(() => {
                const tier = approvalPolicy?.tier ?? "high";
                const passwordRequired = approvalPolicy ? approvalPolicy.passwordRequired : true;
                const copy = tierCopy[tier];
                return (
                  <>
                    <strong>{passwordRequired ? `${copy.label} · password required` : `${copy.label} · ${tier === "low" ? "one click" : "confirm to run"}`}</strong>
                    <span>{passwordRequired ? tierCopy.high.description : copy.description}{approvalPolicy?.elevated && tier === "high" ? " Your session is elevated, so no password is needed right now." : ""}</span>
                    {approvalPolicy?.confirmText && <label>Type <code>{approvalPolicy.confirmText}</code> to confirm<input aria-label="Typed confirmation" autoComplete="off" spellCheck="false" value={confirmTyped} onChange={(event) => setConfirmTyped(event.target.value)} /></label>}
                    {passwordRequired && <input aria-label="Approval password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />}
                    <button className="primary-button" type="button" onClick={() => void approve()} disabled={pending || (passwordRequired && password.length < 12) || Boolean(approvalPolicy?.confirmText && confirmTyped !== approvalPolicy.confirmText)}>{pending ? "Working..." : tier === "low" && !passwordRequired ? "Run" : "Approve and run"}</button>
                  </>
                );
              })()}
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
