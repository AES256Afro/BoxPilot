/**
 * Low-space recovery (M30.8): where the bytes and the inodes went, and a bounded cleanup of what
 * grows on its own.
 *
 * Four things fill a home server without anyone installing anything: the systemd journal, the job
 * logs BoxPilot keeps under /run, APT's download cache, and the images an update leaves dangling.
 * Local backups grow too, but each kind has retention of its own, which this reports rather than
 * overrides. `inspect` attributes bytes and inodes to each; `plan` says exactly what a cleanup with
 * the chosen bounds removes, how much that frees, and what it keeps and why; `cleanup` works the
 * plan out again, carries it out, and measures what was actually freed.
 *
 * Never touched: an active journal file, the log of a job that is still running or was written to
 * in the last hour, a failed job's log, a Docker volume, a tagged image, and every backup. The
 * journal and APT halves run in the root task runner: the helper sees /var read-only.
 */
import { lstat, readFile, stat, statfs, unlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fixedRun } from "./exec.mjs";
import { defaultJobLogDirectory, jobIdPattern, jobLogPath } from "./job-log.mjs";
import { createHousekeepingService, defaultKeepBackupsPerApp, humanBytes, parseDockerSize, parseReclaimable } from "./housekeeping.mjs";
import { validateParameters } from "./ops/registry.mjs";
import { createTreeScanBudget, diskUsage, listTreeEntries, measureTreeUsage } from "./tree-scan.mjs";

const dayMs = 86_400_000;
const mebibyte = 1024 ** 2;
/** A log written to within this long is treated as active whatever its job's record says. */
export const activeLogGraceMs = 60 * 60_000;
/** Items a plan lists by name per category; the rest are counted. */
const listedItems = 200;

/** What a cleanup can be asked to do. Backups, volumes and tagged images are not among them. */
export const cleanupCategoryIds = Object.freeze(["journal", "job-logs", "apt-cache", "docker-dangling"]);

/** The bounds a cleanup accepts. The floors are what keeps it bounded: none of them empties a category. */
export const cleanupBounds = Object.freeze({
  journalMinBytes: 64 * mebibyte,
  journalMaxBytes: 1024 ** 4,
  journalMinAgeDays: 1,
  journalMaxAgeDays: 3650,
  jobLogMinDays: 1,
  jobLogMaxDays: 365,
  jobLogDefaultDays: 14,
});

const wholeBetween = (min, max) => (value) => (Number.isInteger(value) && value >= min && value <= max ? null : `must be a whole number from ${min} to ${max}`);

/** The parameters of the preview and the cleanup, which are the same so the preview is what runs. */
export const cleanupParameters = Object.freeze({ fields: {
  categories: { type: "array", validate: (value, parameters) => {
    if (!value.length) return "must name at least one of: " + cleanupCategoryIds.join(", ");
    if (!value.every((entry) => cleanupCategoryIds.includes(entry))) return `must name only: ${cleanupCategoryIds.join(", ")}`;
    if (new Set(value).size !== value.length) return "must not name a category twice";
    if (value.includes("journal") && (parameters.journalMaxBytes ?? null) === null && (parameters.journalMaxAgeDays ?? null) === null) return "the journal needs a size bound, an age bound, or both";
    return null;
  } },
  journalMaxBytes: { type: "number", optional: true, nullable: true, validate: wholeBetween(cleanupBounds.journalMinBytes, cleanupBounds.journalMaxBytes) },
  journalMaxAgeDays: { type: "number", optional: true, nullable: true, validate: wholeBetween(cleanupBounds.journalMinAgeDays, cleanupBounds.journalMaxAgeDays) },
  jobLogRetentionDays: { type: "number", optional: true, validate: wholeBetween(cleanupBounds.jobLogMinDays, cleanupBounds.jobLogMaxDays) },
} });

// ---------------------------------------------------------------------------------------------
// Reading what the tools print. Each takes the captured text and returns numbers, or null when the
// text is not what that tool prints, so "could not tell" never reads as zero.

/** journald's sizes are powers of 1024 printed to one decimal: "1.2G", "24.0M", "1016B". */
const journalScale = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5, E: 1024 ** 6 };
const journalSize = (number, unit) => Math.round(Number(number) * journalScale[unit ?? ""]);

/**
 * `journalctl --disk-usage`: "Archived and active journals take up 1.2G in the file system." on
 * current systemd, "Journals take up 1.2G on disk." on older. journald's own total, to a tenth.
 */
export function parseJournalDiskUsage(text) {
  const match = /take up\s+(\d+(?:\.\d+)?)\s*([KMGTPE]?)B?\b/.exec(String(text ?? ""));
  return match ? journalSize(match[1], match[2]) : null;
}

/** `journalctl --vacuum-*`: the archived files it deleted, and the total it says it freed. */
export function parseJournalVacuum(text) {
  const deleted = [];
  let freedBytes = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    const file = /^Deleted (?:empty )?archived journal (\S+) \((\d+(?:\.\d+)?)([KMGTPE]?)B?\)\.?$/.exec(line);
    if (file) deleted.push({ path: file[1], bytes: journalSize(file[2], file[3]) });
    const done = /^Vacuuming done, freed (\d+(?:\.\d+)?)([KMGTPE]?)B? of archived journals from (\S+?)\.?$/.exec(line);
    if (done) freedBytes = (freedBytes ?? 0) + journalSize(done[1], done[2]);
  }
  return { deleted, freedBytes };
}

/**
 * `docker system df --format json`, one object per line. Docker prints powers of 1000 ("1.7GB").
 * Volumes are reported here and never cleaned.
 */
export function parseDockerSystemDf(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { return null; }
    if (typeof entry?.Type !== "string") return null;
    const count = (value) => (/^\d+$/.test(String(value ?? "")) ? Number(value) : null);
    const percent = /\((\d+(?:\.\d+)?)%\)/.exec(String(entry.Reclaimable ?? ""))?.[1];
    rows.push({
      type: entry.Type,
      total: count(entry.TotalCount ?? entry.Total),
      active: count(entry.Active),
      bytes: parseDockerSize(entry.Size),
      reclaimableBytes: parseReclaimable(entry.Reclaimable),
      reclaimablePercent: percent === undefined ? null : Number(percent),
    });
  }
  return rows;
}

/** `du --summarize` with `--block-size=1` or `--inodes`: "<number>\t<path>" per path given. */
export function parseDuSummary(text) {
  const totals = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const match = /^(\d+)\t(.+)$/.exec(line.trimEnd());
    if (match) totals.set(match[2], Number(match[1]));
  }
  return totals;
}

// ---------------------------------------------------------------------------------------------
// The journal's own vacuum, modelled so the preview names the files it deletes.

/**
 * One journal file's name as journald's vacuum reads it (src/libsystemd/sd-journal/journal-vacuum.c).
 * Archived: `<prefix>@<seqnum id>-<head seqnum>-<head realtime>.journal`. Corrupted, set aside on
 * a dirty shutdown: `<prefix>@<realtime>-<random>.journal~`. Any other `.journal` or `.journal~`
 * is active: counted, never deleted. Anything else is not a journal file.
 */
export function parseJournalFileName(name) {
  const archived = /@([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{16})\.journal$/.exec(name);
  if (archived) return { kind: "archived", seqnumId: archived[1].toLowerCase(), seqnum: BigInt(`0x${archived[2]}`), realtimeUs: Number(BigInt(`0x${archived[3]}`)) };
  const corrupted = /@([0-9a-fA-F]{16})-([0-9a-fA-F]{16})\.journal~$/.exec(name);
  if (corrupted) return { kind: "corrupted", seqnumId: null, seqnum: null, realtimeUs: Number(BigInt(`0x${corrupted[1]}`)) };
  if (name.endsWith(".journal") || name.endsWith(".journal~")) return { kind: "active" };
  return null;
}

/**
 * The exact `journalctl` arguments for a bound, shared by the preview and the root task so the two
 * cannot drift. Sizes go as plain bytes, which journalctl reads as bytes.
 */
export function journalVacuumArgs({ maxBytes = null, maxAgeDays = null } = {}) {
  return [
    ...(maxBytes !== null ? [`--vacuum-size=${maxBytes}`] : []),
    ...(maxAgeDays !== null ? [`--vacuum-time=${maxAgeDays}d`] : []),
  ];
}

/** A journal file's first-entry time as ISO text; null for a name whose time is not a real date. */
const isoFromMicroseconds = (microseconds) => {
  const milliseconds = microseconds / 1000;
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? new Date(milliseconds).toISOString() : null;
};

/** journald's order: by sequence number within one sequence, else by the time of the first entry. */
function vacuumOrder(left, right) {
  if (left.seqnumId && right.seqnumId && left.seqnumId === right.seqnumId) return left.seqnum < right.seqnum ? -1 : left.seqnum > right.seqnum ? 1 : 0;
  if (left.realtimeUs !== right.realtimeUs) return left.realtimeUs < right.realtimeUs ? -1 : 1;
  if (left.seqnumId && right.seqnumId && left.seqnumId !== right.seqnumId) return left.seqnumId < right.seqnumId ? -1 : 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/**
 * The archived files `journalctl --vacuum-size/--vacuum-time` deletes from one journal folder. Its
 * own loop: every journal file counts towards the folder's size; archived and corrupted ones are
 * taken oldest first until the folder is within every bound given. The size bound applies to each
 * folder on its own. journald also deletes archived files with no entries, which is not modelled:
 * they hold a few kilobytes, and what `cleanup` measures includes them.
 */
export function planJournalFolder(files, { maxBytes = null, maxAgeDays = null, now }) {
  let sum = 0; let activeFiles = 0; let activeBytes = 0;
  const archived = [];
  for (const file of files) {
    const parsed = parseJournalFileName(file.name);
    if (!parsed) continue;
    sum += file.bytes;
    if (parsed.kind === "active") { activeFiles += 1; activeBytes += file.bytes; continue; }
    archived.push({ ...file, ...parsed });
  }
  archived.sort(vacuumOrder);
  const limitUs = maxAgeDays === null ? null : (now - maxAgeDays * dayMs) * 1000;
  const remove = [];
  for (const file of archived) {
    if ((limitUs === null || file.realtimeUs >= limitUs) && (maxBytes === null || sum <= maxBytes)) break;
    remove.push(file);
    sum -= file.bytes;
  }
  const kept = archived.slice(remove.length);
  return { remove, kept, activeFiles, activeBytes, remainingBytes: sum };
}

// ---------------------------------------------------------------------------------------------

/** Job states for these ids, read-only, without opening the state store or running its migrations. */
export function jobStates(ids, databasePath) {
  const states = new Map();
  if (!ids.length) return states;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    for (let index = 0; index < ids.length; index += 200) {
      const chunk = ids.slice(index, index + 200);
      const rows = database.prepare(`SELECT j.id AS id, j.state AS state, length(CAST(o.output AS BLOB)) AS savedBytes FROM jobs AS j LEFT JOIN job_output AS o ON o.job_id = j.id WHERE j.id IN (${chunk.map(() => "?").join(",")})`).all(...chunk);
      for (const row of rows) states.set(row.id, { state: row.state, savedBytes: row.savedBytes ?? null });
    }
  } finally { database.close(); }
  return states;
}

const terminalJobStates = new Set(["completed", "failed", "cancelled"]);

/** Where each log stands: never removed unless it is the log of a completed job older than the retention. */
export function classifyJobLog(log, { cutoffMs, nowMs }) {
  if (nowMs - log.modifiedAt < activeLogGraceMs) return "active";
  if (!log.job) return "unlisted";
  if (!terminalJobStates.has(log.job.state)) return "active";
  if (log.job.state !== "completed") return "failed";
  return log.modifiedAt < cutoffMs ? "past-retention" : "completed";
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const days = (count) => plural(count, "day");

function defaultBackupRoots() {
  const managed = process.env.BOXPILOT_APPLICATION_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups";
  return [
    { id: "application", title: "Application backups", path: path.join(managed, "catalog"), retention: `Each backup keeps the newest copies of its own kind. Reclaim disk space offers those beyond the newest ${defaultKeepBackupsPerApp} of each kind, keeping any a machine snapshot restores from.` },
    { id: "database", title: "BoxPilot database backups", path: process.env.BOXPILOT_CONTROLLER_BACKUP_ROOT ?? path.join(managed, "boxpilot-controller"), retention: "Each new backup keeps the newest 10 local copies." },
    { id: "machine-snapshots", title: "Machine snapshots", path: process.env.BOXPILOT_MACHINE_SNAPSHOT_ROOT ?? "/var/lib/boxpilot-managed/machine-snapshots", retention: "Each new snapshot keeps the newest 3." },
    { id: "vm-exports", title: "VM exports", path: process.env.BOXPILOT_VM_EXPORT_ROOT ?? "/var/lib/boxpilot-managed/vm-exports", retention: "Not pruned automatically." },
  ];
}

export function createSpaceRecovery({
  run = fixedRun,
  runUnit = null,
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  housekeeping = createHousekeepingService({ run, dockerBinary }),
  journalctl = process.env.BOXPILOT_JOURNALCTL_BINARY ?? "/usr/bin/journalctl",
  duBinary = "/usr/bin/du",
  journalRoots = ["/var/log/journal", "/run/log/journal"],
  aptCacheRoot = "/var/cache/apt",
  aptListsPartial = "/var/lib/apt/lists/partial",
  jobLogDirectory = process.env.BOXPILOT_JOB_LOG_DIRECTORY ?? defaultJobLogDirectory,
  databasePath = process.env.BOXPILOT_CONTROLLER_DATABASE ?? path.join(process.env.BOXPILOT_STATE_DIRECTORY ?? "/var/lib/boxpilot", "boxpilot.sqlite3"),
  lookupJobs = (ids) => jobStates(ids, databasePath),
  backupRoots = defaultBackupRoots(),
  // The helper runs as root and every log it trusts is root's. Tests pass their own uid.
  expectedUid = 0,
  usageOf = diskUsage,
  now = () => new Date(),
  treeScanLimits = {},
} = {}) {
  const budget = () => createTreeScanBudget(treeScanLimits);
  const docker = (args, options = {}) => run(dockerBinary, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });

  /** Free bytes and inodes of the filesystem holding `target`; null when it cannot be read. */
  async function filesystemOf(target) {
    try {
      const [info, fs] = await Promise.all([stat(target), statfs(target)]);
      return { key: String(info.dev), path: target, freeBytes: Number(fs.bavail) * Number(fs.bsize), totalBytes: Number(fs.blocks) * Number(fs.bsize), freeInodes: Number(fs.ffree), totalInodes: Number(fs.files) };
    } catch { return null; }
  }

  /** Regular files directly inside `directory`, with what they take on disk. Missing is empty. */
  async function filesIn(directory, scan, accept = () => true) {
    const listed = [];
    for (const entry of await listTreeEntries(directory, { budget: scan })) {
      if (!entry.isFile() || !accept(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const info = await lstat(full).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (!info?.isFile()) continue;
      listed.push({ name: entry.name, path: full, bytes: usageOf(info), modifiedAt: info.mtimeMs, ino: info.ino, uid: info.uid });
    }
    return listed;
  }

  // --- the journal ---------------------------------------------------------------------------

  /** Every journal folder (one per machine id, and per namespace) under /var/log/journal and /run/log/journal. */
  async function journalFolders() {
    const scan = budget();
    const folders = [];
    for (const root of journalRoots) {
      for (const entry of await listTreeEntries(root, { budget: scan })) {
        if (!entry.isDirectory() || !/^[0-9a-f]{32}(?:\.[A-Za-z0-9_-]{1,64})?$/.test(entry.name)) continue;
        const directory = path.join(root, entry.name);
        folders.push({ directory, files: await filesIn(directory, scan, (name) => parseJournalFileName(name) !== null) });
      }
    }
    return folders;
  }

  const journalBytes = (folders) => folders.reduce((sum, folder) => sum + folder.files.reduce((total, file) => total + file.bytes, 0), 0);

  // --- job logs --------------------------------------------------------------------------------

  async function jobLogs() {
    const logs = (await filesIn(jobLogDirectory, budget(), (name) => jobIdPattern.test(name.replace(/\.log$/, "")) && name.endsWith(".log")))
      .map((log) => ({ ...log, jobId: log.name.replace(/\.log$/, "") }));
    // Without the job records nothing can be told apart, and a log is never taken on a guess.
    const states = await Promise.resolve().then(() => lookupJobs(logs.map((log) => log.jobId))).catch((error) => { throw Object.assign(new Error(`BoxPilot's job records could not be read: ${error.message}`), { code: "JOB_RECORDS_UNAVAILABLE" }); });
    return logs.map((log) => ({ ...log, job: states.get(log.jobId) ?? null }));
  }

  function jobLogClasses(logs, retentionDays) {
    const nowMs = now().getTime();
    const cutoffMs = nowMs - retentionDays * dayMs;
    const classes = { active: [], "past-retention": [], completed: [], failed: [], unlisted: [] };
    for (const log of logs) classes[classifyJobLog(log, { cutoffMs, nowMs })].push(log);
    return classes;
  }

  /**
   * Remove one completed job's log, checking again at the moment of removal: the folder and the
   * file are root's and nobody else can write them, the file is the one the plan saw, it has not
   * been written to since, and the job is still recorded as completed. Anything else keeps it.
   */
  async function removeJobLog(log, { cutoffMs }) {
    const kept = (reason) => ({ removed: false, reason });
    try {
      const folder = await lstat(jobLogDirectory);
      if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== expectedUid || (folder.mode & 0o022)) return kept("the log folder is not root's alone");
      if (log.path !== jobLogPath(log.jobId, jobLogDirectory)) return kept("not in the job log folder");
      const info = await lstat(log.path);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== expectedUid || (info.mode & 0o022)) return kept("not a file only root can write");
      if (info.ino !== log.ino || info.mtimeMs !== log.modifiedAt) return kept("written to since it was listed");
      if (info.mtimeMs >= cutoffMs || now().getTime() - info.mtimeMs < activeLogGraceMs) return kept("newer than the retention");
      const job = (await Promise.resolve().then(() => lookupJobs([log.jobId]))).get(log.jobId);
      if (job?.state !== "completed") return kept("its job is no longer recorded as completed");
      await unlink(log.path);
      return { removed: true, bytes: usageOf(info) };
    } catch (error) {
      if (error.code === "ENOENT") return { removed: false, reason: "already gone", gone: true };
      return kept(`could not be checked (${error.code ?? "error"})`);
    }
  }

  // --- APT ------------------------------------------------------------------------------------

  /** Exactly what `apt-get clean` deletes: downloaded packages, partial downloads, and the binary caches. */
  async function aptCleanTargets() {
    const scan = budget();
    const archives = path.join(aptCacheRoot, "archives");
    const targets = [
      ...await filesIn(archives, scan, (name) => name !== "lock"),
      ...await filesIn(path.join(archives, "partial"), scan),
      ...await filesIn(aptCacheRoot, scan, (name) => name === "pkgcache.bin" || name === "srcpkgcache.bin"),
      ...await filesIn(aptListsPartial, scan),
    ];
    return targets;
  }

  // --- Docker ----------------------------------------------------------------------------------

  /** Dangling images `docker image prune` (without --all) removes: those no container uses, stopped or not. */
  async function danglingImages() {
    const [dangling, containers] = await Promise.all([housekeeping.internals.danglingLayers(), docker(["ps", "--all", "--no-trunc", "--format", "{{.Image}}"])]);
    if (dangling === null || !containers.ok) return null;
    const used = containers.stdout.split("\n").map((line) => line.trim().replace(/^sha256:/, "")).filter(Boolean);
    const inUse = (image) => used.some((reference) => reference.startsWith(image.id.replace(/^sha256:/, "")));
    return { remove: dangling.filter((image) => !inUse(image)), kept: dangling.filter(inUse) };
  }

  async function dockerRows() {
    const df = await docker(["system", "df", "--format", "json"], { maxBuffer: 2 * 1024 * 1024 });
    return df.ok ? parseDockerSystemDf(df.stdout) : null;
  }

  async function dockerRoot() {
    const info = await docker(["info", "--format", "{{.DockerRootDir}}"], { timeout: 30_000 });
    return info.ok && info.stdout.startsWith("/") ? info.stdout.split("\n")[0].trim() : "/var/lib/docker";
  }

  // --- backups ---------------------------------------------------------------------------------

  /** Each local backup folder's bytes and inodes, and its own retention; application backups per app. */
  async function backupUsage() {
    const roots = [];
    for (const root of backupRoots) {
      try {
        const usage = await measureTreeUsage(root.path, { budget: budget(), usageOf });
        const entry = { id: root.id, title: root.title, path: root.path, ...usage, retention: root.retention };
        if (root.id === "application") entry.beyondNewest = await applicationBackupsBeyondNewest(root.path);
        roots.push(entry);
      } catch (error) {
        roots.push({ id: root.id, title: root.title, path: root.path, bytes: null, inodes: null, files: null, retention: root.retention, unavailable: error.code === "ENOENT" ? "Not created yet" : error.code === "TREE_SCAN_BUDGET" ? "Too large to measure in one pass" : "Could not be read" });
      }
    }
    return roots;
  }

  /** Archives past the newest few of each kind, counted the way Reclaim disk space counts them. */
  async function applicationBackupsBeyondNewest(root) {
    let count = 0; let bytes = 0;
    const scan = budget();
    for (const app of await listTreeEntries(root, { budget: scan })) {
      if (!app.isDirectory()) continue;
      const directory = path.join(root, app.name);
      const archives = (await filesIn(directory, scan, (name) => /^\d{8}T\d{6}Z\.tar\.gz$/.test(name))).sort((left, right) => right.name.localeCompare(left.name));
      const byKind = { checkpoint: [], backup: [] };
      for (const archive of archives) {
        const meta = await readFile(archive.path.replace(/\.tar\.gz$/, ".json"), "utf8").then(JSON.parse).catch(() => null);
        byKind[meta?.checkpoint ? "checkpoint" : "backup"].push(archive);
      }
      for (const archive of [...byKind.checkpoint.slice(defaultKeepBackupsPerApp), ...byKind.backup.slice(defaultKeepBackupsPerApp)]) { count += 1; bytes += archive.bytes; }
    }
    return { count, bytes, keepsPerKind: defaultKeepBackupsPerApp };
  }

  // --- where the space went ---------------------------------------------------------------------

  async function inspectJournal() {
    const [folders, reported] = await Promise.all([journalFolders(), run(journalctl, ["--disk-usage"], { timeout: 60_000 })]);
    const files = folders.flatMap((folder) => folder.files);
    const active = files.filter((file) => parseJournalFileName(file.name)?.kind === "active");
    return {
      id: "journal", title: "System journal", path: journalRoots[0],
      bytes: journalBytes(folders), inodes: files.length + folders.length,
      detail: {
        // journald's own figure, rounded to a tenth of a unit; the byte count above is summed file by file.
        journaldReportedBytes: reported.ok || reported.stdout ? parseJournalDiskUsage(`${reported.stdout}\n${reported.stderr}`) : null,
        folders: folders.length, activeFiles: active.length, activeBytes: active.reduce((sum, file) => sum + file.bytes, 0),
        archivedFiles: files.length - active.length, archivedBytes: files.filter((file) => !active.includes(file)).reduce((sum, file) => sum + file.bytes, 0),
      },
    };
  }

  async function inspectJobLogs() {
    const logs = await jobLogs();
    const classes = jobLogClasses(logs, cleanupBounds.jobLogDefaultDays);
    const summary = (list) => ({ count: list.length, bytes: list.reduce((sum, log) => sum + log.bytes, 0) });
    return {
      id: "job-logs", title: "BoxPilot job logs", path: jobLogDirectory,
      bytes: logs.reduce((sum, log) => sum + log.bytes, 0), inodes: logs.length,
      detail: { retentionDays: cleanupBounds.jobLogDefaultDays, ...Object.fromEntries(Object.entries(classes).map(([name, list]) => [name, summary(list)])) },
    };
  }

  async function inspectApt() {
    const [bytesRun, inodesRun, targets] = await Promise.all([
      run(duBinary, ["--summarize", "--one-file-system", "--block-size=1", aptCacheRoot], { timeout: 60_000 }),
      run(duBinary, ["--summarize", "--one-file-system", "--inodes", aptCacheRoot], { timeout: 60_000 }),
      aptCleanTargets(),
    ]);
    const bytes = parseDuSummary(bytesRun.stdout).get(aptCacheRoot) ?? null;
    const inodes = parseDuSummary(inodesRun.stdout).get(aptCacheRoot) ?? null;
    if (bytes === null && inodes === null) throw Object.assign(new Error("du could not measure the APT cache"), { code: "UNMEASURED" });
    return {
      id: "apt-cache", title: "APT download cache", path: aptCacheRoot, bytes, inodes,
      detail: { cleanableFiles: targets.length, cleanableBytes: targets.reduce((sum, file) => sum + file.bytes, 0), packages: targets.filter((file) => file.name.endsWith(".deb")).length },
    };
  }

  async function inspectDocker() {
    const [rows, dangling, root] = await Promise.all([dockerRows(), danglingImages().catch(() => null), dockerRoot()]);
    if (!rows) throw Object.assign(new Error("Docker did not answer"), { code: "DOCKER_UNAVAILABLE" });
    return {
      id: "docker", title: "Docker", path: root,
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0), inodes: null,
      detail: {
        rows,
        danglingImages: dangling ? { count: dangling.remove.length, bytes: dangling.remove.reduce((sum, image) => sum + image.bytes, 0), usedByContainers: dangling.kept.length } : null,
      },
    };
  }

  async function inspectBackups() {
    const roots = await backupUsage();
    const measured = roots.filter((root) => root.bytes !== null);
    return {
      id: "backups", title: "Local backups", path: measured[0]?.path ?? null,
      bytes: measured.reduce((sum, root) => sum + root.bytes, 0), inodes: measured.reduce((sum, root) => sum + root.inodes, 0),
      detail: { roots },
    };
  }

  const unavailableReason = (error) => error?.code === "TREE_SCAN_BUDGET" ? "Too large to measure in one pass"
    : error?.code === "DOCKER_UNAVAILABLE" ? "Docker did not answer"
      : error?.code === "JOB_RECORDS_UNAVAILABLE" ? "BoxPilot's job records could not be read"
      : error?.code === "EACCES" || error?.code === "EPERM" ? "Could not be read"
        : "Could not be measured";

  /** Bytes and inodes per category, and the free space and inodes of the filesystems they sit on. */
  async function inspect() {
    const titles = { journal: "System journal", "job-logs": "BoxPilot job logs", "apt-cache": "APT download cache", docker: "Docker", backups: "Local backups" };
    const readers = [["journal", inspectJournal], ["job-logs", inspectJobLogs], ["apt-cache", inspectApt], ["docker", inspectDocker], ["backups", inspectBackups]];
    const settled = await Promise.allSettled(readers.map(([, read]) => read()));
    // Unavailable is never zero: a category that could not be read has no numbers, only the reason.
    const categories = settled.map((result, index) => (result.status === "fulfilled"
      ? { ...result.value, available: true, unavailable: null, humanBytes: result.value.bytes === null ? null : humanBytes(result.value.bytes) }
      : { id: readers[index][0], title: titles[readers[index][0]], available: false, unavailable: unavailableReason(result.reason), bytes: null, inodes: null, humanBytes: null, detail: null }));
    const filesystems = new Map();
    for (const category of categories) {
      if (!category.available || !category.path) continue;
      const filesystem = await filesystemOf(category.path);
      if (!filesystem) continue;
      category.filesystem = filesystem.key;
      const known = filesystems.get(filesystem.key) ?? { ...filesystem, categories: [] };
      known.categories.push(category.id);
      filesystems.set(filesystem.key, known);
    }
    return { generatedAt: now().toISOString(), categories, filesystems: [...filesystems.values()] };
  }

  // --- the plan: exactly what a cleanup with these bounds removes ------------------------------

  function boundsOf(parameters) {
    const problem = validateParameters(cleanupParameters, parameters ?? {}, "Disk-space cleanup");
    if (problem) throw new Error(problem);
    return {
      categories: cleanupCategoryIds.filter((id) => parameters.categories.includes(id)),
      journalMaxBytes: parameters.journalMaxBytes ?? null,
      journalMaxAgeDays: parameters.journalMaxAgeDays ?? null,
      jobLogRetentionDays: parameters.jobLogRetentionDays ?? cleanupBounds.jobLogDefaultDays,
    };
  }

  const listItems = (entries, describe) => ({ items: entries.slice(0, listedItems).map(describe), more: Math.max(0, entries.length - listedItems) });

  async function planJournal(bounds) {
    const folders = await journalFolders();
    const planned = folders.map((folder) => ({ folder, ...planJournalFolder(folder.files, { maxBytes: bounds.journalMaxBytes, maxAgeDays: bounds.journalMaxAgeDays, now: now().getTime() }) }));
    const remove = planned.flatMap((entry) => entry.remove);
    const keptArchived = planned.flatMap((entry) => entry.kept);
    const active = planned.reduce((sum, entry) => sum + entry.activeFiles, 0);
    const limits = [bounds.journalMaxBytes !== null ? `each journal folder is within ${humanBytes(bounds.journalMaxBytes)}` : null, bounds.journalMaxAgeDays !== null ? `no archived file starts more than ${days(bounds.journalMaxAgeDays)} ago` : null].filter(Boolean);
    return {
      public: {
        bound: `Archived journal files, oldest first, until ${limits.join(" and ")} (journalctl ${journalVacuumArgs({ maxBytes: bounds.journalMaxBytes, maxAgeDays: bounds.journalMaxAgeDays }).join(" ")}).`,
        bytes: remove.reduce((sum, file) => sum + file.bytes, 0), inodes: remove.length,
        ...listItems(remove, (file) => ({ what: file.path, bytes: file.bytes, at: isoFromMicroseconds(file.realtimeUs) })),
        keeping: [
          `${plural(active, "active journal file")} (${humanBytes(planned.reduce((sum, entry) => sum + entry.activeBytes, 0))}), which journald is writing and never deletes`,
          ...(keptArchived.length ? [`${plural(keptArchived.length, "archived file")} within the bound (${humanBytes(keptArchived.reduce((sum, file) => sum + file.bytes, 0))})`] : []),
        ],
      },
      candidates: remove,
      measure: async () => journalBytes(await journalFolders()),
      remaining: async () => present(remove),
      path: journalRoots[0],
    };
  }

  async function planJobLogs(bounds) {
    const classes = jobLogClasses(await jobLogs(), bounds.jobLogRetentionDays);
    const remove = classes["past-retention"];
    const size = (list) => humanBytes(list.reduce((sum, log) => sum + log.bytes, 0));
    const saved = (log) => (log.job?.savedBytes === null || log.job?.savedBytes === undefined ? "no copy in Activity" : log.job.savedBytes >= log.bytes ? "Activity keeps its output" : "Activity keeps the end of its output");
    return {
      public: {
        bound: `Logs of completed jobs last written more than ${days(bounds.jobLogRetentionDays)} ago.`,
        bytes: remove.reduce((sum, log) => sum + log.bytes, 0), inodes: remove.length,
        ...listItems(remove, (log) => ({ what: `${log.jobId}.log`, bytes: log.bytes, at: new Date(log.modifiedAt).toISOString(), detail: saved(log) })),
        keeping: [
          ...(classes.active.length ? [`${plural(classes.active.length, "log")} of jobs still running or written in the last hour (${size(classes.active)})`] : []),
          ...(classes.failed.length ? [`${plural(classes.failed.length, "log")} of failed or cancelled jobs, the record of what went wrong (${size(classes.failed)})`] : []),
          ...(classes.completed.length ? [`${plural(classes.completed.length, "completed job's log", "completed jobs' logs")} newer than ${days(bounds.jobLogRetentionDays)} (${size(classes.completed)})`] : []),
          ...(classes.unlisted.length ? [`${plural(classes.unlisted.length, "log")} of jobs Activity no longer lists (${size(classes.unlisted)}); Reclaim disk space removes those after 90 days`] : []),
        ],
      },
      candidates: remove,
      measure: async () => (await filesIn(jobLogDirectory, budget(), (name) => name.endsWith(".log"))).reduce((sum, log) => sum + log.bytes, 0),
      remaining: async () => present(remove),
      path: jobLogDirectory,
    };
  }

  async function planApt() {
    const targets = await aptCleanTargets();
    const packages = targets.filter((file) => file.name.endsWith(".deb"));
    return {
      public: {
        bound: "Downloaded package files and APT's rebuildable package cache (apt-get clean).",
        bytes: targets.reduce((sum, file) => sum + file.bytes, 0), inodes: targets.length,
        ...listItems([...packages, ...targets.filter((file) => !packages.includes(file))], (file) => ({ what: file.path, bytes: file.bytes })),
        keeping: ["The package lists, so the next install only downloads its own packages"],
      },
      candidates: targets,
      measure: async () => (await aptCleanTargets()).reduce((sum, file) => sum + file.bytes, 0),
      remaining: async () => present(targets),
      path: aptCacheRoot,
    };
  }

  async function planDocker() {
    const dangling = await danglingImages();
    if (!dangling) throw Object.assign(new Error("Docker did not answer"), { code: "DOCKER_UNAVAILABLE" });
    const imagesBytes = async () => (await dockerRows())?.find((row) => /^images$/i.test(row.type))?.bytes ?? null;
    return {
      public: {
        bound: "Dangling images no container uses (docker image prune, without --all).",
        bytes: dangling.remove.reduce((sum, image) => sum + image.bytes, 0), inodes: null,
        ...listItems(dangling.remove, (image) => ({ what: image.id, bytes: image.bytes })),
        keeping: [
          "Every tagged image, every container, every volume, and the build cache",
          ...(dangling.kept.length ? [`${plural(dangling.kept.length, "dangling image")} a container still uses`] : []),
          "Sizes are Docker's; layers an image shares with a kept one are not freed",
        ],
      },
      candidates: dangling.remove,
      measure: imagesBytes,
      remaining: async () => {
        const after = await housekeeping.internals.danglingLayers();
        return after === null ? null : dangling.remove.filter((image) => after.some((left) => left.id === image.id)).map((image) => image.id);
      },
      path: await dockerRoot(),
    };
  }

  /** The planned files still on disk, by path; null when that cannot be checked. */
  async function present(files) {
    const still = [];
    for (const file of files) {
      const there = await lstat(file.path).then(() => true, (error) => (error.code === "ENOENT" ? false : null));
      if (there !== false) still.push(file.path);
    }
    return still;
  }

  const planners = { journal: planJournal, "job-logs": planJobLogs, "apt-cache": planApt, "docker-dangling": planDocker };
  const cleanupTitles = { journal: "System journal", "job-logs": "BoxPilot job logs", "apt-cache": "APT download cache", "docker-dangling": "Dangling Docker images" };

  async function prepare(parameters) {
    const bounds = boundsOf(parameters);
    const internal = new Map();
    const categories = [];
    for (const id of bounds.categories) {
      try {
        const planned = await planners[id](bounds);
        internal.set(id, planned);
        categories.push({ id, title: cleanupTitles[id], available: true, unavailable: null, ...planned.public, humanBytes: humanBytes(planned.public.bytes) });
      } catch (error) {
        // A category that cannot be read is not cleaned: nothing runs blind.
        categories.push({ id, title: cleanupTitles[id], available: false, unavailable: unavailableReason(error), bound: null, bytes: 0, inodes: 0, items: [], more: 0, keeping: [], humanBytes: humanBytes(0) });
      }
    }
    const available = categories.filter((category) => category.available);
    const totalBytes = available.reduce((sum, category) => sum + category.bytes, 0);
    return {
      bounds,
      internal,
      plan: {
        generatedAt: now().toISOString(),
        bounds: { journalMaxBytes: bounds.journalMaxBytes, journalMaxAgeDays: bounds.journalMaxAgeDays, jobLogRetentionDays: bounds.jobLogRetentionDays },
        categories,
        totalBytes, totalHumanBytes: humanBytes(totalBytes),
        totalInodes: available.reduce((sum, category) => sum + (category.inodes ?? 0), 0),
      },
    };
  }

  /** The preview: what these bounds remove now, what that frees, and what stays. Changes nothing. */
  async function plan(parameters) {
    return (await prepare(parameters)).plan;
  }

  // --- the cleanup -------------------------------------------------------------------------------

  async function carryOut(id, planned, bounds, { say, jobLog }) {
    if (id === "journal") {
      if (!runUnit) throw new Error("Vacuuming the journal needs the root task runner, which is not available");
      const result = await runUnit.runTask("journal.vacuum", { maxBytes: bounds.journalMaxBytes, maxAgeDays: bounds.journalMaxAgeDays }, { timeoutMs: 10 * 60_000, logPath: jobLog?.path ?? null });
      return { reportedFreedBytes: result?.freedBytes ?? null, removed: result?.deleted ?? null };
    }
    if (id === "apt-cache") {
      if (!runUnit) throw new Error("Cleaning the APT cache needs the root task runner, which is not available");
      await runUnit.runTask("apt.clean", {}, { timeoutMs: 10 * 60_000, logPath: jobLog?.path ?? null });
      return { reportedFreedBytes: null, removed: planned.candidates.length };
    }
    if (id === "docker-dangling") {
      // Dangling only: no --all, which would take every image no container uses, and never
      // `system prune` or `volume prune`, which take stopped apps' containers and their data.
      say("$ docker image prune --force");
      const result = await docker(["image", "prune", "--force"], { timeout: 10 * 60_000 });
      if (!result.ok) throw new Error(`docker image prune failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
      const reclaimed = /Total reclaimed space:\s*(.+)$/m.exec(result.stdout)?.[1]?.trim() ?? null;
      return { reportedFreedBytes: reclaimed ? parseDockerSize(reclaimed) : null, removed: planned.candidates.length };
    }
    // Job logs: removed here, one at a time, each checked again before it goes.
    const cutoffMs = now().getTime() - bounds.jobLogRetentionDays * dayMs;
    let removed = 0; const kept = [];
    for (const log of planned.candidates) {
      const outcome = await removeJobLog(log, { cutoffMs });
      if (outcome.removed) removed += 1;
      else if (!outcome.gone) { kept.push({ what: `${log.jobId}.log`, reason: outcome.reason }); say(`  kept ${log.jobId}.log: ${outcome.reason}`); }
    }
    return { reportedFreedBytes: null, removed, kept };
  }

  /**
   * Work the plan out again from the same bounds, carry out each chosen category, and measure what
   * went: the category's own bytes before and after, and the free space on its filesystem. A
   * planned item still there afterwards is reported, and the category is not counted as verified.
   */
  async function cleanup(parameters, { progress = null, jobLog = null } = {}) {
    const say = (line, stream = "stdout") => progress?.(line, stream);
    const { bounds, internal, plan: planned } = await prepare(parameters);
    const results = [];
    for (const category of planned.categories) {
      const base = { id: category.id, title: category.title, plannedBytes: category.bytes, plannedItems: category.inodes };
      if (!category.available) {
        say(`${category.title}: skipped, ${category.unavailable.toLowerCase()}.`, "stderr");
        results.push({ ...base, done: false, verified: false, skipped: category.unavailable });
        continue;
      }
      const work = internal.get(category.id);
      if (!work.candidates.length) {
        say(`${category.title}: nothing past the bound.`);
        results.push({ ...base, done: true, verified: true, freedBytes: 0, removed: 0 });
        continue;
      }
      say(`${category.title}: ${category.bound} ${plural(work.candidates.length, "item")}, ${category.humanBytes}.`);
      const [measuredBefore, filesystemBefore] = await Promise.all([work.measure().catch(() => null), filesystemOf(work.path)]);
      let outcome = null; let error = null;
      try { outcome = await carryOut(category.id, work, bounds, { say, jobLog }); } catch (caught) { error = caught; say(`${category.title} could not be cleaned: ${caught.message}`, "stderr"); }
      const [measuredAfter, filesystemAfter, remaining] = await Promise.all([work.measure().catch(() => null), filesystemOf(work.path), work.remaining().catch(() => null)]);
      // Job logs the recheck kept are reported as kept, not as a cleanup that failed to happen.
      const keptOnPurpose = new Set((outcome?.kept ?? []).map((entry) => path.join(jobLogDirectory, entry.what)));
      const stillThere = remaining === null ? null : remaining.filter((entry) => !keptOnPurpose.has(entry));
      const freedBytes = measuredBefore !== null && measuredAfter !== null ? Math.max(0, measuredBefore - measuredAfter) : null;
      const verified = !error && stillThere !== null && stillThere.length === 0;
      say(`  freed ${freedBytes === null ? "an amount that could not be measured" : humanBytes(freedBytes)}${filesystemBefore && filesystemAfter && filesystemBefore.key === filesystemAfter.key ? `; the filesystem has ${humanBytes(filesystemAfter.freeBytes)} free` : ""}${stillThere?.length ? `; ${plural(stillThere.length, "planned item")} still there` : ""}.`, verified ? "stdout" : "stderr");
      results.push({
        ...base,
        done: !error,
        verified,
        error: error?.message ?? null,
        removed: outcome?.removed ?? null,
        kept: outcome?.kept ?? [],
        freedBytes,
        freedHumanBytes: freedBytes === null ? null : humanBytes(freedBytes),
        reportedFreedBytes: outcome?.reportedFreedBytes ?? null,
        filesystem: filesystemBefore && filesystemAfter && filesystemBefore.key === filesystemAfter.key
          ? { path: work.path, freeBytesBefore: filesystemBefore.freeBytes, freeBytesAfter: filesystemAfter.freeBytes, freeInodesBefore: filesystemBefore.freeInodes, freeInodesAfter: filesystemAfter.freeInodes }
          : null,
        stillThere: stillThere === null ? null : stillThere.slice(0, listedItems),
      });
    }
    const freedBytes = results.reduce((sum, result) => sum + (result.freedBytes ?? 0), 0);
    const failures = results.filter((result) => result.error || result.skipped);
    if (failures.length) {
      const message = failures.map((result) => `${result.title}: ${result.error ?? result.skipped}`).join("; ");
      // The categories that did run stay done; the job fails so the owner sees which did not.
      throw Object.assign(new Error(`Freed ${humanBytes(freedBytes)}, but not everything chosen was cleaned. ${message}`), { result: results });
    }
    say(`Done. Freed ${humanBytes(freedBytes)}, measured before and after.`);
    return { cleaned: true, verified: results.every((result) => result.verified), bounds: planned.bounds, categories: results, freedBytes, freedHumanBytes: humanBytes(freedBytes) };
  }

  return { inspect, plan, cleanup, internals: { journalFolders, jobLogs, aptCleanTargets, danglingImages, removeJobLog, filesystemOf } };
}
