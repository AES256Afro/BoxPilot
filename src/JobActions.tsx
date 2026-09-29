import { useState } from "react";
import { dismissedFailure, ranAgain } from "./jobStatus";
import { readJson } from "./http";
import { cancelJob, type Job } from "./operations";
import { Button, type RiskTier } from "./ui";

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
  if (job.state === "awaiting_approval") {
    return (
      <div className="activity-actions">
        <Button risk={tierOf(job.risk)} variant="primary" disabled={busy} onClick={() => onReview(job)}>Review and approve</Button>
        <Button variant="ghost" busy={busy} onClick={() => void run(() => cancelJob(job.id, csrfToken))}>Cancel it</Button>
        {problem && <p className="auth-error" role="alert">{problem}</p>}
      </div>
    );
  }
  if (job.state === "failed" && !dismissedFailure(job) && !ranAgain(job)) {
    return (
      <div className="activity-actions">
        <Button variant="ghost" busy={busy} onClick={() => void run(() => fetch(`/api/v1/jobs/${encodeURIComponent(job.id)}/dismiss`, { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } }).then((response) => readJson(response)))}>Dismiss</Button>
        <span className="muted">It stays here; Home and Ops stop asking about it.</span>
        {problem && <p className="auth-error" role="alert">{problem}</p>}
      </div>
    );
  }
  return null;
}
