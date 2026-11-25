import { useCallback, useEffect, useMemo, useState } from "react";
import { readJson } from "../http";
import type { Job } from "../operations";

/*
 * More of the job history than the live feed keeps (it holds the newest fifty), read once when a
 * view opens and again when asked: Ops' backup matrix (M33.3) and Today's "what ran overnight"
 * (M25.3). The live feed's copy of a job is newer, so it wins when both have it.
 */

export type HistoryState = "loading" | "ready" | "failed";

/**
 * The history, and whether it has been read (M88): Today said "Nothing ran overnight." while this
 * was still on its way, or after it had failed, because a failure here was swallowed.
 */
export function useJobHistory(limit = 200): { jobs: Job[]; state: HistoryState; reload: () => void } {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [state, setState] = useState<HistoryState>("loading");
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    // The summary view: no results or step logs, which none of these views read.
    fetch(`/api/v1/jobs?limit=${limit}&view=summary`).then((response) => readJson<{ jobs?: Job[] }>(response))
      .then((body) => {
        if (!live) return;
        if (!Array.isArray(body?.jobs)) throw new Error("The job history was missing");
        setJobs(body.jobs);
        setState("ready");
      })
      .catch(() => { if (live) setState("failed"); });
    return () => { live = false; };
  }, [limit, round]);
  // A read again keeps what was read on screen; one after a failure says it is reading.
  const reload = useCallback(() => { setState((current) => (current === "failed" ? "loading" : current)); setRound((value) => value + 1); }, []);
  return { jobs, state, reload };
}

/**
 * One list, newest first: the history read once, with the live feed's copy of each job over it,
 * unless the history's copy says it was updated later (a history read again after the event).
 */
export function mergeJobs(history: Job[], live: Job[]): Job[] {
  const byId = new Map<string, Job>(history.map((job) => [job.id, job]));
  for (const job of live) {
    const read = byId.get(job.id);
    if (!read || !read.updatedAt || !job.updatedAt || read.updatedAt <= job.updatedAt) byId.set(job.id, job);
  }
  return [...byId.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export function useMergedJobs(history: Job[], live: Job[]): Job[] {
  return useMemo(() => mergeJobs(history, live), [history, live]);
}
