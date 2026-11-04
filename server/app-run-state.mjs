/**
 * Whether an app's container is actually doing its job, from the record `app.inspect` keeps.
 *
 * Docker reports a paused container as running: it exists, it holds its ports and its folders, and
 * it answers nothing. Six places asked the question and each wrote the answer out again
 * (`Boolean(container?.running) && container?.status !== "paused"`). They agreed, which is the
 * trouble: the day another status should also not count as running, five of the six would have been
 * missed. The question has one answer here (M52.6).
 */

/** Container statuses that exist but serve nobody. */
const notServing = new Set(["paused"]);

/**
 * `true` when this container is up and serving. A missing container, a missing record and a status
 * that only looks like running are all `false`.
 */
export function containerRunning(container) {
  return container?.running === true && !notServing.has(container?.status);
}
