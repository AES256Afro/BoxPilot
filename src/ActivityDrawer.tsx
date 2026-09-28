import { useCallback, useEffect, useRef, useState } from "react";
import { JobLogView } from "./JobLogView";
import { ApproveDialog } from "./ApproveDialog";
import { activeJobStates, jobStatus } from "./jobStatus";
import { useDialogFocus } from "./useDialogFocus";
import { createPortal } from "react-dom";
import { followJobOutput, followJobs, terminalJobStates, type Job, type JobFeedStatus } from "./operations";

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


export function ActivityDrawer({ csrfToken = "" }: { csrfToken?: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState(false);
  // The timed-out job being staged again with more time, through the ordinary approval dialog.
  const [moreTime, setMoreTime] = useState<Job | null>(null);
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
  const toggle = useCallback((jobId: string) => setExpandedId((current) => (current === jobId ? null : jobId)), []);
  // The drawer closes first: two modals would each hold keyboard focus against the other.
  const tryWithMoreTime = useCallback((job: Job) => { setOpen(false); setMoreTime(job); }, []);

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
                  {expanded?.id === job.id && <JobLogView job={expanded} onMoreTime={csrfToken ? tryWithMoreTime : undefined} />}
                </div>
              ))}
            </div>
          </aside>
        </div>,
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
