/**
 * Per-job live output. Root-side writers (helper, boxpilot-run@ tasks) append lines to
 * <directory>/<jobId>.log, created 0640 root:<group> inside a 0750 directory so the unprivileged
 * web service can tail it and stream it to the browser. The web service persists and removes the
 * file when the job finishes.
 */
import { appendFile, chown, mkdir, open, readFile, rm, stat } from "node:fs/promises";
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
    try {
      const buffer = await readFile(target);
      const text = buffer.toString("utf8", Math.min(offset, buffer.length));
      return { text, offset: buffer.length, exists: true };
    } catch (error) {
      if (error.code === "ENOENT") return { text: "", offset, exists: false };
      throw error;
    }
  }
  async function remove(jobId) {
    await rm(jobLogPath(jobId, directory), { force: true }).catch(() => {});
  }
  return { read, remove, directory };
}
