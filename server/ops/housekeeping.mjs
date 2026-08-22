/**
 * Reclaiming space, as one place that knows about all of it.
 *
 * `docker system df` sees the Docker half; nothing saw BoxPilot's own previous releases, old
 * backup archives, or the folders an interrupted restore left behind. These two operations put
 * every category in front of the owner with its size and why it is safe, and clear only what they
 * pick.
 */
import { defineOperation } from "./registry.mjs";

export function housekeepingOperations() {
  return [
    defineOperation({
      id: "housekeeping.inspect", title: "Find space that can be reclaimed", risk: "low", readOnly: true, timeoutMs: 3 * 60_000,
      description: "What is taking up room that nothing needs: previous BoxPilot releases, images no app uses, old backup archives, unfinished restores, and Docker's own leftovers.",
      run: (_parameters, { housekeeping }) => housekeeping.inspect(),
    }),
    defineOperation({
      id: "housekeeping.reclaim", title: "Reclaim disk space", risk: "medium", timeoutMs: 30 * 60_000,
      description: "Removes only the categories you chose. Images a container uses, the release a failed update would roll back to, and the newest backups of each app are never candidates.",
      parameters: { fields: { targets: { type: "array" } } },
      run: (parameters, { housekeeping, progress }) => housekeeping.reclaim({ targets: parameters.targets ?? [], progress }),
    }),
  ];
}
