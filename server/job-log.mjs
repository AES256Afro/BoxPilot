/**
 * Per-job live output. Root-side writers (helper, boxpilot-run@ tasks) append lines to
 * <directory>/<jobId>.log, created 0640 root:<group> inside a 0750 directory so the unprivileged
 * web service can tail it and stream it to the browser. The web service persists and removes the
 * file when the job finishes.
 */
import { appendFile, chmod, chown, mkdir, open, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

export const defaultJobLogDirectory = process.env.BOXPILOT_JOB_LOG_DIRECTORY ?? "/run/boxpilot/logs";
let cachedServiceGroupId = null;
/** The service group's id, for handing a root-written log to the web service. */
export function serviceGroupId() {
  if (cachedServiceGroupId !== null) return cachedServiceGroupId === -1 ? null : cachedServiceGroupId;
  try {
    const line = readFileSync("/etc/group", "utf8").split("\n").find((entry) => entry.startsWith("boxpilot:"));
    const gid = line ? Number.parseInt(line.split(":")[2], 10) : Number.NaN;
    cachedServiceGroupId = Number.isInteger(gid) ? gid : -1;
  } catch { cachedServiceGroupId = -1; }
  return cachedServiceGroupId === -1 ? null : cachedServiceGroupId;
}

export const jobIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const maxJobLogBytes = 4 * 1024 * 1024;
export const maxJobLogLineBytes = 64 * 1024;

/** End at a UTF-8 boundary when a byte budget cuts through a multi-byte character. */
function utf8End(buffer, limit) {
  let end = Math.min(buffer.length, limit);
  if (end < buffer.length) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

export function jobLogPath(jobId, directory = defaultJobLogDirectory) {
  if (typeof jobId !== "string" || !jobIdPattern.test(jobId)) throw new Error("Job id must be a UUID");
  return path.join(directory, `${jobId}.log`);
}

/** Writer for root-side processes. `group` is resolved by gid lookup of the boxpilot service user when available. */
export function createJobLogWriter({ jobId, directory = defaultJobLogDirectory, gid = null, now = () => new Date(), replaceExisting = false } = {}) {
  if (!jobId) return { append: async () => {}, flush: async () => {}, path: null, enabled: false };
  const target = jobLogPath(jobId, directory);
  let prepared = null; let bytes = 0;
  const pending = new Set();
  async function prepare() {
    await mkdir(directory, { recursive: true, mode: 0o750 });
    if (gid !== null) await chown(directory, 0, gid).catch(() => {});
    const handle = await open(target, replaceExisting ? "w" : "a", 0o640);
    await handle.close();
    if (gid !== null) await chown(target, 0, gid).catch(() => {});
    // The modes above are requests, and the process umask edits them: the helper runs with
    // UMask=0077, which turned 0640 into 0600 and 0750 into 0700, and the web service - a member
    // of the group, never root - could not read a log the helper wrote. Every job the helper ran
    // itself (installs, backups, restores) ended "recorded no output" while the file sat there,
    // full, until the next restart. chmod is not subject to the umask.
    await chmod(directory, 0o750).catch(() => {});
    await chmod(target, 0o640).catch(() => {});
    try { bytes = (await stat(target)).size; } catch { bytes = 0; }
  }
  async function write(line, stream = "stdout") {
    if (!prepared) prepared = prepare().then(() => true, () => false);
    if (!await prepared) return false;
    const budget = Math.min(maxJobLogLineBytes, maxJobLogBytes - bytes);
    const prefix = `${now().toISOString()} ${stream === "stderr" ? "! " : "  "}`;
    const marker = " [output truncated]";
    const available = budget - Buffer.byteLength(prefix + marker + "\n");
    if (available <= 0) return false;
    const raw = String(line);
    // Slice before encoding or stripping controls so a huge line cannot double its allocation.
    const clippedRaw = raw.slice(0, available).replace(/[\uD800-\uDBFF]$/, "");
    const buffer = Buffer.from(clippedRaw.replace(/[\0]/g, ""));
    const end = utf8End(buffer, available);
    const clipped = raw.length > available || end < buffer.length;
    const text = `${prefix}${buffer.toString("utf8", 0, end)}${clipped ? marker : ""}\n`;
    bytes += Buffer.byteLength(text);
    return appendFile(target, text).then(() => true, () => false);
  }
  function append(line, stream = "stdout") {
    const writing = write(line, stream);
    pending.add(writing);
    writing.then(() => pending.delete(writing), () => pending.delete(writing));
    return writing;
  }
  async function flush() { while (pending.size) await Promise.allSettled([...pending]); }
  return { append, flush, path: target, enabled: true };
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
      const from = Math.min(Number.isSafeInteger(offset) ? Math.max(0, offset) : 0, size);
      if (from >= size) return { text: "", offset: size, exists: true };
      // A damaged or oversized old file must not determine the web process's allocation.
      const buffer = Buffer.allocUnsafe(Math.min(size - from, maxJobLogBytes + 3));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      const consumed = utf8End(buffer.subarray(0, bytesRead), maxJobLogBytes);
      return { text: buffer.toString("utf8", 0, consumed), offset: from + consumed, exists: true };
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
