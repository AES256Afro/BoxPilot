import { useEffect, useState } from "react";
import { readJson } from "../../http";
import type { Job } from "../../operations";

/*
 * Jobs running right now, for the update button (M36). Approving an update while a job runs is
 * refused (server/jobs.mjs: the update restarts BoxPilot and would interrupt it), so the button
 * says so before anyone clicks it. Read only while an update is on offer, every ten seconds.
 */

const runningStates = new Set(["applying", "verifying"]);

/** The titles of jobs still running, the update itself left out. */
export function runningTitles(jobs: Job[]): string[] {
  return jobs.filter((job) => runningStates.has(job.state) && job.type !== "op:system.update").map((job) => job.title);
}

export function useRunningJobs(enabled: boolean, everyMs = 10_000): string[] {
  const [titles, setTitles] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) { setTitles([]); return undefined; }
    let live = true;
    const read = () => fetch("/api/v1/jobs?limit=30").then((response) => readJson<{ jobs?: Job[] }>(response))
      .then((body) => { if (live && Array.isArray(body?.jobs)) setTitles(runningTitles(body.jobs)); })
      // Unknown is not "none running": keep what was last read, and the server still refuses.
      .catch(() => undefined);
    void read();
    const timer = window.setInterval(() => void read(), everyMs);
    return () => { live = false; window.clearInterval(timer); };
  }, [enabled, everyMs]);
  return titles;
}
