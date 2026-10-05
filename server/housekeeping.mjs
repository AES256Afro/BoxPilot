/**
 * What is taking up room that nothing needs any more.
 *
 * A home server fills up quietly: images for apps that were removed, superseded versions left
 * behind by updates, BoxPilot's own previous releases, backup archives older than anyone will
 * restore. None of it is visible from one place, and `docker system df` only knows about the
 * Docker half — the 3.8 GB of old BoxPilot trees under /opt does not appear anywhere.
 *
 * Every category here answers three questions: what it is, how much it is, and why it is safe to
 * remove. Anything that could still be wanted — an image a container uses, the release BoxPilot
 * would roll back to, the newest backups — is never a candidate, and says so.
 */
import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
// The writer decides where job logs live; a second copy of that path here is the one that drifts.
// This category spent a month scanning a directory nothing had ever written to.
import { defaultJobLogDirectory } from "./job-log.mjs";
import path from "node:path";
import { fixedRun } from "./exec.mjs";
import { shared } from "./cache.mjs";
import { createTreeScanBudget, listTreeEntries, measureTreeBytes } from "./tree-scan.mjs";
import { snapshotBackupReferences, snapshotLeftoverKind } from "./machine-snapshot-helper.mjs";

/**
 * Directories in /opt left behind by past upgrades, under every naming scheme BoxPilot has used.
 *
 * They fall into two kinds, and the difference decides what is kept. A **revert** tree is a working
 * copy of a version that ran here, so the newest one is worth keeping: it is what you would move
 * back into place by hand if a release turned out badly. A **spent** tree is neither — a build that
 * has already been swapped in or a version that failed its health check and was rolled away — and
 * only the most recent failure is worth keeping, as the evidence for why it failed.
 *
 * The upgrade script prunes just two of its own `.prev.` trees and has never known about the
 * others, so on a box updated as often as this one they pile up unseen: nothing lists /opt.
 */
const previousTreeKinds = [
  { kind: "revert", pattern: /^boxpilot(?:\.prev\.|\.rollback-|-prev-|-live-before-)/ },
  { kind: "spent", pattern: /^boxpilot(?:-candidate-|\.failed\.)/ },
];

/** Which kind of leftover a directory name is, or null if it is not one. */
function previousTreeKind(name) {
  return previousTreeKinds.find((entry) => entry.pattern.test(name))?.kind ?? null;
}

/** Every category `inspect` reports and `reclaim` accepts, in the order they are shown. */
export const categoryIds = Object.freeze([
  "boxpilot-versions", "docker-unused", "docker-unreferenced-images", "app-backups", "restore-leftovers", "snapshot-leftovers", "job-logs",
]);

export const humanBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

/** How many of each kind of application backup "Older application backups" always keeps. */
export const defaultKeepBackupsPerApp = 3;

/**
 * The copies of BoxPilot's database an update takes before it swaps the code in (M36,
 * scripts/boxpilot-upgrade.sh): `boxpilot-rollback-<version>-<UTC stamp>.sqlite3` beside the
 * database. Copies made by hand before the script took them itself used the same prefix, sometimes
 * without the stamp, so any `boxpilot-rollback-*.sqlite3` counts. Nothing removes them on its own:
 * which go is the owner's call, by a rule the owner sets and a list the owner reads first.
 */
export const databaseCopyPattern = /^boxpilot-rollback-([A-Za-z0-9._+-]{1,80})\.sqlite3$/;
const stampedCopyPattern = /^boxpilot-rollback-(.+)-(\d{8}T\d{6}Z)\.sqlite3$/;
/** The rule's defaults: the newest three, and anything younger than thirty days. */
export const defaultDatabaseCopyRule = Object.freeze({ keep: 3, keepDays: 30 });
export const databaseCopyLimits = Object.freeze({ keep: [1, 50], keepDays: [0, 3650] });
/**
 * The first release whose startup masks secrets stored in the database (M29.3). A copy taken from
 * an older version was taken before that ran, so it may still hold passwords and tokens that the
 * live database no longer does.
 */
export const secretScrubVersion = "1.127.0";

/** "20260816T101500Z" as a time, or null. */
function stampTime(stamp) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp ?? "");
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) : null;
}

/** Numeric x.y.z order, enough to tell a copy from before the scrub; anything unparsed sorts low. */
function olderThan(version, than) {
  const parts = (value) => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? "")) ?? []).slice(1).map(Number);
  const [a, b] = [parts(version), parts(than)];
  if (a.length !== 3) return true;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index];
  return false;
}

/**
 * Which copies a rule lets go of: everything except the newest `keep` and any taken less than
 * `keepDays` days ago. Pure; `copies` carry `takenAt` in milliseconds. Each copy comes back with
 * `goes` and, when kept, why.
 */
export function planDatabaseCopies(copies, { keep = defaultDatabaseCopyRule.keep, keepDays = defaultDatabaseCopyRule.keepDays, now = Date.now() } = {}) {
  const newestFirst = [...copies].sort((left, right) => right.takenAt - left.takenAt || right.name.localeCompare(left.name));
  const cutoff = now - keepDays * 86_400_000;
  return newestFirst.map((copy, index) => {
    const keptBecause = index < keep ? "newest" : copy.takenAt > cutoff ? "recent" : null;
    return { ...copy, goes: keptBecause === null, keptBecause };
  });
}

/**
 * One copy from its file name and what `lstat` said: the version it was taken from and when (the
 * stamp in the name, or the file's time for a copy made by hand without one), its size, and whether
 * it predates the secret scrub.
 */
export function describeDatabaseCopy(name, { bytes, mtimeMs }) {
  const stamped = stampedCopyPattern.exec(name);
  const version = stamped ? stamped[1] : (databaseCopyPattern.exec(name)?.[1] ?? "unknown");
  const takenAt = (stamped && stampTime(stamped[2])) ?? mtimeMs;
  return { name, version, takenAt, bytes, heldSecrets: olderThan(version, secretScrubVersion) };
}

/** What `housekeeping.database-copies.inspect` answers, from the copies and a rule. Pure. */
export function databaseCopyReport(copies, { rule, now, directory }) {
  const planned = planDatabaseCopies(copies, { ...rule, now });
  const going = planned.filter((copy) => copy.goes);
  const goesBytes = going.reduce((sum, copy) => sum + copy.bytes, 0);
  return {
    directory,
    rule,
    defaults: defaultDatabaseCopyRule,
    limits: databaseCopyLimits,
    secretScrubVersion,
    copies: planned.map((copy) => ({ ...copy, takenAt: new Date(copy.takenAt).toISOString(), humanBytes: humanBytes(copy.bytes) })),
    goes: going.map((copy) => copy.name),
    goesBytes,
    goesHumanBytes: humanBytes(goesBytes),
    totalHumanBytes: humanBytes(planned.reduce((sum, copy) => sum + copy.bytes, 0)),
  };
}

/** A rule from parameters: integers within the limits, or the defaults. Throws on anything else. */
export function databaseCopyRule({ keep = defaultDatabaseCopyRule.keep, keepDays = defaultDatabaseCopyRule.keepDays } = {}) {
  for (const [name, value] of Object.entries({ keep, keepDays })) {
    const [low, high] = databaseCopyLimits[name];
    if (!Number.isInteger(value) || value < low || value > high) throw new Error(`${name} must be a whole number from ${low} to ${high}`);
  }
  return { keep, keepDays };
}

/** A `docker system df` reclaimable cell, which reads like "1.1GB (32%)". */
export function parseReclaimable(cell) {
  const match = /^\s*([\d.]+\s*[KMGT]?B)/i.exec(String(cell ?? ""));
  return match ? parseDockerSize(match[1]) : 0;
}

/** Docker's own size accounting, which is the only source that understands shared layers. */
export function parseDockerSize(text) {
  const match = /^([\d.]+)\s*([KMGT]?B)$/i.exec(String(text ?? "").trim());
  if (!match) return 0;
  // Powers of 1000, because that is what the Docker CLI printed. It formats every size this way —
  // "1.7GB" means 1.7 billion bytes, not 1.7 GiB — so reading them as powers of 1024 overstated
  // every figure by 7%, on the one screen whose whole job is telling you how much you get back.
  const scale = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Math.round(Number(match[1]) * (scale[match[2].toUpperCase()] ?? 1));
}

export function createHousekeepingService({
  run = fixedRun,
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  installRoot = "/opt",
  currentTree = "/opt/boxpilot",
  catalogRoot = process.env.BOXPILOT_CATALOG_ROOT ?? "/var/lib/boxpilot-managed/catalog",
  applicationBackupRoot = path.join(process.env.BOXPILOT_APPLICATION_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups", "catalog"),
  jobLogDirectory = process.env.BOXPILOT_JOB_LOG_DIRECTORY ?? defaultJobLogDirectory,
  machineSnapshotRoot = process.env.BOXPILOT_MACHINE_SNAPSHOT_ROOT ?? "/var/lib/boxpilot-managed/machine-snapshots",
  tarBinary = process.env.BOXPILOT_TAR_BINARY ?? "/usr/bin/tar",
  apps = null,
  runUnit = null,
  keepBackupsPerApp = defaultKeepBackupsPerApp,
  jobLogMaxAgeDays = 90,
  // Where the database lives, and so where the update's copies of it are (the helper's unit names it).
  liveDatabase = process.env.BOXPILOT_CONTROLLER_DATABASE ?? "/var/lib/boxpilot/boxpilot.sqlite3",
  now = () => new Date(),
  treeScanLimits = {},
} = {}) {
  const docker = (args, options = {}) => run(dockerBinary, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });
  const copyDirectory = path.dirname(path.resolve(liveDatabase));

  /** Every copy beside the database, with its size (the file and any -wal, -shm or -journal beside it). */
  async function listDatabaseCopies() {
    const entries = await readdir(copyDirectory, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const copies = [];
    for (const entry of entries) {
      if (!entry.isFile() || !databaseCopyPattern.test(entry.name)) continue;
      const full = path.join(copyDirectory, entry.name);
      if (full === path.resolve(liveDatabase)) continue;
      const info = await lstat(full).catch(() => null);
      if (!info?.isFile()) continue;
      let bytes = info.size;
      for (const suffix of ["-wal", "-shm", "-journal"]) bytes += (await lstat(`${full}${suffix}`).catch(() => null))?.size ?? 0;
      copies.push(describeDatabaseCopy(entry.name, { bytes, mtimeMs: info.mtimeMs }));
    }
    return copies;
  }

  /**
   * The update's database copies and what a rule would do with them (M36): every copy, newest
   * first, each saying whether it goes, and the totals. Read-only; the owner reads this list before
   * approving the removal, and the removal takes exactly the names it showed.
   */
  async function databaseCopies(parameters = {}) {
    return databaseCopyReport(await listDatabaseCopies(), { rule: databaseCopyRule(parameters), now: now().getTime(), directory: copyDirectory });
  }

  /**
   * Remove the copies the owner saw listed. A name goes only if it was listed AND the same rule,
   * applied now, still lets it go: a copy an update took since the list was read, or one that became
   * one of the newest, stays whatever the list said. Nothing outside the directory, nothing that is
   * not a copy, and never the live database.
   */
  async function removeDatabaseCopies({ keep, keepDays, names = [], progress = null } = {}) {
    const rule = databaseCopyRule({ keep, keepDays });
    if (!Array.isArray(names) || names.length === 0) throw new Error("Name the copies to remove");
    const listed = new Set(names);
    const planned = planDatabaseCopies(await listDatabaseCopies(), { ...rule, now: now().getTime() });
    const say = (message, stream = "stdout") => progress?.(message, stream);
    const removed = [];
    const kept = [];
    let freedBytes = 0;
    for (const name of listed) {
      const copy = planned.find((entry) => entry.name === name);
      if (!copy) { kept.push({ name, reason: "not among the copies" }); say(`${name}: not among the copies`); continue; }
      if (!copy.goes) { kept.push({ name, reason: copy.keptBecause === "newest" ? `now one of the newest ${rule.keep}` : `younger than ${rule.keepDays} days` }); say(`${name}: kept, it is ${copy.keptBecause === "newest" ? `now one of the newest ${rule.keep}` : `younger than ${rule.keepDays} days`}`); continue; }
      const full = path.join(copyDirectory, name);
      try {
        for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${full}${suffix}`, { force: true });
        await rm(full);
        removed.push(name);
        freedBytes += copy.bytes;
        say(`removed ${name} (${humanBytes(copy.bytes)})`);
      } catch (error) {
        kept.push({ name, reason: error.message });
        say(`could not remove ${name}: ${error.message}`, "stderr");
      }
    }
    const left = planned.filter((copy) => !removed.includes(copy.name)).length;
    say(`Removed ${removed.length} of ${listed.size} (${humanBytes(freedBytes)}); ${left} cop${left === 1 ? "y" : "ies"} remain${left === 1 ? "s" : ""}.`);
    return { removed, kept, freedBytes, freedHumanBytes: humanBytes(freedBytes), remaining: left, rule };
  }

  /** Releases of BoxPilot left in /opt by past upgrades, newest kept as the rollback target. */
  async function previousTrees({ budget = createTreeScanBudget(treeScanLimits) } = {}) {
    const entries = await listTreeEntries(installRoot, { budget });
    const found = [];
    for (const entry of entries) {
      const kind = previousTreeKind(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !kind) continue;
      const full = path.join(installRoot, entry.name);
      if (path.resolve(full) === path.resolve(currentTree)) continue;
      const info = await stat(full).catch(() => null);
      if (info) found.push({ path: full, name: entry.name, kind, at: info.mtimeMs, bytes: await measureTreeBytes(full, { budget }) });
    }
    found.sort((left, right) => right.at - left.at);
    // The newest of each kind stays: the version you would revert to by hand, and the last failed
    // upgrade's tree, which is the evidence for why it failed. Everything behind them is finished
    // with — several of these naming schemes belong to updaters BoxPilot no longer ships.
    const keep = previousTreeKinds.map(({ kind }) => found.find((entry) => entry.kind === kind)).filter(Boolean);
    return { keep, remove: found.filter((entry) => !keep.includes(entry)) };
  }

  /** Every image on the box, with what references it. */
  /** Untagged layers an image update left behind. Nothing can reference these by name. */
  async function danglingLayers() {
    const listed = await docker(["images", "--filter", "dangling=true", "--format", "{{.ID}}\t{{.Size}}"]);
    if (!listed.ok) return null;
    return listed.stdout.split("\n").filter(Boolean).map((line) => {
      const [id, size] = line.split("\t");
      return { id, bytes: parseDockerSize(size) };
    });
  }

  async function imageInventory() {
    const listed = await docker(["images", "--no-trunc", "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}", "--filter", "dangling=false"]);
    if (!listed.ok) return null;
    const inUse = new Set();
    const containers = await docker(["ps", "--all", "--no-trunc", "--format", "{{.Image}}"]);
    if (!containers.ok || !apps) return null;
    for (const line of containers.stdout.split("\n")) if (line.trim()) inUse.add(line.trim());
    const installedReferences = new Set();
    if (apps) {
      const inspection = await apps.inspect({}).catch(() => null);
      if (!Array.isArray(inspection?.applications) || inspection.problems?.length) return null;
      for (const application of inspection.applications) {
        if (!application.installed) continue;
        if (application.installedImage) installedReferences.add(application.installedImage);
        if (application.state?.image?.reference) installedReferences.add(application.state.image.reference);
      }
    }
    const images = [];
    for (const line of listed.stdout.split("\n")) {
      const [reference, id, size] = line.split("\t");
      if (!reference || reference.includes("<none>")) continue;
      images.push({ reference, id, bytes: parseDockerSize(size), used: inUse.has(reference) || installedReferences.has(reference) });
    }
    // Different tags can name one image. A container using any alias protects them all.
    const normalizeId = (value) => value.replace(/^sha256:/, "");
    const usedIds = new Set(images.filter((image) => image.used || inUse.has(image.id) || inUse.has(normalizeId(image.id)) || inUse.has(`sha256:${normalizeId(image.id)}`)).map((image) => normalizeId(image.id)));
    return images.map((image) => ({ ...image, used: image.used || usedIds.has(normalizeId(image.id)) }));
  }

  /**
   * The application backups each retained machine snapshot would restore from: the newest one each
   * app had when the snapshot was taken, which is usually older than the newest few kept here. The
   * same reading an app backup's own pruning asks (machine-snapshot-helper.mjs). Throws when a
   * snapshot cannot be read, so nothing is offered that a restore might still need.
   */
  async function machineSnapshotReferences({ budget }) {
    const names = (await listTreeEntries(machineSnapshotRoot, { budget })).filter((entry) => entry.isFile()).map((entry) => entry.name);
    try {
      return await snapshotBackupReferences({ snapshotRoot: machineSnapshotRoot, names, run, tarBinary });
    } catch (error) {
      throw new Error(`${error.message}, so no application backup is offered for removal`);
    }
  }

  /** What a machine snapshot or a restore of one left when it was cut off (snapshotLeftoverKind). */
  async function snapshotLeftovers({ budget = createTreeScanBudget(treeScanLimits) } = {}) {
    const found = [];
    for (const entry of await listTreeEntries(machineSnapshotRoot, { budget })) {
      const kind = snapshotLeftoverKind(entry.name);
      if (!kind || entry.isSymbolicLink() || (kind === "partial" ? !entry.isFile() : !entry.isDirectory())) continue;
      const full = path.join(machineSnapshotRoot, entry.name);
      const bytes = kind === "partial" ? (await lstat(full).catch(() => null))?.size ?? 0 : await measureTreeBytes(full, { budget });
      found.push({ path: full, name: entry.name, kind, bytes });
    }
    return found;
  }

  /**
   * Backup archives past the newest few for each app. Pre-change checkpoints and the owner's own
   * backups are counted separately, as the app deployer prunes them, so a run of settings changes
   * cannot push every real backup out; and nothing a retained machine snapshot restores from goes.
   */
  async function oldApplicationBackups({ budget = createTreeScanBudget(treeScanLimits) } = {}) {
    const references = await machineSnapshotReferences({ budget });
    const entries = await listTreeEntries(applicationBackupRoot, { budget });
    const stale = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(applicationBackupRoot, entry.name);
      const names = (await listTreeEntries(directory, { budget })).filter((entry) => entry.isFile() && /^\d{8}T\d{6}Z\.tar\.gz$/.test(entry.name)).map((entry) => entry.name).sort().reverse();
      const byKind = { checkpoint: [], backup: [] };
      for (const name of names) {
        const meta = await readFile(path.join(directory, name.replace(/\.tar\.gz$/, ".json")), "utf8").then(JSON.parse).catch(() => null);
        byKind[meta?.checkpoint ? "checkpoint" : "backup"].push(name);
      }
      const referenced = references.get(entry.name) ?? new Set();
      const behind = [...byKind.checkpoint.slice(keepBackupsPerApp), ...byKind.backup.slice(keepBackupsPerApp)].filter((name) => !referenced.has(name)).sort();
      for (const name of behind) {
        const full = path.join(directory, name);
        const info = await lstat(full).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
        if (info?.isFile()) stale.push({ app: entry.name, path: full, meta: full.replace(/\.tar\.gz$/, ".json"), bytes: info.size });
      }
    }
    return stale;
  }

  /** Directories a restore left behind when it could not finish putting things back. */
  async function restoreLeftovers({ budget = createTreeScanBudget(treeScanLimits) } = {}) {
    const entries = await listTreeEntries(catalogRoot, { budget });
    const found = [];
    for (const entry of entries) {
      const match = /^([a-z0-9][a-z0-9-]*)\.(replaced|restoring)$/.exec(entry.name);
      if (!entry.isDirectory() || !match) continue;
      const full = path.join(catalogRoot, entry.name);
      found.push({ path: full, app: match[1], bytes: await measureTreeBytes(full, { budget }) });
    }
    return found;
  }

  /**
   * Job logs older than the history that could point at them. The database prunes finished jobs
   * after ninety days, so a log older than that belongs to a job nothing lists any more — decided
   * on age rather than by asking the web process, which keeps this side free of that dependency.
   */
  async function orphanedJobLogs({ budget = createTreeScanBudget(treeScanLimits) } = {}) {
    const cutoff = now().getTime() - jobLogMaxAgeDays * 86_400_000;
    const entries = await listTreeEntries(jobLogDirectory, { budget });
    const found = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.log$/.test(entry.name)) continue;
      const full = path.join(jobLogDirectory, entry.name);
      const info = await stat(full).catch(() => null);
      if (!info || info.mtimeMs >= cutoff) continue;
      found.push({ path: full, bytes: info.size });
    }
    return found;
  }

  /**
   * Everything reclaimable, as categories the owner can choose between. `knownJobIds` comes from
   * the web process, which is the side that has the database.
   */
  async function inspect() {
    const budget = createTreeScanBudget(treeScanLimits);
    const scans = await Promise.allSettled([
      previousTrees({ budget }), imageInventory(), oldApplicationBackups({ budget }), restoreLeftovers({ budget }),
      orphanedJobLogs({ budget }), docker(["system", "df", "--format", "json"]), danglingLayers(), snapshotLeftovers({ budget }),
    ]);
    const defaults = [{ keep: [], remove: [] }, null, [], [], [], { ok: false, stdout: "" }, null, []];
    const [trees, images, backups, leftovers, logs, df, dangling, snapshotScraps] = scans.map((result, index) => result.status === "fulfilled" ? result.value : defaults[index]);
    const categoryForScan = ["boxpilot-versions", "docker-unreferenced-images", "app-backups", "restore-leftovers", "job-logs", "docker-unused", "docker-unused", "snapshot-leftovers"];
    const unavailable = new Map();
    scans.forEach((result, index) => {
      if (result.status === "rejected") unavailable.set(categoryForScan[index], result.reason?.code === "TREE_SCAN_BUDGET"
        ? "Folder measurement reached its entry, depth or time budget. This category needs further review before cleanup."
        : "This category could not be fully inspected. Retry after checking access and the source.");
    });

    const unusedImages = (images ?? []).filter((image) => !image.used);
    const dockerRows = df.ok ? df.stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : [];
    // Only the build cache from `df`. Its "Images reclaimable" counts every image no *running*
    // container holds, which is the other category's job and would be counted twice here.
    const buildCacheBytes = dockerRows.filter((row) => /build cache/i.test(String(row.Type ?? ""))).reduce((sum, row) => sum + parseReclaimable(row.Reclaimable), 0);
    const danglingBytes = (dangling ?? []).reduce((sum, entry) => sum + entry.bytes, 0);

    const categories = [
      {
        id: "boxpilot-versions",
        title: "Previous BoxPilot releases",
        summary: "Copies of BoxPilot that past updates left in /opt. The most recent working version is kept, so you can still put it back by hand, and so is the last update that failed its health check.",
        items: trees.remove.length,
        bytes: trees.remove.reduce((sum, entry) => sum + entry.bytes, 0),
        detail: trees.remove.map((entry) => entry.name),
        keeping: trees.keep.map((entry) => entry.name),
        safe: true,
      },
      {
        id: "docker-unused",
        title: "Orphaned image layers and build cache",
        summary: "Layers left behind when an image was replaced by a newer version, and what Docker cached while building. Nothing references either; both come back on their own if they are ever needed again.",
        items: dangling?.length || null,
        bytes: danglingBytes + buildCacheBytes,
        detail: [
          ...(dangling?.length ? [`${dangling.length} orphaned layer${dangling.length === 1 ? "" : "s"}: ${humanBytes(danglingBytes)}`] : []),
          ...(buildCacheBytes ? [`build cache: ${humanBytes(buildCacheBytes)}`] : []),
        ],
        keeping: [],
        safe: df.ok && dangling !== null,
        unavailable: !df.ok || dangling === null ? "Docker usage could not be fully inspected. Retry when Docker is available." : null,
      },
      {
        id: "docker-unreferenced-images",
        title: "Images no app uses",
        summary: "Complete images that no container references and no installed app needs. Left by apps you removed, versions replaced by updates, or a trial run. Installing one of these again downloads it again.",
        items: unusedImages.length,
        bytes: unusedImages.reduce((sum, image) => sum + image.bytes, 0),
        detail: unusedImages.slice(0, 40).map((image) => `${image.reference} (${humanBytes(image.bytes)})`),
        keeping: [],
        safe: images !== null,
        unavailable: images === null ? "Container or installed-app references could not be verified. Retry the scan before cleanup." : null,
      },
      {
        id: "app-backups",
        title: "Older application backups",
        summary: `Backup archives beyond the newest ${keepBackupsPerApp} for each app. The newest ${keepBackupsPerApp} backups and the newest ${keepBackupsPerApp} pre-change checkpoints are always kept, as is any backup a kept machine snapshot restores from, and any copy already mirrored off this server is unaffected.`,
        items: backups.length,
        bytes: backups.reduce((sum, entry) => sum + entry.bytes, 0),
        detail: [...new Set(backups.map((entry) => entry.app))].map((app) => `${app}: ${backups.filter((entry) => entry.app === app).length} archive(s)`),
        keeping: [],
        safe: true,
      },
      {
        id: "restore-leftovers",
        title: "Unfinished restores",
        summary: "Staging or previous-data folders beside an app. A restore may still be running, or this may be the only recoverable original. Review the restore job and backups before moving anything.",
        items: leftovers.length,
        bytes: leftovers.reduce((sum, entry) => sum + entry.bytes, 0),
        detail: leftovers.map((entry) => `${entry.app}: ${path.basename(entry.path)}`),
        keeping: leftovers.map((entry) => path.basename(entry.path)),
        safe: false,
        unavailable: "Recovery evidence. General cleanup cannot remove these folders.",
      },
      {
        id: "snapshot-leftovers",
        title: "Unfinished machine snapshots",
        summary: "What a machine snapshot or a restore of one left when it was cut off part way: a half-written archive, or the folder it was assembled or unpacked in. The folders hold an unencrypted copy of BoxPilot's database and every app's secrets, and nothing reads them again; BoxPilot clears them when it starts. A snapshot or restore running now is finished before these are cleared.",
        items: snapshotScraps.length,
        bytes: snapshotScraps.reduce((sum, entry) => sum + entry.bytes, 0),
        detail: snapshotScraps.map((entry) => entry.name),
        keeping: [],
        safe: true,
      },
      {
        id: "job-logs",
        title: "Logs for jobs no longer listed",
        summary: `Output from jobs older than ${jobLogMaxAgeDays} days, which is longer than the history keeps them; nothing lists those jobs any more.`,
        items: logs.length,
        bytes: logs.reduce((sum, entry) => sum + entry.bytes, 0),
        detail: [],
        keeping: [],
        safe: true,
      },
    ];

    for (const category of categories) if (unavailable.has(category.id)) { category.safe = false; category.unavailable = unavailable.get(category.id); }
    return {
      generatedAt: now().toISOString(),
      categories: categories.map((category) => ({ ...category, humanBytes: humanBytes(category.bytes) })),
      totalBytes: categories.filter((category) => category.safe).reduce((sum, category) => sum + category.bytes, 0),
      totalHumanBytes: humanBytes(categories.filter((category) => category.safe).reduce((sum, category) => sum + category.bytes, 0)),
    };
  }

  /** Clear the chosen categories. Anything not named is left exactly as it was. */
  /**
   * Clear the chosen categories. A category that fails is reported and the rest still run: the
   * first version stopped at the first error, so an /opt permission problem left eighteen
   * gigabytes of unused images in place for a reason that had nothing to do with them.
   */
  async function reclaim({ targets = [], progress = null } = {}) {
    const chosen = new Set(Array.isArray(targets) ? targets : []);
    const unknown = [...chosen].filter((id) => !categoryIds.includes(id));
    if (unknown.length) throw new Error(`Not something this can clear: ${unknown.join(", ")}`);
    const removed = [];
    let freedBytes = 0;
    // Clearing several gigabytes of small files takes minutes. Without a running commentary the
    // job looks stuck, and the honest fix is to say what is going rather than to raise a timeout.
    const say = (message, stream = "stdout") => progress?.(message, stream);
    const failures = [];
    // Each category stands alone. Stopping at the first error meant an /opt permission problem
    // left eighteen gigabytes of unused images in place for a reason unrelated to them.
    const attempt = async (label, work) => {
      try { await work(); }
      catch (error) { failures.push({ category: label, error: error.message }); say(`${label} could not be cleared: ${error.message}`, "stderr"); }
    };

    if (chosen.has("boxpilot-versions")) await attempt("boxpilot-versions", async () => {
      const trees = await previousTrees();
      say(`Removing ${trees.remove.length} previous release${trees.remove.length === 1 ? "" : "s"}, keeping ${trees.keep.map((entry) => entry.name).join(" and ") || "none"}.`);
      // Through the task runner, not from here: this process runs with /opt read-only on purpose,
      // so that a root helper cannot rewrite the application it is part of. Doing it inline failed
      // with EROFS every time, on the largest category the page offers.
      if (!runUnit) throw new Error("Removing previous releases needs the root task runner, which is not available");
      const result = await runUnit.runTask("housekeeping.remove-trees", {
        paths: trees.remove.map((entry) => entry.path), installRoot, currentTree,
      }, { timeoutMs: 20 * 60_000 });
      const gone = new Set(result?.removed ?? []);
      for (const entry of trees.remove) {
        if (!gone.has(path.resolve(entry.path))) continue;
        freedBytes += entry.bytes;
        removed.push({ category: "boxpilot-versions", what: entry.name, bytes: entry.bytes });
      }
      say(`  removed ${gone.size} of ${trees.remove.length}.`);
      for (const refusal of result?.refused ?? []) say(`  kept ${path.basename(refusal.path)}: ${refusal.reason}`, "stderr");
    });

    if (chosen.has("docker-unused")) await attempt("docker-unused", async () => {
      // Deliberately not `docker system prune`. That also removes exited containers and unused
      // networks, and an app you stopped from this very interface is both: pruning deletes its
      // container and its network, and Docker then refuses to start it again — the container is
      // pinned to a network ID that no longer exists, which not even `compose up` recovers from.
      // Dangling layers and the build cache are the two things nothing can be holding.
      for (const [what, args] of [["orphaned image layers", ["image", "prune", "--force"]], ["build cache", ["builder", "prune", "--force"]]]) {
        say(`Clearing ${what}...`);
        const result = await docker(args, { timeout: 10 * 60_000 });
        if (!result.ok) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        removed.push({ category: "docker-unused", what, reclaimed: result.stdout.match(/Total reclaimed space:\s*(.+)$/m)?.[1] ?? null });
      }
    });

    if (chosen.has("docker-unreferenced-images")) await attempt("docker-unreferenced-images", async () => {
      const images = await imageInventory();
      if (!images) throw new Error("Container or installed-app references could not be verified; images were retained");
      const unused = images.filter((entry) => !entry.used);
      say(`Removing ${unused.length} image${unused.length === 1 ? "" : "s"} no app uses.`);
      for (const [index, image] of unused.entries()) {
        // Docker refuses an image a container still holds, which is the guard that matters here.
        const result = await docker(["rmi", image.reference], { timeout: 120_000 });
        if (result.ok) { removed.push({ category: "docker-unreferenced-images", what: image.reference, estimatedImageBytes: image.bytes }); }
        say(`  [${index + 1}/${unused.length}] ${image.reference}${result.ok ? "" : ". Still in use, left alone"}`);
      }
    });

    if (chosen.has("app-backups")) await attempt("app-backups", async () => {
      const stale = await oldApplicationBackups();
      say(`Removing ${stale.length} backup archive${stale.length === 1 ? "" : "s"} behind the newest ${keepBackupsPerApp} of each app.`);
      for (const entry of stale) {
        await rm(entry.path, { force: true });
        await rm(entry.meta, { force: true });
        freedBytes += entry.bytes;
        removed.push({ category: "app-backups", what: `${entry.app}/${path.basename(entry.path)}`, bytes: entry.bytes });
      }
    });

    if (chosen.has("restore-leftovers")) await attempt("restore-leftovers", async () => {
      throw new Error("Unfinished restore folders may contain the only original data or an active restore. Review the restore job and backups; general cleanup preserves them.");
    });

    if (chosen.has("snapshot-leftovers")) await attempt("snapshot-leftovers", async () => {
      // A snapshot or a restore holds the exclusive lane, so none is running beside this.
      const scraps = await snapshotLeftovers();
      say(`Removing ${scraps.length} unfinished machine snapshot${scraps.length === 1 ? "" : "s"} or restore folder${scraps.length === 1 ? "" : "s"}.`);
      for (const entry of scraps) {
        await rm(entry.path, { recursive: entry.kind !== "partial", force: true });
        freedBytes += entry.bytes;
        removed.push({ category: "snapshot-leftovers", what: entry.name, bytes: entry.bytes });
      }
    });

    if (chosen.has("job-logs")) await attempt("job-logs", async () => {
      const logs = await orphanedJobLogs();
      say(`Removing ${logs.length} log${logs.length === 1 ? "" : "s"} for jobs nothing lists any more.`);
      for (const entry of logs) {
        await rm(entry.path, { force: true });
        freedBytes += entry.bytes;
        removed.push({ category: "job-logs", what: path.basename(entry.path), bytes: entry.bytes });
      }
    });

    say(`Done. Removed files total ${humanBytes(freedBytes)} by file size. Docker reports its own reclaimed space; image sizes are excluded because layers may be shared.`);
    return { reclaimed: failures.length === 0, targets: [...chosen], removed, failures, freedBytes, freedHumanBytes: humanBytes(freedBytes) };
  }

  return { inspect: shared(inspect), reclaim, databaseCopies, removeDatabaseCopies, internals: { listDatabaseCopies, previousTrees, imageInventory, danglingLayers, oldApplicationBackups, restoreLeftovers, snapshotLeftovers, orphanedJobLogs, humanBytes } };
}
