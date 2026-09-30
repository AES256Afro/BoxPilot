import { useSyncExternalStore } from "react";
import type { Job } from "../operations";

/**
 * How many jobs wait for this account's approval, as Activity's live feed last said (M25): the dock
 * shows it on Today, where they are listed first, so an approval is one tap from anywhere. Activity
 * follows the job stream for the whole session; this only repeats its count, and fetches nothing.
 */
let waiting: string[] = [];
const listeners = new Set<() => void>();

export function publishWaiting(jobs: Job[]): void {
  const next = jobs.filter((job) => job.state === "awaiting_approval").map((job) => job.id).sort();
  if (next.length === waiting.length && next.every((id, index) => id === waiting[index])) return;
  waiting = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const count = () => waiting.length;

export function useApprovalsWaiting(): number {
  return useSyncExternalStore(subscribe, count, count);
}
