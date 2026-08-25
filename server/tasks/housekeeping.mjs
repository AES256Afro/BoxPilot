import { rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Remove the copies of BoxPilot that past updates left in /opt.
 *
 * This is a task rather than something the helper does itself, and the reason is the whole point:
 * the helper runs `ProtectSystem=strict` with /opt read-only, so a root process that is compromised
 * still cannot rewrite the application it is part of. That boundary is worth keeping — which meant
 * the housekeeping category that clears these trees failed with EROFS every time it ran, on the
 * largest thing it had to offer. The task runner is where privileged host changes belong.
 *
 * Paths are re-checked here rather than trusted from the caller: every one has to sit directly in
 * the install root, be a directory, match a naming scheme BoxPilot's own updater has used, and not
 * be the running install.
 */
const leftoverPattern = /^boxpilot(?:\.prev\.|\.rollback-|-prev-|-live-before-|-candidate-|\.failed\.)/;

export async function housekeepingRemoveTrees({ paths = [], installRoot = "/opt", currentTree = "/opt/boxpilot" } = {}, { log = null, files = { rm, stat } } = {}) {
  if (!Array.isArray(paths)) throw new Error("paths must be a list");
  if (paths.length > 500) throw new Error("too many paths in one request");
  const root = path.resolve(installRoot);
  const current = path.resolve(currentTree);
  const removed = [];
  const refused = [];
  for (const candidate of paths) {
    if (typeof candidate !== "string") { refused.push({ path: String(candidate), reason: "not a path" }); continue; }
    const resolved = path.resolve(candidate);
    // Directly inside the install root, not merely underneath it: no nesting, no traversal.
    if (path.dirname(resolved) !== root) { refused.push({ path: resolved, reason: "not directly in the install root" }); continue; }
    if (resolved === current) { refused.push({ path: resolved, reason: "this is the running install" }); continue; }
    if (!leftoverPattern.test(path.basename(resolved))) { refused.push({ path: resolved, reason: "not a name a BoxPilot update leaves behind" }); continue; }
    const info = await files.stat(resolved).catch(() => null);
    if (!info) { refused.push({ path: resolved, reason: "no longer there" }); continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) { refused.push({ path: resolved, reason: "not a directory" }); continue; }
    try {
      await files.rm(resolved, { recursive: true, force: true });
      removed.push(resolved);
      log?.(`removed ${resolved}`, "stdout");
    } catch (error) {
      refused.push({ path: resolved, reason: error.message });
      log?.(`could not remove ${resolved}: ${error.message}`, "stderr");
    }
  }
  return { removed, refused };
}
