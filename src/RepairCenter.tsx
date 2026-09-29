import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { readJson } from "./http";
import RuntimeHealth from "./RuntimeHealth";
import PackageRecovery from "./PackageRecovery";
import ControllerDoctor from "./ControllerDoctor";
import ServerRunbook from "./ServerRunbook";
import { useOperation } from "./ApproveDialog";
import { AutoReconnectToggle, useAutoReconnect } from "./AutoReconnect";
import { inspectOperation } from "./operations";
import { countOf, type ViewName } from "./data";
import { Button, Card, Section, StatusChip, Table, type Status, type TableColumn } from "./ui";
import { mayStart, riskOf } from "./ui/operationRisk";
import { FindingCard, severityStatus } from "./repair/FindingCard";
import { fixesOf, scanFrom, type Finding, type RepairScan, type Severity } from "./repair/types";
import { tierOf, useRepairFixes, type BatchEntry } from "./repair/useRepairFixes";

/*
 * Repair (M35, "Repair that fixes"): what is wrong on this server, worst first, each with the fix
 * that fixes it. A fix runs through the approval dialog at its own tier, its log streams in the
 * finding's card, and the finding is checked again when it ends: "Fixed", with what changed, or
 * "Still there", with the job's own error and the next step. The low-risk ones can be run in one go,
 * a finding can be set aside with a reason, and a set-aside one comes back when it changes.
 *
 * The page wears Ops' Command Center look (ADR-004, M33.7): hairline panels, small capitals, status
 * first. Below the findings are the checks that are not findings - the root helper, packages, the
 * prerequisites, the approval desk, protection gaps, the rebuild checklist and Activity.
 */

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
  parameters?: Record<string, unknown>;
  // Optional in truth, not just in principle: a job whose recovery block was missing took the
  // whole Repair Center down, because the type said it could not happen.
  recovery?: { reason?: string; manual?: string };
  createdAt?: string;
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
}

interface ActionCenter {
  generatedAt: string;
  sourceStatus: "ready" | "unavailable";
  summary: { critical: number; warning: number; info: number; total: number };
  notices: ActionNotice[];
}

/** The managed drive a finding is about when that drive dropped or went read-only: what can be reconnected automatically. */
function droppedDrive(problem: Finding): string | null {
  const drive = problem.id.match(/^(?:stale-mount|read-only-remount):([a-z0-9][a-z0-9-]{0,31})$/)?.[1] ?? null;
  return fixesOf(problem).some((fix) => fix.operationId === "storage.remount") ? drive : null;
}

const groups: Array<{ severity: Severity; title: string; summary: string }> = [
  { severity: "critical", title: "Critical", summary: "Something is failing now: fix these first." },
  { severity: "warning", title: "To fix", summary: "Working, but wrong in a way that will bite." },
  { severity: "info", title: "Suggestions", summary: "Worth doing; nothing is broken." },
];

const prerequisiteStatus: Record<Prerequisite["status"], Status> = { ready: "good", repairable: "warning", missing: "warning", conflict: "danger" };

export default function RepairCenter({ csrfToken, role = "owner", onNavigate = () => undefined }: { csrfToken: string; role?: string; onNavigate?: (view: ViewName) => void }) {
  const [checks, setChecks] = useState<Prerequisite[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [recoveryKit, setRecoveryKit] = useState<RecoveryKit | null>(null);
  const [actionCenter, setActionCenter] = useState<ActionCenter | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prerequisiteError, setPrerequisiteError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy | null>(null);
  const [pending, setPending] = useState(false);
  const [canaryResult, setCanaryResult] = useState<string | null>(null);
  const [scan, setScan] = useState<RepairScan | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  /** The problem scan alone: what a fix reads again when it ends. */
  const loadScan = useCallback(async (): Promise<RepairScan | null> => {
    try {
      const parsed = scanFrom(await readJson(await fetch("/api/v1/remediations")));
      setScan(parsed);
      setScanError(parsed.sourceStatus === "partial" ? `Could not check: ${parsed.unavailableChecks.join(", ") || "some parts of this server"}. Other findings are shown below.` : null);
      return parsed;
    } catch {
      // A problem sweep that cannot run must not take the page down with it, nor pass for a clean one.
      setScan(null);
      setScanError("The problem scan could not finish. Check again to retry.");
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPrerequisiteError(null);
    setJobError(null);
    setRecoveryError(null);
    setActionError(null);
    try {
      // The fetches must start before allSettled sees them, or they run one after another and a
      // dropped connection escapes to the outer catch instead of failing just its own collector.
      const [prerequisiteResult, jobResult, recoveryResult, actionResult] = await Promise.allSettled([
        fetch("/api/v1/operations/prerequisites").then((response) => readJson<{ checks: Prerequisite[] }>(response)),
        fetch("/api/v1/jobs?limit=25").then((response) => readJson<{ jobs: Job[] }>(response)),
        fetch("/api/v1/operations/recovery-kit").then((response) => readJson<RecoveryKit>(response)),
        fetch("/api/v1/operations/action-center").then((response) => readJson<ActionCenter>(response)),
        loadScan(),
      ]);
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
  }, [loadScan]);

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

  // A reconnect done here by hand lifts an automatic reconnect's hold, so both are read again after it.
  const autoReconnect = useAutoReconnect(csrfToken);
  const { start: startOperation, dialog: operationDialog } = useOperation(csrfToken, () => { void refresh(); void autoReconnect.refresh(); });
  // A finding's fix: approved in the same dialog, followed here, and checked again when it ends.
  const recheck = useCallback(async () => {
    const [fresh] = await Promise.all([loadScan(), autoReconnect.refresh()]);
    void fetch("/api/v1/jobs?limit=25").then((response) => readJson<{ jobs: Job[] }>(response)).then((body) => { if (Array.isArray(body?.jobs)) setJobs(body.jobs); }).catch(() => undefined);
    return fresh;
  }, [loadScan, autoReconnect]);
  const fixes = useRepairFixes({ csrfToken, recheck });

  // One generic review flow: read the live pinned versions from the registry inspect,
  // then stage the matching install through the shared risk-tiered dialog.
  const repairDefinitions: Record<string, { inspect: string; install: string; describe: (result: Record<string, unknown>) => { title: string; parameters: Record<string, unknown>; preview: ReactNode } }> = {
    "storage.drive-tools": {
      inspect: "prerequisite.drive-tools.inspect", install: "prerequisite.drive-tools.install",
      describe: (result) => {
        const packages = (result.candidatePackages ?? {}) as Record<string, string>;
        return { title: "Install the drive check tools", parameters: { expectedPackages: packages }, preview: <span>Installs <code>{Object.entries(packages).map(([name, version]) => `${name} ${version}`).join(", ")}</code> from the configured Ubuntu source, then confirms smartctl and fsck.exfat answer and reads every disk's SMART health again. The job re-checks the pinned versions before it runs. No drive is touched.</span> };
      },
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

  // The desk offers whatever job is waiting, which may have been staged on another page or in
  // another tab. Withdrawing it is as available as approving it.
  const withdraw = async () => {
    if (!awaitingApproval) return;
    setPending(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/jobs/${encodeURIComponent(awaitingApproval.id)}`, { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } }));
      setPassword("");
      setConfirmTyped("");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not withdraw the job");
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

  const problems = scan?.findings ?? [];
  const present = new Set(problems.map((problem) => problem.id));
  // Fixed from this page and gone from the scan since: shown once more, as fixed, above the rest.
  const justFixed = Object.values(fixes.remembered).filter((finding) => !present.has(finding.id) && fixes.runs[finding.id] && ["fixed", "scheduled"].includes(fixes.runs[finding.id].phase));
  // Still running, but gone from a scan read meanwhile (another tab's fix, a refresh): keep its card.
  const inFlight = Object.values(fixes.remembered).filter((finding) => !present.has(finding.id) && fixes.runs[finding.id] && ["queued", "running", "checking", "still"].includes(fixes.runs[finding.id].phase));
  const dismissed = scan?.dismissed ?? [];
  const busyRun = (id: string) => ["queued", "running", "checking"].includes(fixes.runs[id]?.phase ?? "");
  // "Fix the safe ones": each finding's first fix, when it is low risk, this role may start it, and it is not already running.
  const safe: BatchEntry[] = problems.flatMap((finding) => {
    const fix = fixesOf(finding).find((entry) => mayStart(role, entry.operationId));
    return fix && fix.kind !== "schedule" && tierOf(fix) === "low" && !busyRun(finding.id) ? [{ finding, fix }] : [];
  });
  const counts = scan?.counts ?? { critical: 0, warning: 0, info: 0 };
  const verdict: { status: Status; label: string; sentence: string } = loading && !scan
    ? { status: "unknown", label: "Checking", sentence: "Checking this server…" }
    : !scan ? { status: "unknown", label: "Not checked", sentence: "The problem scan could not finish, so this page cannot say what is wrong. Check again." }
      : counts.critical ? { status: "danger", label: `${counts.critical} critical`, sentence: `${countOf(problems.length, "thing")} to fix, ${counts.critical} of them critical. Each says what is wrong and what its fix does.` }
        : counts.warning ? { status: "warning", label: `${counts.warning} to fix`, sentence: `${countOf(problems.length, "thing")} to fix. Each says what is wrong and what its fix does.` }
          : counts.info ? { status: "neutral", label: `${counts.info} to consider`, sentence: "Nothing is broken; a few things are worth doing." }
            : scanError ? { status: "unknown", label: "Not fully checked", sentence: "Nothing wrong in what could be read." }
              : { status: "good", label: "Nothing to fix", sentence: "This scan found nothing to fix." };

  const card = (finding: Finding, gone = false) => (
    <FindingCard key={finding.id} finding={finding} role={role} run={fixes.runs[finding.id]} gone={gone}
      onFix={(fix) => fixes.start(finding, fix)} onDismiss={() => fixes.dismiss({ kind: "finding", finding })}
      extra={droppedDrive(finding) && !gone ? <AutoReconnectToggle drive={droppedDrive(finding)!} control={autoReconnect} /> : undefined} />
  );

  const dismissedColumns: Array<TableColumn<Finding>> = [
    { id: "finding", header: "Finding", cell: (finding) => <span className="rp-wrap">{finding.title}</span> },
    { id: "reason", header: "Why", cell: (finding) => <span className="rp-wrap">{finding.dismissal?.reason ?? ""}</span> },
    { id: "when", header: "Dismissed", numeric: true, hideOnPhone: true, cell: (finding) => (finding.dismissal?.at ? new Date(finding.dismissal.at).toLocaleDateString() : "—") },
    { id: "back", header: <span className="ui-visually-hidden">Bring back</span>, label: "", cell: (finding) => (role === "owner" || role === "operator" ? <Button variant="ghost" onClick={() => void fixes.restore(finding.id)} aria-label={`Bring back: ${finding.title}`}>Bring back</Button> : null) },
  ];

  return (
    <div className="repair-page rp">
      <div className="rp-status">
        <StatusChip status={verdict.status}>{verdict.label}</StatusChip>
        <p>{verdict.sentence}</p>
        <div className="rp-status__actions">
          {safe.length > 0 && <Button risk="low" onClick={() => fixes.startBatch(safe)} disabled={fixes.busy}>{fixes.busy ? "Fixing…" : `Fix the safe ones (${safe.length})`}</Button>}
          <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>{loading ? "Checking..." : "Check again"}</Button>
        </div>
      </div>

      {(scanError || prerequisiteError || jobError) && !loading && <p className="rp-status__incomplete" role="status"><StatusChip status="unknown">Checks incomplete</StatusChip><span>Some checks could not finish. Review what could be read and check again for the rest.</span></p>}
      {scanError && <div className="notice warning-notice" role="status"><strong>Problem scan incomplete</strong><span>{scanError}</span></div>}
      {fixes.notice && <div className="notice" role="status">{fixes.notice}</div>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      {operationDialog}
      {fixes.dialog}

      {/* Problems first: this page used to open with a prerequisite inventory, which is the least
          urgent thing on it. Every entry here was a real failure that took a shell to explain. */}
      {(justFixed.length > 0 || inFlight.length > 0) && (
        <section className="rp-panel" aria-label="Fixed just now">
          <header className="rp-panel__head"><h2>Just now <span className="cc-count ui-marked" data-status="good"><span className="ui-mark" aria-hidden="true" />{justFixed.length + inFlight.length}</span></h2></header>
          <div className="rp-list">{inFlight.map((finding) => card(finding))}{justFixed.map((finding) => card(finding, true))}</div>
        </section>
      )}
      {groups.map((group) => {
        const list = problems.filter((problem) => problem.severity === group.severity);
        if (!list.length) return null;
        return (
          <section className={`rp-panel rp-panel--${group.severity}`} key={group.severity} aria-label={`${group.title}, ${list.length}`}>
            <header className="rp-panel__head">
              <h2>{group.title} <span className="cc-count ui-marked" data-status={severityStatus[group.severity]}><span className="ui-mark" aria-hidden="true" />{list.length}</span></h2>
              <p className="rp-panel__meta">{group.summary}</p>
            </header>
            <div className="rp-list">{list.map((finding) => card(finding))}</div>
          </section>
        );
      })}
      {scan && problems.length === 0 && justFixed.length === 0 && (
        <Card className="rp-clear"><StatusChip status={scanError ? "unknown" : "good"}>{scanError ? "Not fully checked" : "Problem scan complete"}</StatusChip><span>{scanError ? "Nothing wrong in what could be read." : "No repair findings. The checks below cover the helper, packages and prerequisites."}</span></Card>
      )}
      {dismissed.length > 0 && (
        <section className="rp-panel rp-panel--dismissed" aria-label={`Dismissed, ${dismissed.length}`}>
          <header className="rp-panel__head">
            <h2>Dismissed <span className="cc-count ui-marked" data-status="neutral"><span className="ui-mark" aria-hidden="true" />{dismissed.length}</span></h2>
            <p className="rp-panel__meta">Set aside with a reason; each comes back by itself if it changes.</p>
            <Button variant="ghost" aria-expanded={showDismissed} onClick={() => setShowDismissed((value) => !value)}>{showDismissed ? "Hide" : "Show"}</Button>
          </header>
          {showDismissed && <Table caption="Dismissed findings" columns={dismissedColumns} rows={dismissed} rowKey={(finding) => finding.id} rowStatus={(finding) => severityStatus[finding.severity]} />}
        </section>
      )}

      <RuntimeHealth />
      <ControllerDoctor onOpenBackups={() => onNavigate("backups")} />
      <PackageRecovery csrfToken={csrfToken} />

      <div className="rp-grid">
        <section className="rp-panel repair-prerequisites" aria-label="Prerequisites">
          <header className="rp-panel__head">
            <h2>Prerequisites {!loading && !prerequisiteError && checks.length > 0 && <span className="cc-count ui-marked" data-status={ready === checks.length ? "good" : "warning"}><span className="ui-mark" aria-hidden="true" />{ready}/{checks.length}</span>}</h2>
            <p className="rp-panel__meta">{loading ? "Checking..." : prerequisiteError ? "Prerequisites unavailable" : checks.length ? `${ready} of ${checks.length} ready` : "No prerequisite checks returned"}</p>
          </header>
          {prerequisiteError && <div className="notice warning-notice" role="status">{prerequisiteError}</div>}
          <div className="rp-checks">
            {checks.map((item) => (
              <article className="rp-check" key={item.id}>
                <StatusChip status={prerequisiteStatus[item.status] ?? "neutral"}>{item.status}</StatusChip>
                <div><small>{item.group}</small><strong>{item.name}</strong><p>{item.summary}</p>{item.repair && <em>{item.repair.description}</em>}</div>
                {item.repair?.kind === "approved" && repairDefinitions[item.id] && mayStart(role, repairDefinitions[item.id].install) && <Button risk={riskOf(repairDefinitions[item.id].install)} onClick={() => void reviewRepair(item.id)} disabled={pending}>Review exact repair</Button>}
              </article>
            ))}
          </div>
        </section>

        <aside className="rp-panel helper-canary" aria-label={awaitingApproval ? "Approval desk" : "Helper check"}>
          <header className="rp-panel__head"><h2>{awaitingApproval ? "Approval desk" : "Helper check"}</h2></header>
          <div className="rp-panel__body">
            <h3>{awaitingApproval ? awaitingApproval.title : "Helper connection and logging"}</h3>
            <p>{awaitingApproval ? "Check what this job will do, then approve it." : "Checks the privileged helper connection and writes a small test log. Run this if jobs fail to start or their output is missing."}</p>
            {awaitingApproval && <p className="job-recovery"><strong>{awaitingApproval.risk} risk:</strong> {awaitingApproval.recovery?.reason ?? "Follow the recorded recovery instructions if verification fails."}</p>}
            {awaitingApproval && (
              <div className="approval-parameters" aria-label="What this job will run">
                <span>Operation <code>{awaitingApproval.type.replace(/^op:/, "")}</code></span>
                {Object.keys(awaitingApproval.parameters ?? {}).length > 0
                  ? <dl>{Object.entries(awaitingApproval.parameters ?? {}).map(([name, value]) => <div key={name}><dt>{name}</dt><dd><code>{typeof value === "string" ? value : JSON.stringify(value)}</code></dd></div>)}</dl>
                  : <span className="muted">No parameters.</span>}
              </div>
            )}
            {!awaitingApproval ? (
              <>
                <Button variant="primary" onClick={() => void runCanary()} disabled={pending}>{pending ? "Checking..." : "Check helper"}</Button>
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
                      <Button variant="primary" risk={tier} onClick={() => void approve()} disabled={pending || (passwordRequired && password.length < 12) || Boolean(approvalPolicy?.confirmText && confirmTyped !== approvalPolicy.confirmText)}>{pending ? "Working..." : tier === "low" && !passwordRequired ? "Run" : "Approve and run"}</Button>
                      <Button onClick={() => void withdraw()} disabled={pending}>Withdraw</Button>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </aside>
      </div>

      {actionError && <div className="notice warning-notice" role="status"><strong>Protection checks incomplete</strong><span>{actionError}. Press Check again to retry.</span></div>}
      {actionCenter && (
        <Section className="rp-section action-center" title="Protection gaps"
          status={{ status: actionCenter.summary.critical ? "danger" : actionCenter.summary.warning ? "warning" : actionCenter.summary.total ? "neutral" : "good", label: actionCenter.summary.total ? `${actionCenter.summary.total} to look at` : "None" }}
          summary={`Backup and recovery coverage that needs attention. Checked ${new Date(actionCenter.generatedAt).toLocaleString()}${actionCenter.sourceStatus === "ready" ? "" : " · checks incomplete"}`}>
          <div className="action-list">
            {actionCenter.notices.map((item) => (
              <Card className={`action-card action-${item.severity}`} key={item.id}>
                <div className="action-card-heading"><div><span>{item.category}</span><strong>{item.title}</strong></div><StatusChip status={item.severity === "critical" ? "danger" : item.severity === "warning" ? "warning" : "neutral"}>{item.severity}</StatusChip></div>
                <p>{item.summary}</p>
                <details className="repair-details"><summary>Evidence and recommended steps</summary><div className="action-evidence">{item.evidence.map((evidence) => <span key={evidence}>{evidence}</span>)}</div><ol>{item.recommendation.steps.map((step) => <li key={step}>{step}</li>)}</ol></details>
                <footer><Button onClick={() => onNavigate(item.recommendation.view)}>{item.recommendation.title}</Button></footer>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {recoveryError && <div className="notice warning-notice" role="status"><strong>Could not build the rebuild checklist</strong><span>{recoveryError}. The rest of this page still works.</span></div>}
      {recoveryKit && (
        <Section className="rp-section recovery-kit" title="Rebuild checklist"
          status={{ status: recoveryKit.summary.actionRequired > 0 ? "warning" : recoveryKit.summary.operatorChecks > 0 ? "neutral" : "good", label: recoveryKit.summary.actionRequired > 0 ? `${recoveryKit.summary.actionRequired} to sort out` : recoveryKit.summary.operatorChecks > 0 ? `${recoveryKit.summary.operatorChecks} to check` : "ready" }}
          summary={`Checked ${new Date(recoveryKit.generatedAt).toLocaleString()} · BoxPilot ${recoveryKit.product.version} · private recovery information; keep a protected copy on another device`}
          actions={<><Button onClick={() => downloadRecoveryKit("markdown")}>Download rebuild steps (.md)</Button><Button onClick={() => downloadRecoveryKit("json")}>Download recovery data (.json)</Button></>}>
          <Card>
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
          </Card>
        </Section>
      )}

      {/* Beside the recovery kit: the kit says whether this server could be rebuilt, the runbook
          says what it is and how to put each thing back (M34.4). */}
      <ServerRunbook />

      <Section className="rp-section job-history" title="Activity on this server" summary="Everything BoxPilot has run, with each step it took. Kept across restarts.">
        {jobError && <div className="notice warning-notice" role="status">{jobError}</div>}
        {jobs.length === 0 ? <div className="log-empty">{jobError ? "Activity is unavailable." : "Nothing has run yet."} Every change you approve appears here with its steps.</div> : (
          <div className="rp-jobs">
            {jobs.map((job) => (
              <details className="job-row" key={job.id} open={job === jobs[0]}>
                <summary><div><strong>{job.title}</strong><span>{job.risk} risk · {job.steps.length} steps</span></div><StatusChip status={job.state === "completed" ? "good" : job.state === "failed" ? "danger" : "neutral"}>{job.state.replaceAll("_", " ")}</StatusChip></summary>
                <div className="job-steps">{job.steps.map((step, index) => <div key={`${step.createdAt}-${index}`}><span>{step.state}</span><strong>{step.name}</strong><p>{step.detail}</p></div>)}</div>
                {job.error && <p className="job-error">{job.error}</p>}
                {job.recovery?.manual && <p className="job-recovery"><strong>Recovery:</strong> {job.recovery.manual}</p>}
              </details>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
