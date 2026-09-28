import type { Job, JobTimeout, RiskTier } from "./operations";
import { Button } from "./ui";

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
 * Whether the job's error is only the timeout said again. The server words a whole-operation or
 * queued timeout as the error ("did not finish within 25 minutes. ... Activity shows how far it
 * got"), which the notice below says better; a step's own error still carries what the step said.
 */
export function errorIsTheTimeout(job: Pick<Job, "state" | "timeout"> | null | undefined): boolean {
  const timeout = jobTimeout(job);
  return timeout !== null && (timeout.scope === "operation" || timeout.phase === "queued");
}

const tiers: readonly string[] = ["low", "medium", "high"];

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
          {/* The same operation again, so the same tier: shown on the button, not only in the dialog. */}
          <Button className="job-timeout-retry" risk={tiers.includes(job.risk) ? job.risk as RiskTier : "high"} busy={busy} onClick={onMoreTime}>Try again with more time</Button>
        </>
      )}
    </div>
  );
}
