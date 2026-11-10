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
