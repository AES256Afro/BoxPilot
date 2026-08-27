import { useCallback, useEffect, useRef, useState } from "react";
import { JobLogView } from "./JobLogView";
import { createPortal } from "react-dom";
import { followJobOutput, followJobs, terminalJobStates, type Job } from "./operations";

/**
 * Global Activity drawer (M1.5): a topbar button with a running-job badge that opens a panel
 * listing recent jobs, updated live over /api/v1/events. Expanding a job shows its step log and
 * output — streamed while it runs, fetched once when it is finished.
 */

const activeStates = new Set(["applying", "verifying"]);

const stateLabel: Record<string, string> = {
  awaiting_approval: "Awaiting approval",
  cancelled: "Cancelled",
  applying: "Running",
  verifying: "Verifying",
  completed: "Completed",
  failed: "Failed",
};

function stateTone(state: string): string {
  if (state === "completed") return "status-good";
  if (state === "failed") return "status-danger";
  if (activeStates.has(state)) return "status-warning";
  return "status-neutral";
}

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


export function ActivityDrawer() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => followJobs({
    onSnapshot: (snapshot) => setJobs([...snapshot].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, 50)),
    onJob: (job) => setJobs((current) => upsert(current, job)),
  }), []);

  const runningCount = jobs.filter((job) => activeStates.has(job.state)).length;
  const expanded = expandedId ? jobs.find((job) => job.id === expandedId) ?? null : null;
  const toggle = useCallback((jobId: string) => setExpandedId((current) => (current === jobId ? null : jobId)), []);

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
          <aside className="activity-drawer" aria-label="Activity" onMouseDown={(event) => event.stopPropagation()}>
            <header className="activity-header">
              <div>
                <span className="eyebrow">Activity</span>
                <h2>{runningCount > 0 ? `${runningCount} job${runningCount === 1 ? "" : "s"} running` : "Recent jobs"}</h2>
              </div>
              <button className="icon-button" type="button" aria-label="Close activity" onClick={() => setOpen(false)}>X</button>
            </header>
            <div className="activity-list">
              {jobs.length === 0 && <p className="activity-empty">Nothing has run yet. Approved operations appear here with their live output.</p>}
              {jobs.map((job) => (
                <div key={job.id} className="activity-item">
                  <button type="button" className="activity-row" aria-expanded={expandedId === job.id} onClick={() => toggle(job.id)}>
                    <span className="activity-title">{job.title}</span>
                    <span className="activity-meta">
                      <span className={`status-pill ${stateTone(job.state)}`}>{stateLabel[job.state] ?? job.state}</span>
                      <span className="activity-time">{timeLabel(job.createdAt)}</span>
                    </span>
                  </button>
                  {expanded?.id === job.id && <JobLogView job={expanded} />}
                </div>
              ))}
            </div>
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
}

export default ActivityDrawer;
