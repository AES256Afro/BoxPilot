import { jobTimeout } from "./JobTimeout";
import { jobWarnings } from "./JobWarnings";
import type { Job } from "./operations";

/** A job the helper is working on. */
export const activeJobStates = new Set(["applying", "verifying"]);

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
  if (activeJobStates.has(state)) return "status-warning";
  return "status-neutral";
}

/**
 * Whether a restart cut this job off and BoxPilot ran it again by itself (M30.2). The cut-off record
 * stays failed, with a "rerun" step naming the new job, which has its own entry and its own ending.
 */
export function ranAgain(job: Pick<Job, "state" | "steps">): boolean {
  return job.state === "failed" && (job.steps ?? []).some((step) => step.name === "rerun" && step.state === "started");
}

/** A failed job someone looked at and let go (M36): it stays in Activity and stops asking for attention. */
export function dismissedFailure(job: Pick<Job, "state" | "steps">): boolean {
  return job.state === "failed" && (job.steps ?? []).some((step) => step.name === "dismissed" && step.state === "completed");
}

/** What a job acted on, as far as its parameters say: an app, a unit, a drive, a release. */
export function jobSubject(job: Pick<Job, "parameters">): string {
  const parameters = job.parameters ?? {};
  for (const key of ["id", "name", "unit", "target", "device", "mountpoint", "tag"]) {
    const value = parameters[key];
    if (typeof value === "string" && value) return `${key}:${value}`;
  }
  return "";
}

/**
 * The work a job did, as one key: its operation and subject. "Reconnect a drive" given a network share
 * (share-<name>) reconnects it as the share (since 1.149.0), so it is the same work as "Reconnect a
 * network share" for that share, and either one working settles a failure of the other: the owner's
 * backup share was mounted again from Storage while Home still said "Failed: Reconnect a drive".
 */
export function jobWork(job: Pick<Job, "type" | "parameters">): string {
  const name = job.parameters?.name;
  if (job.type === "op:storage.remount" && typeof name === "string" && name.startsWith("share-")) return `op:share.reconnect|name:${name.slice("share-".length)}`;
  return `${job.type}|${jobSubject(job)}`;
}

/**
 * Whether a failure has been dealt with, so it no longer needs the owner (M36): dismissed, run again
 * by BoxPilot after a restart, or tried again since - with more time, or the same work on the same
 * subject that is now done, running or waiting for approval. A later failure is its own entry.
 */
export function failureSettled(job: Job, jobs: Job[]): boolean {
  if (job.state !== "failed") return true;
  if (dismissedFailure(job) || ranAgain(job)) return true;
  const at = Date.parse(job.createdAt ?? "");
  const work = jobWork(job);
  return jobs.some((other) => other.id !== job.id && (
    other.recovery?.retryOf === job.id || other.recovery?.rerunOf === job.id
    || (jobWork(other) === work && Date.parse(other.createdAt ?? "") > at && other.state !== "failed" && other.state !== "cancelled")
  ));
}

/**
 * What a job's pill says, in Activity and on the Overview. A job that ran out of time is not one
 * that failed (M30.3), and one BoxPilot already ran again after a restart is not waiting on anyone.
 */
export function jobStatus(job: Job): { label: string; tone: string } {
  if (job.state === "completed" && jobWarnings(job.result).length) return { label: "Completed with notice", tone: "status-warning" };
  if (jobTimeout(job)) return { label: "Timed out", tone: "status-warning" };
  if (ranAgain(job)) return { label: "Interrupted, ran again", tone: "status-neutral" };
  if (dismissedFailure(job)) return { label: "Failed, dismissed", tone: "status-neutral" };
  if (job.state === "cancelled" && /^Superseded: /.test(job.error ?? "")) return { label: "Superseded", tone: "status-neutral" };
  return { label: stateLabel[job.state] ?? job.state, tone: stateTone(job.state) };
}
