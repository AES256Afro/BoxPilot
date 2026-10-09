/**
 * Reclaiming space, as one place that knows about all of it.
 *
 * `docker system df` sees the Docker half; nothing saw BoxPilot's own previous releases, old
 * backup archives, or the folders an interrupted restore left behind. These two operations put
 * every category in front of the owner with its size and why it is safe, and clear only what they
 * pick.
 */
import { defineOperation } from "./registry.mjs";
import { categoryIds, databaseCopyLimits, databaseCopyPattern } from "../housekeeping.mjs";
import { snapshotNamePattern } from "../machine-snapshot-helper.mjs";

/** A whole number within the rule's limits, for the keep and keepDays parameters. */
const within = (name) => (value) => {
  const [low, high] = databaseCopyLimits[name];
  return Number.isInteger(value) && value >= low && value <= high ? null : `must be a whole number from ${low} to ${high}`;
};
const rule = {
  keep: { type: "number", validate: within("keep") },
  keepDays: { type: "number", validate: within("keepDays") },
};

export function housekeepingOperations() {
  return [
    defineOperation({
      id: "housekeeping.inspect", title: "Find space that can be reclaimed", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 3 * 60_000,
      description: "What is taking up room that nothing needs: previous BoxPilot releases, images no app uses, old backup archives, unfinished restores, and Docker's own leftovers.",
      run: (_parameters, { housekeeping }) => housekeeping.inspect(),
    }),
    defineOperation({
      id: "housekeeping.reclaim", title: "Reclaim disk space", risk: "medium", timeoutMs: 30 * 60_000,
      description: "Removes only the categories you chose. Images a container or an installed app needs, the most recent release you could put back by hand, and the newest backups of each app are never candidates.",
      parameters: { fields: { targets: { type: "array", validate: (value) => (value.every((entry) => categoryIds.includes(entry)) ? null : `must name only: ${categoryIds.join(", ")}`) } } },
      run: (parameters, { housekeeping, progress }) => housekeeping.reclaim({ targets: parameters.targets ?? [], progress }),
    }),
    // M36: the copies of the database an update takes before it swaps the code in. The list is a
    // directory listing of the state directory made as root, so it needs an operator (ADR-003).
    defineOperation({
      id: "housekeeping.database-copies.inspect", title: "List the database copies updates took", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 30_000,
      description: "Every copy of BoxPilot's database an update took before it swapped the code in, newest first, and which of them a rule would let go of: all but the newest few and any younger than a number of days.",
      parameters: { fields: { keep: { ...rule.keep, optional: true }, keepDays: { ...rule.keepDays, optional: true } } },
      run: (parameters, { housekeeping }) => housekeeping.databaseCopies(parameters),
    }),
    defineOperation({
      // Owner only: the copies hold everything the database does - accounts, settings and, in
      // copies older than the secret scrub, passwords - and deleting data is the owner's call.
      id: "housekeeping.database-copies.remove", title: "Remove old database copies", risk: "medium", minimumRole: "owner", timeoutMs: 2 * 60_000,
      description: "Deletes exactly the database copies listed, each only if the same rule still lets it go when the job runs. The newest copies, recent ones and the live database are never touched.",
      parameters: { fields: { ...rule, names: { type: "array", validate: (value) => (value.length >= 1 && value.length <= 500 && value.every((name) => typeof name === "string" && databaseCopyPattern.test(name)) ? null : "must list 1 to 500 copies named boxpilot-rollback-*.sqlite3") } } },
      run: (parameters, { housekeeping, progress }) => housekeeping.removeDatabaseCopies({ keep: parameters.keep, keepDays: parameters.keepDays, names: parameters.names, progress }),
    }),
    defineOperation({
      // Owner only, like the database copies: a machine snapshot holds the database and every app's
      // secrets, and deleting one is the owner's call. One that cannot be read stops every app's
      // older backups from being pruned (R4B3-5), and nothing else removes it.
      id: "housekeeping.unreadable-snapshot.remove", title: "Remove an unreadable machine snapshot", risk: "medium", minimumRole: "owner", timeoutMs: 5 * 60_000,
      description: "Deletes one machine snapshot BoxPilot cannot open, and its description beside it, only if it still cannot be read when the job runs. Nothing else in the snapshot folder is touched, and a link is never followed.",
      parameters: { fields: { name: { type: "string", maxLength: 80, pattern: snapshotNamePattern } } },
      run: (parameters, { housekeeping, progress }) => housekeeping.removeUnreadableSnapshot({ name: parameters.name, progress }),
    }),
  ];
}
