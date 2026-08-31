import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { readJson } from "./http";
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
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy | null>(null);
  const [pending, setPending] = useState(false);
  const [canaryResult, setCanaryResult] = useState<string | null>(null);
  const [remediations, setRemediations] = useState<{ findings: Remediation[]; counts: { critical: number; warning: number; info: number } } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRecoveryError(null);
    setActionError(null);
    try {
      // The fetches must start before allSettled sees them, or they run one after another and a
      // dropped connection escapes to the outer catch instead of failing just its own collector.
      const [prerequisiteResult, jobResult, recoveryResult, actionResult, remediationResult] = await Promise.allSettled([
        fetch("/api/v1/operations/prerequisites").then((response) => readJson<{ checks: Prerequisite[] }>(response)),
        fetch("/api/v1/jobs?limit=25").then((response) => readJson<{ jobs: Job[] }>(response)),
        fetch("/api/v1/operations/recovery-kit").then((response) => readJson<RecoveryKit>(response)),
        fetch("/api/v1/operations/action-center").then((response) => readJson<ActionCenter>(response)),
        fetch("/api/v1/remediations").then((response) => readJson<{ findings: Remediation[]; counts: { critical: number; warning: number; info: number } }>(response)),
      ]);
      // A problem sweep that cannot run must not take the page down with it.
      setRemediations(remediationResult.status === "fulfilled" ? remediationResult.value : null);
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
          <strong>{loading ? "Checking this server..." : problems.length === 0 ? "Nothing needs fixing" : `${problems.length} thing${problems.length === 1 ? "" : "s"} to fix`}</strong>
          <p>{problems.length === 0 ? "Everything BoxPilot knows how to check is working. What is installed, and what you would need to rebuild this server, are below." : "Each one says what is wrong and what fixes it. Nothing runs until you approve it."}</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Checking..." : "Check again"}</button>
      </section>

      {/* Problems first: this page used to open with a prerequisite inventory, which is the least
          urgent thing on it. Every entry here was a real failure that took a shell to explain. */}
      {problems.length > 0 && (
        <section className={`panel repair-problems repair-worst-${worst}`}>
          <header className="panel-header">
            <div><strong>Fix these</strong><span>Worst first. Each fix is a normal job: you see exactly what it will do before it runs.</span></div>
            <div className="action-counts">
              {remediations!.counts.critical > 0 && <span className="action-critical">{remediations!.counts.critical} serious</span>}
              {remediations!.counts.warning > 0 && <span className="action-warning">{remediations!.counts.warning} to look at</span>}
              {remediations!.counts.info > 0 && <span>{remediations!.counts.info} worth knowing</span>}
            </div>
          </header>
          <div className="problem-list">
            {problems.map((problem) => (
              <article className={`problem-card problem-${problem.severity}`} key={problem.id}>
                <div className="problem-heading">
                  <strong>{problem.title}</strong>
                  <span className={`status-pill status-${problem.severity === "critical" ? "warning" : problem.severity === "warning" ? "warning" : "neutral"}`}>{problem.severity === "critical" ? "serious" : problem.severity === "warning" ? "look at this" : "worth knowing"}</span>
                </div>
                <p>{problem.detail}</p>
                {problem.evidence.length > 0 && <ul className="problem-evidence">{problem.evidence.map((line) => <li key={line}>{line}</li>)}</ul>}
                {problem.fix
                  ? <button className="primary-button" type="button" onClick={() => startOperation({ operationId: problem.fix!.operationId, title: problem.fix!.label, parameters: problem.fix!.parameters, preview: <span>{problem.fix!.preview}</span> })}>{problem.fix.label}</button>
                  : <p className="problem-manual">{problem.manual}</p>}
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="repair-readiness repair-prereq-header">
        <div><span className="eyebrow">Prerequisites</span><strong>{loading ? "Checking..." : `${ready} of ${checks.length} ready`}</strong><p>The tools BoxPilot needs installed. Each is checked on its own, so one failure does not hide the rest.</p></div>
      </section>

      {error && <div className="auth-error" role="alert">{error}</div>}
      {operationDialog}
      {recoveryError && <div className="notice warning-notice" role="status"><strong>Recovery kit unavailable</strong><span>{recoveryError}. Prerequisite checks and durable jobs remain available.</span></div>}
      {actionError && <div className="notice warning-notice" role="status"><strong>Action Center unavailable</strong><span>{actionError}. No all-clear state is being claimed.</span></div>}

      {actionCenter && (
        <section className="panel action-center">
          <header className="panel-header">
            <div><span className="eyebrow">Not broken, not protected</span><strong>What is not covered yet</strong><span>Nothing here is failing. These are the gaps that only matter on the day something does. Checked {new Date(actionCenter.generatedAt).toLocaleString()}{actionCenter.sourceStatus === "ready" ? "" : " · some of it could not be read, so this list may be short"}</span></div>
            <div className="action-counts">{actionCenter.summary.critical > 0 && <span className="action-critical">{actionCenter.summary.critical} serious</span>}{actionCenter.summary.warning > 0 && <span className="action-warning">{actionCenter.summary.warning} to look at</span>}{actionCenter.summary.info > 0 && <span>{actionCenter.summary.info} worth knowing</span>}</div>
          </header>
          <div className="action-list">
            {actionCenter.notices.map((item) => (
              <article className={`action-card action-${item.severity}`} key={item.id}>
                <div className="action-card-heading"><div><span>{item.category}</span><strong>{item.title}</strong></div><span className={`status-pill status-${item.severity === "critical" || item.severity === "warning" ? "warning" : "neutral"}`}>{item.severity}</span></div>
                <p>{item.summary}</p>
                <div className="action-evidence"><strong>What was seen</strong>{item.evidence.map((evidence) => <span key={evidence}>{evidence}</span>)}</div>
                <ol>{item.recommendation.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                <footer><span>Take me to it</span><button className="secondary-button" type="button" onClick={() => onNavigate(item.recommendation.view)}>{item.recommendation.title}</button></footer>
              </article>
            ))}
          </div>
        </section>
      )}

      {recoveryKit && (
        <section className="panel recovery-kit">
          <header className="panel-header">
            <div><span className="eyebrow">If you had to rebuild this server</span><strong>What you would need, and what you have</strong><span>Checked {new Date(recoveryKit.generatedAt).toLocaleString()} · BoxPilot {recoveryKit.product.version} · contains no passwords or keys, so it is safe to keep a copy off the box</span></div>
            <span className={`status-pill status-${recoveryKit.summary.actionRequired > 0 ? "warning" : "neutral"}`}>{recoveryKit.summary.actionRequired > 0 ? `${recoveryKit.summary.actionRequired} to sort out` : recoveryKit.summary.operatorChecks > 0 ? `${recoveryKit.summary.operatorChecks} to check` : "ready"}</span>
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
          <footer className="recovery-actions"><button className="secondary-button" type="button" onClick={() => downloadRecoveryKit("markdown")}>Download the rebuild steps</button><button className="secondary-button" type="button" onClick={() => downloadRecoveryKit("json")}>Download the raw data</button></footer>
        </section>
      )}

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
          <h3>{awaitingApproval ? awaitingApproval.title : "Can BoxPilot still do root work?"}</h3>
          <p>{awaitingApproval ? "Check what this job will do, then approve it." : "Asks the part of BoxPilot that runs as root to answer. If it does not, nothing that changes this server will work. Changes nothing itself."}</p>
          {awaitingApproval && <p className="job-recovery"><strong>{awaitingApproval.risk} risk:</strong> {awaitingApproval.recovery?.reason ?? "Follow the recorded recovery instructions if verification fails."}</p>}
          {!awaitingApproval ? (
            <>
              <button className="primary-button" type="button" onClick={() => void runCanary()} disabled={pending}>{pending ? "Checking..." : "Check it"}</button>
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
        <header className="panel-header"><div><strong>Recent jobs</strong><span>Everything BoxPilot has run, with each step it took. Kept across restarts.</span></div></header>
        {jobs.length === 0 ? <div className="log-empty">No jobs yet.</div> : jobs.map((job) => (
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
