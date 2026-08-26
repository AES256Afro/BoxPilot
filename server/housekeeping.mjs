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
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "./exec.mjs";

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

/** Bytes in a directory tree, following nothing and tolerating races. */
async function directorySize(target) {
  let total = 0;
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else total += await stat(full).then((info) => info.size, () => 0);
    }
  };
  await walk(target);
  return total;
}

/** Every category `inspect` reports and `reclaim` accepts, in the order they are shown. */
export const categoryIds = Object.freeze([
  "boxpilot-versions", "docker-unused", "docker-unreferenced-images", "app-backups", "restore-leftovers", "job-logs",
]);

export const humanBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

/** A `docker system df` reclaimable cell, which reads like "1.1GB (32%)". */
function parseReclaimable(cell) {
  const match = /^\s*([\d.]+\s*[KMGT]?B)/i.exec(String(cell ?? ""));
  return match ? parseDockerSize(match[1]) : 0;
}

/** Docker's own size accounting, which is the only source that understands shared layers. */
function parseDockerSize(text) {
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
  jobLogDirectory = process.env.BOXPILOT_JOB_LOG_DIRECTORY ?? "/var/lib/boxpilot/job-logs",
  apps = null,
  runUnit = null,
  keepBackupsPerApp = 3,
  jobLogMaxAgeDays = 90,
  now = () => new Date(),
} = {}) {
  const docker = (args, options = {}) => run(dockerBinary, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });

  /** Releases of BoxPilot left in /opt by past upgrades, newest kept as the rollback target. */
  async function previousTrees() {
    const entries = await readdir(installRoot, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const entry of entries) {
      const kind = previousTreeKind(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !kind) continue;
      const full = path.join(installRoot, entry.name);
      if (path.resolve(full) === path.resolve(currentTree)) continue;
      const info = await stat(full).catch(() => null);
      if (info) found.push({ path: full, name: entry.name, kind, at: info.mtimeMs, bytes: await directorySize(full) });
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
    if (!listed.ok) return [];
    return listed.stdout.split("\n").filter(Boolean).map((line) => {
      const [id, size] = line.split("\t");
      return { id, bytes: parseDockerSize(size) };
    });
  }

  async function imageInventory() {
    const listed = await docker(["images", "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}", "--filter", "dangling=false"]);
    if (!listed.ok) return null;
    const inUse = new Set();
    const containers = await docker(["ps", "--all", "--format", "{{.Image}}"]);
    if (containers.ok) for (const line of containers.stdout.split("\n")) if (line.trim()) inUse.add(line.trim());
    const installedReferences = new Set();
    if (apps) {
      const inspection = await apps.inspect({}).catch(() => null);
      for (const application of inspection?.applications ?? []) {
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
    return images;
  }

  /** Backup archives past the newest few for each app. */
  async function oldApplicationBackups() {
    const entries = await readdir(applicationBackupRoot, { withFileTypes: true }).catch(() => []);
    const stale = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(applicationBackupRoot, entry.name);
      const names = (await readdir(directory).catch(() => [])).filter((name) => /^\d{8}T\d{6}Z\.tar\.gz$/.test(name)).sort().reverse();
      for (const name of names.slice(keepBackupsPerApp)) {
        const full = path.join(directory, name);
        const info = await stat(full).catch(() => null);
        stale.push({ app: entry.name, path: full, meta: full.replace(/\.tar\.gz$/, ".json"), bytes: info?.size ?? 0 });
      }
    }
    return stale;
  }

  /** Directories a restore left behind when it could not finish putting things back. */
  async function restoreLeftovers() {
    const entries = await readdir(catalogRoot, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const appDirectory = path.join(catalogRoot, entry.name);
      for (const child of await readdir(appDirectory, { withFileTypes: true }).catch(() => [])) {
        if (!child.isDirectory() || !/\.(replaced|restoring)$/.test(child.name)) continue;
        const full = path.join(appDirectory, child.name);
        found.push({ path: full, app: entry.name, bytes: await directorySize(full) });
      }
    }
    return found;
  }

  /**
   * Job logs older than the history that could point at them. The database prunes finished jobs
   * after ninety days, so a log older than that belongs to a job nothing lists any more — decided
   * on age rather than by asking the web process, which keeps this side free of that dependency.
   */
  async function orphanedJobLogs() {
    const cutoff = now().getTime() - jobLogMaxAgeDays * 86_400_000;
    const entries = await readdir(jobLogDirectory, { withFileTypes: true }).catch(() => []);
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
    const [trees, images, backups, leftovers, logs, df, dangling] = await Promise.all([
      previousTrees(),
      imageInventory(),
      oldApplicationBackups(),
      restoreLeftovers(),
      orphanedJobLogs(),
      docker(["system", "df", "--format", "json"]),
      danglingLayers(),
    ]);

    const unusedImages = (images ?? []).filter((image) => !image.used);
    const dockerRows = df.ok ? df.stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : [];
    // Only the build cache from `df`. Its "Images reclaimable" counts every image no *running*
    // container holds, which is the other category's job and would be counted twice here.
    const buildCacheBytes = dockerRows.filter((row) => /build cache/i.test(String(row.Type ?? ""))).reduce((sum, row) => sum + parseReclaimable(row.Reclaimable), 0);
    const danglingBytes = dangling.reduce((sum, entry) => sum + entry.bytes, 0);

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
        items: dangling.length || null,
        bytes: danglingBytes + buildCacheBytes,
        detail: [
          ...(dangling.length ? [`${dangling.length} orphaned layer${dangling.length === 1 ? "" : "s"}: ${humanBytes(danglingBytes)}`] : []),
          ...(buildCacheBytes ? [`build cache: ${humanBytes(buildCacheBytes)}`] : []),
        ],
        keeping: [],
        safe: true,
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
      },
      {
        id: "app-backups",
        title: "Older application backups",
        summary: `Backup archives beyond the newest ${keepBackupsPerApp} for each app. The newest ${keepBackupsPerApp} are always kept, and any copy already mirrored off this server is unaffected.`,
        items: backups.length,
        bytes: backups.reduce((sum, entry) => sum + entry.bytes, 0),
        detail: [...new Set(backups.map((entry) => entry.app))].map((app) => `${app}: ${backups.filter((entry) => entry.app === app).length} archive(s)`),
        keeping: [],
        safe: true,
      },
      {
        id: "restore-leftovers",
        title: "Unfinished restores",
        summary: "Folders a restore left behind when it could not finish swapping data back. They are copies, not the live data an app is using.",
        items: leftovers.length,
        bytes: leftovers.reduce((sum, entry) => sum + entry.bytes, 0),
        detail: leftovers.map((entry) => `${entry.app}: ${path.basename(entry.path)}`),
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

    return {
      generatedAt: now().toISOString(),
      categories: categories.map((category) => ({ ...category, humanBytes: humanBytes(category.bytes) })),
      totalBytes: categories.reduce((sum, category) => sum + category.bytes, 0),
      totalHumanBytes: humanBytes(categories.reduce((sum, category) => sum + category.bytes, 0)),
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
      const unused = (images ?? []).filter((entry) => !entry.used);
      say(`Removing ${unused.length} image${unused.length === 1 ? "" : "s"} no app uses.`);
      for (const [index, image] of unused.entries()) {
        // Docker refuses an image a container still holds, which is the guard that matters here.
        const result = await docker(["rmi", image.reference], { timeout: 120_000 });
        if (result.ok) { freedBytes += image.bytes; removed.push({ category: "docker-unreferenced-images", what: image.reference, bytes: image.bytes }); }
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
      const leftovers = await restoreLeftovers();
      say(`Removing ${leftovers.length} folder${leftovers.length === 1 ? "" : "s"} an unfinished restore left behind.`);
      for (const entry of leftovers) {
        await rm(entry.path, { recursive: true, force: true });
        freedBytes += entry.bytes;
        removed.push({ category: "restore-leftovers", what: `${entry.app}/${path.basename(entry.path)}`, bytes: entry.bytes });
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

    say(`Done. ${humanBytes(freedBytes)} back, plus whatever Docker's own prune returned.`);
    return { reclaimed: failures.length === 0, targets: [...chosen], removed, failures, freedBytes, freedHumanBytes: humanBytes(freedBytes) };
  }

  return { inspect, reclaim, internals: { previousTrees, imageInventory, danglingLayers, oldApplicationBackups, restoreLeftovers, orphanedJobLogs, humanBytes } };
}
