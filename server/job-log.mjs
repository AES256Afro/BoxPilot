/**
 * Per-job live output. Root-side writers (helper, boxpilot-run@ tasks) append lines to
 * <directory>/<jobId>.log, created 0640 root:<group> inside a 0750 directory so the unprivileged
 * web service can tail it and stream it to the browser. The web service persists and removes the
 * file when the job finishes.
 */
import { appendFile, chown, mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";

export const defaultJobLogDirectory = process.env.BOXPILOT_JOB_LOG_DIRECTORY ?? "/run/boxpilot/logs";
export const jobIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxLogBytes = 4 * 1024 * 1024;

export function jobLogPath(jobId, directory = defaultJobLogDirectory) {
  if (typeof jobId !== "string" || !jobIdPattern.test(jobId)) throw new Error("Job id must be a UUID");
  return path.join(directory, `${jobId}.log`);
}

/** Writer for root-side processes. `group` is resolved by gid lookup of the boxpilot service user when available. */
export function createJobLogWriter({ jobId, directory = defaultJobLogDirectory, gid = null, now = () => new Date() } = {}) {
  if (!jobId) return { append: async () => {}, path: null, enabled: false };
  const target = jobLogPath(jobId, directory);
  let prepared = null; let bytes = 0;
  async function prepare() {
    await mkdir(directory, { recursive: true, mode: 0o750 });
    if (gid !== null) await chown(directory, 0, gid).catch(() => {});
    const handle = await open(target, "a", 0o640);
    await handle.close();
    if (gid !== null) await chown(target, 0, gid).catch(() => {});
    try { bytes = (await stat(target)).size; } catch { bytes = 0; }
  }
  async function append(line, stream = "stdout") {
    if (!prepared) prepared = prepare().catch(() => {});
    await prepared;
    if (bytes > maxLogBytes) return;
    const text = `${now().toISOString()} ${stream === "stderr" ? "! " : "  "}${String(line).replace(/[\0]/g, "")}\n`;
    bytes += Buffer.byteLength(text);
    await appendFile(target, text).catch(() => {});
  }
  return { append, path: target, enabled: true };
}

/** Reader for the web service. `read(jobId, offset)` returns the bytes after `offset`. */
export function createJobLogReader({ directory = defaultJobLogDirectory } = {}) {
  async function read(jobId, offset = 0) {
    const target = jobLogPath(jobId, directory);
    // Read from the offset rather than loading the file and slicing: the job stream polls this
    // every 700 ms per open connection, and a long install's log settles at the 4 MiB cap.
    let handle;
    try {
      handle = await open(target, "r");
      const { size } = await handle.stat();
      const from = Math.min(Math.max(0, offset), size);
      if (from >= size) return { text: "", offset: size, exists: true };
      const buffer = Buffer.allocUnsafe(size - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      return { text: buffer.toString("utf8", 0, bytesRead), offset: from + bytesRead, exists: true };
    } catch (error) {
      if (error.code === "ENOENT") return { text: "", offset, exists: false };
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  async function remove(jobId) {
    await rm(jobLogPath(jobId, directory), { force: true }).catch(() => {});
  }
  return { read, remove, directory };
}
