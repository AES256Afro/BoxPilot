/**
 * The bar's Refresh (M25): what a phone's pull-to-refresh would do, for the installed app, which has
 * no browser button to reload with. A view that reads its own facts (Home, Ops, Today) says it has
 * it by cancelling the event, and reads them again in place; any other page is loaded again.
 */
export const refreshEvent = "boxpilot:refresh";

export function requestRefresh({ reload = () => window.location.reload() }: { reload?: () => void } = {}): "refreshed" | "reloaded" {
  const event = new Event(refreshEvent, { cancelable: true });
  const taken = !window.dispatchEvent(event);
  if (taken) return "refreshed";
  reload();
  return "reloaded";
}

/**
 * For a view that can read its facts again in place: returns the function that stops listening.
 * `why` is "job" when a job finishing asked (below) rather than a person: a view whose full read is
 * heavy (Home's) reads less then.
 */
export function onRefresh(read: (why: "asked" | "job") => void): () => void {
  const listener = (event: Event) => { event.preventDefault(); read(event instanceof CustomEvent && event.detail === "job" ? "job" : "asked"); };
  window.addEventListener(refreshEvent, listener);
  return () => window.removeEventListener(refreshEvent, listener);
}

/**
 * For a page with its own "Check again". `asked` is that button's own function, so the bar's Refresh
 * reads everything the button does. `job` is the read a job ending asks for: the same facts, read
 * quietly (no busy button, a shown error left alone). Job reads never pile up: one that is asked for
 * while a read is out waits for it and then runs once, and one asked for while the tab is hidden is
 * made once, when the tab is looked at again. Return the read's promise from both, so this knows
 * when it has landed.
 */
export function onPageRefresh({ asked, job }: { asked: () => unknown; job: () => unknown }): () => void {
  let reading = 0;
  let owed = false;
  let stopped = false;
  const hidden = () => typeof document !== "undefined" && document.hidden;
  const track = (started: unknown, after: () => void) => {
    if (!started || typeof (started as PromiseLike<unknown>).then !== "function") return;
    reading += 1;
    const landed = () => { reading -= 1; after(); };
    (started as PromiseLike<unknown>).then(landed, landed);
  };
  const readForJob = () => {
    if (stopped) return;
    if (reading > 0 || hidden()) { owed = true; return; }
    owed = false;
    track(job(), () => { if (owed) readForJob(); });
  };
  const stopListening = onRefresh((why) => {
    if (why === "job") { readForJob(); return; }
    // Everything is read again: nothing a job ended meanwhile is still owed.
    owed = false;
    track(asked(), () => { if (owed) readForJob(); });
  });
  const visible = () => { if (owed && !hidden()) readForJob(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visible);
  return () => { stopped = true; stopListening(); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visible); };
}

/*
 * Jobs a page is following to their end itself (its approval dialog hands it the finished job, and
 * the page reads again then). The feed's news of the same job would be a second read of the same
 * facts, so it is not sent for these.
 */
const followedByPage = new Set<string>();

/** Says a page will hear of this job's end itself; returns the function that takes that back. */
export function pageFollowsJob(jobId: string): () => void {
  followedByPage.add(jobId);
  return () => { followedByPage.delete(jobId); };
}

export const pageIsFollowing = (jobId: string): boolean => followedByPage.has(jobId);

/**
 * A job has finished, wherever it was started (the command bar, Activity, a schedule, another tab):
 * the page in front reads its facts again, so Apps stops saying "Update ready" once the update ran.
 * Only a page that listens does anything; nothing is loaded again. Jobs that finish together make
 * one read: at most one a second.
 */
const afterJobs: { last: number; timer: ReturnType<typeof setTimeout> | null } = { last: -Infinity, timer: null };

export function refreshAfterJob({ now = () => Date.now(), everyMs = 1000 }: { now?: () => number; everyMs?: number } = {}): void {
  if (typeof window === "undefined" || afterJobs.timer !== null) return;
  const emit = () => { afterJobs.timer = null; afterJobs.last = now(); window.dispatchEvent(new CustomEvent(refreshEvent, { cancelable: true, detail: "job" })); };
  const wait = afterJobs.last + everyMs - now();
  if (wait <= 0) emit();
  else afterJobs.timer = setTimeout(emit, wait);
}
