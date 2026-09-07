import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { defaultJobLogDirectory, jobLogPath, maxJobLogBytes } from "./job-log.mjs";

/** Read an existing durable copy without opening the state store or running migrations. */
export function savedCompletedOutput(jobId, databasePath = process.env.BOXPILOT_CONTROLLER_DATABASE ?? path.join(process.env.BOXPILOT_STATE_DIRECTORY ?? "/var/lib/boxpilot", "boxpilot.sqlite3")) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT o.output FROM jobs AS j JOIN job_output AS o ON o.job_id = j.id WHERE j.id = ? AND j.state = 'completed' AND length(CAST(o.output AS BLOB)) <= ?").get(jobId, maxJobLogBytes)?.output ?? null;
  } finally { database.close(); }
}

/** Remove only a fully saved, completed log from the fixed protected runtime directory. */
export async function releaseSavedJobLog({ jobId }, {
  directory = defaultJobLogDirectory,
  lookup = savedCompletedOutput,
  expectedUid = 0,
  inspect = lstat,
  openFile = open,
  remove = unlink,
} = {}) {
  const file = jobLogPath(jobId, directory);
  let handle;
  const retained = (reason) => ({ removed: false, retained: true, reason });
  try {
    const parent = await inspect(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== expectedUid || (parent.mode & 0o022)) return retained("untrusted-directory");
    const saved = await lookup(jobId);
    if (typeof saved !== "string") return retained("completed-output-not-saved");
    handle = await openFile(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== expectedUid || (before.mode & 0o022)) return retained("untrusted-file");
    if (before.size > maxJobLogBytes) return retained("oversized-log");
    const buffer = Buffer.alloc(before.size);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (!bytesRead) return retained("file-changed");
      read += bytesRead;
    }
    // Bytes, not a lossy UTF-8 decode: malformed bytes must not compare equal to replacements.
    if (!buffer.equals(Buffer.from(saved, "utf8"))) return retained("saved-copy-differs");
    const current = await inspect(file);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) return retained("file-changed");
    await remove(file);
    return { removed: true, retained: false, bytes: before.size };
  } catch (error) {
    if (error.code === "ENOENT") return { removed: false, retained: false, reason: "already-absent" };
    return retained(error.code === "ELOOP" ? "untrusted-file" : "cleanup-unavailable");
  } finally { await handle?.close().catch(() => {}); }
}
