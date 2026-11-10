/**
 * Opening Activity at one job from anywhere (M36): Home's "waiting for approval" and failed-job
 * items, and the notification centre, hand the job to the drawer, which opens with it expanded.
 */
export const openActivityEvent = "boxpilot:open-activity";

export function openActivity(jobId?: string): void {
  window.dispatchEvent(new CustomEvent<{ jobId: string | null }>(openActivityEvent, { detail: { jobId: jobId ?? null } }));
}

/**
 * Opening a page from anywhere (M49): a panel deep in Settings that points at Updates or at the page
 * a watched condition belongs to can offer the button instead of the words. The app listens and
 * changes view as a tile would.
 */
export const openViewEvent = "boxpilot:open-view";

export interface OpenViewOptions {
  app?: string;
  tab?: string;
  /** With `app`: the tab its sheet opens at (Apps reads ?sheet=), "backups" from the Backups page. */
  sheet?: string;
  /** With `app` and `sheet: "tunnel"`: the app to publish, chosen already in the tunnel's form. */
  publish?: string;
}

export function openView(view: string, options: OpenViewOptions = {}): void {
  window.dispatchEvent(new CustomEvent<{ view: string; options: OpenViewOptions }>(openViewEvent, { detail: { view, options } }));
}

/**
 * Whether this page, at this tab when one is named, is what the address says is showing. A page's
 * first tab is not written in the address, so a tab that is not there counts as not showing.
 */
export function viewIsShowing(view: string, tab?: string): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if ((params.get("view") ?? "home") !== view) return false;
  return !tab || params.get(view === "setup" ? "mode" : "tab") === tab;
}

/** Opening the notification centre from anywhere (M36): Home's "could not tell you" item shows what. */
export const openNotificationsEvent = "boxpilot:open-notifications";

export function openNotifications(): void {
  window.dispatchEvent(new Event(openNotificationsEvent));
}
