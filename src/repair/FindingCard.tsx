import { useId, type ReactNode } from "react";
import { JobLogView } from "../JobLogView";
import { Button, StatusChip, type Status } from "../ui";
import { mayStart } from "../ui/operationRisk";
import { cx } from "../ui/types";
import { tierOf, type FixRun } from "./useRepairFixes";
import { fixesOf, type Finding, type RepairFix, type Severity } from "./types";

/*
 * One finding on Repair (M35): what is wrong, the evidence, every fix with its tier on the button,
 * and - once one runs - its log streaming right here, then "Fixed" with what changed or "Still there"
 * with the job's own error and the next step.
 */

export const severityStatus: Record<Severity, Status> = { critical: "danger", warning: "warning", info: "neutral" };
export const severityWords: Record<Severity, string> = { critical: "Critical", warning: "Warning", info: "Suggestion" };

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");

/** The fix buttons, each with its tier; a role that may not start one does not see it. */
export function FixButtons({ finding, role, onFix, disabled = false, retrying = false }: { finding: Finding; role: string | null | undefined; onFix: (fix: RepairFix) => void; disabled?: boolean; retrying?: boolean }) {
  const fixes = fixesOf(finding).filter((fix) => mayStart(role, fix.operationId));
  if (!fixes.length) return null;
  return (
    <>
      {fixes.map((fix, index) => (
        <Button key={`${fix.operationId}:${fix.label}`} variant={index === 0 ? "primary" : "secondary"} risk={tierOf(fix)} disabled={disabled}
          aria-label={`${index === 0 && retrying ? `Try again: ${fix.label}` : fix.label}: ${finding.title}`} onClick={() => onFix(fix)}>
          {index === 0 && retrying ? `Try again: ${fix.label}` : fix.label}
        </Button>
      ))}
    </>
  );
}

/** Where a fix run is: queued, running with its live log, checking again, then the verdict. */
export function FixProgress({ run, title }: { run: FixRun; title: string }) {
  const log = (open: boolean, jobId: string | null) => (jobId ? (open ? <JobLogView jobId={jobId} title={run.label} /> : <details className="rp-log"><summary>Job log</summary><JobLogView jobId={jobId} title={run.label} /></details>) : null);
  if (run.phase === "queued") return <div className="rp-run" role="status"><StatusChip status="neutral">Waiting its turn</StatusChip><span>{run.label}</span></div>;
  if (run.phase === "running" || run.phase === "checking") {
    return (
      <div className="rp-run rp-run--live" role="status" aria-label={`${run.label} for ${title}`}>
        <div className="rp-run__head"><StatusChip status="unknown">{run.phase === "running" ? "Running" : "Checking again"}</StatusChip><span>{run.phase === "running" ? `${run.label}: the log below is live.` : "Finished; reading the server again to see whether it is fixed."}</span></div>
        {log(true, run.jobId)}
      </div>
    );
  }
  if (run.phase === "fixed") {
    return (
      <div className="rp-run rp-run--fixed" role="status">
        <div className="rp-run__head"><StatusChip status="good">Fixed</StatusChip><span>{run.changed}</span></div>
        {log(false, run.jobId)}
      </div>
    );
  }
  if (run.phase === "scheduled") return <div className="rp-run rp-run--fixed" role="status"><div className="rp-run__head"><StatusChip status="good">Scheduled</StatusChip><span>{run.message}</span></div></div>;
  return (
    <div className="rp-run rp-run--still" role="alert">
      <div className="rp-run__head"><StatusChip status="danger">Still there</StatusChip><span>{run.error ?? "The fix ran, but the scan still finds this."}</span></div>
      <p className="rp-run__next"><strong>Next:</strong> {run.next}</p>
      {log(true, run.jobId)}
    </div>
  );
}

export interface FindingCardProps {
  finding: Finding;
  role: string | null | undefined;
  run?: FixRun;
  onFix: (fix: RepairFix) => void;
  onDismiss?: () => void;
  onRestore?: () => void;
  /** Beside the fixes: "Reconnect it automatically next time" for a drive. */
  extra?: ReactNode;
  /** Gone from the scan since it was fixed here: shown once, as fixed. */
  gone?: boolean;
}

export function FindingCard({ finding, role, run, onFix, onDismiss, onRestore, extra, gone = false }: FindingCardProps) {
  const headingId = useId();
  const running = run && (run.phase === "queued" || run.phase === "running" || run.phase === "checking");
  const attempt = finding.lastAttempt ?? null;
  // A failed try not already shown by a run on this page: said on the card, and the fix says "Try again".
  const failedBefore = !run && attempt?.state === "failed";
  const canAct = role === "owner" || role === "operator";
  const hasFixes = fixesOf(finding).some((fix) => mayStart(role, fix.operationId));
  return (
    <article className={cx("rp-finding", gone && "rp-finding--gone")} data-severity={finding.severity} aria-labelledby={headingId}>
      <header className="rp-finding__head">
        <StatusChip status={severityStatus[finding.severity]}>{severityWords[finding.severity]}</StatusChip>
        <h3 id={headingId}>{finding.title}</h3>
      </header>
      {!gone && <p className="rp-finding__detail">{finding.detail}</p>}
      {finding.returned && !gone && (
        <p className="rp-finding__note">{finding.returned.why === "critical" ? "Dismissed, but it is critical, so it stays until it is fixed." : "Back: it changed since it was dismissed"}{finding.returned.reason ? <> (“{finding.returned.reason}”, {when(finding.returned.at)})</> : null}.</p>
      )}
      {finding.dismissal && (
        <p className="rp-finding__note">Dismissed {when(finding.dismissal.at)}: “{finding.dismissal.reason}”. It comes back by itself if it changes.</p>
      )}
      {failedBefore && attempt && (
        <p className="rp-finding__note rp-finding__note--failed"><strong>Last try failed</strong> ({attempt.title}, {when(attempt.at)}): {attempt.error ?? "no error was recorded"}</p>
      )}
      {!gone && finding.evidence.length > 0 && (
        <details className="rp-evidence"><summary>Evidence</summary><ul>{finding.evidence.map((line) => <li key={line}>{line}</li>)}</ul></details>
      )}
      {!gone && (hasFixes || extra || (onDismiss && canAct && finding.severity !== "critical") || onRestore) && (
        <div className="rp-finding__actions">
          {!finding.dismissal && <FixButtons finding={finding} role={role} onFix={onFix} disabled={Boolean(running)} retrying={failedBefore} />}
          {extra}
          {onDismiss && canAct && finding.severity !== "critical" && !finding.dismissal && <Button variant="ghost" className="rp-dismiss" disabled={Boolean(running)} onClick={onDismiss} aria-label={`Dismiss: ${finding.title}`}>Dismiss</Button>}
          {onRestore && canAct && finding.dismissal && <Button variant="ghost" onClick={onRestore} aria-label={`Bring back: ${finding.title}`}>Bring back</Button>}
        </div>
      )}
      {finding.manual && !gone && <p className="rp-finding__manual"><strong>{hasFixes ? "If that does not do it:" : "What to do:"}</strong> {finding.manual}</p>}
      {!hasFixes && !finding.manual && !gone && canAct && <p className="rp-finding__manual">Your role cannot start this fix; the owner can.</p>}
      {run && <FixProgress run={run} title={finding.title} />}
    </article>
  );
}
