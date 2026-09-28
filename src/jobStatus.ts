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

/**
 * What a job's pill says, in Activity and on the Overview. A job that ran out of time is not one
 * that failed (M30.3), and one BoxPilot already ran again after a restart is not waiting on anyone.
 */
export function jobStatus(job: Job): { label: string; tone: string } {
  if (job.state === "completed" && jobWarnings(job.result).length) return { label: "Completed with notice", tone: "status-warning" };
  if (jobTimeout(job)) return { label: "Timed out", tone: "status-warning" };
  if (ranAgain(job)) return { label: "Interrupted, ran again", tone: "status-neutral" };
  return { label: stateLabel[job.state] ?? job.state, tone: stateTone(job.state) };
}
