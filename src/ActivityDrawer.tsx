import { useCallback, useEffect, useRef, useState } from "react";
import { JobLogView } from "./JobLogView";
import { ApproveDialog } from "./ApproveDialog";
import { activeJobStates, dismissedFailure, jobStatus, ranAgain } from "./jobStatus";
import { openActivityEvent } from "./activityEvents";
import { readJson } from "./http";
import { Button, type RiskTier } from "./ui";
import { useDialogFocus } from "./useDialogFocus";
import { createPortal } from "react-dom";
import { cancelJob, followJobs, type Job, type JobFeedStatus } from "./operations";

/** A retry with more time is staged from the job itself; the dialog's own parameters go unused. */
const noParameters: Record<string, unknown> = {};

/**
 * Global Activity drawer (M1.5): a topbar button with a running-job badge that opens a panel
 * listing recent jobs, updated live over /api/v1/events. Expanding a job shows its step log and
 * output — streamed while it runs, fetched once when it is finished.
 */

function timeLabel(iso?: string): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const sameDay = new Date().toDateString() === date.toDateString();
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? clock : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

function upsert(jobs: Job[], job: Job): Job[] {
  const next = jobs.some((entry) => entry.id === job.id) ? jobs.map((entry) => (entry.id === job.id ? job : entry)) : [job, ...jobs];
  return next
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 50);
}


const tierOf = (risk: string): RiskTier => (risk === "low" || risk === "medium" ? risk : "high");

/**
 * What can be done with a job from Activity (M36): one waiting for approval can be reviewed and
 * approved - through the ordinary dialog, at its own tier - or cancelled; a failure can be dismissed,
 * so Home and Ops stop asking about it while Activity keeps it. A viewer only looks.
 */
function JobActions({ job, role, csrfToken, onReview }: { job: Job; role: string; csrfToken: string; onReview: (job: Job) => void }) {
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

export function ActivityDrawer({ csrfToken = "", role = "owner" }: { csrfToken?: string; role?: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState(false);
  // The timed-out job being staged again with more time, through the ordinary approval dialog.
  const [moreTime, setMoreTime] = useState<Job | null>(null);
  // A staged job being approved from here (M36), through the same dialog at its own tier.
  const [reviewing, setReviewing] = useState<Job | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [feedStatus, setFeedStatus] = useState<JobFeedStatus>("loading");
  const [retry, setRetry] = useState(0);
  const drawerRef = useRef<HTMLElement | null>(null);
  useDialogFocus(drawerRef, open);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => followJobs({
    onSnapshot: (snapshot) => setJobs([...snapshot].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, 50)),
    onJob: (job) => setJobs((current) => upsert(current, job)),
    onStatus: setFeedStatus,
  }), [retry]);

  const runningCount = jobs.filter((job) => activeJobStates.has(job.state)).length;
  const expanded = expandedId ? jobs.find((job) => job.id === expandedId) ?? null : null;
  // Home, Ops and the notification centre open Activity at one job (M36).
  useEffect(() => {
    const onOpen = (event: Event) => {
      const jobId = (event as CustomEvent<{ jobId: string | null }>).detail?.jobId ?? null;
      setOpen(true);
      if (jobId) setExpandedId(jobId);
    };
    window.addEventListener(openActivityEvent, onOpen);
    return () => window.removeEventListener(openActivityEvent, onOpen);
  }, []);
  const toggle = useCallback((jobId: string) => setExpandedId((current) => (current === jobId ? null : jobId)), []);
  // The drawer closes first: two modals would each hold keyboard focus against the other.
  const tryWithMoreTime = useCallback((job: Job) => { setOpen(false); setMoreTime(job); }, []);
  const review = useCallback((job: Job) => { setOpen(false); setReviewing(job); }, []);

  return (
    <>
      <button
        className={`text-button activity-button${runningCount > 0 ? " activity-button-live" : ""}`}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Activity{runningCount > 0 ? <span className="activity-badge" aria-label={`${runningCount} running`}>{runningCount}</span> : null}
      </button>
      {/* Portal to <body>: the topbar's backdrop-filter makes it the containing block for
          position:fixed descendants, which would pin and clip the drawer to the topbar. */}
      {open && createPortal(
        <div className="activity-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <aside ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" className="activity-drawer" aria-label="Activity" onMouseDown={(event) => event.stopPropagation()}>
            <header className="activity-header">
              <div>
                <span className="eyebrow">Latest</span>
                <h2>{runningCount > 0 ? `${runningCount} job${runningCount === 1 ? "" : "s"} running` : "Activity"}</h2>
              </div>
              <button className="icon-button" type="button" aria-label="Close activity" onClick={() => setOpen(false)}>X</button>
            </header>
            <div className="activity-list">
              {feedStatus === "loading" && <p className="activity-empty">Reading job history...</p>}
              {feedStatus === "unavailable" && <div role="alert"><p>Activity could not be refreshed. {jobs.length > 0 ? "The entries below may be out of date." : "Job history is unavailable."}</p><button className="secondary-button" type="button" onClick={() => setRetry((value) => value + 1)}>Try refreshing Activity</button></div>}
              {feedStatus === "polling" && <p className="muted" role="status">Activity refreshes every few seconds while this tab is visible.</p>}
              {/* Asked for from elsewhere, and older than the fifty listed here. */}
              {expandedId && !expanded && feedStatus !== "loading" && <div className="activity-item"><JobLogView jobId={expandedId} /></div>}
              {jobs.length === 0 && (feedStatus === "live" || feedStatus === "polling") && <p className="activity-empty">No jobs are visible to this account in the recent history. Approved operations appear here.</p>}
              {jobs.map((job) => (
                <div key={job.id} className="activity-item">
                  <button type="button" className="activity-row" aria-expanded={expandedId === job.id} onClick={() => toggle(job.id)}>
                    <span className="activity-title">{job.title}</span>
                    <span className="activity-meta">
                      <span className={`status-pill ${jobStatus(job).tone}`}>{jobStatus(job).label}</span>
                      <span className="activity-time">{timeLabel(job.createdAt)}</span>
                    </span>
                  </button>
                  {expanded?.id === job.id && <><JobActions job={expanded} role={role} csrfToken={csrfToken} onReview={review} /><JobLogView job={expanded} onMoreTime={csrfToken ? tryWithMoreTime : undefined} /></>}
                </div>
              ))}
            </div>
          </aside>
        </div>,
        document.body,
      )}
      {reviewing && createPortal(
        <ApproveDialog operationId={reviewing.type.slice(3)} title={reviewing.title} parameters={noParameters} existingJobId={reviewing.id} csrfToken={csrfToken}
          preview={reviewing.recovery?.reason ? <span>{reviewing.recovery.reason}</span> : undefined} onClose={() => setReviewing(null)} />,
        document.body,
      )}
      {moreTime && createPortal(
        <ApproveDialog operationId={moreTime.type.slice(3)} title={moreTime.title} parameters={noParameters} moreTimeFor={moreTime.id} csrfToken={csrfToken} onClose={() => setMoreTime(null)} />,
        document.body,
      )}
    </>
  );
}

export default ActivityDrawer;
