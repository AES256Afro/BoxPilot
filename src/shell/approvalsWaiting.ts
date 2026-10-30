import { useSyncExternalStore } from "react";
import { failureSettled } from "../jobStatus";
import type { Job } from "../operations";

/**
 * How many jobs wait for this account's approval, as Activity's live feed last said (M25): the dock
 * shows it on Today, where they are listed first, so an approval is one tap from anywhere. Activity
 * follows the job stream for the whole session; this only repeats its count, and fetches nothing.
 */
let waiting: string[] = [];
/** The newest failure nobody has dealt with yet (jobStatus failureSettled): the command bar offers it (M36). */
let unsettled: { id: string; title: string } | null = null;
const listeners = new Set<() => void>();

export function publishWaiting(jobs: Job[]): void {
  const next = jobs.filter((job) => job.state === "awaiting_approval").map((job) => job.id).sort();
  const failed = [...jobs].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).find((job) => job.state === "failed" && !failureSettled(job, jobs));
  const nextFailed = failed ? { id: failed.id, title: failed.title } : null;
  const sameWaiting = next.length === waiting.length && next.every((id, index) => id === waiting[index]);
  const sameFailed = nextFailed?.id === unsettled?.id && nextFailed?.title === unsettled?.title;
  if (sameWaiting && sameFailed) return;
  waiting = next;
  if (!sameFailed) unsettled = nextFailed;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const count = () => waiting.length;

export function useApprovalsWaiting(): number {
  return useSyncExternalStore(subscribe, count, count);
}

const latestFailure = () => unsettled;

export function useLatestFailure(): { id: string; title: string } | null {
  return useSyncExternalStore(subscribe, latestFailure, latestFailure);
}
