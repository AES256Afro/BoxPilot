import { useCallback, useEffect, useMemo, useState } from "react";
import { readJson } from "../http";
import type { Job } from "../operations";

/*
 * More of the job history than the live feed keeps (it holds the newest fifty), read once when a
 * view opens and again when asked: Ops' backup matrix (M33.3) and Today's "what ran overnight"
 * (M25.3). The live feed's copy of a job is newer, so it wins when both have it.
 */

export function useJobHistory(limit = 200): { jobs: Job[]; reload: () => void } {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    fetch(`/api/v1/jobs?limit=${limit}`).then((response) => readJson<{ jobs?: Job[] }>(response))
      .then((body) => { if (live && Array.isArray(body?.jobs)) setJobs(body.jobs); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [limit, round]);
  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { jobs, reload };
}

/** One list, newest first: the history read once, with the live feed's copy of each job over it. */
export function mergeJobs(history: Job[], live: Job[]): Job[] {
  const byId = new Map<string, Job>([...history, ...live].map((job) => [job.id, job]));
  return [...byId.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export function useMergedJobs(history: Job[], live: Job[]): Job[] {
  return useMemo(() => mergeJobs(history, live), [history, live]);
}
