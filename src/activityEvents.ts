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

export function openView(view: string, options: { app?: string; tab?: string } = {}): void {
  window.dispatchEvent(new CustomEvent<{ view: string; options: { app?: string; tab?: string } }>(openViewEvent, { detail: { view, options } }));
}

/** Opening the notification centre from anywhere (M36): Home's "could not tell you" item shows what. */
export const openNotificationsEvent = "boxpilot:open-notifications";

export function openNotifications(): void {
  window.dispatchEvent(new Event(openNotificationsEvent));
}
