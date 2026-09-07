import { lstat, opendir } from "node:fs/promises";

export function createTreeScanBudget({ maxEntries = 100_000, maxDurationMs = 60_000, maxDepth = 64, now = () => Date.now() } = {}) {
  let visited = 0;
  const deadline = now() + maxDurationMs;
  return {
    check(depth = 0, count = false) {
      if (count) visited += 1;
      if (visited > maxEntries || now() >= deadline || depth > maxDepth) throw Object.assign(new Error("Folder measurement exceeded its entry, depth or time budget"), { code: "TREE_SCAN_BUDGET" });
    },
    visited: () => visited,
  };
}

/** Collect only a bounded directory inventory. Missing install roots are empty; denied reads fail. */
export async function listTreeEntries(target, { budget = createTreeScanBudget() } = {}) {
  let root;
  try { root = await lstat(target); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Inventory requires a real directory");
  budget.check();
  const entries = [];
  const handle = await opendir(target, { bufferSize: 32 });
  for await (const entry of handle) { budget.check(0, true); entries.push(entry); }
  return entries;
}

/** Stream directory entries with bounded depth and cooperative work limits. Skip links and mounts. */
export async function measureTreeBytes(target, { budget = createTreeScanBudget() } = {}) {
  const root = await lstat(target);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Folder measurement requires a real directory");
  let bytes = 0;
  async function walk(directory, depth) {
    budget.check(depth);
    const handle = await opendir(directory, { bufferSize: 32 });
    // The async iterator closes its handle on return or an exception, including budget refusal.
    for await (const entry of handle) {
      budget.check(depth, true);
      if (entry.isSymbolicLink()) continue;
      const full = `${directory}/${entry.name}`;
      const info = await lstat(full).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (!info || info.isSymbolicLink() || info.dev !== root.dev) continue;
      if (info.isDirectory()) await walk(full, depth + 1);
      else if (info.isFile()) bytes += info.size;
    }
  }
  await walk(target, 0);
  return bytes;
}
