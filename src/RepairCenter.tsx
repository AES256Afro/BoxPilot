import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { readJson } from "./http";
import RuntimeHealth from "./RuntimeHealth";
import PackageRecovery from "./PackageRecovery";
import ControllerDoctor from "./ControllerDoctor";
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
  // Optional in truth, not just in principle: a job whose recovery block was missing took the
  // whole Repair Center down, because the type said it could not happen.
  recovery?: { reason?: string; manual?: string };
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
  high: { label: "High risk", description: "Enter your owner password to run this." },
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

interface Remediation {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  evidence: string[];
  fix: { operationId: string; parameters: Record<string, unknown>; label: string; preview: string } | null;
  manual: string | null;
}

export default function RepairCenter({ csrfToken, onNavigate = () => undefined }: { csrfToken: string; onNavigate?: (view: ViewName) => void }) {
  const [checks, setChecks] = useState<Prerequisite[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [recoveryKit, setRecoveryKit] = useState<RecoveryKit | null>(null);
  const [actionCenter, setActionCenter] = useState<ActionCenter | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prerequisiteError, setPrerequisiteError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [remediationError, setRemediationError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy | null>(null);
  const [pending, setPending] = useState(false);
  const [canaryResult, setCanaryResult] = useState<string | null>(null);
  const [remediations, setRemediations] = useState<{ findings: Remediation[]; counts: { critical: number; warning: number; info: number }; sourceStatus?: "ready" | "partial"; unavailableChecks?: string[] } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPrerequisiteError(null);
    setJobError(null);
    setRecoveryError(null);
    setActionError(null);
    setRemediationError(null);
    try {
      // The fetches must start before allSettled sees them, or they run one after another and a
      // dropped connection escapes to the outer catch instead of failing just its own collector.
      const [prerequisiteResult, jobResult, recoveryResult, actionResult, remediationResult] = await Promise.allSettled([
        fetch("/api/v1/operations/prerequisites").then((response) => readJson<{ checks: Prerequisite[] }>(response)),
        fetch("/api/v1/jobs?limit=25").then((response) => readJson<{ jobs: Job[] }>(response)),
        fetch("/api/v1/operations/recovery-kit").then((response) => readJson<RecoveryKit>(response)),
        fetch("/api/v1/operations/action-center").then((response) => readJson<ActionCenter>(response)),
        fetch("/api/v1/remediations").then((response) => readJson<{ findings: Remediation[]; counts: { critical: number; warning: number; info: number }; sourceStatus?: "ready" | "partial"; unavailableChecks?: string[] }>(response)),
      ]);
      // A problem sweep that cannot run must not take the page down with it.
      if (remediationResult.status === "fulfilled" && Array.isArray(remediationResult.value?.findings) && remediationResult.value.counts) {
        setRemediations(remediationResult.value);
        if (remediationResult.value.sourceStatus === "partial") setRemediationError(`Could not check: ${(remediationResult.value.unavailableChecks ?? []).join(", ") || "some parts of this server"}. Other findings are shown below.`);
      } else {
        setRemediations(null);
        setRemediationError("The problem scan could not finish. Check again to retry.");
      }
      if (actionResult.status === "fulfilled" && Array.isArray(actionResult.value?.notices) && actionResult.value.summary) setActionCenter(actionResult.value);
      else {
        setActionCenter(null);
        setActionError(actionResult.status === "rejected" && actionResult.reason instanceof Error ? actionResult.reason.message : "Protection checks returned incomplete data");
      }
      if (prerequisiteResult.status === "fulfilled" && Array.isArray(prerequisiteResult.value?.checks)) setChecks(prerequisiteResult.value.checks);
      else { setChecks([]); setPrerequisiteError("Prerequisite checks could not finish. Check again to retry."); }
      if (jobResult.status === "fulfilled" && Array.isArray(jobResult.value?.jobs)) setJobs(jobResult.value.jobs);
      else setJobError("Activity could not be refreshed. Any jobs below are from the previous check.");
      if (recoveryResult.status === "fulfilled" && Array.isArray(recoveryResult.value?.checks) && recoveryResult.value.summary && recoveryResult.value.product && Array.isArray(recoveryResult.value.evidence?.controllerBackups)) setRecoveryKit(recoveryResult.value);
      else {
        setRecoveryKit(null);
        setRecoveryError(recoveryResult.status === "rejected" && recoveryResult.reason instanceof Error ? recoveryResult.reason.message : "The rebuild checklist returned incomplete data");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to inspect prerequisites");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);


  // While a job runs, the only thing that changes is the job list. Refreshing everything every ten
  // seconds re-ran the prerequisite checks, the host inventory and the recovery kit each time -
  // forty-odd child processes a poll, because both server caches are also ten seconds - to learn
  // nothing new. Poll the jobs alone, and refresh the rest once when the run is over.
  const running = jobs.some((job) => ["applying", "verifying"].includes(job.state));
  useEffect(() => {
    if (!running) return undefined;
    let busy = false;
    const interval = window.setInterval(() => {
      if (busy) return;
      busy = true;
      fetch("/api/v1/jobs?limit=25").then((response) => (response.ok ? response.json() : null)).then((body: { jobs?: typeof jobs } | null) => { if (Array.isArray(body?.jobs)) setJobs(body.jobs); }).catch(() => {}).finally(() => { busy = false; });
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [running]);
  // The moment the last running job finishes, one full refresh picks up what it changed.
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (running) { setWasRunning(true); return; }
    if (wasRunning) { setWasRunning(false); void refresh(); }
  }, [running, wasRunning, refresh]);

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
      setCanaryResult(`Answered: the root side is running, version ${result.helperVersion}. Nothing on the server was changed.`);
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
        body: JSON.stringify({ ...(password ? { password } : {}), ...(confirmTyped ? { confirmText: confirmTyped } : {}) }),
      }));
      if (password) window.dispatchEvent(new Event("boxpilot:auth-changed"));
      setPassword("");
      setConfirmTyped("");
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
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const problems = remediations?.findings ?? [];
  const worst = problems[0]?.severity;

  return (
    <div className="repair-page">
      <section className="repair-readiness">
        <div>
          <span className="eyebrow">Repair</span>
          <strong>{loading ? "Checking this server..." : (remediationError || prerequisiteError || jobError) ? "Checks incomplete" : problems.length === 0 ? "Problem scan complete" : `${problems.length} thing${problems.length === 1 ? "" : "s"} to fix`}</strong>
          <p>{(remediationError || prerequisiteError || jobError) ? "Some checks could not finish. Review the available findings and retry the missing checks." : problems.length === 0 ? "This scan found no repair findings. Run installation, package and resource checks below for more detail." : "Each one says what is wrong and what fixes it. Review a fix to see its steps and approval requirements."}</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Checking..." : "Check again"}</button>
      </section>

      {remediationError && <div className="notice warning-notice" role="status"><strong>Problem scan incomplete</strong><span>{remediationError}</span></div>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      {operationDialog}

      {/* Problems first: this page used to open with a prerequisite inventory, which is the least
          urgent thing on it. Every entry here was a real failure that took a shell to explain. */}
      {problems.length > 0 && (
        <section className={`panel repair-problems repair-worst-${worst}`}>
          <header className="panel-header">
            <div><strong>Fix these</strong><span>Worst first. Each fix is a normal job: you see exactly what it will do before it runs.</span></div>
            <div className="action-counts">
              {remediations!.counts.critical > 0 && <span className="action-critical">{remediations!.counts.critical} critical</span>}
              {remediations!.counts.warning > 0 && <span className="action-warning">{remediations!.counts.warning} warning</span>}
              {remediations!.counts.info > 0 && <span>{remediations!.counts.info} information</span>}
            </div>
          </header>
          <div className="problem-list">
            {problems.map((problem) => (
              <article className={`problem-card problem-${problem.severity}`} key={problem.id}>
                <div className="problem-heading">
                  <strong>{problem.title}</strong>
                  <span className={`status-pill status-${problem.severity === "critical" ? "warning" : problem.severity === "warning" ? "warning" : "neutral"}`}>{problem.severity === "critical" ? "Critical" : problem.severity === "warning" ? "Warning" : "Information"}</span>
                </div>
                <p>{problem.detail}</p>
                {problem.evidence.length > 0 && <details className="repair-details"><summary>Technical evidence</summary><ul className="problem-evidence">{problem.evidence.map((line) => <li key={line}>{line}</li>)}</ul></details>}
                {problem.fix
                  ? <button className="primary-button" type="button" onClick={() => startOperation({ operationId: problem.fix!.operationId, title: problem.fix!.label, parameters: problem.fix!.parameters, preview: <span>{problem.fix!.preview}</span> })}>{problem.fix.label}</button>
                  : <p className="problem-manual">{problem.manual}</p>}
              </article>
            ))}
          </div>
        </section>
      )}

      <RuntimeHealth />
      <ControllerDoctor onOpenBackups={() => onNavigate("backups")} />
      <PackageRecovery csrfToken={csrfToken} />

      <section className="repair-prerequisites" aria-label="Prerequisites">
        <header className="repair-readiness repair-prereq-header">
          <div><span className="eyebrow">Prerequisites</span><strong>{loading ? "Checking..." : prerequisiteError ? "Prerequisites unavailable" : checks.length ? `${ready} of ${checks.length} ready` : "No prerequisite checks returned"}</strong><p>The tools and services BoxPilot needs.</p></div>
        </header>
        {prerequisiteError && <div className="notice warning-notice" role="status">{prerequisiteError}</div>}
      <div className="repair-layout">
        <section className="panel repair-checks">
          {checks.map((item) => (
            <article className="repair-check" key={item.id}>
              <span className={`repair-state repair-${item.status}`}>{item.status}</span>
              <div><small>{item.group}</small><strong>{item.name}</strong><p>{item.summary}</p>{item.repair && <em>{item.repair.description}</em>}{item.repair?.kind === "approved" && repairDefinitions[item.id] && <button className="secondary-button repair-plan-button" type="button" onClick={() => void reviewRepair(item.id)} disabled={pending}>Review exact repair</button>}</div>
            </article>
          ))}
        </section>

        <aside className="panel helper-canary">
          <span className="eyebrow">{awaitingApproval ? "Approval desk" : "Helper check"}</span>
          <h3>{awaitingApproval ? awaitingApproval.title : "Helper connection and logging"}</h3>
          <p>{awaitingApproval ? "Check what this job will do, then approve it." : "Checks the privileged helper connection and writes a small test log. Run this if jobs fail to start or their output is missing."}</p>
          {awaitingApproval && <p className="job-recovery"><strong>{awaitingApproval.risk} risk:</strong> {awaitingApproval.recovery?.reason ?? "Follow the recorded recovery instructions if verification fails."}</p>}
          {!awaitingApproval ? (
            <>
              <button className="primary-button" type="button" onClick={() => void runCanary()} disabled={pending}>{pending ? "Checking..." : "Check helper"}</button>
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
      </section>

      {actionError && <div className="notice warning-notice" role="status"><strong>Protection checks incomplete</strong><span>{actionError}. Press Check again to retry.</span></div>}
      {actionCenter && (
        <section className="panel action-center">
          <header className="panel-header">
            <div><strong>Protection gaps</strong><span>Backup and recovery coverage that needs attention. Checked {new Date(actionCenter.generatedAt).toLocaleString()}{actionCenter.sourceStatus === "ready" ? "" : " · checks incomplete"}</span></div>
            <div className="action-counts">{actionCenter.summary.critical > 0 && <span className="action-critical">{actionCenter.summary.critical} critical</span>}{actionCenter.summary.warning > 0 && <span className="action-warning">{actionCenter.summary.warning} warning</span>}{actionCenter.summary.info > 0 && <span>{actionCenter.summary.info} information</span>}</div>
          </header>
          <div className="action-list">
            {actionCenter.notices.map((item) => (
              <article className={`action-card action-${item.severity}`} key={item.id}>
                <div className="action-card-heading"><div><span>{item.category}</span><strong>{item.title}</strong></div><span className={`status-pill status-${item.severity === "critical" || item.severity === "warning" ? "warning" : "neutral"}`}>{item.severity}</span></div>
                <p>{item.summary}</p>
                <details className="repair-details"><summary>Evidence and recommended steps</summary><div className="action-evidence">{item.evidence.map((evidence) => <span key={evidence}>{evidence}</span>)}</div><ol>{item.recommendation.steps.map((step) => <li key={step}>{step}</li>)}</ol></details>
                <footer><button className="secondary-button" type="button" onClick={() => onNavigate(item.recommendation.view)}>{item.recommendation.title}</button></footer>
              </article>
            ))}
          </div>
        </section>
      )}

      {recoveryError && <div className="notice warning-notice" role="status"><strong>Could not build the rebuild checklist</strong><span>{recoveryError}. The rest of this page still works.</span></div>}
      {recoveryKit && (
        <section className="panel recovery-kit">
          <header className="panel-header">
            <div><strong>Rebuild checklist</strong><span>Checked {new Date(recoveryKit.generatedAt).toLocaleString()} · BoxPilot {recoveryKit.product.version} · private recovery information; keep a protected copy on another device</span></div>
            <span className={`status-pill status-${recoveryKit.summary.actionRequired > 0 ? "warning" : "neutral"}`}>{recoveryKit.summary.actionRequired > 0 ? `${recoveryKit.summary.actionRequired} to sort out` : recoveryKit.summary.operatorChecks > 0 ? `${recoveryKit.summary.operatorChecks} to check` : "ready"}</span>
          </header>
          <div className="recovery-summary">
            <span><strong>{recoveryKit.summary.verified}</strong>verified</span>
            <span><strong>{recoveryKit.summary.actionRequired}</strong>action required</span>
            <span><strong>{recoveryKit.summary.operatorChecks}</strong>operator checks</span>
            <span><strong>{recoveryKit.summary.notApplicable}</strong>not applicable</span>
          </div>
          <details className="repair-details"><summary>View {recoveryKit.checks.length} recovery checks</summary>
          <div className="recovery-check-grid">
            {recoveryKit.checks.map((item) => (
              <article key={item.id} className={`recovery-check recovery-${item.state}`}>
                <div><strong>{item.title}</strong><span>{item.state.replaceAll("-", " ")}</span></div>
                <p>{item.evidence}</p>
                <small>{item.action}</small>
              </article>
            ))}
          </div>
          </details>
          <div className="recovery-evidence-strip">
            <span>{recoveryKit.evidence.controllerBackups.length} database backups</span>
            <span>{recoveryKit.evidence.controllerProtections?.length ?? 0} with an encrypted second copy</span>
            <span>{recoveryKit.evidence.controllerRetentionRuns?.length ?? 0} controller retention runs</span>
            <span>{recoveryKit.evidence.applications?.length ?? 0} installed apps</span>
            <span>{recoveryKit.evidence.vmBackups?.length ?? 0} VM backups</span>
          </div>
          <footer className="recovery-actions"><button className="secondary-button" type="button" onClick={() => downloadRecoveryKit("markdown")}>Download rebuild steps (.md)</button><button className="secondary-button" type="button" onClick={() => downloadRecoveryKit("json")}>Download recovery data (.json)</button></footer>
        </section>
      )}


      <section className="panel job-history">
        <header className="panel-header"><div><strong>Activity on this server</strong><span>Everything BoxPilot has run, with each step it took. Kept across restarts.</span></div></header>
        {jobError && <div className="notice warning-notice" role="status">{jobError}</div>}
        {jobs.length === 0 ? <div className="log-empty">{jobError ? "Activity is unavailable." : "Nothing has run yet."} Every change you approve appears here with its steps.</div> : jobs.map((job) => (
          <details className="job-row" key={job.id} open={job === jobs[0]}>
            <summary><div><strong>{job.title}</strong><span>{job.risk} risk · {job.steps.length} steps</span></div><span className={`status-pill status-${job.state === "completed" ? "good" : job.state === "failed" ? "warning" : "neutral"}`}>{job.state.replaceAll("_", " ")}</span></summary>
            <div className="job-steps">{job.steps.map((step, index) => <div key={`${step.createdAt}-${index}`}><span>{step.state}</span><strong>{step.name}</strong><p>{step.detail}</p></div>)}</div>
            {job.error && <p className="job-error">{job.error}</p>}
            {job.recovery?.manual && <p className="job-recovery"><strong>Recovery:</strong> {job.recovery.manual}</p>}
          </details>
        ))}
      </section>
    </div>
  );
}
