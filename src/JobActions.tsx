import { useState } from "react";
import { dismissedFailure, ranAgain } from "./jobStatus";
import { readJson } from "./http";
import { cancelJob, type Job } from "./operations";
import { Button, Notice, type RiskTier } from "./ui";
import "./shell/jobs.css";

const tierOf = (risk: string): RiskTier => (risk === "low" || risk === "medium" ? risk : "high");

/**
 * What can be done with a job from Activity (M36): one waiting for approval can be reviewed and
 * approved - through the ordinary dialog, at its own tier - or cancelled; a failure can be dismissed,
 * so Home and Ops stop asking about it while Activity keeps it. A viewer only looks.
 */
export function JobActions({ job, role, csrfToken, onReview }: { job: Job; role: string; csrfToken: string; onReview: (job: Job) => void }) {
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
        <Button variant="ghost" busy={busy} onClick={() => void run(() => fetch(`/api/v1/jobs/${encodeURIComponent(job.id)}/dismiss`, { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } }).then((response) => readJson(response)))}>Dismiss</Button>
        <span className="jobs-actions__note">It stays here; Home and Ops stop asking about it.</span>
        {failure}
      </div>
    );
  }
  return null;
}
