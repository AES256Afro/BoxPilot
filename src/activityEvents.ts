/**
 * Opening Activity at one job from anywhere (M36): Home's "waiting for approval" and failed-job
 * items, and the notification centre, hand the job to the drawer, which opens with it expanded.
 */
export const openActivityEvent = "boxpilot:open-activity";

export function openActivity(jobId?: string): void {
  window.dispatchEvent(new CustomEvent<{ jobId: string | null }>(openActivityEvent, { detail: { jobId: jobId ?? null } }));
}

/** Opening the notification centre from anywhere (M36): Home's "could not tell you" item shows what. */
export const openNotificationsEvent = "boxpilot:open-notifications";

export function openNotifications(): void {
  window.dispatchEvent(new Event(openNotificationsEvent));
}
