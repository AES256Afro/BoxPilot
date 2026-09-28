import type { Job, JobTimeout } from "./operations";

/** "40 seconds", "25 minutes", "2 hours 30 minutes": how a budget is said. Same as the server's. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

/** The job's timeout, when it finished by running out of time (M30.3); null for anything else. */
export function jobTimeout(job: Pick<Job, "state" | "timeout"> | null | undefined): JobTimeout | null {
  const timeout = job?.state === "failed" ? job.timeout : null;
  return timeout && typeof timeout.budgetMs === "number" && typeof timeout.elapsedMs === "number" ? timeout : null;
}

/** Whether the job offers "Try again with more time": the server says so, and how much, on the record. */
export function moreTimeOffered(job: Pick<Job, "state" | "timeout"> | null | undefined): number | null {
  const offered = jobTimeout(job)?.moreTimeMs;
  return typeof offered === "number" && offered > 0 ? offered : null;
}

/**
 * A timeout, said as one: which limit ran out, how far the job got, and - where the operation
 * offers it and a handler is given - the button that stages it again with more time.
 */
export function JobTimeoutNotice({ job, onMoreTime, busy = false }: { job: Job; onMoreTime?: () => void; busy?: boolean }) {
  const timeout = jobTimeout(job);
  if (!timeout) return null;
  const moreTime = moreTimeOffered(job);
  const limit = timeout.phase === "queued"
    ? `It waited ${formatDuration(timeout.elapsedMs)} behind other work on the server and never started.`
    : timeout.scope === "operation"
      ? `It had ${formatDuration(timeout.budgetMs)} and used all of it. It may still be running on the server.`
      : `${timeout.step ?? "One step"} had ${formatDuration(timeout.budgetMs)} and did not finish. The job ran for ${formatDuration(timeout.elapsedMs)}.`;
  return (
    <div className="notice warning-notice job-timeout" role="status">
      <strong>Ran out of time</strong>
      <p>{limit}</p>
      {timeout.lastOutput && <p>Last output: <code>{timeout.lastOutput}</code></p>}
      {onMoreTime && moreTime !== null && (
        <>
          <p>Trying again gives it {formatDuration(moreTime)}, and asks for approval like any other job.</p>
          <button className="secondary-button" type="button" disabled={busy} onClick={onMoreTime}>Try again with more time</button>
        </>
      )}
    </div>
  );
}
