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

/** Directories in /opt left behind by past upgrades, under every naming scheme BoxPilot has used. */
const previousTreePattern = /^boxpilot(?:\.prev\.|\.rollback-|-prev-)/;

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

export const humanBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

/** Docker's own size accounting, which is the only source that understands shared layers. */
function parseDockerSize(text) {
  const match = /^([\d.]+)\s*([KMGT]?B)$/i.exec(String(text ?? "").trim());
  if (!match) return 0;
  const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
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
      if (!entry.isDirectory() || entry.isSymbolicLink() || !previousTreePattern.test(entry.name)) continue;
      const full = path.join(installRoot, entry.name);
      if (path.resolve(full) === path.resolve(currentTree)) continue;
      const info = await stat(full).catch(() => null);
      if (info) found.push({ path: full, name: entry.name, at: info.mtimeMs, bytes: await directorySize(full) });
    }
    found.sort((left, right) => right.at - left.at);
    // The newest is what a failed upgrade rolls back to; everything older is finished with.
    return { keep: found.slice(0, 1), remove: found.slice(1) };
  }

  /** Every image on the box, with what references it. */
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
    const [trees, images, backups, leftovers, logs, df] = await Promise.all([
      previousTrees(),
      imageInventory(),
      oldApplicationBackups(),
      restoreLeftovers(),
      orphanedJobLogs(),
      docker(["system", "df", "--format", "json"]),
    ]);

    const unusedImages = (images ?? []).filter((image) => !image.used);
    const dockerRows = df.ok ? df.stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : [];
    const reclaimableFromDf = dockerRows.reduce((sum, row) => sum + parseDockerSize(String(row.Reclaimable ?? "").split(" ")[0] + (String(row.Reclaimable ?? "").match(/[KMGT]?B/) ?? [""])[0]), 0);

    const categories = [
      {
        id: "boxpilot-versions",
        title: "Previous BoxPilot releases",
        summary: "Copies of BoxPilot left in /opt by past updates. The most recent one is kept — that is what a failed update rolls back to.",
        items: trees.remove.length,
        bytes: trees.remove.reduce((sum, entry) => sum + entry.bytes, 0),
        detail: trees.remove.map((entry) => entry.name),
        keeping: trees.keep.map((entry) => entry.name),
        safe: true,
      },
      {
        id: "docker-unused",
        title: "Stopped containers and dangling images",
        summary: "What a Docker prune removes: containers that exited, networks nothing joins, untagged image layers, and the build cache. Nothing in use is touched.",
        items: null,
        bytes: reclaimableFromDf,
        detail: dockerRows.map((row) => `${row.Type}: ${row.Reclaimable ?? "0B"} of ${row.Size ?? "0B"}`),
        keeping: [],
        safe: true,
      },
      {
        id: "docker-unreferenced-images",
        title: "Images no app uses",
        summary: "Complete images that no container references and no installed app needs — left by apps you removed, versions replaced by updates, or a trial run. Installing one of these again downloads it again.",
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
        summary: `Output from jobs older than ${jobLogMaxAgeDays} days, which is longer than the history keeps them — nothing lists those jobs any more.`,
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
  async function reclaim({ targets = [] } = {}) {
    const chosen = new Set(Array.isArray(targets) ? targets : []);
    const removed = [];
    let freedBytes = 0;

    if (chosen.has("boxpilot-versions")) {
      const trees = await previousTrees();
      for (const entry of trees.remove) {
        await rm(entry.path, { recursive: true, force: true });
        freedBytes += entry.bytes;
        removed.push({ category: "boxpilot-versions", what: entry.name, bytes: entry.bytes });
      }
    }

    if (chosen.has("docker-unused")) {
      const result = await docker(["system", "prune", "--force"], { timeout: 10 * 60_000 });
      if (!result.ok) throw new Error(`docker system prune failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
      const reclaimed = result.stdout.match(/Total reclaimed space:\s*(.+)$/m)?.[1] ?? null;
      removed.push({ category: "docker-unused", what: "stopped containers, unused networks, dangling images, build cache", reclaimed });
    }

    if (chosen.has("docker-unreferenced-images")) {
      const images = await imageInventory();
      for (const image of (images ?? []).filter((entry) => !entry.used)) {
        // Docker refuses an image a container still holds, which is the guard that matters here.
        const result = await docker(["rmi", image.reference], { timeout: 120_000 });
        if (result.ok) { freedBytes += image.bytes; removed.push({ category: "docker-unreferenced-images", what: image.reference, bytes: image.bytes }); }
      }
    }

    if (chosen.has("app-backups")) {
      for (const entry of await oldApplicationBackups()) {
        await rm(entry.path, { force: true });
        await rm(entry.meta, { force: true });
        freedBytes += entry.bytes;
        removed.push({ category: "app-backups", what: `${entry.app}/${path.basename(entry.path)}`, bytes: entry.bytes });
      }
    }

    if (chosen.has("restore-leftovers")) {
      for (const entry of await restoreLeftovers()) {
        await rm(entry.path, { recursive: true, force: true });
        freedBytes += entry.bytes;
        removed.push({ category: "restore-leftovers", what: `${entry.app}/${path.basename(entry.path)}`, bytes: entry.bytes });
      }
    }

    if (chosen.has("job-logs")) {
      for (const entry of await orphanedJobLogs()) {
        await rm(entry.path, { force: true });
        freedBytes += entry.bytes;
        removed.push({ category: "job-logs", what: path.basename(entry.path), bytes: entry.bytes });
      }
    }

    return { reclaimed: true, targets: [...chosen], removed, freedBytes, freedHumanBytes: humanBytes(freedBytes) };
  }

  return { inspect, reclaim, internals: { previousTrees, imageInventory, oldApplicationBackups, restoreLeftovers, orphanedJobLogs, humanBytes } };
}
