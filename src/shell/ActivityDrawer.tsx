import { useCallback, useEffect, useMemo, useState } from "react";
import { JobLogView } from "../JobLogView";
import { ApproveDialog } from "./ApproveDialog";
import { publishWaiting } from "./approvalsWaiting";
import { activeJobStates, dismissedFailure, jobStatus, ranAgain } from "../jobStatus";
import { openActivityEvent } from "../activityEvents";
import { JobActions, dismissJob } from "../JobActions";
import { readJson } from "../http";
import { followJobs, type Job, type JobFeedStatus } from "../operations";
import { Button, EmptyState, Notice, SearchField, Segmented, Sheet, StatusChip, type Status } from "../ui";
import "./look.css";
import "./bar.css";
import "./jobs.css";

/** A retry with more time is staged from the job itself; the dialog's own parameters go unused. */
const noParameters: Record<string, unknown> = {};

/**
 * Activity (M1.5; M33.13 in the console's look): a top-bar button with a running-job badge that
 * opens a drawer of recent jobs, updated live over /api/v1/events. Each job is a row with its state
 * in words; expanding one shows what can be done with it (M36: review and approve, cancel, try
 * again, dismiss) and its step log and output - streamed while it runs, fetched once when it is
 * finished. The feed keeps the latest fifty; "Show older" reads the next fifty, and the Failed
 * filter can dismiss every failure it shows at once.
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

/** How many jobs a page of the list is, and the most the server will list. */
const pageSize = 50;
const mostListed = 200;
/** The fewest the feed hands over when there may be more behind them (the live snapshot is thirty). */
const feedSize = 30;
const newestFirst = (jobs: Job[]) => [...jobs].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

type Scope = "all" | "running" | "waiting" | "failed";

/** Which jobs a scope shows (M36: Activity filters). */
const inScope = (job: Job, scope: Scope) => scope === "all"
  || (scope === "running" && activeJobStates.has(job.state))
  || (scope === "waiting" && job.state === "awaiting_approval")
  || (scope === "failed" && job.state === "failed");

/** A search matches the title, the operation, or the state in words, case-blind, every word somewhere. */
export function matchesSearch(job: Job, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${job.title} ${job.type.replace(/^op:/, "")} ${jobStatus(job).label}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

const toneStatus = (tone: string): Status => (tone === "status-good" ? "good" : tone === "status-danger" ? "danger" : tone === "status-warning" ? "warning" : "neutral");

export function ActivityDrawer({ csrfToken = "", role = "owner" }: { csrfToken?: string; role?: string }) {
  const [feedJobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState(false);
  // The timed-out job being staged again with more time, through the ordinary approval dialog.
  const [moreTime, setMoreTime] = useState<Job | null>(null);
  // A staged job being approved from here (M36), through the same dialog at its own tier.
  const [reviewing, setReviewing] = useState<Job | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [feedStatus, setFeedStatus] = useState<JobFeedStatus>("loading");
  const [retry, setRetry] = useState(0);
  // The same operation with the same parameters, staged again through the ordinary dialog.
  const [again, setAgain] = useState<Job | null>(null);
  // Jobs older than the feed's fifty, read a page at a time when asked for ("Show older").
  const [older, setOlder] = useState<Job[]>([]);
  const [olderState, setOlderState] = useState<{ busy: boolean; problem: string | null; end: boolean }>({ busy: false, problem: null, end: false });
  // "Dismiss all N failed": one request at a time, with how far it has got and what would not go.
  const [dismissing, setDismissing] = useState<{ done: number; of: number } | null>(null);
  const [dismissProblem, setDismissProblem] = useState<string | null>(null);

  useEffect(() => followJobs({
    onSnapshot: (snapshot) => setJobs([...snapshot].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, 50)),
    onJob: (job) => { setJobs((current) => upsert(current, job)); setOlder((current) => (current.some((entry) => entry.id === job.id) ? current.map((entry) => (entry.id === job.id ? job : entry)) : current)); },
    onStatus: setFeedStatus,
  }), [retry]);

  // The dock's count of approvals waiting (M25) is this feed's, said once more.
  useEffect(() => { publishWaiting(feedJobs); }, [feedJobs]);
  // What the feed keeps, with the older pages under it.
  const jobs = useMemo(() => {
    if (!older.length) return feedJobs;
    const live = new Set(feedJobs.map((job) => job.id));
    return newestFirst([...feedJobs, ...older.filter((job) => !live.has(job.id))]);
  }, [feedJobs, older]);
  const showOlder = async () => {
    const limit = Math.min(mostListed, (Math.floor(jobs.length / pageSize) + 1) * pageSize);
    setOlderState({ busy: true, problem: null, end: false });
    try {
      const body = await readJson<{ jobs: Job[] }>(await fetch(`/api/v1/jobs?limit=${limit}`));
      if (!Array.isArray(body?.jobs)) throw new Error("Job history was incomplete");
      const known = new Set(jobs.map((job) => job.id));
      const found = body.jobs.filter((job) => job && typeof job.id === "string" && Array.isArray(job.steps));
      setOlder(found);
      setOlderState({ busy: false, problem: null, end: found.length < limit || limit >= mostListed || !found.some((job) => !known.has(job.id)) });
    } catch (error) {
      setOlderState({ busy: false, problem: error instanceof Error ? error.message : "The older jobs could not be read", end: false });
    }
  };
  const runningCount = jobs.filter((job) => activeJobStates.has(job.state)).length;
  const waitingCount = jobs.filter((job) => job.state === "awaiting_approval").length;
  const failedCount = jobs.filter((job) => job.state === "failed").length;
  const expanded = expandedId ? jobs.find((job) => job.id === expandedId) ?? null : null;
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const shown = useMemo(() => jobs.filter((job) => inScope(job, scope) && matchesSearch(job, query)), [jobs, scope, query]);
  // Home, Ops and the notification centre open Activity at one job (M36). The row is brought into
  // view and focused: expanded below the fold, the job asked for looked like it had not opened.
  const [reveal, setReveal] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const jobId = (event as CustomEvent<{ jobId: string | null }>).detail?.jobId ?? null;
      setOpen(true);
      // The job asked for is shown whatever the filter was left at.
      if (jobId) { setScope("all"); setQuery(""); setExpandedId(jobId); setReveal(jobId); }
    };
    window.addEventListener(openActivityEvent, onOpen);
    return () => window.removeEventListener(openActivityEvent, onOpen);
  }, []);
  useEffect(() => {
    if (!open || !reveal) return undefined;
    // After the sheet has taken focus for itself, which it does as it opens.
    const frame = window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`.jobs-row[data-job="${CSS.escape(reveal)}"]`);
      if (!row) return;
      row.scrollIntoView?.({ block: "start" });
      row.focus({ preventScroll: true });
      setReveal(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, reveal, jobs]);
  // Failures nobody has dealt with, among those shown: what "Dismiss all" lets go.
  const mayAct = Boolean(csrfToken) && role !== "viewer";
  const dismissable = shown.filter((job) => job.state === "failed" && !dismissedFailure(job) && !ranAgain(job));
  const dismissAll = async () => {
    const batch = [...dismissable];
    let refused = 0;
    setDismissProblem(null);
    setDismissing({ done: 0, of: batch.length });
    for (const [index, job] of batch.entries()) {
      try { await dismissJob(job.id, csrfToken); } catch { refused += 1; }
      setDismissing({ done: index + 1, of: batch.length });
    }
    setDismissing(null);
    if (refused) setDismissProblem(`${refused === 1 ? "1 failed job" : `${refused} failed jobs`} could not be dismissed. ${refused === 1 ? "It is" : "They are"} still asked about on Home and Ops. Try again.`);
  };
  const toggle = useCallback((jobId: string) => setExpandedId((current) => (current === jobId ? null : jobId)), []);
  // The drawer closes first: two modals would each hold keyboard focus against the other.
  const tryWithMoreTime = useCallback((job: Job) => { setOpen(false); setMoreTime(job); }, []);
  const review = useCallback((job: Job) => { setOpen(false); setReviewing(job); }, []);
  const tryAgain = useCallback((job: Job) => { setOpen(false); setAgain(job); }, []);
  const listed = feedStatus === "live" || feedStatus === "polling" || jobs.length > 0;

  return (
    <>
      <button className="bar-button bar-activity" data-live={runningCount > 0 || undefined} type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
        Activity{runningCount > 0 ? <span className="bar-badge" aria-label={`${runningCount} running`}>{runningCount}</span> : null}
      </button>
      {open && (
        <Sheet
          title="Activity"
          kicker={runningCount > 0 ? `${runningCount} job${runningCount === 1 ? "" : "s"} running` : "Latest"}
          side="right"
          className="look-console jobs-sheet"
          onClose={() => setOpen(false)}
        >
          {listed && jobs.length > 0 && (
            <div className="jobs-filters">
              <Segmented label="Which jobs" value={scope} onChange={setScope} options={[
                { value: "all", label: "All", count: jobs.length },
                { value: "running", label: "Running", count: runningCount },
                { value: "waiting", label: "Waiting for approval", count: waitingCount },
                { value: "failed", label: "Failed", count: failedCount },
              ]} />
              <SearchField label="Filter jobs" value={query} onValueChange={setQuery} />
            </div>
          )}
          {feedStatus === "loading" && <p className="jobs-quiet">Reading job history...</p>}
          {feedStatus === "unavailable" && (
            <Notice tone="danger" live action={<Button onClick={() => setRetry((value) => value + 1)}>Try refreshing Activity</Button>}>
              Activity could not be refreshed. {jobs.length > 0 ? "The entries below may be out of date." : "Job history is unavailable."}
            </Notice>
          )}
          {feedStatus === "polling" && <p className="jobs-quiet" role="status">Activity refreshes every few seconds while this tab is visible.</p>}
          {/* Asked for from elsewhere, and older than the fifty listed here. */}
          {expandedId && !expanded && feedStatus !== "loading" && <div className="jobs-item jobs-item--open"><JobLogView jobId={expandedId} /></div>}
          {jobs.length === 0 && (feedStatus === "live" || feedStatus === "polling") && (
            <EmptyState title="No jobs are visible to this account in the recent history.">Approved operations appear here, with their steps and output.</EmptyState>
          )}
          {jobs.length > 0 && shown.length === 0 && (
            <p className="jobs-quiet" role="status">
              None of the last {jobs.length} jobs {query.trim() ? <>match “{query.trim()}”{scope !== "all" ? " here" : ""}</> : scope === "running" ? "is running" : scope === "waiting" ? "is waiting for approval" : "failed"}.{" "}
              {/* The button goes with the message it is in: focus moves to the filter's All, not off the drawer. */}
              <Button variant="ghost" onClick={() => {
                setScope("all"); setQuery("");
                window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.jobs-filters [role="radio"][data-value="all"]')?.focus());
              }}>Show all</Button>
            </p>
          )}
          {scope === "failed" && mayAct && (dismissable.length > 1 || dismissing) && (
            <div className="jobs-bulk">
              <Button busy={dismissing !== null} onClick={() => void dismissAll()}>
                {dismissing ? `Dismissing, ${dismissing.done} of ${dismissing.of}` : `Dismiss all ${dismissable.length} failed`}
              </Button>
              <span className="jobs-actions__note">They stay here; Home and Ops stop asking about them.</span>
            </div>
          )}
          {dismissProblem && <Notice tone="danger" live onDismiss={() => setDismissProblem(null)}>{dismissProblem}</Notice>}
          {shown.length > 0 && (
            <ul className="jobs-list" aria-label="Recent jobs">
              {shown.map((job) => {
                const words = jobStatus(job);
                const status = toneStatus(words.tone);
                const isOpen = expanded?.id === job.id;
                return (
                  <li key={job.id} className={isOpen ? "jobs-item jobs-item--open" : "jobs-item"} data-status={status}>
                    <button type="button" className="jobs-row" data-job={job.id} aria-expanded={isOpen} onClick={() => toggle(job.id)}>
                      <span className="jobs-row__title">{job.title}</span>
                      <span className="jobs-row__meta">
                        <StatusChip status={status}>{words.label}</StatusChip>
                        <span className="jobs-row__time">{timeLabel(job.createdAt)}</span>
                      </span>
                    </button>
                    {isOpen && expanded && (
                      <div className="jobs-detail">
                        <JobActions job={expanded} role={role} csrfToken={csrfToken} onReview={review} onRetry={tryAgain} />
                        <JobLogView job={expanded} onMoreTime={csrfToken ? tryWithMoreTime : undefined} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {/* The feed keeps the latest fifty; older ones are read a page at a time, up to what the server lists. */}
          {listed && jobs.length >= feedSize && (
            <div className="jobs-older">
              {olderState.problem && <Notice tone="danger" live>{olderState.problem}</Notice>}
              {olderState.end
                ? <p className="jobs-quiet" role="status">{jobs.length >= mostListed ? `These are the latest ${mostListed} jobs. Activity lists no more than that.` : "That is every job in the history."}</p>
                : <Button busy={olderState.busy} onClick={() => void showOlder()}>Show older</Button>}
            </div>
          )}
        </Sheet>
      )}
      {again && (
        <ApproveDialog operationId={again.type.slice(3)} title={again.title} parameters={again.parameters ?? noParameters} csrfToken={csrfToken}
          preview={<span>Runs {again.title} again with the same settings. The last run failed: {again.error ?? "no error was recorded"}</span>} onClose={() => setAgain(null)} />
      )}
      {reviewing && (
        <ApproveDialog operationId={reviewing.type.slice(3)} title={reviewing.title} parameters={noParameters} existingJobId={reviewing.id} csrfToken={csrfToken}
          preview={reviewing.recovery?.reason ? <span>{reviewing.recovery.reason}</span> : undefined} onClose={() => setReviewing(null)} />
      )}
      {moreTime && (
        <ApproveDialog operationId={moreTime.type.slice(3)} title={moreTime.title} parameters={noParameters} moreTimeFor={moreTime.id} csrfToken={csrfToken} onClose={() => setMoreTime(null)} />
      )}
    </>
  );
}

export default ActivityDrawer;
