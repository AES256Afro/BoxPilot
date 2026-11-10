import { useState } from "react";
import { dismissedFailure, ranAgain } from "./jobStatus";
import { jobTimeout, mayStillBeRunning } from "./JobTimeout";
import { adviseRetry } from "./retryAdvice";
import { readJson } from "./http";
import { cancelJob, type Job } from "./operations";
import { Button, Notice, type RiskTier } from "./ui";
import "./shell/jobs.css";

const tierOf = (risk: string): RiskTier => (risk === "low" || risk === "medium" ? risk : "high");

/**
 * Whether "Try again" is offered on a failed job: Home's rule (src/home/needs.ts), so the two never
 * disagree. The same operation with the same parameters, staged again through the approval dialog
 * at its own tier. Not for a job whose parameters held a secret (the record keeps a placeholder, and
 * a run with the placeholder is not the same run), one that may still be running on the server (a
 * second copy beside the first), or one whose error names a fix somewhere else (it would fail the
 * same way). A run that ran out of time and can have more is offered that in its log instead.
 */
export function mayTryAgain(job: Job, now: number = Date.now()): boolean {
  if (job.state !== "failed" || !job.type.startsWith("op:") || dismissedFailure(job) || ranAgain(job)) return false;
  if (jobTimeout(job)?.moreTimeMs) return false;
  if (JSON.stringify(job.parameters ?? {}).includes("[secret]")) return false;
  if (mayStillBeRunning(job, now)) return false;
  return adviseRetry(job.error).retry;
}

/** Marks a failure dismissed: it stays in Activity, and Home and Ops stop asking about it. */
export const dismissJob = (jobId: string, csrfToken: string) => fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/dismiss`, { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } }).then((response) => readJson(response));

/**
 * What can be done with a job from Activity (M36): one waiting for approval can be reviewed and
 * approved - through the ordinary dialog, at its own tier - or cancelled; a failure can be tried
 * again where that can work, or dismissed, so Home and Ops stop asking about it while Activity keeps
 * it. A viewer only looks.
 */
export function JobActions({ job, role, csrfToken, onReview, onRetry }: { job: Job; role: string; csrfToken: string; onReview: (job: Job) => void; /** Stages the same operation again, through the approval dialog. */ onRetry?: (job: Job) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!csrfToken || role === "viewer") return null;
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setProblem(null);
    try { await work(); } catch (error) { setProblem(error instanceof Error ? error.message : "That did not work"); } finally { setBusy(false); }
  };
  const failure = problem && <Notice tone="danger" live className="jobs-actions__problem">{problem}</Notice>;
  if (job.state === "awaiting_approval") {
    return (
      <div className="jobs-actions">
        <Button risk={tierOf(job.risk)} variant="primary" disabled={busy} onClick={() => onReview(job)}>Review and approve</Button>
        <Button variant="ghost" busy={busy} onClick={() => void run(() => cancelJob(job.id, csrfToken))}>Cancel it</Button>
        {failure}
      </div>
    );
  }
  if (job.state === "failed" && !dismissedFailure(job) && !ranAgain(job)) {
    return (
      <div className="jobs-actions">
        {onRetry && mayTryAgain(job) && <Button risk={tierOf(job.risk)} disabled={busy} onClick={() => onRetry(job)}>Try again</Button>}
        <Button variant="ghost" busy={busy} onClick={() => void run(() => dismissJob(job.id, csrfToken))}>Dismiss</Button>
        <span className="jobs-actions__note">It stays here; Home and Ops stop asking about it.</span>
        {failure}
      </div>
    );
  }
  return null;
}
