/**
 * Which apps the owner stopped on purpose (M33.2). Home calls an app that is not running a problem;
 * one the owner stopped from BoxPilot is a choice, said quietly as "Stopped", the way a pause is.
 * Kept per app in a setting, not read back from jobs, because jobs are pruned within weeks and an
 * app stopped in spring is still stopped on purpose in autumn.
 *
 * A stop records it. Anything that brings the app back or replaces it clears it: start, restart,
 * unpause, an update, a reinstall or reconfigure, a rollback, and removing the app. A pause leaves
 * it as it was. Only operations that finished are folded in (operationRecordHooks run on success).
 */
export const appStopClearingOperations = Object.freeze(["app.install", "app.reinstall", "app.update", "app.reconfigure", "app.rollback", "app.uninstall", "app.purge"]);

/** The record after `job`: a new object, or the same one when the job changes nothing. */
export function foldAppStop(entries, job, { now = () => new Date() } = {}) {
  const current = entries && typeof entries === "object" ? entries : {};
  const id = job?.parameters?.id;
  if (typeof id !== "string" || !id) return current;
  const operation = String(job.type ?? "").replace(/^op:/, "");
  const action = job.parameters?.action;
  if (operation === "app.action" && action === "stop") return { ...current, [id]: { at: now().toISOString(), by: job.createdBy ?? null } };
  // Repair's "Recreate (stays stopped)" (M35) builds a pruned app's container and leaves it stopped:
  // it is still stopped on purpose, since the owner's stop stands.
  if (operation === "app.reinstall" && job.parameters?.start === false) return current;
  const clears = (operation === "app.action" && ["start", "restart", "unpause"].includes(action)) || appStopClearingOperations.includes(operation);
  if (!clears || !(id in current)) return current;
  const { [id]: _cleared, ...rest } = current;
  return rest;
}

/**
 * The record rebuilt from recent jobs, for an install that stopped apps before it kept one: its
 * completed app jobs folded oldest first, each stop dated when it finished. Run once, when there
 * is no record yet; after that the hooks keep it.
 */
export function seedAppStops(jobs = []) {
  return [...jobs]
    .filter((job) => job?.state === "completed")
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
    .reduce((entries, job) => {
      const at = new Date(job.updatedAt ?? job.createdAt ?? Date.now());
      return foldAppStop(entries, job, { now: () => (Number.isNaN(at.getTime()) ? new Date() : at) });
    }, {});
}
