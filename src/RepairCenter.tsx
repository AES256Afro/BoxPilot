import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, errorWords, isNetworkError, readJson } from "./http";
import RuntimeHealth from "./RuntimeHealth";
import PackageRecovery from "./PackageRecovery";
import ControllerDoctor from "./repair/ControllerDoctor";
import ServerRunbook from "./repair/ServerRunbook";
import { ApproveDialog, useOperation } from "./shell/ApproveDialog";
import { onPageRefresh } from "./shell/refresh";
import { openActivity } from "./activityEvents";
import { JobActions } from "./JobActions";
import { useAutoReconnect } from "./AutoReconnect";
import { inspectOperation, type Job as ActivityJob } from "./operations";
import { stateWords, stepWords } from "./JobLogView";
import { jobStatus } from "./jobStatus";
import { countOf, type ViewName } from "./data";
import { Button, Field, Notice, PageHeader, Panel, RiskTag, SecretInput, StatusChip, Table, TextInput, type RiskTier, type Status, type TableColumn } from "./ui";
import { mayStart, riskOf, type KnownOperation } from "./ui/operationRisk";
import { DriveAutoReconnect } from "./repair/DriveAutoReconnect";
import { FindingCard, severityStatus } from "./repair/FindingCard";
import { fixesOf, scanFrom, type Finding, type RepairScan, type Severity } from "./repair/types";
import { tierOf, useRepairFixes, type BatchEntry } from "./repair/useRepairFixes";
import "./repair/repair.css";

/*
 * Repair (M35, "Repair that fixes"): what is wrong on this server, worst first, each with the fix
 * that fixes it. A fix runs through the approval dialog at its own tier, its log streams in the
 * finding's card, and the finding is checked again when it ends: "Fixed", with what changed, or
 * "Still there", with the job's own error and the next step. The low-risk ones can be run in one go,
 * a finding can be set aside with a reason, and a set-aside one comes back when it changes.
 *
 * The page is Ops' Command Center console (ADR-004, M33.7), built from src/ui alone: the verdict
 * first (the kit's PageHeader, its name in the bar, since M33.14), then console panels with small-capital titles, mono figures and a tier on every button.
 * Below the findings are the checks that are not findings - prerequisites, the approval desk, the
 * helper, BoxPilot's own resources, installation and packages, protection gaps, the rebuild
 * checklist, the runbook and Activity. Its styles are beside it, in src/repair/repair.css.
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
  low: { label: "Low risk", description: "One click." },
  medium: { label: "Medium risk", description: "Confirm to run. Read what it will do first." },
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
const recoveryStatus: Record<RecoveryKit["checks"][number]["state"], Status> = { verified: "good", "action-required": "warning", "operator-check": "neutral", "not-applicable": "neutral", unavailable: "unknown" };
const tierWord = (risk: string): RiskTier => (risk === "low" || risk === "medium" || risk === "high" ? risk : "high");

/** The finding the scan reports when BoxPilot's admin service is not answering (M89): the page's verdict, not one card among many. */
const adminServiceFindingId = "helper.not-answering";
/**
 * The scan's checks that read through the admin service (server/remediations-scan.mjs): every one
 * of them unread is the admin service not answering, or near enough to ask it (canary.verify).
 * The rest are an operator's reads, which a viewer's scan does not make.
 */
const helperChecks = ["Applications", "App backups"];
const operatorHelperChecks = ["File sharing", "USB history", "Unclean unmounts", "Drive filesystems", "Signed releases"];
const noParameters: Record<string, unknown> = {};

/**
 * What the admin service said when asked directly, for the scan it was asked after. "silent" is only
 * the service itself not answering (a helper_* code, or no reply at all); any other refusal (a session
 * that ended, too many requests) is "failed": said in its own words, and no verdict on the service.
 */
interface ServiceProbe { scan: number; state: "asking" | "answered" | "silent" | "failed"; words: string }

/** Whether a failed direct ask means the admin service is not answering, rather than some other refusal. */
function probeSilent(failure: unknown): boolean {
  if (isNetworkError(failure)) return true;
  return failure instanceof ApiError && typeof failure.code === "string" && failure.code.startsWith("helper_");
}

export default function RepairCenter({ csrfToken, role = "owner", onNavigate = () => undefined }: { csrfToken: string; role?: string; onNavigate?: (view: ViewName, options?: { tab?: string }) => void }) {
  const [checks, setChecks] = useState<Prerequisite[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [recoveryKit, setRecoveryKit] = useState<RecoveryKit | null>(null);
  const [actionCenter, setActionCenter] = useState<ActionCenter | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Which panel a failed click came from, so its error is said there: a wrong approval password or a
  // helper that did not answer used to be said at the top of a long page, out of sight of the button.
  const [errorAt, setErrorAt] = useState<"page" | "prerequisites" | "desk">("page");
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
  // Counts scans read, so the admin service is asked once per scan that could not read through it.
  const [scanCount, setScanCount] = useState(0);
  const [probe, setProbe] = useState<ServiceProbe | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  // A job from the Activity panel being approved, or staged again, through the ordinary dialog.
  const [reviewing, setReviewing] = useState<ActivityJob | null>(null);
  const [again, setAgain] = useState<ActivityJob | null>(null);

  /** The problem scan alone: what a fix reads again when it ends. */
  const loadScan = useCallback(async (): Promise<RepairScan | null> => {
    try {
      const parsed = scanFrom(await readJson(await fetch("/api/v1/remediations?fresh=1")));
      setScan(parsed);
      setScanCount((count) => count + 1);
      setScanError(parsed.sourceStatus === "partial" ? `Could not check: ${parsed.unavailableChecks.join(", ") || "some parts of this server"}. Other findings are shown below.` : null);
      return parsed;
    } catch (scanFailure) {
      // A problem sweep that cannot run must not take the page down with it, nor pass for a clean one.
      setScan(null);
      setScanError(errorWords(scanFailure, "The problem scan could not finish."));
      return null;
    }
  }, []);

  /**
   * Everything read again. `quiet` is the read a job ending asks for (src/shell/refresh.ts): no busy
   * button, and nothing shown is cleared first, so a notice does not flicker off and back on; each
   * part's words change only when that part reads differently.
   */
  const refresh = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
      setPrerequisiteError(null);
      setJobError(null);
      setRecoveryError(null);
      setActionError(null);
    }
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
      if (actionResult.status === "fulfilled" && Array.isArray(actionResult.value?.notices) && actionResult.value.summary) { setActionCenter(actionResult.value); setActionError(null); }
      else {
        setActionCenter(null);
        setActionError(actionResult.status === "rejected" ? errorWords(actionResult.reason, "Protection checks returned incomplete data.") : "Protection checks returned incomplete data.");
      }
      if (prerequisiteResult.status === "fulfilled" && Array.isArray(prerequisiteResult.value?.checks)) { setChecks(prerequisiteResult.value.checks); setPrerequisiteError(null); }
      else { setChecks([]); setPrerequisiteError(prerequisiteResult.status === "rejected" ? errorWords(prerequisiteResult.reason, "Prerequisite checks could not finish.") : "Prerequisite checks could not finish."); }
      if (jobResult.status === "fulfilled" && Array.isArray(jobResult.value?.jobs)) { setJobs(jobResult.value.jobs); setJobError(null); }
      else setJobError(jobResult.status === "rejected" ? errorWords(jobResult.reason, "Activity could not be read.") : "Activity could not be read.");
      if (recoveryResult.status === "fulfilled" && Array.isArray(recoveryResult.value?.checks) && recoveryResult.value.summary && recoveryResult.value.product && Array.isArray(recoveryResult.value.evidence?.controllerBackups)) { setRecoveryKit(recoveryResult.value); setRecoveryError(null); }
      else {
        setRecoveryKit(null);
        setRecoveryError(recoveryResult.status === "rejected" ? errorWords(recoveryResult.reason, "The rebuild checklist returned incomplete data.") : "The rebuild checklist returned incomplete data.");
      }
    } catch (requestError) {
      setErrorAt("page");
      setError(errorWords(requestError, "Unable to inspect prerequisites."));
    } finally {
      if (!quiet) setLoading(false);
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
    if (wasRunning) { setWasRunning(false); void refresh({ quiet: true }); }
  }, [running, wasRunning, refresh]);

  const awaitingApproval = useMemo(() => jobs.find((job) => job.state === "awaiting_approval"), [jobs]);

  // Read once per job waiting, not on every ten-second poll (each brings a new object for the same
  // job): a poll whose read failed swapped the typed confirmation for a password field mid-entry.
  const awaitingId = awaitingApproval?.id ?? null;
  useEffect(() => {
    if (!awaitingId) { setApprovalPolicy(null); return; }
    let cancelled = false;
    fetch(`/api/v1/jobs/${awaitingId}/approval`)
      .then((response) => (response.ok ? response.json() : null))
      .then((policy: ApprovalPolicy | null) => { if (!cancelled) setApprovalPolicy(policy); })
      .catch(() => { if (!cancelled) setApprovalPolicy(null); });
    return () => { cancelled = true; };
  }, [awaitingId]);

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

  // Something left unread (an outage, the admin service down): a job ending elsewhere, or BoxPilot
  // answering again (M89), reads the whole page again; otherwise the scan and the jobs are enough.
  const incomplete = Boolean(scanError || prerequisiteError || jobError || actionError || (role === "owner" && recoveryError) || (scan?.sourceStatus === "partial"));
  const incompleteRef = useRef(incomplete);
  incompleteRef.current = incomplete;
  useEffect(() => onPageRefresh({ asked: () => refresh(), job: () => (incompleteRef.current ? refresh({ quiet: true }) : recheck()) }), [refresh, recheck]);

  // Every check that reads through the admin service came back unread: ask it directly, once per
  // scan, and say its answer in the verdict rather than leave a button for it further down (M89).
  const ownHelperChecks = role === "owner" || role === "operator" ? [...helperChecks, ...operatorHelperChecks] : helperChecks;
  const helperUnread = Boolean(scan && scan.sourceStatus === "partial" && ownHelperChecks.every((name) => scan.unavailableChecks.includes(name)));
  const probeFor = helperUnread ? scanCount : null;
  useEffect(() => {
    if (probeFor === null) return undefined;
    let gone = false;
    inspectOperation<{ helperVersion?: string }>("canary.verify").then(
      ({ result }) => { if (!gone) setProbe({ scan: probeFor, state: "answered", words: `Asked directly, the admin service answers${result?.helperVersion ? ` (version ${result.helperVersion})` : ""}, so it was busy or slow during the scan rather than down. Check again.` }); },
      (failure: unknown) => {
        if (gone) return;
        setProbe(probeSilent(failure)
          ? { scan: probeFor, state: "silent", words: `Asked directly, it did not answer either: ${errorWords(failure, "no reply.")}` }
          : { scan: probeFor, state: "failed", words: `Asking the admin service directly did not work: ${errorWords(failure, "no reply.")}` });
      },
    );
    return () => { gone = true; };
  }, [probeFor]);
  const serviceProbe: ServiceProbe | null = probeFor === null ? null : probe?.scan === probeFor ? probe : { scan: probeFor, state: "asking", words: "Asking the admin service directly whether it answers…" };

  // One generic review flow: read the live pinned versions from the registry inspect,
  // then stage the matching install through the shared risk-tiered dialog.
  const repairDefinitions: Record<string, { inspect: string; install: KnownOperation; describe: (result: Record<string, unknown>) => { title: string; parameters: Record<string, unknown>; preview: ReactNode } }> = {
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
      setErrorAt("prerequisites");
      setError(errorWords(requestError, "Unable to inspect the prerequisite."));
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
      setCanaryResult(`Answered: the admin service is running, version ${result.helperVersion}. Nothing on the server was changed.`);
    } catch (requestError) {
      setErrorAt("desk");
      setError(errorWords(requestError, "The admin service did not answer."));
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
      setErrorAt("desk");
      setError(errorWords(requestError, "Job approval failed."));
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
      setErrorAt("desk");
      setError(errorWords(requestError, "Could not withdraw the job."));
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

  // The admin service not answering is the verdict, said once at the top with what to run (M89).
  const serviceFinding = scan?.findings.find((finding) => finding.id === adminServiceFindingId) ?? null;
  const serviceDown = Boolean(serviceFinding) || serviceProbe?.state === "silent";
  const problems = (scan?.findings ?? []).filter((finding) => finding.id !== adminServiceFindingId);
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
  // The admin service's own finding is one of the scan's criticals; the verdict names it apart.
  const otherCritical = Math.max(0, counts.critical - (serviceFinding ? 1 : 0));
  const verdict: { status: Status; label: string; sentence: string } = loading && !scan
    ? { status: "unknown", label: "Checking", sentence: "Checking this server…" }
    : serviceDown ? { status: "danger", label: "Admin service down", sentence: `BoxPilot's admin service is not answering, so most of this server could not be checked.${problems.length ? ` ${countOf(problems.length, "other thing")} to fix in what could be read${otherCritical > 0 ? `, ${otherCritical} of them critical` : ""}.` : ""}` }
    : !scan ? { status: "unknown", label: "Not checked", sentence: "The problem scan could not finish, so this page cannot say what is wrong. Check again." }
      : counts.critical ? { status: "danger", label: `${counts.critical} critical`, sentence: `${countOf(problems.length, "thing")} to fix, ${counts.critical} of them critical. Each says what is wrong and what its fix does.` }
        : counts.warning ? { status: "warning", label: `${counts.warning} to fix`, sentence: `${countOf(problems.length, "thing")} to fix. Each says what is wrong and what its fix does.` }
          : counts.info ? { status: "neutral", label: `${counts.info} to consider`, sentence: "Nothing is broken; a few things are worth doing." }
            : scanError ? { status: "unknown", label: "Not fully checked", sentence: "Nothing wrong in what could be read." }
              : { status: "good", label: "Nothing to fix", sentence: "This scan found nothing to fix." };

  const card = (finding: Finding, gone = false) => (
    <FindingCard key={finding.id} finding={finding} role={role} run={fixes.runs[finding.id]} gone={gone}
      onFix={(fix) => fixes.start(finding, fix)} onDismiss={() => fixes.dismiss({ kind: "finding", finding })} onOpen={onNavigate}
      onDismissTry={finding.lastAttempt ? () => fixes.dismiss({ kind: "job", jobId: finding.lastAttempt!.jobId, title: finding.lastAttempt!.title }) : undefined}
      onMoreTime={() => fixes.moreTime(finding)}
      extra={droppedDrive(finding) && !gone ? <DriveAutoReconnect drive={droppedDrive(finding)!} control={autoReconnect} /> : undefined} />
  );

  const dismissedColumns: Array<TableColumn<Finding>> = [
    { id: "finding", header: "Finding", className: "rp-cell-wrap rp-cell-strong", cell: (finding) => finding.title },
    { id: "reason", header: "Why", className: "rp-cell-wrap", cell: (finding) => finding.dismissal?.reason ?? "" },
    { id: "when", header: "Dismissed", numeric: true, hideOnPhone: true, cell: (finding) => (finding.dismissal?.at ? new Date(finding.dismissal.at).toLocaleDateString() : "—") },
    { id: "back", header: <span className="ui-visually-hidden">Bring back</span>, label: "", cell: (finding) => (role === "owner" || role === "operator" ? <Button variant="ghost" onClick={() => void fixes.restore(finding.id)} aria-label={`Bring back: ${finding.title}`}>Bring back</Button> : null) },
  ];

  const prerequisiteColumns: Array<TableColumn<Prerequisite>> = [
    { id: "state", header: "State", cell: (item) => <StatusChip status={prerequisiteStatus[item.status] ?? "neutral"}>{item.status}</StatusChip> },
    { id: "check", header: "Check", className: "rp-cell-wrap rp-cell-strong", cell: (item) => <>{item.name}<span className="rp-row__kicker"> · {item.group}</span></> },
    { id: "found", header: "Found", className: "rp-cell-wrap", cell: (item) => <>{item.summary}{item.repair && <span className="rp-cell-dim"> {item.repair.description}</span>}</> },
    { id: "act", header: <span className="ui-visually-hidden">Repair</span>, label: "", cell: (item) => (item.repair?.kind === "approved" && repairDefinitions[item.id] && mayStart(role, repairDefinitions[item.id].install)
      ? <Button risk={riskOf(repairDefinitions[item.id].install)} onClick={() => void reviewRepair(item.id)} disabled={pending}>Review exact repair</Button> : null) },
  ];

  const recoveryColumns: Array<TableColumn<RecoveryKit["checks"][number]>> = [
    { id: "state", header: "State", cell: (item) => <StatusChip status={recoveryStatus[item.state] ?? "neutral"}>{item.state.replaceAll("-", " ")}</StatusChip> },
    { id: "check", header: "Check", className: "rp-cell-wrap rp-cell-strong", cell: (item) => item.title },
    { id: "evidence", header: "Evidence", className: "rp-cell-wrap", cell: (item) => item.evidence },
    { id: "action", header: "To do", hideOnPhone: true, className: "rp-cell-wrap", cell: (item) => item.action },
  ];

  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const gaps = actionCenter?.summary;

  // One notice for everything this check could not read, naming the cause when it is known and
  // carrying the retry (M89, s1-05 Design #1): the same partial failure was said four to seven times.
  const ownsRebuild = role === "owner";
  const unread = [
    ...(scan?.sourceStatus === "partial" ? scan.unavailableChecks : !scan && scanError ? ["the problem scan"] : []),
    ...(prerequisiteError ? ["prerequisites"] : []),
    ...(actionError ? ["protection checks"] : []),
    ...(recoveryError && ownsRebuild ? ["the rebuild checklist"] : []),
    ...(jobError ? ["Activity"] : []),
  ];
  const reasons = [...new Set([!scan ? scanError : null, prerequisiteError, actionError, ownsRebuild ? recoveryError : null, jobError].filter((reason): reason is string => Boolean(reason)))];
  const notRead = unread.length ? <p>Not read: {unread.join(", ")}. What could be read is below.</p> : null;
  const checkAgain = <Button onClick={() => void refresh()} disabled={loading}>{loading ? "Checking…" : "Check again"}</Button>;
  const commands = serviceFinding?.commands?.length ? serviceFinding.commands : ["sudo systemctl restart boxpilot-helper", "sudo sh /opt/boxpilot/scripts/boxpilot-doctor.sh --control-plane"];
  const verdictNotice = serviceDown ? (
    <Notice tone="danger" className="rp-verdict" title="BoxPilot's admin service is not answering" action={checkAgain}>
      <p>{serviceFinding?.detail ?? "BoxPilot reads the drives, apps and shares, and makes every change, through its admin service (boxpilot-helper), so none of that can be checked or fixed from here until it is back."}</p>
      <p>On the server over SSH, run <code>{commands[0]}</code>, then check again.{commands[1] ? <> If it does not stay up, <code>{commands[1]}</code> says why.</> : null}</p>
      {/* What it said when asked directly, answered included: the scan's finding and the ask can disagree. */}
      {serviceProbe && serviceProbe.state !== "asking" && <p>{serviceProbe.words}</p>}
      {notRead}
    </Notice>
  ) : (unread.length > 0 || reasons.length > 0) && !loading ? (
    <Notice tone="warning" className="rp-verdict" title="Not everything could be checked" action={checkAgain}>
      {notRead}
      {reasons.length > 0 && <p>{reasons.join(" ")}</p>}
      {serviceProbe && <p>{serviceProbe.words}</p>}
    </Notice>
  ) : null;

  return (
    <div className="rp cc" data-density="compact">
      <PageHeader
        title="Repair"
        status={{ status: verdict.status, label: verdict.label }}
        summary={verdict.sentence}
        meta={<>critical <b>{counts.critical}</b> · to fix <b>{counts.warning}</b> · suggestions <b>{counts.info}</b> · dismissed <b>{dismissed.length}</b>{scan?.checkedAt ? <> · checked <b>{time(scan.checkedAt)}</b></> : null}</>}
        actions={<>
          {/* Every fix runs through the admin service: while it is down each would wait for it and fail. */}
          {safe.length > 0 && <Button variant="primary" risk="low" onClick={() => fixes.startBatch(safe)} disabled={fixes.busy || serviceDown}
            title={serviceDown && !fixes.busy ? "BoxPilot's admin service is not answering, so no fix can run until it is back." : undefined}>{fixes.busy ? "Fixing…" : `Fix the safe ones (${safe.length})`}</Button>}
          <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>{loading ? "Checking…" : "Check again"}</Button>
        </>}
        about="What is wrong on this server, worst first, each with the fix that fixes it. A fix runs through the approval dialog at its own tier, and the finding is checked again when it ends. Below the findings: prerequisites, the approval desk, the helper, BoxPilot's own resources, protection gaps, the rebuild checklist, the runbook and Activity."
      />

      {verdictNotice}
      {fixes.notice && <p className="rp-note" role="status">{fixes.notice}</p>}
      {error && errorAt === "page" && <p className="rp-note" data-tone="danger" role="alert">{error}</p>}
      {operationDialog}
      {fixes.dialog}
      {reviewing && (
        <ApproveDialog operationId={reviewing.type.replace(/^op:/, "")} title={reviewing.title} parameters={noParameters} existingJobId={reviewing.id} csrfToken={csrfToken}
          preview={reviewing.recovery?.reason ? <span>{reviewing.recovery.reason}</span> : undefined} onClose={() => { setReviewing(null); void refresh(); }} />
      )}
      {again && (
        <ApproveDialog operationId={again.type.replace(/^op:/, "")} title={again.title} parameters={again.parameters ?? noParameters} csrfToken={csrfToken}
          preview={<span>Runs {again.title} again with the same settings. The last run failed: {again.error ?? "no error was recorded"}</span>} onClose={() => { setAgain(null); void refresh(); }} />
      )}

      {/* Problems first, worst first: every entry here was a real failure that took a shell to explain. */}
      {(justFixed.length > 0 || inFlight.length > 0) && (
        <Panel title="Just now" label="Fixed just now" count={{ status: "good", label: String(justFixed.length + inFlight.length) }}>
          <div className="rp-list">{inFlight.map((finding) => card(finding))}{justFixed.map((finding) => card(finding, true))}</div>
        </Panel>
      )}
      {groups.map((group) => {
        const list = problems.filter((problem) => problem.severity === group.severity);
        if (!list.length) return null;
        return (
          <Panel key={group.severity} title={group.title} label={`${group.title}, ${list.length}`} count={{ status: severityStatus[group.severity], label: String(list.length) }} meta={group.summary}>
            <div className="rp-list">{list.map((finding) => card(finding))}</div>
          </Panel>
        );
      })}
      {scan && !scanError && problems.length === 0 && justFixed.length === 0 && (
        <p className="rp-note" data-tone="good"><StatusChip status="good">Problem scan complete</StatusChip><span>No repair findings.</span></p>
      )}
      {dismissed.length > 0 && (
        <Panel title="Dismissed" label={`Dismissed, ${dismissed.length}`} count={{ status: "neutral", label: String(dismissed.length) }} meta="each comes back if it changes"
          actions={<Button variant="ghost" aria-expanded={showDismissed} onClick={() => setShowDismissed((value) => !value)}>{showDismissed ? "Hide" : "Show"}</Button>}>
          {showDismissed && <Table caption="Dismissed findings" columns={dismissedColumns} rows={dismissed} rowKey={(finding) => finding.id} rowStatus={(finding) => severityStatus[finding.severity]} />}
        </Panel>
      )}

      <div className="rp-grid">
        <Panel title="Prerequisites" label="Prerequisites"
          count={!loading && !prerequisiteError && checks.length > 0 ? { status: ready === checks.length ? "good" : "warning", label: `${ready}/${checks.length}` } : undefined}
          meta={loading ? "Checking…" : prerequisiteError ? "not read" : checks.length ? `${ready} of ${checks.length} ready` : "No prerequisite checks returned"}>
          {error && errorAt === "prerequisites" && <p className="rp-note" data-tone="danger" role="alert">{error}</p>}
          {checks.length > 0 && <Table caption="Prerequisites" columns={prerequisiteColumns} rows={checks} rowKey={(item) => item.id} />}
        </Panel>

        <Panel title={awaitingApproval ? "Approval desk" : "Admin service"} label={awaitingApproval ? "Approval desk" : "Check the admin service"} className={awaitingApproval ? "rp-desk" : undefined}
          count={awaitingApproval ? { status: "warning", label: "1 waiting" } : undefined}
          meta={awaitingApproval ? undefined : "connection and logging"}>
          <div className="rp-body">
            {error && errorAt === "desk" && <p className="rp-note" data-tone="danger" role="alert">{error}</p>}
            {awaitingApproval ? (
              <>
                <p className="rp-row__title">{awaitingApproval.title}</p>
                <p className="rp-row__text"><RiskTag risk={tierWord(awaitingApproval.risk)} /> {awaitingApproval.recovery?.reason ?? "Follow the recorded recovery instructions if verification fails."}</p>
                <dl className="rp-kv" aria-label="What this job will run">
                  <dt>operation</dt><dd>{awaitingApproval.type.replace(/^op:/, "")}</dd>
                  {Object.keys(awaitingApproval.parameters ?? {}).length > 0
                    ? Object.entries(awaitingApproval.parameters ?? {}).map(([name, value]) => <Fragment key={name}><dt>{name}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></Fragment>)
                    : <><dt>parameters</dt><dd>none</dd></>}
                </dl>
                {(() => {
                  const tier = approvalPolicy?.tier ?? "high";
                  const passwordRequired = approvalPolicy ? approvalPolicy.passwordRequired : true;
                  const copy = tierCopy[tier];
                  return (
                    <>
                      <p className="rp-row__text"><strong>{passwordRequired ? `${copy.label} · password required` : `${copy.label} · ${tier === "low" ? "one click" : "confirm to run"}`}</strong> {passwordRequired ? tierCopy.high.description : copy.description}{approvalPolicy?.elevated && tier === "high" ? " Your session is elevated, so no password is needed right now." : ""}</p>
                      {approvalPolicy?.confirmText && (
                        <Field label="Typed confirmation" hint={<>Type <code>{approvalPolicy.confirmText}</code> exactly as shown.</>}>
                          <TextInput mono autoComplete="off" spellCheck={false} autoCapitalize="off" value={confirmTyped} onValueChange={setConfirmTyped} />
                        </Field>
                      )}
                      {passwordRequired && (
                        <Field label="Approval password">
                          <SecretInput autoComplete="current-password" value={password} onValueChange={setPassword} revealLabel="Show" />
                        </Field>
                      )}
                      <div className="rp-finding__actions">
                        <Button variant="primary" risk={tier} onClick={() => void approve()} disabled={pending || (passwordRequired && password.length < 12) || Boolean(approvalPolicy?.confirmText && confirmTyped !== approvalPolicy.confirmText)}>{pending ? "Working…" : tier === "low" && !passwordRequired ? "Run" : "Approve and run"}</Button>
                        <Button variant="ghost" onClick={() => void withdraw()} disabled={pending}>Withdraw</Button>
                      </div>
                    </>
                  );
                })()}
              </>
            ) : (
              <>
                <p className="rp-row__text">Run this if jobs fail to start or their output is missing: it asks BoxPilot's admin service to answer and writes a small test log.</p>
                <div className="rp-finding__actions"><Button onClick={() => void runCanary()} busy={pending}>{pending ? "Checking…" : "Check the admin service"}</Button></div>
                {canaryResult && <p className="rp-note" data-tone="good" role="status">{canaryResult}</p>}
              </>
            )}
          </div>
        </Panel>
      </div>

      <div className="rp-grid rp-grid--three">
        <RuntimeHealth />
        <ControllerDoctor onOpenBackups={() => onNavigate("backups")} />
        <PackageRecovery csrfToken={csrfToken} />
      </div>

      {actionError && !actionCenter && <Panel title="Protection gaps" label="Protection gaps" meta="not read" />}
      {actionCenter && gaps && (
        <Panel title="Protection gaps" label="Protection gaps"
          count={{ status: gaps.critical ? "danger" : gaps.warning ? "warning" : gaps.total ? "neutral" : "good", label: gaps.total ? String(gaps.total) : "none" }}
          meta={`checked ${time(actionCenter.generatedAt)}${actionCenter.sourceStatus === "ready" ? "" : " · incomplete"}`}>
          {actionCenter.notices.length === 0 ? <p className="rp-quiet">Backups and recovery cover what they should.</p> : (
            <div className="rp-rows">
              {actionCenter.notices.map((item) => (
                <article className="rp-row" key={item.id} data-status={item.severity === "critical" ? "danger" : item.severity === "warning" ? "warning" : "neutral"}>
                  <div className="rp-row__body">
                    <span className="rp-row__kicker">{item.category}</span>
                    <strong className="rp-row__title">{item.title}</strong>
                    <p className="rp-row__text">{item.summary}</p>
                    <details className="rp-more"><summary>Evidence and steps</summary><ul>{item.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul><ol className="rp-row__text">{item.recommendation.steps.map((step) => <li key={step}>{step}</li>)}</ol></details>
                  </div>
                  <div className="rp-row__act"><Button onClick={() => onNavigate(item.recommendation.view)}>{item.recommendation.title}</Button></div>
                </article>
              ))}
            </div>
          )}
        </Panel>
      )}

      {/* The owner keeps the rebuild checklist; for anyone else it is not a failure (s1-05). */}
      {recoveryError && !recoveryKit && ownsRebuild && <Panel title="Rebuild checklist" label="Rebuild checklist" meta="not read" />}
      {recoveryKit && (
        <Panel title="Rebuild checklist" label="Rebuild checklist"
          count={{ status: recoveryKit.summary.actionRequired > 0 ? "warning" : recoveryKit.summary.operatorChecks > 0 ? "neutral" : "good", label: recoveryKit.summary.actionRequired > 0 ? `${recoveryKit.summary.actionRequired} to sort out` : recoveryKit.summary.operatorChecks > 0 ? `${recoveryKit.summary.operatorChecks} to check` : "ready" }}
          meta={`BoxPilot ${recoveryKit.product.version} · private: keep a copy on another device`}
          actions={<><Button onClick={() => downloadRecoveryKit("markdown")}>Download rebuild steps (.md)</Button><Button onClick={() => downloadRecoveryKit("json")}>Download recovery data (.json)</Button></>}>
          <div className="rp-figures">
            <span data-status="good"><b>{recoveryKit.summary.verified}</b>verified</span>
            <span data-status={recoveryKit.summary.actionRequired ? "warning" : undefined}><b>{recoveryKit.summary.actionRequired}</b>action required</span>
            <span><b>{recoveryKit.summary.operatorChecks}</b>operator checks</span>
            <span><b>{recoveryKit.summary.notApplicable}</b>not applicable</span>
            <span><b>{recoveryKit.evidence.controllerBackups.length}</b>database backups</span>
            <span><b>{recoveryKit.evidence.controllerProtections?.length ?? 0}</b>second copies</span>
            <span><b>{recoveryKit.evidence.applications?.length ?? 0}</b>apps</span>
            <span><b>{recoveryKit.evidence.vmBackups?.length ?? 0}</b>vm backups</span>
          </div>
          <details className="rp-more rp-body"><summary>{`All ${recoveryKit.checks.length} recovery checks`}</summary>
            <Table caption="Recovery checks" columns={recoveryColumns} rows={recoveryKit.checks} rowKey={(item) => item.id} />
          </details>
        </Panel>
      )}

      {/* Beside the recovery kit: the kit says whether this server could be rebuilt, the runbook
          says what it is and how to put each thing back (M34.4). */}
      <ServerRunbook />

      {/* The same words as the Activity drawer (M50): "Checked the request · done", "medium risk",
          "Awaiting approval", where this printed the server's own step names and states. */}
      <Panel title="Activity" label="Activity on this server" count={jobs.length ? { status: jobs.some((job) => job.state === "failed") ? "warning" : "neutral", label: String(jobs.length) } : undefined}
        meta={jobError ? (jobs.length ? "not read · from the last check" : "not read") : "every job, with its steps"}>
        {jobs.length === 0 ? <p className="rp-quiet">{jobError ? "Activity is unavailable." : "Nothing has run yet."} Every change you approve appears here with its steps.</p> : (
          <div className="rp-rows">
            {jobs.map((job) => (
              <details className="rp-job" key={job.id} open={job === jobs[0]} data-status={job.state === "completed" ? "good" : job.state === "failed" ? "danger" : "neutral"}>
                <summary>
                  <strong>{job.title}</strong>
                  <span className="rp-job__meta">{/^(low|medium|high)$/.test(job.risk) ? `${job.risk} risk · ` : ""}{countOf(job.steps.length, "step")}{job.createdAt ? ` · ${new Date(job.createdAt).toLocaleString()}` : ""}</span>
                  <StatusChip status={job.state === "completed" ? "good" : job.state === "failed" ? "danger" : "neutral"}>{jobStatus(job as unknown as ActivityJob).label}</StatusChip>
                </summary>
                {job.steps.length > 0 && <ol className="rp-job__steps">{job.steps.map((step, index) => <li key={`${step.createdAt}-${index}`}><span>{stateWords(step.state)}</span><strong>{stepWords(step.name)}</strong><p>{step.detail}</p></li>)}</ol>}
                {job.error && <p className="rp-finding__note rp-finding__note--failed">{job.error}</p>}
                {job.recovery?.manual && <p className="rp-finding__manual"><strong>Recovery:</strong> {job.recovery.manual}</p>}
                {/* What Activity offers for it (M89): approve, cancel, try again, dismiss; and its output there. */}
                <div className="rp-job__actions">
                  <JobActions job={job as unknown as ActivityJob} role={role} csrfToken={csrfToken} onReview={setReviewing} onRetry={setAgain} />
                  <Button variant="ghost" onClick={() => openActivity(job.id)}>Open in Activity</Button>
                </div>
              </details>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
