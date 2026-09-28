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
/** Room kept below the cap for the "truncated" notice and the last lines of a log that reached it. */
const jobLogTailReserveBytes = 256 * 1024;
const jobLogTailLines = 200;
const jobLogTailLineBytes = 1024;

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
  /** One timestamped line, clipped to `limit` bytes at a UTF-8 boundary; null when not even the prefix fits. */
  function format(line, stream, limit) {
    const prefix = `${now().toISOString()} ${stream === "stderr" ? "! " : "  "}`;
    const marker = " [output truncated]";
    const available = limit - Buffer.byteLength(prefix + marker + "\n");
    if (available <= 0) return null;
    const raw = String(line);
    // Slice before encoding or stripping controls so a huge line cannot double its allocation.
    const clippedRaw = raw.slice(0, available).replace(/[\uD800-\uDBFF]$/, "");
    const buffer = Buffer.from(clippedRaw.replace(/[\0]/g, ""));
    const end = utf8End(buffer, available);
    const clipped = raw.length > available || end < buffer.length;
    return `${prefix}${buffer.toString("utf8", 0, end)}${clipped ? marker : ""}\n`;
  }
  // Past the cap, the start of the log is kept and so is its end: the error that stopped a long job
  // is usually the last thing it printed. The tail is held here and written by flush().
  let truncated = false; let omitted = 0;
  const tail = [];
  async function write(line, stream = "stdout") {
    if (!prepared) prepared = prepare().then(() => true, () => false);
    if (!await prepared) return false;
    if (!truncated) {
      const text = format(line, stream, Math.min(maxJobLogLineBytes, maxJobLogBytes - jobLogTailReserveBytes - bytes));
      if (text !== null) {
        bytes += Buffer.byteLength(text);
        return appendFile(target, text).then(() => true, () => false);
      }
      truncated = true;
      const notice = format(`… log truncated at ${maxJobLogBytes / 1024 / 1024} MiB; the last lines follow when the operation ends`, "stderr", maxJobLogLineBytes);
      bytes += Buffer.byteLength(notice);
      await appendFile(target, notice).catch(() => {});
    }
    tail.push(format(line, stream, jobLogTailLineBytes));
    if (tail.length > jobLogTailLines) { tail.shift(); omitted += 1; }
    return false;
  }
  async function writeTail() {
    if (!tail.length) return;
    // Oldest first out if the reserve cannot hold them all; the newest lines are the ones that matter.
    const lines = tail.splice(0);
    let size = lines.reduce((total, text) => total + Buffer.byteLength(text), 0);
    while (lines.length && size > maxJobLogBytes - bytes - maxJobLogLineBytes) { size -= Buffer.byteLength(lines.shift()); omitted += 1; }
    const header = omitted ? format(`… ${omitted} line(s) omitted; the last ${lines.length} follow`, "stderr", maxJobLogLineBytes) : "";
    const text = header + lines.join("");
    bytes += Buffer.byteLength(text);
    omitted = 0;
    await appendFile(target, text).catch(() => {});
  }
  // Appends run one after another on a single chain. Independent appendFile calls finish in any
  // order, so a burst of output could land in the file shuffled.
  let chain = Promise.resolve();
  function append(line, stream = "stdout") {
    const writing = chain.then(() => write(line, stream), () => write(line, stream));
    chain = writing.catch(() => false);
    return writing;
  }
  async function flush() {
    chain = chain.then(writeTail, writeTail);
    await chain.catch(() => {});
  }
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
  /**
   * Whether this process can open a job's log (M30.1): an open and an fstat, never a read, so a
   * log at the 4 MiB cap costs the same as an empty one. "absent" is a job that printed nothing,
   * since the writer creates the file on its first line; a folder this process cannot search is
   * "unreadable", not absent. When the file cannot be opened, the mode of whatever was in the way
   * is reported if it can be seen: the file's when the folder can be searched, else the folder's.
   */
  async function check(jobId) {
    const target = jobLogPath(jobId, directory);
    let handle;
    try {
      handle = await open(target, "r");
      const info = await handle.stat();
      if (!info.isFile()) return { state: "unreadable", code: "ENOTFILE", path: target, blocking: null };
      return { state: "readable", bytes: info.size, path: target };
    } catch (error) {
      if (error.code === "ENOENT") return { state: "absent", path: target };
      const blocking = await stat(target).then((entry) => ({ what: "file", mode: entry.mode & 0o777 }), () => stat(directory).then((entry) => ({ what: "folder", mode: entry.mode & 0o777 }), () => null));
      return { state: "unreadable", code: typeof error.code === "string" ? error.code : "unknown", path: target, blocking };
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  async function remove(jobId) {
    await rm(jobLogPath(jobId, directory), { force: true }).catch(() => {});
  }
  return { read, check, remove, directory };
}
