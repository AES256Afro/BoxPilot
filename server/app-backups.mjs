/**
 * App backup and restore (helper side, runs as root), for the generic deployer (app-helper.mjs):
 * backing an app up and the checkpoint taken before a change, putting right a backup a power cut
 * interrupted, listing, rehearsing, reviewing and deleting backups, and restoring a whole backup or
 * one path from it. Archives live in <backupRoot>/<id>/<stamp>.tar.gz beside a <stamp>.json.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lchown, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, stat, unlink } from "node:fs/promises";
import { assertArchiveFits } from "./archive-expansion.mjs";
import path from "node:path";
import YAML from "yaml";
import { readFileWithoutFollowing, replaceFileWithoutFollowing, writeFileDurably } from "./durable-file.mjs";
import { deployedImages } from "./catalog/compose.mjs";
import { isDeniedHostPath, keepsBackupData, resolveValues, sanitizeStoredValues } from "./catalog/schema.mjs";
import { keepTimeout } from "./timeouts.mjs";
import { snapshotBackupReferences } from "./machine-snapshot-helper.mjs";
import { appFolderMounts, composeFindingsText, composeSha256, imageRepository, powerfulComposeSettings, sameCompose } from "./catalog/compose-review.mjs";
import { readArchiveMembers } from "./archive-members.mjs";
import { homepageSyncFile } from "./app-homepage.mjs";

/**
 * The limits one app backup runs within, and so a checkpoint's: stopping the app, writing the
 * archive, starting it again. An operation that takes a checkpoint before its change budgets the
 * ceiling on top of its own steps (ops/apps.mjs), or the checkpoint alone could outlast the job.
 */
const backupLimitsMs = Object.freeze({ stop: 2 * 60_000, archive: 60 * 60_000, start: 3 * 60_000 });
export const checkpointCeilingMs = backupLimitsMs.stop + backupLimitsMs.archive + backupLimitsMs.start;

export const backupNamePattern = /^\d{8}T\d{6}Z\.tar\.gz$/;
/** Pre-change checkpoints kept per app, counted separately from the owner's own backups. */
const checkpointKeep = 5;
/** What a backup in progress leaves in the app's folder, saying what it stopped (see backup). */
const backupMarkerFile = ".boxpilot-backup-in-progress.json";
/**
 * The files BoxPilot itself writes, as root, at the top of an app's folder, and the temporary names
 * they are written under. A backup is unpacked into that folder, so a restore must never bring back a
 * symbolic link at any of these names (see linksWhereBoxPilotWrites): the next write would follow it.
 */
const projectFileNames = Object.freeze([".env", "compose.yaml", "boxpilot.json", homepageSyncFile]);
const scratchFileNames = Object.freeze([...projectFileNames.map((name) => `${name}.tmp`), backupMarkerFile, `${backupMarkerFile}.tmp`]);

async function sha256File(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * The host devices a compose file hands its services (`/dev/ttyUSB0:/dev/ttyUSB0`), host side only.
 * Empty for a file that names none or does not parse.
 */
function composeDevices(composeText) {
  let parsed = null;
  try { parsed = YAML.parse(String(composeText ?? "")); } catch { return []; }
  const devices = new Set();
  for (const service of Object.values(parsed?.services && typeof parsed.services === "object" ? parsed.services : {})) {
    for (const entry of Array.isArray(service?.devices) ? service.devices : []) {
      const host = typeof entry === "string" ? entry.split(":")[0] : entry?.source;
      if (typeof host === "string" && host.startsWith("/dev/")) devices.add(host);
    }
  }
  return [...devices];
}

/**
 * The app backup and restore operations, sharing the deployer's own steps rather than copies of
 * them: `compose`, `waitHealthy`, `assertPortsFree` and `renderProject` are the ones install and
 * update use, so a restore starts an app exactly as a deploy does.
 *
 * @param {{
 *   root: string,
 *   backupRoot: string,
 *   machineSnapshotRoot: string,
 *   tarBinary: string,
 *   runCommand: typeof import("./exec.mjs").fixedRun,
 *   catalog: ReturnType<typeof import("./catalog/index.mjs").createCatalogService>,
 *   wait: (ms: number) => Promise<unknown>,
 *   clock: () => Date,
 *   realpathOf: (target: string) => Promise<string>,
 *   freeBytesOf: (directory: string) => Promise<number>,
 *   restoreReserveBytes: number,
 *   idPattern: RegExp,
 *   dirFor: (id: string) => string,
 *   presentIds: () => Promise<Set<string> | null>,
 *   readState: (id: string) => Promise<any>,
 *   ensureManifest: (id: string) => Promise<any>,
 *   containerStatus: (id: string) => Promise<any>,
 *   compose: (id: string, args: string[], options?: { progress?: ((line: string, stream: string) => void) | null, timeout?: number }) => ReturnType<typeof import("./exec.mjs").fixedRun>,
 *   waitHealthy: (manifest: any, progress?: ((line: string, stream: string) => void) | null) => Promise<any>,
 *   assertPortsFree: (manifest: any, composeText: string, options?: { progress?: ((line: string, stream: string) => void) | null, refused?: string }) => Promise<{ warnings: string[] }>,
 *   renderProject: (manifest: any, values: any, options?: { existingEnv?: Record<string, string>, devices?: string[] | null }) => Promise<ReturnType<typeof import("./catalog/compose.mjs").renderCompose>>,
 *   readProjectFiles: (id: string) => Promise<{ compose: string | null, env: string | null }>,
 *   withSavedSecrets: (manifest: any, raw: any, existingEnv: Record<string, string>) => any,
 *   redact: (value: unknown) => string,
 *   parseEnvFile: (text: unknown) => Record<string, string>,
 *   resolveExisting: (target: string, options?: { realpath?: (target: string) => Promise<string> }) => Promise<string>,
 * }} dependencies `root` is the resolved catalog root; the rest are createAppHelper's own options and steps.
 */
/**
 * An image a backup or a saved boxpilot.json names, kept only when it is the catalog's own image for
 * that service at another tag or digest. Those files can come from a drive or a mirror someone else
 * writes, and whatever they name runs with everything the catalog grants the app (the Docker socket,
 * host networking, devices): a different repository is never taken from them.
 */
export function catalogImagePin(candidate, catalogReference) {
  return typeof candidate === "string" && candidate && imageRepository(candidate) === imageRepository(catalogReference) ? candidate : null;
}

export function createAppBackups({ root, backupRoot, machineSnapshotRoot, tarBinary, runCommand, catalog, wait, clock, realpathOf, freeBytesOf, restoreReserveBytes, idPattern, dirFor, presentIds, readState, ensureManifest, containerStatus, compose, waitHealthy, assertPortsFree, renderProject, readProjectFiles, withSavedSecrets, redact, parseEnvFile, resolveExisting }) {
  const backupDirFor = (id) => path.join(path.resolve(backupRoot), id);

  /** Where a backup in progress says what it stopped and what it is writing (see backup). */
  const interruptedBackupMarker = (id) => path.join(dirFor(id), backupMarkerFile);
  /** Flush a file's data to disk before it is renamed into place. */
  async function syncFile(file) {
    const handle = await open(file, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  /**
   * Backups a power cut or a restart cut off: each app whose marker is still there, with what the
   * backup had stopped and the archive it was writing. Read when the helper starts, before it takes
   * a request; a marker that cannot be read says nothing it could act on and is left alone.
   */
  async function interruptedBackups() {
    const ids = await presentIds();
    const found = [];
    for (const id of [...ids ?? []].filter((entry) => idPattern.test(entry)).sort()) {
      const text = await readFileWithoutFollowing(interruptedBackupMarker(id)).catch(() => null);
      if (text === null) continue;
      let marker = null;
      try { marker = JSON.parse(text); } catch { marker = null; }
      if (marker && typeof marker === "object") found.push({ id, restart: marker.restart === true, partial: typeof marker.partial === "string" ? marker.partial : null, startedAt: marker.startedAt ?? null });
    }
    return found;
  }

  /**
   * Put right what an interrupted backup left: its half-written archive is removed, and an app it
   * had stopped is started again. Docker never starts a container stopped by hand, whatever its
   * restart policy, so after a power cut during the nightly backup the app stayed down until
   * someone noticed. The caller has waited for Docker first (waitForDocker); the start is still
   * tried a few times. A marker gone by now was settled by a backup that ran meanwhile, which
   * started the app again or left it as the owner had it: nothing is done.
   */
  async function resumeInterruptedBackup({ id, restart, partial }, { attempts = 3, delayMs = 5_000 } = {}) {
    if (!(await stat(interruptedBackupMarker(id)).then(() => true, () => false))) return { id, removedPartial: false, restarted: false, settled: true };
    let removedPartial = false;
    if (partial && /^\d{8}T\d{6}Z\.tar\.gz\.partial$/.test(partial)) {
      const file = path.join(backupDirFor(id), partial);
      removedPartial = await stat(file).then(() => rm(file, { force: true }).then(() => true), () => false);
    }
    let started = false;
    let error = null;
    for (let attempt = 1; restart && !started && attempt <= attempts; attempt += 1) {
      const result = await compose(id, ["start"], { timeout: 180_000 });
      if (result.ok) started = true;
      else {
        error = redact(result.stderr).split("\n").filter(Boolean).slice(-2).join(" ") || "docker compose start failed";
        if (attempt < attempts) await wait(delayMs);
      }
    }
    if (!restart || started) await rm(interruptedBackupMarker(id), { force: true });
    return { id, removedPartial, restarted: started, ...(restart && !started ? { error } : {}) };
  }

  /**
   * Back up several apps in one job (M35: Repair's "Back up now" for every app that has gone without
   * one). Each is backed up exactly as app.backup does it, one after another so only one app is
   * stopped at a time; one that fails does not stop the others, and the job fails at the end naming
   * it, with the others' backups kept.
   */
  async function backupMany({ ids, keep = 5 }, { progress = null } = {}) {
    const done = []; const failed = [];
    for (const id of ids) {
      progress?.(`── ${id} ──`, "stdout");
      try {
        const result = await backup({ id, keep }, { progress });
        done.push({ id, artifact: result.artifact, sizeBytes: result.sizeBytes });
      } catch (error) {
        failed.push({ id, error: error.message });
        progress?.(`${id}: ${error.message}`, "stderr");
      }
    }
    if (failed.length) throw new Error(`${failed.map((entry) => `${entry.id}: ${entry.error}`).join("; ")}${done.length ? `. ${done.map((entry) => entry.id).join(", ")} ${done.length === 1 ? "was" : "were"} backed up.` : ""}`);
    return { backedUp: true, apps: done };
  }

  /**
   * Pre-change checkpoint (M6.7): an ordinary app backup taken right before an update, a
   * settings change, or a compose edit, so the change can be undone from the card's Restore.
   * Only managed volumes flagged for backup are archived (config-sized, not media libraries).
   *
   * Checkpoints are tagged and pruned only against each other. Pruning them with the owner's
   * backups meant a handful of settings tweaks replaced every good nightly with copies of a broken
   * state, and a file restore from the oldest backup deleted that backup before extracting from it.
   * `preserve` names an archive the caller is about to read, which no prune may remove.
   */
  async function checkpoint({ id, reason, preserve = null }, { progress = null } = {}) {
    progress?.(`Checkpoint before ${reason}: backing up current data first`, "stdout");
    const result = await backup({ id, keep: checkpointKeep, checkpointReason: reason, preserve }, { progress });
    return { artifact: result.artifact, checksumSha256: result.checksumSha256, sizeBytes: result.sizeBytes, downtimeMs: result.downtimeMs };
  }

  /**
   * What is at `relative` in an app's folder, as a backup would archive it, never following a link:
   * `{ state: "present" }`, `{ state: "absent" }`, `{ state: "link", at, target }` for a link on the
   * way or at the name, or `{ state: "other", at }` for a project file that is not a plain file.
   */
  async function archivedEntry(directory, relative, kind) {
    const parts = relative.split("/").filter(Boolean);
    let current = directory;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const info = await lstat(current).catch((error) => { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; });
      if (!info) return { state: "absent" };
      const at = parts.slice(0, index + 1).join("/");
      if (info.isSymbolicLink()) return { state: "link", at, target: await readlink(current).catch(() => "somewhere else") };
      if (index < parts.length - 1 && !info.isDirectory()) return { state: "absent" };
      if (index === parts.length - 1 && kind === "file" && !info.isFile()) return { state: "other", at };
    }
    return { state: "present" };
  }

  /** Why a backup was refused for what archivedEntry found. */
  function unfitWords(manifest, directory, unfit) {
    const links = unfit.filter((entry) => entry.state === "link");
    const said = unfit.map((entry) => (entry.state === "link" ? `${entry.at} is a link to ${entry.target}` : `${entry.at} is not a plain file`)).join(", and ");
    const one = links.length === 1;
    const why = links.length
      ? `: a backup would hold only the link${one ? "" : "s"}, none of what ${one ? "it points" : "they point"} at, and a restore refuses a link where BoxPilot writes ${manifest.name}'s files as root. Move the data back into ${links.map((entry) => path.join(directory, entry.at)).join(" and ")}, or mount the other disk there itself rather than linking to it, then back up again.`
      : `, which BoxPilot never writes there, and a restore refuses. Remove ${unfit.length === 1 ? "it" : "them"}, then save ${manifest.name}'s settings again, which writes its project files afresh.`;
    return `${manifest.name} was not backed up; nothing was stopped. In its folder ${said}${why}`;
  }

  /**
   * Consistent backup of an app's managed data: stop, tar the compose project plus every
   * backup-flagged managed volume, restart, then prune to `keep` copies. hostPath volumes
   * (locations the operator manages) are listed as skipped, never silently included.
   */
  /** `checkpointReason` and `preserve` are for checkpoint() only; the registry operation passes neither. */
  async function backup({ id, keep = 5, checkpointReason = null, preserve = null }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state) throw new Error(`${manifest.name} has no data to back up`);
    if (keep !== null && (!Number.isInteger(keep) || keep < 1 || keep > 30)) throw new Error("keep must be a whole number between 1 and 30");
    const directory = dirFor(id);
    // What goes into the archive is looked at first, never through a link (R5B3-1): tar archives a
    // link as a link, so a data folder the owner moved to another disk and linked back made backups
    // holding only the link, which the rehearsal passed and every restore refuses.
    const unfit = [];
    const contents = [];
    const add = async (relative, kind) => {
      const found = await archivedEntry(directory, relative, kind);
      if (found.state === "present") contents.push(relative);
      else if (found.state !== "absent") unfit.push(found);
    };
    await add("boxpilot.json", "file");
    // Uninstalled apps have no compose.yaml.
    for (const name of ["compose.yaml", ".env"]) await add(name, "file");
    const skippedHostPaths = [];
    const skippedVolumes = [];
    for (const volume of manifest.volumes) {
      // Anything not going into the archive is recorded, so the owner is told what a backup leaves out
      // — whether it is a folder they chose or a volume the manifest does not archive.
      if (!volume.backup || !volume.path) {
        if (volume.hostPath) skippedHostPaths.push(volume.hostPath);
        else if (volume.path) skippedVolumes.push(volume.label ?? volume.id);
        continue;
      }
      await add(volume.path, "folder");   // absent: not created yet
    }
    for (const sidecar of manifest.sidecars ?? []) {
      for (const volume of sidecar.volumes) {
        if (!volume.backup) continue;
        await add(volume.path, "folder");
      }
    }
    if (unfit.length) throw new Error(unfitWords(manifest, directory, unfit));
    const status = await containerStatus(id);
    const wasRunning = status.running;
    const backupDirectory = backupDirFor(id);
    // Names are second-granular; a checkpoint followed by a restore's safety copy can land in
    // the same second, so step forward until the name is free instead of overwriting.
    let stamp = null; let artifact = null;
    for (let offset = 0; offset < 120; offset += 1) {
      stamp = new Date(clock().getTime() + offset * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      artifact = path.join(backupDirectory, `${stamp}.tar.gz`);
      if (!(await stat(artifact).then(() => true, () => false))) break;
      if (offset === 119) throw new Error("Could not find a free backup name");
    }
    // The archive is written under a name no listing reads, and takes its own only once it is whole
    // and described, so a backup cut off part-way is never counted as one, pruned against, or mirrored.
    const partial = `${artifact}.partial`;
    // Said on disk before the app stops. A power cut or a restart mid-backup leaves the app stopped
    // by hand, which Docker's unless-stopped never undoes, and half an archive; the helper's next
    // start reads this and puts both right (resumeInterruptedBackup).
    // A marker already here is a backup cut off whose resume is still waiting for Docker: the app it
    // stopped is started again after this one, as the resume would have, and its half archive goes.
    const cutOff = await readFileWithoutFollowing(interruptedBackupMarker(id)).then((text) => { try { return JSON.parse(text); } catch { return null; } }, () => null);
    const restartAfter = wasRunning || cutOff?.restart === true;
    if (typeof cutOff?.partial === "string" && /^\d{8}T\d{6}Z\.tar\.gz\.partial$/.test(cutOff.partial)) await rm(path.join(backupDirectory, cutOff.partial), { force: true }).catch(() => {});
    await replaceFileWithoutFollowing(interruptedBackupMarker(id), JSON.stringify({ startedAt: clock().toISOString(), partial: path.basename(partial), restart: restartAfter }), { mode: 0o600 });
    const started = clock().getTime();
    let downtimeMs = null;
    let restartError = null;
    let meta = null;
    try {
      if (wasRunning) {
        progress?.(`Stopping ${manifest.name} for a consistent backup...`, "stdout");
        const stop = await compose(id, ["stop"], { timeout: backupLimitsMs.stop, progress });
        if (!stop.ok) throw new Error(`docker compose stop failed: ${redact(stop.stderr).split("\n").slice(-3).join(" ")}`);
      }
      try {
        await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
        progress?.(`$ tar -czf ${stamp}.tar.gz ${contents.join(" ")}`, "stdout");
        const archive = await runCommand(tarBinary, ["-czf", partial, "-C", directory, ...contents], { timeout: backupLimitsMs.archive, maxBuffer: 4 * 1024 * 1024 });
        if (!archive.ok) throw new Error(`tar failed: ${archive.stderr.split("\n").slice(-2).join(" ")}`);
      } catch (error) {
        await rm(partial, { force: true }).catch(() => {});
        // Said with the failure: a start that did not work left the app down while the job spoke
        // only of tar (a full disk fails both).
        const back = restartAfter ? await compose(id, ["start"], { timeout: backupLimitsMs.start, progress }).catch((failure) => ({ ok: false, stderr: failure.message })) : { ok: true };
        if (!back.ok) throw new Error(`${String(error.message).replace(/[.\s]+$/, "")}. ${manifest.name} did not start again either: ${redact(back.stderr ?? "").split("\n").slice(-3).join(" ") || "docker compose start failed"}`);
        throw error;
      } finally {
        if (wasRunning) downtimeMs = clock().getTime() - started;
      }
      if (restartAfter) {
        const start = await compose(id, ["start"], { timeout: backupLimitsMs.start, progress });
        if (!start.ok) restartError = redact(start.stderr).split("\n").slice(-3).join(" ");
      }
      await syncFile(partial);
      const [checksumSha256, artifactStat] = await Promise.all([sha256File(partial), stat(partial)]);
      meta = { id, createdAt: clock().toISOString(), artifact: path.basename(artifact), checksumSha256, sizeBytes: artifactStat.size, downtimeMs, contents, skippedVolumes, skippedHostPaths, image: state.image?.reference ?? null, ...(checkpointReason ? { checkpoint: { reason: checkpointReason } } : {}) };
      await writeFileDurably(path.join(backupDirectory, `${stamp}.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });
      await rename(partial, artifact);
      if (restartError) throw new Error(`The backup succeeded (${path.basename(artifact)}), but ${manifest.name} did not start again: ${restartError}`);
    } finally {
      // Not reached when the process dies mid-backup, which is when the marker is wanted.
      await rm(interruptedBackupMarker(id), { force: true }).catch(() => {});
    }
    let pruned = [];
    // A machine snapshot restores each app from the backup that was its newest when the snapshot was
    // taken, usually older than the newest few kept here, so none of those goes (housekeeping keeps
    // them too). A snapshot that cannot be read could name any of them: then nothing goes this time.
    let referenced = null;
    if (keep !== null) {
      try {
        referenced = (await snapshotBackupReferences({ snapshotRoot: machineSnapshotRoot, run: runCommand, tarBinary })).get(id) ?? new Set();
      } catch (error) {
        // Named, with where to remove it: one damaged snapshot keeps every app's older copies.
        const damaged = Array.isArray(error.unreadable) && error.unreadable.length;
        progress?.(`Kept every older backup of ${manifest.name}: ${error.message}, and one it restores from may be among them.${damaged ? ` If ${error.unreadable.length === 1 ? "it is" : "they are"} damaged, remove ${error.unreadable.length === 1 ? "it" : "them"} from Housekeeping on the System page; until then no app's older backups are removed.` : ""}`, "stderr");
      }
    }
    if (referenced) {
      // Each kind is counted against its own kind only. An archive without metadata is treated as
      // the owner's, so a checkpoint never removes something it cannot identify as a checkpoint.
      const names = (await readdir(backupDirectory)).filter((name) => backupNamePattern.test(name)).sort().reverse();
      const sameKind = [];
      for (const name of names) {
        let entryMeta = null;
        try { entryMeta = JSON.parse(await readFile(path.join(backupDirectory, name.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { entryMeta = null; }
        if (Boolean(entryMeta?.checkpoint) === Boolean(checkpointReason)) sameKind.push(name);
      }
      const behind = sameKind.slice(keep).filter((name) => name !== preserve);
      pruned = behind.filter((name) => !referenced.has(name));
      if (pruned.length < behind.length) progress?.(`Kept ${behind.length - pruned.length} older cop${behind.length - pruned.length === 1 ? "y" : "ies"} a machine snapshot restores ${manifest.name} from`, "stdout");
      for (const name of pruned) {
        await rm(path.join(backupDirectory, name), { force: true });
        await rm(path.join(backupDirectory, name.replace(/\.tar\.gz$/, ".json")), { force: true });
      }
    }
    progress?.(`Backup ${meta.artifact} written (${meta.sizeBytes} bytes)${pruned.length ? `; pruned ${pruned.length} old cop${pruned.length === 1 ? "y" : "ies"}` : ""}`, "stdout");
    return { backedUp: true, ...meta, pruned };
  }

  /**
   * What an app backup leaves out on purpose, which a restore therefore keeps from the app folder it
   * replaces: the folders marked `backup: false` of the app and its sidecars (downloaded models, a
   * cache, an export folder, a mailbox) and the config files the manifest ships (a prometheus.yml),
   * which the deployer writes and the compose file mounts. Relative to the app folder, shortest first.
   * `all` also names what BoxPilot itself keeps beside an app's project and no backup holds (the
   * address Homepage's links are written for): a restore deleted it with the folder it replaced.
   */
  function keptOutOfBackup(manifest) {
    const folders = [...manifest.volumes, ...(manifest.sidecars ?? []).flatMap((sidecar) => sidecar.volumes ?? [])].filter((volume) => volume.path && !volume.backup).map((volume) => volume.path);
    const files = (manifest.files ?? []).map((file) => path.posix.normalize(file.path)).filter((relative) => !relative.startsWith("..") && !path.posix.isAbsolute(relative));
    return { folders, files, all: [...new Set([...folders, ...files, homepageSyncFile])].sort((a, b) => a.length - b.length) };
  }

  /**
   * Why a link the owner left at a folder backups leave out (R5B3-4: downloaded models moved to
   * another disk) cannot be carried into a restored app folder, or null when it can: where it leads,
   * every link resolved (a not-yet-mounted tail too), must pass what an install checks a folder the
   * owner chooses against, a protected system location, and must not be inside BoxPilot's own
   * folders (another app's, this app's own, the backups). A backup never brings such a link: one in
   * an archive at a folder BoxPilot manages is refused before anything changes (linksWhereBoxPilotWrites),
   * and so is a backup of an archived folder that is one (archivedEntry). This one is the owner's,
   * on this server, in the folder the restore replaces.
   */
  async function ownersLinkRefusal(link) {
    const real = await resolveExisting(link, { realpath: realpathOf });
    if (isDeniedHostPath(real)) return `${real}, a protected system location`;
    const inside = (base) => { const relative = path.relative(path.resolve(base), real); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
    if ([root, backupRoot, machineSnapshotRoot].some(inside)) return `${real}, inside BoxPilot's own folders`;
    return null;
  }

  /**
   * Take set-user-id and set-group-id off every regular file under `root`, an archive just unpacked.
   *
   * tar as root reproduces whatever mode an archive names, and an app backup is only as trustworthy
   * as whoever last held the file: a set-user-id binary in it would come back root's, in a folder a
   * container mounts. `--no-same-owner` is not the answer here, as it is for a machine snapshot: it
   * hands every file to root, and an app whose data must belong to its container user (a Postgres
   * data directory, a PUID 1000 app's files) cannot start or write after the restore. Nor is
   * `--no-same-permissions`, which applies the helper's umask (0077) and takes group and other
   * access from files a container reads as another user. So owners and permissions stay as archived,
   * and only these two bits go. Links are never followed; folders keep set-group-id, which grants
   * nothing.
   *
   * And take out everything that is neither a regular file, a folder nor a link (sweep 4). tar as
   * root makes the named pipes an archive lists (the helper's PrivateDevices stops device nodes, and
   * an archive cannot hold a socket, but one is removed all the same): a pipe where BoxPilot or an
   * app later reads waits for ever, and a backup BoxPilot made holds none, since the apps that use
   * one make it again when they start. Removed with a warning naming each rather than refusing the
   * restore, so an app's real data with a stray pipe in it still comes back. Every entry is looked
   * at with lstat, and nothing is followed. Returns both lists, relative to `root`.
   */
  async function settleUnpacked(root, progress = null) {
    const cleared = [];
    const removed = [];
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(full); continue; }
        const info = await lstat(full);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { await walk(full); continue; }
        const relative = path.relative(root, full).split(path.sep).join("/");
        if (!info.isFile()) { await unlink(full); removed.push(relative); continue; }
        if (!(info.mode & 0o6000)) continue;
        await chmod(full, info.mode & 0o1777);
        cleared.push(relative);
      }
    };
    await walk(root);
    cleared.sort(); removed.sort();
    const some = (list) => `${list.slice(0, 10).join(", ")}${list.length > 10 ? ", ..." : ""}`;
    if (cleared.length) progress?.(`Cleared set-user-id and set-group-id from ${cleared.length} file${cleared.length === 1 ? "" : "s"} the backup marked so: ${some(cleared)}`, "stderr");
    if (removed.length) progress?.(specialFilesWords(removed), "stderr");
    return { cleared, removed };
  }

  /** The warning for what settleUnpacked took out of a restore. */
  function specialFilesWords(removed) {
    const one = removed.length === 1;
    return `Not restored: ${removed.slice(0, 10).join(", ")}${removed.length > 10 ? `, and ${removed.length - 10} more` : ""}, ${one ? "a pipe, socket or device" : "pipes, sockets or devices"} in the backup, which BoxPilot does not unpack as root into a folder a container mounts. An app that uses one makes it again when it starts.`;
  }

  /** Whether `relative` is under `base` through real folders only: "present", "absent", or "unsafe" (a link or a file on the way). */
  async function entryAt(base, relative) {
    const parts = relative.split("/");
    let current = base;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const info = await lstat(current).catch((error) => { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; });
      if (!info) return "absent";
      if (index < parts.length - 1 && (info.isSymbolicLink() || !info.isDirectory())) return "unsafe";
    }
    return "present";
  }

  /**
   * Where a backup unpacked into `directory` has a symbolic link at a place BoxPilot writes as root,
   * relative to `directory`, sorted: its project files and their temporary names, the folders it
   * makes and hands to the app's user, and the folders on the way to the config files it ships.
   * A file there that is not a regular file (a pipe, a device) is named too: every later read of it
   * would wait or read a device. So is one with another name (a hard link, R5S2-2): the archive can
   * make boxpilot.json or compose.yaml the same file as one in the app's data folder.
   *
   * A backup is only as trustworthy as whoever last held the file, and tar puts a link wherever the
   * archive says. One at `.env.tmp` made the restore's own rewrite of the project write `.env` over
   * whatever it pointed at; one at `data` would have every later deploy create and chown folders
   * through it, and Docker mount whatever it points at into the container. BoxPilot never writes a
   * link at any of these names, so a backup it made holds none.
   */
  async function linksWhereBoxPilotWrites(directory, manifest) {
    const volumes = [...manifest.volumes, ...(manifest.sidecars ?? []).flatMap((sidecar) => sidecar.volumes ?? [])].filter((volume) => volume.path).map((volume) => volume.path);
    const shipped = keptOutOfBackup(manifest).files;
    const found = new Set();
    for (const relative of [...projectFileNames, ...scratchFileNames, ...volumes, ...shipped]) {
      const parts = path.posix.normalize(relative).split("/").filter((part) => part && part !== ".");
      let current = directory;
      for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        const info = await lstat(current).catch((error) => { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; });
        if (!info) break;
        const name = parts.slice(0, index + 1).join("/");
        if (info.isSymbolicLink()) { found.add(name); break; }
        if ((projectFileNames.includes(name) || scratchFileNames.includes(name)) && !info.isFile()) { found.add(name); break; }
        // A hard link is a regular file too (R5S2-2): boxpilot.json the same file as data/x is a file
        // the container rewrites through its own volume, after every check here has looked at it.
        if (index === parts.length - 1 && !volumes.includes(relative) && info.isFile() && info.nlink > 1) { found.add(name); break; }
      }
    }
    return [...found].sort();
  }

  /**
   * Why a restore of `what` from a backup with `planted` (linksWhereBoxPilotWrites) was refused. A
   * data folder there can be the owner's own doing rather than a crafted archive: one moved to another
   * disk with a link left in its place was archived as that link until backups refused it (R5B3-1).
   */
  function plantedWords(manifest, planted, what = manifest.name) {
    const one = planted.length === 1;
    const folders = new Set([...manifest.volumes, ...(manifest.sidecars ?? []).flatMap((sidecar) => sidecar.volumes ?? [])].filter((volume) => volume.path).map((volume) => path.posix.normalize(volume.path).replace(/\/$/, "")));
    const linkedFolders = planted.filter((name) => folders.has(name));
    const how = linkedFolders.length
      ? ` If ${linkedFolders.join(" and ")} ${linkedFolders.length === 1 ? "was a link" : "were links"} in ${manifest.name}'s folder when this backup was taken (to another disk, say), the backup holds only that link and none of what it pointed at; backups now refuse such a folder instead of taking it.`
      : "";
    return `${what} was not restored; nothing was changed. In this backup ${planted.join(", ")} ${one ? "is a link, or not a plain file," : "are links, or not plain files,"} where BoxPilot writes ${manifest.name}'s own files as root: restored, the next change to ${manifest.name} would have written through ${one ? "it" : "them"} to somewhere else on this server.${how}`;
  }

  /** Backups on disk for one app, newest first. The filesystem is the source of truth. */
  /**
   * How many backups each app has, from one walk of the backup root. The recovery kit needs only
   * the counts, and asking per app cost a helper round trip and a directory walk each.
   */
  async function countAppBackups() {
    const backupRootPath = path.resolve(backupRoot);
    let entries;
    try {
      entries = await readdir(backupRootPath, { withFileTypes: true });
    } catch (error) {
      // A root that does not exist yet genuinely holds nothing; one that cannot be read is
      // unknown, and reporting it as zero would tell the owner every app is unprotected.
      if (error.code !== "ENOENT") return { available: false, counts: {}, reason: error.message };
      entries = [];
    }
    const counts = {};
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const names = await readdir(path.join(backupRootPath, entry.name)).catch(() => []);
      counts[entry.name] = names.filter((name) => backupNamePattern.test(name)).length;
    }
    return { available: true, counts };
  }

  /**
   * Which installed apps actually have a backup, and how old the newest one is.
   *
   * BoxPilot warned when its own database backup went stale and when nothing had been mirrored
   * off-box, but never that an *application* had never been backed up at all — so a server could
   * reach a dozen apps holding passwords, photos and documents with nothing protecting any of
   * them, and nothing saying so. An app counts as protectable when at least one of its volumes is
   * marked for backup; the rest (caches, downloaded models) are excluded on purpose and should not
   * be reported as unprotected.
   */
  async function backupProtection() {
    const { manifests } = await catalog.all();
    const backupRootPath = path.resolve(backupRoot);
    const apps = [];
    let readable = true;
    for (const manifest of manifests) {
      const state = await readState(manifest.id);
      if (!state?.installed) continue;
      const protectable = keepsBackupData(manifest);
      const directory = path.join(backupRootPath, manifest.id);
      let names = [];
      try { names = (await readdir(directory)).filter((name) => backupNamePattern.test(name)); }
      catch (error) { if (error.code !== "ENOENT") readable = false; names = []; }
      let newestAt = null;
      for (const name of names.sort().reverse().slice(0, 1)) {
        const meta = await readFile(path.join(directory, name.replace(/\.tar\.gz$/, ".json")), "utf8").then(JSON.parse).catch(() => null);
        const artifact = await stat(path.join(directory, name)).catch(() => null);
        newestAt = meta?.createdAt ?? artifact?.mtime?.toISOString() ?? null;
      }
      apps.push({ id: manifest.id, name: manifest.name, protectable, backups: names.length, newestAt });
    }
    // A root that cannot be read is unknown, not empty: reporting zero would tell the owner every
    // app is unprotected and invite them to "fix" something that may be fine.
    return { available: readable, apps, generatedAt: clock().toISOString() };
  }

  async function listAppBackups({ id }) {
    await ensureManifest(id);
    const backupDirectory = backupDirFor(id);
    let names = [];
    try { names = (await readdir(backupDirectory)).filter((name) => backupNamePattern.test(name)).sort().reverse(); } catch { names = []; }
    const backups = [];
    for (const name of names) {
      let meta = null;
      try { meta = JSON.parse(await readFile(path.join(backupDirectory, name.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { meta = null; }
      const artifactStat = await stat(path.join(backupDirectory, name)).catch(() => null);
      backups.push({ artifact: name, createdAt: meta?.createdAt ?? artifactStat?.mtime?.toISOString() ?? null, sizeBytes: meta?.sizeBytes ?? artifactStat?.size ?? null, checksumSha256: meta?.checksumSha256 ?? null, downtimeMs: meta?.downtimeMs ?? null, skippedHostPaths: meta?.skippedHostPaths ?? [], skippedVolumes: meta?.skippedVolumes ?? [], image: meta?.image ?? null });
    }
    return { id, directory: backupDirectory, backups };
  }

  /**
   * Rehearse a restore without performing one (M20.3). A checksum proves the bytes are the bytes
   * that were written; it does not prove the archive can be opened, or that what comes out is the
   * app.
   *
   * Nothing is written to disk to find that out. An earlier version of this unpacked the archive
   * into scratch space beside the backups, which was wrong twice over: the off-box mirrors copy
   * that tree and never delete, so a half-extracted `.env` would be pushed to the destination and
   * stay there; and a large app would fill the filesystem holding every backup and every app's
   * live data, unattended, at half past three in the morning.
   *
   * Reading the archive proves as much. `tar -tzf` has to decompress the entire stream to reach
   * every header, so a corrupt byte, a truncated member, or a bad gzip checksum anywhere fails it,
   * and the output is a list of names rather than the data. The compose file is then read on its
   * own, because being able to redeploy from the archive is the thing being rehearsed.
   */
  async function verifyAppBackup({ id, backup: backupName = null }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const backupDirectory = backupDirFor(id);
    const names = await readdir(backupDirectory).catch(() => []);
    const available = names.filter((name) => backupNamePattern.test(name)).sort().reverse();
    const target = backupName ?? available[0] ?? null;
    if (!target) throw new Error(`${manifest.name} has no backup to check`);
    if (!backupNamePattern.test(target)) throw new Error("Backup name is invalid");
    const artifact = path.join(backupDirectory, target);
    const info = await stat(artifact).catch(() => null);
    if (!info) throw new Error(`Backup ${target} does not exist`);
    const startedAt = clock().getTime();
    let meta = null;
    try { meta = JSON.parse(await readFile(path.join(backupDirectory, target.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { meta = null; }

    const fail = (reason) => ({ verified: false, id, backup: target, checkedAt: clock().toISOString(), sizeBytes: info.size, reason, durationMs: clock().getTime() - startedAt });

    if (meta?.checksumSha256) {
      progress?.(`Checking the checksum of ${target}...`, "stdout");
      const actual = await sha256File(artifact);
      if (actual !== meta.checksumSha256) return fail("The archive does not match the checksum recorded when it was written, so it has been damaged since.");
    }
    // Stream the member list rather than buffering it. `tar -tzf` prints one name per file, and an
    // app with a large mail store or photo library has enough files that the whole list would blow
    // a fixed stdout buffer and read as damage on a perfectly good archive. onLine counts them and
    // keeps only the top-level names, so memory stays flat however many files the backup holds.
    progress?.(`$ tar -tzf ${target} (reads the whole archive; writes nothing)`, "stdout");
    const topLevel = new Set();
    let memberCount = 0;
    const shipped = new Set(keptOutOfBackup(manifest).files);
    const shippedInArchive = new Set();
    // The folders a backup archives, each seen as a folder (`data/`, or something under it) or only
    // as a bare name: tar lists a folder with its slash, so `data` alone is a link or a file there,
    // and the backup holds none of the folder's data (R5B3-1).
    const folders = [...manifest.volumes, ...(manifest.sidecars ?? []).flatMap((sidecar) => sidecar.volumes ?? [])].filter((volume) => volume.backup && volume.path).map((volume) => path.posix.normalize(volume.path).replace(/\/$/, ""));
    const bare = new Set();
    const asFolder = new Set();
    const listed = await runCommand(tarBinary, ["-tzf", artifact], {
      timeout: 60 * 60_000,
      onLine: (line, stream) => {
        if (stream !== "stdout") return;   // tar warns on stderr; a warning is not an archive member
        const name = String(line ?? "").trim();
        if (!name) return;
        memberCount += 1;
        const first = name.replace(/^\.\//, "").split("/")[0];
        if (first) topLevel.add(first);
        const member = name.replace(/^\.\//, "").replace(/\/$/, "");
        if (shipped.has(member)) shippedInArchive.add(member);
        const raw = name.replace(/^\.\//, "");
        for (const folder of folders) {
          if (raw === folder) bare.add(folder);
          else if (raw.startsWith(`${folder}/`)) asFolder.add(folder);
        }
      },
    });
    if (!listed.ok) return fail(`The archive could not be read all the way through: ${redact(listed.stderr).split("\n").slice(-2).join(" ")}`);
    const expected = meta?.contents ?? ["compose.yaml"];
    const missing = expected.filter((entry) => !topLevel.has(entry.split("/")[0]));
    if (missing.length) return fail(`The archive is missing ${missing.join(", ")}, which the backup says it contains.`);
    const linked = folders.filter((folder) => bare.has(folder) && !asFolder.has(folder));
    if (linked.length) return fail(`The archive holds ${linked.join(" and ")} as a link, not the folder and what is in it: ${linked.length === 1 ? "it was a link" : "they were links"} in ${manifest.name}'s folder when the backup was taken (to another disk, say), so the backup has none of that data, and a restore refuses it.`);

    // Read the compose file out on its own. No --occurrence: that is GNU tar only, and this has to
    // behave the same wherever it runs. It costs a second pass over the archive, which a weekly
    // background rehearsal can afford.
    const compose = await runCommand(tarBinary, ["-xzOf", artifact, "compose.yaml"], { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    if (!compose.ok || !compose.stdout.trim()) return fail("The archive has no compose.yaml, so it could not be redeployed from.");
    let archivedCompose;
    try { archivedCompose = YAML.parse(compose.stdout); } catch (error) { return fail(`The compose file in the archive is not valid YAML: ${error.message}`); }

    // A config file the manifest ships is never archived: the restore keeps it from the app folder
    // (keptOutOfBackup). One the archived compose file mounts that the folder no longer has would
    // come back as a directory Docker makes in its place, and the app would not start.
    const mountedSources = new Set(Object.values(archivedCompose?.services ?? {}).flatMap((service) => (Array.isArray(service?.volumes) ? service.volumes : []))
      .map((volume) => (typeof volume === "string" ? volume.split(":")[0] : volume?.source))
      .filter((source) => typeof source === "string" && source.startsWith("./"))
      .map((source) => path.posix.normalize(source)));
    const lost = [];
    for (const relative of shipped) {
      if (!mountedSources.has(relative) || shippedInArchive.has(relative)) continue;
      if ((await entryAt(dirFor(id), relative)) !== "present") lost.push(relative);
    }
    if (lost.length) return fail(`Restoring it would leave ${lost.join(", ")} missing: the backup does not hold ${lost.length === 1 ? "that config file" : "those config files"} (${manifest.name} ships them, so no backup does) and ${manifest.name}'s folder no longer has ${lost.length === 1 ? "it" : "them"} to keep, so Docker would make a folder in ${lost.length === 1 ? "its" : "their"} place and ${manifest.name} would not start. Saving ${manifest.name}'s settings again writes ${lost.length === 1 ? "it" : "them"} back.`);

    const durationMs = clock().getTime() - startedAt;
    progress?.(`${target} reads cleanly: ${memberCount} entr${memberCount === 1 ? "y" : "ies"}, compose.yaml valid`, "stdout");
    return { verified: true, id, backup: target, checkedAt: clock().toISOString(), sizeBytes: info.size, entries: topLevel.size, members: memberCount, contents: expected, checksumVerified: Boolean(meta?.checksumSha256), durationMs, reason: null };
  }

  /**
   * Whether a backup's saved settings can write its compose file again for this server, or why it is
   * started exactly as archived instead (`verbatim`): there are none ("no-settings"), the owner
   * edited the file by hand ("edited"), or they no longer fit the catalog ("unfit", with `errors`).
   * `{ values }` when they can. The restore and the review before it both decide here, so what the
   * dialog says will be started verbatim is what the restore starts verbatim.
   */
  function archivedSettingsFit(manifest, state, existingEnv) {
    if (!state || typeof state !== "object") return { verbatim: "no-settings" };
    if (state.rawEdited) return { verbatim: "edited" };
    const { values, errors } = resolveValues(manifest, withSavedSecrets(manifest, sanitizeStoredValues(manifest, state.values ?? {}), existingEnv));
    if (errors.length) return { verbatim: "unfit", errors };
    return { verbatim: null, values };
  }

  /** The first link on the way to `folder` from /, as `{ path, target }`, or null. Never follows one. */
  async function linkOnTheWay(folder) {
    let current = "/";
    for (const part of folder.split("/").filter(Boolean)) {
      current = path.posix.join(current, part);
      const info = await lstat(current).catch(() => null);
      if (!info) return null;
      if (info.isSymbolicLink()) return { path: current, target: await readlink(current).catch(() => "somewhere else") };
    }
    return null;
  }

  /**
   * Why the data folders saved settings point an app at cannot be used, as an install or a settings
   * change would refuse them (sweep 4, writeProject's checkedDataFolders): not a clean absolute path,
   * a `..` on the way, a protected system location, a link anywhere on the way, or a real location
   * that is not the one named. Empty when they can. A restore takes these from boxpilot.json in the
   * backup, which is only as trustworthy as whoever last held it, starts the app on them without a
   * deploy, and every later deploy mounts them. The manifest's own defaults are checked for links too
   * (R5S2-1); the system mounts a manifest declares by name (Docker's socket, /proc) are not folders
   * of data and are left alone, as a deploy leaves them.
   */
  async function dataFolderProblems(manifest, storedValues) {
    const chosen = sanitizeStoredValues(manifest, storedValues ?? {}).volumes;
    const problems = [];
    for (const volume of manifest.volumes) {
      if (!volume.hostPath) continue;
      const value = volume.configurable && Object.hasOwn(chosen, volume.id) ? chosen[volume.id] : volume.hostPath;
      const label = volume.label ?? volume.id;
      if (value !== volume.hostPath) {
        const error = resolveValues(manifest, { volumes: { [volume.id]: value } }).errors.find((entry) => entry.startsWith(`values.volumes.${volume.id}:`));
        if (error) { problems.push(`${label} is set to ${JSON.stringify(String(value).slice(0, 200))}, which ${error.replace(/^values\.volumes\.[^:]+:\s*/, "")}`); continue; }
      }
      if (isDeniedHostPath(value)) continue;
      const folder = value.replace(/\/+$/, "") || "/";
      const link = await linkOnTheWay(folder);
      if (link) { problems.push(`${label} is set to ${folder}, and ${link.path} on the way there is a link to ${link.target}`); continue; }
      const real = await resolveExisting(folder, { realpath: realpathOf });
      if (isDeniedHostPath(real)) problems.push(`${label} is set to ${folder}, which is ${real} on this server, a protected system location`);
      else if (real !== path.resolve(folder)) problems.push(`${label} is set to ${folder}, which is ${real} on this server: a link on the way leads somewhere else`);
    }
    return problems;
  }

  /** A path as the compose file names it: POSIX, and absolute (a Windows test run's C:\ becomes /C:/). */
  const posixPath = (value) => {
    const forward = value.split(path.sep).join("/");
    return forward.startsWith("/") ? forward : `/${forward}`;
  };

  /** The data folders saved settings point the app at (the catalog's default where they name none). */
  function chosenDataFolders(manifest, state) {
    const chosen = sanitizeStoredValues(manifest, state && typeof state === "object" ? state.values ?? {} : {}).volumes;
    return manifest.volumes.filter((volume) => volume.configurable && volume.hostPath).map((volume) => chosen[volume.id] ?? volume.hostPath).filter((folder) => typeof folder === "string" && folder.startsWith("/"));
  }

  /**
   * What a compose file mounts from the app's own folder that is a link in what the backup unpacked
   * (`staged`): `./data` there pointing at `/` is mounted as `/`, since Docker follows it. Listed as
   * powerful settings, like a mount of what it points at.
   */
  async function linkedAppFolderMounts(compose, manifest, roots, staged) {
    const findings = [];
    for (const mount of appFolderMounts(compose, { manifest, managedRoots: roots })) {
      const parts = path.posix.relative(roots[0], mount.path).split("/").filter(Boolean);
      let current = staged;
      for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        const info = await lstat(current).catch(() => null);
        if (!info) break;
        if (!info.isSymbolicLink()) continue;
        const target = await readlink(current).catch(() => "somewhere else");
        findings.push({ service: mount.service, setting: mount.setting, value: mount.shown, detail: `mounts ${parts.slice(0, index + 1).join("/")} from the app's folder, which in this backup is a link to ${target}`, system: true });
        break;
      }
    }
    return findings;
  }

  /**
   * What a backup's project would do if restored (sweep 4): whether its compose file would be
   * started exactly as archived (`verbatim`, `reason`), every setting in it that reaches past what
   * the catalog grants the app (`findings`, catalog/compose-review.mjs), the file's `sha256`, and
   * whether this server already runs that same file (`sameAsRunning`), in which case restoring it
   * grants nothing new. `folderProblems` are data folders an install would refuse.
   *
   * `files` are the archive's compose.yaml, boxpilot.json and .env as text (null when absent);
   * `staged`, when the archive has been unpacked, is where, so the app-folder paths the file mounts
   * can be checked for links. Nothing here is returned to anyone but the helper's caller: no file
   * contents, no secrets.
   */
  async function reviewArchivedProject(manifest, { compose = null, stateText = null, envText = null } = {}, { staged = null } = {}) {
    let state = null;
    try { state = stateText ? JSON.parse(stateText) : null; } catch { state = null; }
    const folderProblems = await dataFolderProblems(manifest, state && typeof state === "object" ? state.values : null);
    const fit = archivedSettingsFit(manifest, state, parseEnvFile(envText ?? ""));
    const result = { verbatim: Boolean(fit.verbatim), reason: fit.verbatim ?? null, folderProblems, findings: [], sha256: null, sameAsRunning: false };
    if (typeof compose !== "string" || !compose.trim()) return result;
    const roots = [posixPath(dirFor(manifest.id)), ...chosenDataFolders(manifest, state)];
    const findings = powerfulComposeSettings(compose, { manifest, appId: manifest.id, managedRoots: roots });
    if (staged) findings.push(...await linkedAppFolderMounts(compose, manifest, roots, staged));
    // The app as it runs now, before anything is replaced. A setting a variable decides is the same
    // only when the .env that decides it is the same too.
    const running = await readFileWithoutFollowing(path.join(dirFor(manifest.id), "compose.yaml")).catch(() => null);
    const runningEnv = findings.some((finding) => finding.variable) ? await readFileWithoutFollowing(path.join(dirFor(manifest.id), ".env")).catch(() => null) : null;
    const sameAsRunning = sameCompose(compose, running) && (!findings.some((finding) => finding.variable) || sameCompose(envText ?? "", runningEnv ?? ""));
    return { ...result, findings, sha256: composeSha256(compose), sameAsRunning };
  }

  /** What the review says, for the restore dialogs: the review and whether the restore needs `allowCompose`. */
  function reviewSummary(manifest, review) {
    const refused = review.verbatim ? review.findings.filter((finding) => finding.refuse) : [];
    const powerful = review.verbatim ? review.findings.filter((finding) => !finding.refuse) : [];
    const refusals = [...review.folderProblems, ...refused.map((finding) => composeFindingsText([finding]))];
    return {
      id: manifest.id, name: manifest.name, verbatim: review.verbatim, reason: review.reason,
      findings: powerful, refusals, sha256: review.verbatim ? review.sha256 : null, sameAsRunning: review.sameAsRunning,
      needsAllow: refusals.length === 0 && powerful.length > 0 && !review.sameAsRunning,
    };
  }

  const verbatimWhy = { edited: "it was edited by hand", "no-settings": "the backup holds no saved settings to write it again from", unfit: "its saved settings no longer fit the catalog" };

  /**
   * The restore's gate on a compose file it is about to start exactly as archived (sweep 4). Nothing
   * to say when it grants nothing past the catalog, or this server already runs that very file. A
   * file that pulls in others, or does not parse, is refused whatever was allowed. Otherwise it is
   * refused unless `allowCompose` is its sha256: the restore dialogs list these settings and a
   * typed confirmation stages the restore with that hash. Returns the warning an allowed one leaves.
   */
  function composeGate(manifest, review, allowCompose) {
    const why = verbatimWhy[review.reason] ?? "it could not be written again from the catalog";
    const refused = review.findings.filter((finding) => finding.refuse);
    if (refused.length) throw Object.assign(new Error(`${manifest.name} was not restored; nothing was changed. Its compose file would be started exactly as it was backed up, since ${why}, and ${composeFindingsText(refused)}, so BoxPilot cannot tell what it would start.`), { code: "compose_refused" });
    if (!review.findings.length || review.sameAsRunning) return null;
    const list = composeFindingsText(review.findings);
    if (allowCompose && allowCompose === review.sha256) return `${manifest.name}'s compose file was started exactly as it was backed up, with the settings you allowed: ${list}.`;
    const next = allowCompose
      ? "It is not the compose file that was allowed: the backup has changed since it was reviewed, so review it again."
      : "To start it anyway, allow these settings in the restore dialog, which lists them.";
    throw Object.assign(new Error(`${manifest.name} was not restored; nothing was changed. Its compose file would be started exactly as it was backed up, since ${why}, and it gives ${manifest.name} more than the catalog does: ${list}. ${next} (compose sha256 ${review.sha256})`), { code: "compose_not_allowed" });
  }

  /** Why a restore was refused for the data folders a backup's settings name (dataFolderProblems). */
  const folderWords = (manifest, problems, what = manifest.name) => `${what} was not restored; nothing was changed. The backup's settings point ${manifest.name} at data folders an install would refuse: ${problems.join("; ")}.`;

  /**
   * The review of an app data archive at `archive` without unpacking it (archive-members.mjs): for
   * the restore dialogs, and a machine snapshot's check before it changes anything. A preview: the
   * restore checks what it actually unpacked.
   */
  async function reviewArchive({ id, archive }) {
    const manifest = await ensureManifest(id);
    const members = await readArchiveMembers(archive, ["compose.yaml", "boxpilot.json", ".env"], { maxBytes: 1024 * 1024 });
    const text = (name) => (members.has(name) ? members.get(name).toString("utf8") : null);
    return reviewSummary(manifest, await reviewArchivedProject(manifest, { compose: text("compose.yaml"), stateText: text("boxpilot.json"), envText: text(".env") }));
  }

  /** A machine snapshot's settings for one app, checked before the snapshot restore changes anything (dataFolderProblems). */
  async function dataFoldersRefused({ id, values }) {
    return dataFolderProblems(await ensureManifest(id), values);
  }

  /** app.backup.review: what restoring this backup would start, before it is restored. */
  async function reviewAppBackup({ id, backup: backupName }) {
    await ensureManifest(id);
    const { artifact } = backupArtifactFor(id, backupName);
    await stat(artifact).catch(() => { throw new Error(`Backup ${backupName} does not exist`); });
    return { backup: backupName, ...await reviewArchive({ id, archive: artifact }) };
  }

  /**
   * The compose project of a backup unpacked into `directory`, written again for this server.
   *
   * A backup's compose file carries the server it was taken on: the tailnet address every
   * `tailnet: address` port binds, device paths, a GPU reservation. Started as it was on a rebuilt
   * server or a node that re-joined Tailscale, `up` failed with "cannot assign requested address"
   * and the app was left down. So it is written again from the backup's own saved settings, as
   * Reinstall writes a missing one, on the images the backup's compose file ran (the data in it was
   * written by those, a sidecar's database included), with the devices this server's compose file
   * names (the web process resolved those; this process has no real /dev), else the backup's.
   *
   * A compose file edited by hand is the owner's own and is kept as it is, with a warning; so is one
   * whose saved settings no longer fit the catalog. Throws when this server cannot take the
   * settings (tailnet only with no tailnet address, a device it does not have).
   * Returns `{ rendered, values }` when it wrote the project again, and `warning` when it did not.
   */
  async function projectForThisServer(manifest, directory, archivedCompose, { progress = null } = {}) {
    const state = await readFileWithoutFollowing(path.join(directory, "boxpilot.json")).then(JSON.parse).catch(() => null);
    const existingEnv = parseEnvFile(await readFileWithoutFollowing(path.join(directory, ".env")).catch(() => ""));
    const fit = archivedSettingsFit(manifest, state, existingEnv);
    if (fit.verbatim === "no-settings") return { rendered: null };
    if (fit.verbatim === "edited") return { rendered: null, warning: `${manifest.name}'s compose file was edited by hand, so it was restored exactly as it was backed up. If it names an address, a device or a GPU this server does not have, ${manifest.name} will not start until it is edited again.` };
    if (fit.verbatim === "unfit") return { rendered: null, warning: `${manifest.name}'s settings in this backup no longer fit the catalog (${fit.errors.join("; ")}), so its compose file was restored exactly as it was backed up.` };
    const { values } = fit;
    const ran = deployedImages(archivedCompose);
    const foreign = Object.entries(ran).filter(([service, reference]) => {
      const catalog = service === manifest.id ? manifest.image.reference : (manifest.sidecars ?? []).find((sidecar) => sidecar.id === service)?.image;
      return catalog && !catalogImagePin(reference, catalog);
    });
    const pinned = {
      ...manifest,
      ...(restoreTo[id] ? { image: { ...manifest.image, reference: restoreTo[id] } } : {}),
      sidecars: (manifest.sidecars ?? []).map((sidecar) => (restoreTo[sidecar.id] ? { ...sidecar, image: restoreTo[sidecar.id] } : sidecar)),
    };
    const saved = takeCheckpoint ? await checkpoint({ id, reason: "going back a version" }, { progress }) : null;
    // What is deployed right now, which is what this rollback moves away from. Stepping back several
    // releases means the entry being undone describes an older hop, so its `to` is not where the app
    // actually is — reading the deployed file is the only answer that stays true at any depth.
    const previous = await readProjectFiles(id);
    const runningBefore = deployedImages(previous.compose ?? "");
    const restoring = Object.entries(restoreTo).map(([service, reference]) => `${service} to ${reference}`).join(", ");
    progress?.(`Putting ${manifest.name} back: ${restoring}`, "stdout");
    let started = false;
    let status;
    try {
      await writeProject(pinned, values, { existingEnv: await readEnv(id), devices });
      // Pull explicitly: the previous image is unused after an update, so a prune may have removed it.
      declaredUserCache.delete(manifest.image.reference); declaredOwnerCache.delete(manifest.image.reference);   // a pull can change the image's USER
      const pullBudgetMs = scaled(30 * 60_000, timeScale);
      const pull = await compose(id, ["pull"], { timeout: pullBudgetMs, progress });
      if (!pull.ok) throw stepTimedOut(pull, "Downloading the previous version", pullBudgetMs) ?? new Error(`Could not fetch the previous version: ${redact(pull.stderr).split("\n").slice(-3).join(" ")}`);
      started = true;
      const upBudgetMs = scaled(15 * 60_000, timeScale);
      const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: upBudgetMs, progress });
      if (!up.ok) throw stepTimedOut(up, "Starting the previous version", upBudgetMs) ?? new Error(`${manifest.name} would not start on the previous version: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      status = await waitHealthy(manifest, progress);
    } catch (error) {
      // Put back the compose file this app was running, as reconfigure and a compose edit do, and
      // start it again if the attempt got as far as replacing the containers.
      const restored = await restoreProjectFiles(id, previous).then(() => previous.compose !== null, () => false);
      if (!started) throw keepTimeout(error, new Error(`${manifest.name} could not go back a version; the app was unchanged. ${error.message}`));
      progress?.(`Going back failed: ${error.message}. Restoring the version it was on...`, "stderr");
      const back = restored && (await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 10 * 60_000, progress })).ok;
      throw keepTimeout(error, new Error(`${manifest.name} could not go back a version${back ? "; the version it was on was restored" : " and restoring the version it was on also failed"}. ${error.message}`));
    }
    // The rollback is itself an entry, so going back twice steps back twice rather than ping-ponging.
    const movedFrom = Object.fromEntries(Object.keys(restoreTo).map((service) => [service, runningBefore[service] ?? last.to?.[service] ?? null]));
    const entry = { at: clock().toISOString(), from: movedFrom, to: restoreTo, rolledBack: true };
    await writeState(id, {
      ...state,
      updatedAt: clock().toISOString(),
      image: { reference: restoreTo[id] ?? state.image?.reference ?? null, id: status.image },
      pinnedRollback: true,
      // Entries newer than the one undone describe versions this app is no longer on, so they are
      // dropped rather than left ahead of the current state where "go back" would offer them again.
      updateHistory: [entry, ...history.slice(history.indexOf(last) + 1)].slice(0, updateHistoryLimit),
    });
    progress?.(`${manifest.name} is back on ${restoreTo[id] ?? "its previous version"}`, "stdout");
    return { rolledBack: true, id, restored: restoreTo, from: movedFrom, checkpoint: saved };
  }

  async function reconfigure({ id, values: rawValues = {}, devices = null }, { progress = null, checkpoint: takeCheckpoint = true } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    // What is not being changed stays as it is. A caller that only flips one thing (the exposure
    // toggle) used to reset everything else to catalog defaults: the owner's VPN provider, their
    // folders, their ports, all silently gone. The stored values are the baseline; the request
    // overrides only what it names. Saved settings a catalog release has since dropped are dropped
    // here too, as update does: merged back in raw, every Settings, Reach or password change of
    // such an app failed with "is not a setting of this application".
    const stored = sanitizeStoredValues(manifest, state.values ?? {});
    const merged = {
      ports: { ...stored.ports, ...rawValues.ports },
      env: { ...stored.env, ...rawValues.env },
      volumes: { ...stored.volumes, ...rawValues.volumes },
      setup: rawValues.setup ?? stored.setup,
      exposure: rawValues.exposure ?? stored.exposure,
      networkMode: rawValues.networkMode ?? stored.networkMode,
    };
    // A secret the request does not re-enter is the one in .env (withSavedSecrets): a settings change
    // never asks for the tunnel token again.
    const previousEnv = await readFileWithoutFollowing(path.join(dirFor(id), ".env")).catch(() => "");
    const { values, errors } = resolveValues(manifest, withSavedSecrets(manifest, merged, parseEnvFile(previousEnv)));
    if (errors.length) throw new Error(`Invalid settings: ${errors.join("; ")}`);
    // An app already saved that way (before this was refused) keeps its other settings changeable;
    // Reach's Home network is how it leaves that state.
    const storedOnHost = (stored.networkMode ?? manifest.network) === "host";
    const refusal = storedOnHost && stored.exposure === "tailnet" ? null : hostNetworkTailnetRefusal(manifest, values, { switchingNetwork: !storedOnHost });
    if (refusal) throw new Error(refusal);
    const saved = takeCheckpoint ? await checkpoint({ id, reason: "settings change" }, { progress }) : null;
    const previousCompose = await readFileWithoutFollowing(path.join(dirFor(id), "compose.yaml")).catch(() => null);
    const rendered = await writeProject(manifest, values, { existingEnv: parseEnvFile(previousEnv), devices });
    // The new ports are checked before the containers are recreated. Putting a served app on the
    // home network (every address) while Serve still holds its port on the tailnet address is the
    // Dockge trap: refused here, with the old files back, rather than found by a failed `up` whose
    // rollback then fails the same way.
    let ports;
    try {
      ports = await assertPortsFree(manifest, rendered.composeYaml, { progress, refused: `${manifest.name}'s settings were not changed; nothing was restarted.` });
    } catch (error) {
      if (previousCompose !== null) await restoreProjectFiles(id, { compose: previousCompose, env: previousEnv }).catch(() => {});
      throw error;
    }
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw await bindFailure(manifest, up.stderr, rendered.composeYaml, "Docker could not publish its ports.") ?? new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      await waitHealthy(manifest, progress);
      await writeState(id, { ...state, updatedAt: clock().toISOString(), values: storableValues(manifest, values, rendered.env) });
      const setup = await applySetup(manifest, values, progress);
      return { reconfigured: true, id, hostPorts: rendered.hostPorts, checkpoint: saved, setup, ...withPortWarnings(ports) };
    } catch (error) {
      let rolledBack = false;
      if (previousCompose !== null) {
        await replaceFileWithoutFollowing(path.join(dirFor(id), "compose.yaml"), previousCompose, { mode: 0o600 });
        await replaceFileWithoutFollowing(path.join(dirFor(id), ".env"), previousEnv, { mode: 0o600 });
        progress?.(`Reconfiguration failed: ${error.message}. Restoring previous configuration...`, "stderr");
        rolledBack = (await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 10 * 60_000, progress })).ok;
      }
      throw new Error(`${manifest.name} reconfiguration failed${rolledBack ? "; the previous configuration was restored" : ""}. ${error.message}`);
    }
  }

  /**
   * Power-user escape hatch: replace the app's compose.yaml verbatim. Validated with
   * `docker compose config`, applied with rollback to the previous file on failure.
   * The next Settings change or Update regenerates the file from the manifest.
   */
  async function editCompose({ id, compose: composeText }, { progress = null, checkpoint: takeCheckpoint = true } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    if (typeof composeText !== "string" || !composeText.trim() || composeText.length > 65536) throw new Error("Compose text must be a non-empty string under 64 KB");
    let parsed;
    try { parsed = YAML.parse(composeText); } catch (parseError) { throw new Error(`Not valid YAML: ${parseError.message}`); }
    if (!parsed || typeof parsed !== "object" || !parsed.services || typeof parsed.services !== "object") throw new Error("The compose file must define services");
    const target = path.join(dirFor(id), "compose.yaml");
    const previous = await readFileWithoutFollowing(target).catch(() => null);
    if (previous === null) throw new Error("There is no compose.yaml to edit");
    const saved = takeCheckpoint ? await checkpoint({ id, reason: "compose edit" }, { progress }) : null;
    await replaceFileWithoutFollowing(target, composeText, { mode: 0o600 });
    const check = await compose(id, ["config", "--quiet"], { timeout: 60_000, progress });
    if (!check.ok) {
      await replaceFileWithoutFollowing(target, previous, { mode: 0o600 });
      throw new Error(`docker compose rejected the file; the previous one was restored: ${redact(check.stderr).split("\n").slice(-3).join(" ")}`);
    }
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      await waitHealthy(manifest, progress);
      await writeState(id, { ...state, updatedAt: clock().toISOString(), rawEdited: true });
      return { edited: true, id, rawEdited: true, checkpoint: saved };
    } catch (error) {
      progress?.(`Edit failed: ${error.message}. Restoring the previous compose file...`, "stderr");
      await replaceFileWithoutFollowing(target, previous, { mode: 0o600 });
      const rolledBack = (await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 10 * 60_000, progress })).ok;
      throw Object.assign(new Error(`${manifest.name} rejected the edited compose file${rolledBack ? "; the previous one was restored" : " and automatic rollback also failed"}. ${error.message}`), { rolledBack });
    }
  }

  async function action({ id, action: verb }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    if (!actions.includes(verb)) throw new Error("Action must be start, stop, restart, pause, or unpause");
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    // A container removed outright (M35): `docker system prune` deletes every stopped container,
    // and `compose start` then has nothing to start. Start and restart build it again from the saved
    // compose project, which is what they mean; the data is in volumes and folders a prune leaves.
    let project = null;
    let ports = null;
    if (verb === "start" || verb === "restart") {
      const before = await containerStatus(id);
      project = (await readProjectFiles(id)).compose;
      const refused = `${manifest.name} was not ${verb === "start" ? "started" : "restarted"}.`;
      if (!before.exists) {
        if (project === null) throw new Error(`${manifest.name} has no container and its compose project is gone too; use Reinstall in Repair, which writes it again from the saved settings`);
        progress?.(`${manifest.name} has no container (removed while it was stopped); building it again from its saved compose project.`, "stdout");
        ports = await assertPortsFree(manifest, project, { progress, refused });
        const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
        if (!up.ok) throw await bindFailure(manifest, up.stderr, project, refused) ?? new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-3).join(" ")}`);
        const status = await containerStatus(id);
        return { id, action: verb, running: status.running, status: status.status, recreated: true, ...withPortWarnings(ports) };
      }
      // Starting what already runs binds nothing. A restart lets go of every port and binds it again,
      // which is when something waiting for one takes it.
      if (project !== null && (verb === "restart" || !before.running)) ports = await assertPortsFree(manifest, project, { progress, refused });
    }
    let result = await compose(id, [verb], { timeout: 180_000, progress });
    // A stopped container is pinned to the network it was created on, and anything that prunes
    // Docker — `docker system prune`, Portainer, a compose UI the owner runs themselves — takes
    // that network with it, because nothing running is attached. Starting then fails with a
    // network ID that no longer exists, and plain `up` cannot fix it either: the container has to
    // be built again. Its data is in volumes and bind mounts, so that costs nothing but a moment.
    if (!result.ok && verb !== "stop" && /network [0-9a-f]{12,}.*not found|has active endpoints/i.test(result.stderr)) {
      progress?.(`${manifest.name}'s network was removed while it was stopped; building the container again.`, "stdout");
      result = await compose(id, ["up", "--detach", "--force-recreate", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    }
    if (!result.ok) throw (project !== null ? await bindFailure(manifest, result.stderr, project, `${manifest.name} was not ${verb === "start" ? "started" : "restarted"}.`) : null) ?? new Error(`docker compose ${verb} failed: ${redact(result.stderr).split("\n").slice(-3).join(" ")}`);
    const status = await containerStatus(id);
    return { id, action: verb, running: status.running, status: status.status, ...withPortWarnings(ports) };
  }

  /**
   * Run one fixed command inside an installed app's running container, as a named user, for an
   * operation written for that app (Zulip's manage.py). Nothing here reaches a job log: the output
   * can be a one-time link or an API key, so the caller decides what, if anything, is kept.
   */
  async function execIn({ id, service = null, user, argv, env = {}, timeoutMs = 120_000 }) {
    const manifest = await ensureManifest(id);
    const target = service ?? manifest.id;
    if (target !== manifest.id && !(manifest.sidecars ?? []).some((sidecar) => sidecar.id === target)) throw new Error(`${manifest.name} has no service called ${target}`);
    if (typeof user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("The user to run as is invalid");
    if (!Array.isArray(argv) || !argv.length || argv.length > 32 || argv.some((part) => typeof part !== "string" || part.length > 16_384 || part.includes("\0"))) throw new Error("The command is invalid");
    const pairs = Object.entries(env ?? {});
    if (pairs.length > 16 || pairs.some(([name, value]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value))) throw new Error("The command's environment is invalid");
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const status = await containerStatus(target === manifest.id ? id : `${id}-${target}`);
    if (!status.running) throw new Error(`${manifest.name} is not running; start it and try again`);
    const flags = pairs.flatMap(([name, value]) => ["--env", `${name}=${value}`]);
    const result = await compose(id, ["exec", "-T", "--user", user, ...flags, target, ...argv], { timeout: timeoutMs });
    return { ok: result.ok, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), timedOut: Boolean(result.timedOut) };
  }

  async function logs({ id, lines = 200, container = null }) {
    const manifest = await ensureManifest(id);
    // The tunnel's log is where the public IP and every connection problem lives, and the notes
    // kept telling the owner to read it while the Logs button could only show the app container.
    let name = projectNameFor(id);
    if (container) {
      if (!(manifest.sidecars ?? []).some((sidecar) => sidecar.id === container)) throw new Error(`${manifest.name} has no helper container named ${container}`);
      name = projectNameFor(`${id}-${container}`);
    }
    const tail = Math.min(Math.max(Number.parseInt(lines, 10) || 200, 1), 1000);
    const result = await docker(["logs", "--tail", String(tail), "--timestamps", name], { timeout: 30_000 });
    if (!result.ok && !result.stdout) throw new Error(`docker logs failed: ${redact(result.stderr).split("\n").slice(-2).join(" ")}`);
    const entries = `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean).map(redact).slice(-tail);
    return { id, container: container ?? null, lines: entries };
  }

  /**
   * Where a tunneled app's traffic leaves, read from the tunnel container's own log: the public
   * IP gluetun verified and the place it belongs to, next to whether the tunnel is even running.
   */
  async function vpnStatus({ id }) {
    const manifest = await ensureManifest(id);
    if (!manifest.networkVia) return { id, tunneled: false };
    const state = await readState(id);
    if (!state?.installed) return { id, tunneled: true, running: false, exit: null };
    const status = await containerStatus(`${id}-${manifest.networkVia}`);
    const result = await docker(["logs", "--tail", "300", "--timestamps", projectNameFor(`${id}-${manifest.networkVia}`)], { timeout: 30_000 });
    const exit = parseExit(`${result.stdout}\n${result.stderr}`);
    const forwardedPort = parseForwardedPort(`${result.stdout}\n${result.stderr}`);
    return { id, tunneled: true, sidecarId: manifest.networkVia, running: status.running && status.status === "running", status: status.status, exit, forwardedPort };
  }

  /**
   * The kill-switch drill (M17.3): force the tunnel down for a few seconds, prove nothing leaks,
   * bring it back, and record the whole thing. The claim "if the VPN drops, downloads stop
   * instead of leaking" becomes a recorded fact for this install, the way a restore drill makes
   * "backups work" a fact. Every command runs inside the app's own network namespace via docker
   * exec, which is also why the helper's own network isolation is no obstacle.
   *
   * The restore is attempted no matter what went wrong in between: a drill that leaves the
   * tunnel down has failed at its one job.
   */
  async function vpnKillSwitchDrill({ id }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    if (!manifest.networkVia) throw new Error(`${manifest.name} does not run through a VPN tunnel`);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const name = projectNameFor(id);
    const inTunnel = (args, timeout = 10_000) => docker(["exec", name, ...args], { timeout });
    const control = async (method, path, body = null) => {
      const args = ["curl", "-m", "5", "-sS", ...(method === "PUT" ? ["-X", "PUT", "-d", body] : []), `http://127.0.0.1:8000${path}`];
      const result = await inTunnel(args);
      if (!result.ok) throw new Error(`The tunnel's control endpoint did not answer (${redact(result.stderr).slice(-120)})`);
      try { return JSON.parse(result.stdout); } catch { throw new Error("The tunnel's control endpoint answered with something unreadable"); }
    };

    const hasCurl = await inTunnel(["curl", "--version"], 10_000);
    if (!hasCurl.ok) throw new Error(`${manifest.name}'s image carries no curl, which the drill needs to speak to the tunnel from inside`);
    const status = await control("GET", "/v1/vpn/status");
    if (status.status !== "running") throw new Error(`The tunnel is not running (${status.status ?? "unknown"}); there is nothing to drill`);
    const before = await control("GET", "/v1/publicip/ip").catch(() => null);
    progress?.(`Tunnel up${before?.public_ip ? `, exiting at ${before.public_ip} (${before.country ?? "?"})` : ""}. Forcing it down...`, "stdout");

    const stoppedAt = clock().getTime();
    await control("PUT", "/v1/vpn/status", '{"status":"stopped"}');
    let leaked = false;
    let restored = false;
    try {
      await wait(2000);
      // The one question: with the tunnel down, can anything get out? A firewall that holds
      // answers with silence; an answer from the internet is a leak.
      const probe = await inTunnel(["curl", "-m", "4", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "https://1.1.1.1/"], 12_000);
      leaked = probe.ok && /^[1-5]\d\d$/.test(probe.stdout.trim());
      progress?.(leaked ? "LEAK: the internet answered while the tunnel was down." : "Nothing left while the tunnel was down; the kill switch held.", leaked ? "stderr" : "stdout");
    } finally {
      await control("PUT", "/v1/vpn/status", '{"status":"running"}').catch(() => {});
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const back = await control("GET", "/v1/vpn/status").catch(() => null);
        if (back?.status === "running") { restored = true; break; }
        await wait(2000);
      }
    }
    const downForMs = clock().getTime() - stoppedAt;
    if (!restored) throw new Error("The tunnel did not come back after the drill; restart the app. The drill result was not recorded as a pass.");
    let after = null;
    for (let attempt = 0; attempt < 10 && !after?.public_ip; attempt += 1) {
      await wait(2000);
      after = await control("GET", "/v1/publicip/ip").catch(() => null);
    }
    progress?.(`Tunnel restored${after?.public_ip ? `, exiting at ${after.public_ip} (${after.country ?? "?"})` : ""}.`, "stdout");
    return {
      id, held: !leaked, leaked, restored, downForMs,
      exitBefore: before?.public_ip ?? null, exitAfter: after?.public_ip ?? null,
      verdict: leaked
        ? "LEAKED: something reached the internet while the tunnel was down. Do not rely on this tunnel; check the app's network settings."
        : `The kill switch held: nothing left this app while the tunnel was down for ${(downForMs / 1000).toFixed(1)}s, and the tunnel came back on its own.`,
    };
  }

  /**
   * Compose projects on this server that BoxPilot did not create (M3.10): a stack somebody
   * started by hand in /opt or a home directory. Listed so the catalog page tells the whole
   * truth about the machine; managing them is a later, separate step.
   */
  async function foreignProjects() {
    const result = await docker(["compose", "ls", "--all", "--format", "json"], { timeout: 30_000 });
    if (!result.ok) return { available: false, projects: [] };
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { return { available: false, projects: [] }; }
    if (!Array.isArray(parsed)) return { available: false, projects: [] };
    const projects = parsed
      // BoxPilot's own stacks are not "foreign": the per-app projects are bp-*, and a
      // compose-deployed controller's own project is "boxpilot".
      .filter((entry) => typeof entry?.Name === "string" && !entry.Name.startsWith("bp-") && entry.Name !== "boxpilot")
      .map((entry) => ({ name: entry.Name, status: entry.Status ?? "unknown", configFiles: typeof entry.ConfigFiles === "string" ? entry.ConfigFiles.split(",").map((file) => file.trim()) : [] }));
    return { available: true, projects };
  }

  /**
   * A foreign compose project resolved from `docker compose ls`, or null. The name is looked up
   * against what compose actually reports rather than trusted from the caller, so nothing can be
   * run against an arbitrary path, and BoxPilot's own projects are never treated as foreign.
   */
  async function resolveForeignProject(name) {
    if (typeof name !== "string" || !name.length || name.startsWith("bp-") || name === "boxpilot") return null;
    const { available, projects } = await foreignProjects();
    if (!available) return null;
    return projects.find((project) => project.name === name) ?? null;
  }

  /** The --file arguments for a project's compose files, from its own resolved configuration. */
  function composeFileArgs(project) {
    return project.configFiles.filter((file) => typeof file === "string" && file.startsWith("/")).flatMap((file) => ["--file", file]);
  }

  /**
   * Start, stop, or restart a compose stack BoxPilot did not create (M3.10). Lifecycle only: the
   * project's own compose files are used verbatim, so this manages what is there without adopting
   * or remodelling it.
   */
  async function foreignProjectAction({ name, action }, { progress = null } = {}) {
    if (!["start", "stop", "restart"].includes(action)) throw new Error("action must be start, stop, or restart");
    const project = await resolveForeignProject(name);
    if (!project) throw new Error(`No compose project named ${name} was found (BoxPilot's own apps are managed from their cards)`);
    const files = composeFileArgs(project);
    if (!files.length) throw new Error(`${name} does not report a compose file, so BoxPilot cannot act on it`);
    progress?.(`${action} ${name}...`, "stdout");
    const result = await docker(["compose", "--project-name", name, ...files, action], { timeout: 5 * 60_000, progress });
    if (!result.ok) throw new Error(`docker compose ${action} failed: ${redact(result.stderr).split("\n").slice(-3).join(" ")}`);
    return { name, action, done: true };
  }

  /** Tail a foreign project's logs, the same read the app cards offer for managed apps. */
  async function foreignProjectLogs({ name, lines = 200 }) {
    const project = await resolveForeignProject(name);
    if (!project) throw new Error(`No compose project named ${name} was found`);
    const files = composeFileArgs(project);
    const result = await docker(["compose", "--project-name", name, ...files, "logs", "--no-color", "--tail", String(Math.min(Math.max(Number(lines) || 200, 1), 1000))], { timeout: 30_000 });
    return { name, lines: redact(`${result.stdout}\n${result.stderr}`).split("\n").filter((line) => line.length).slice(-1000) };
  }

  async function readConfigurationFile(id, name) {
    const directory = await lstat(dirFor(id));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Application configuration requires a real project directory");
    const handle = await open(path.join(dirFor(id), name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      const limit = 64 * 1024;
      if (!metadata.isFile() || metadata.size > limit) throw new Error("Configuration must be a regular file no larger than 64 KiB");
      const buffer = Buffer.alloc(limit + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > limit) throw new Error("Configuration exceeded its 64 KiB read limit");
      return buffer.subarray(0, total).toString("utf8");
    } finally { await handle.close(); }
  }

  /** Raw Compose can contain arbitrary inline credentials, so only the elevated owner operation calls this. */
  async function readComposeConfig({ id }) {
    const manifest = await ensureManifest(id);
    if (!(await readState(id))?.installed) throw new Error(`${manifest.name} is not installed`);
    return { id, compose: await readConfigurationFile(id, "compose.yaml") };
  }

  /** Viewer-readable settings. Unknown .env entries are private; raw Compose has a separate owner read. */
  async function config({ id }) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const text = await readConfigurationFile(id, ".env").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    const env = parseEnvFile(text);
    const publicNames = new Set(manifest.env.filter((entry) => !entry.secret && entry.type !== "password").map((entry) => entry.name));
    const entries = Object.keys(env).sort().map((name) => ({ name, value: publicNames.has(name) ? env[name] : "••••••••", secret: !publicNames.has(name) }));
    return { id, name: manifest.name, compose: null, composeProtected: true, env: entries, directory: dirFor(id) };
  }

  /**
   * Consistent backup of an app's managed data: stop, tar the compose project plus every
   * backup-flagged managed volume, restart, then prune to `keep` copies. hostPath volumes
   * (locations the operator manages) are listed as skipped, never silently included.
   */
  const homepageGroup = "BoxPilot";
  const homepageHostPattern = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

  /**
   * M8.2: write a "BoxPilot" group into Homepage's services.yaml listing every installed
   * catalog app (link, description, dashboard icon, live container status through the
   * read-only Docker socket Homepage already mounts). Other groups the operator wrote are
   * kept. `host` is what the browser should use to reach this server; it is remembered so
   * installs and uninstalls can refresh the dashboard without asking again.
   */
  /**
   * This server's own tailnet address, for ports that have to move somewhere reachable but cannot
   * go through Serve. Null when Tailscale is absent or not up.
   *
   * Only an answer is remembered, and only for a minute: the helper usually starts before
   * Tailscale does, and remembering "no address" from then meant every later deploy treated the
   * server as having no tailnet at all.
   */
  const tailnetCacheMs = 60_000;
  const tailnetCache = { address: null, dnsName: null };
  const cachedTailnet = (key) => (tailnetCache[key] && clock().getTime() - tailnetCache[key].at < tailnetCacheMs ? tailnetCache[key].value : null);
  const rememberTailnet = (key, value) => { tailnetCache[key] = value ? { value, at: clock().getTime() } : null; return value; };
  async function tailnetAddress() {
    const cached = cachedTailnet("address");
    if (cached) return cached;
    const result = await runCommand(tailscaleBinary, ["ip", "-4"], { timeout: 15_000 }).catch(() => ({ ok: false, stdout: "" }));
    const address = result.ok ? (result.stdout.split("\n").map((line) => line.trim()).find((line) => /^\d{1,3}(\.\d{1,3}){3}$/.test(line)) ?? null) : null;
    return rememberTailnet("address", address);
  }

  /**
   * The tailnet address a compose file for these values binds to. A port that moves to the tailnet
   * address has nowhere safe to go without one: the renderer would leave it on the LAN, which for
   * an app the owner set to "tailnet only" publishes it to the whole house. Refuse instead, before
   * anything is written, so the app stays exactly as it was.
   */
  async function tailnetAddressFor(manifest, values) {
    if (values.exposure !== "tailnet") return null;
    const address = await tailnetAddress();
    if (address) return address;
    const network = (manifest.networkModes ?? [manifest.network]).includes(values.networkMode) ? values.networkMode : manifest.network;
    if (network === "host" || manifest.network === "host") return null; // no published ports to bind
    const stranded = (manifest.ports ?? []).filter((port) => port.exposure !== "loopback" && (port.tailnet ?? "serve") === "address");
    if (stranded.length) throw new Error(`${manifest.name} is set to tailnet only, but this server has no tailnet address right now (is Tailscale up?). ${stranded.map((port) => port.label ?? port.id).join(", ")} would have been left open on the home network, so nothing was changed`);
    return null;
  }

  /** This server's tailnet machine name (homebox.tail...ts.net), or null without Tailscale. */
  async function tailnetDnsName() {
    const cached = cachedTailnet("dnsName");
    if (cached) return cached;
    const result = await runCommand(tailscaleBinary, ["status", "--json"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ ok: false, stdout: "" }));
    let dnsName = null;
    try { dnsName = result.ok ? (JSON.parse(result.stdout).Self?.DNSName ?? "").replace(/\.$/, "") || null : null; } catch { dnsName = null; }
    return rememberTailnet("dnsName", dnsName);
  }

  /**
   * What the reachability doctor needs to know before it probes anything: the app's containers,
   * the addresses its ports actually live on after the exposure choice, and this host's own
   * names. All of it from this helper's own records and Tailscale's answers, nothing guessed.
   */
  async function reachabilityFacts({ id }) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    const status = await containerStatus(id);
    const sidecarNames = (manifest.sidecars ?? []).map((sidecar) => `${id}-${sidecar.id}`);
    const looked = state?.installed && sidecarNames.length ? await containerStatuses(sidecarNames) : new Map();
    const sidecars = (manifest.sidecars ?? [])
      .map((sidecar) => ({ id: sidecar.id, ...(looked.get(`${id}-${sidecar.id}`) ?? { exists: false }) }))
      .filter((entry) => entry.exists)
      .map((entry) => ({ id: entry.id, running: entry.running, status: entry.status, restarts: entry.restarts ?? 0 }));
    const serveResult = await runCommand(tailscaleBinary, ["serve", "status", "--json"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ ok: false, stdout: "" }));
    const serves = serveResult.ok ? parseServeStatus(serveResult.stdout) : [];
    const tailnet = await tailnetAddress();
    const hostNetworked = (state?.values?.networkMode ?? manifest.network) === "host";
    const ports = manifest.ports.filter((port) => port.protocol !== "udp").map((port) => {
      const host = hostNetworked ? port.container : state?.values?.ports?.[port.id] ?? port.host;
      const { exposure } = bindingFor(port, state?.values?.exposure ?? "lan", { lanAddress, tailnetAddress: tailnet });
      return { id: port.id, label: port.label, host, exposure, protocol: port.protocol };
    });
    return {
      installed: Boolean(state?.installed),
      running: status.running && status.status === "running",
      sidecars, ports, serves,
      lanAddress: lanAddress && lanAddress !== "0.0.0.0" ? lanAddress : null,
      tailnetAddress: tailnet,
      tailnetDnsName: await tailnetDnsName(),
    };
  }

  /** Local ports Tailscale Serve publishes over HTTPS right now; empty when Tailscale is absent. */
  async function servedPorts() {
    const result = await runCommand(tailscaleBinary, ["serve", "status", "--json"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ ok: false, stdout: "" }));
    return new Set(result.ok ? parseServeStatus(result.stdout).map((entry) => entry.port) : []);
  }

  async function syncHomepage({ host } = {}, { progress = null } = {}) {
    const homepage = await catalog.get("homepage");
    if (!homepage) throw new Error("Homepage is not in the catalog");
    const homepageState = await readState("homepage");
    if (!homepageState?.installed) throw new Error("Homepage is not installed");
    const rememberedPath = path.join(dirFor("homepage"), homepageSyncFile);
    const remembered = await readFileWithoutFollowing(rememberedPath).then(JSON.parse).catch(() => null);
    const linkHost = host ?? remembered?.host ?? null;
    if (typeof linkHost !== "string" || !homepageHostPattern.test(linkHost)) throw new Error("A host name or address for the dashboard links is required");
    const configDirectory = path.join(dirFor("homepage"), "config");
    const tailnetHost = /\.ts\.net$/i.test(linkHost);
    const served = tailnetHost ? await servedPorts() : new Set();
    const { manifests } = await catalog.all();
    const entries = [];
    for (const manifest of manifests) {
      if (manifest.id === "homepage") continue;
      const state = await readState(manifest.id);
      if (!state?.installed) continue;
      const port = manifest.ports.find((entry) => entry.protocol === "tcp") ?? null;
      const hostPort = port ? state.values?.ports?.[port.id] ?? port.host : null;
      // A loopback app answers on the server itself only. Tailscale Serve is how it is meant to be
      // reached, so link the HTTPS address when it is published and the dashboard is being read on
      // the tailnet; otherwise say where it lives rather than offering an address that fails in the
      // reader's browser.
      const loopback = port?.exposure === "loopback";
      const publishedOnTailnet = loopback && tailnetHost && served.has(Number(hostPort));
      const href = port ? (loopback ? (publishedOnTailnet ? `https://${linkHost}:${hostPort}` : null) : `http://${linkHost}:${hostPort}`) : null;
      const description = loopback && !publishedOnTailnet ? `${manifest.description} (on the server itself at 127.0.0.1:${hostPort}; publish it with Serve to reach it from elsewhere)` : manifest.description;
      entries.push({ [manifest.name]: { ...(href ? { href } : {}), description, icon: `${manifest.id}.png`, server: "boxpilot", container: projectNameFor(manifest.id) } });
    }
    await mkdir(configDirectory, { recursive: true });
    const servicesPath = path.join(configDirectory, "services.yaml");
    // The owner's own groups live in the same file. One that does not parse, or is not a list of
    // groups, used to count as empty and was replaced with BoxPilot's group alone, deleting theirs.
    // Only a file that is not there (or holds nothing) is empty; anything else is left as it is.
    const leftAlone = (why) => new Error(`Homepage's services.yaml (${servicesPath}) ${why}, so it was left as it is rather than replaced with only BoxPilot's group, which would lose your own groups. Fix the file, or move it aside to start afresh, then sync again.`);
    let existing = [];
    // Homepage's config folder is its container's to write, and a restored backup's: a link here is
    // not followed, so root never reads another file into a services.yaml the container can read.
    const text = await readFileWithoutFollowing(servicesPath).catch((error) => { if (error.code === "ENOENT") return null; throw leftAlone(`could not be read (${error.message})`); });
    if (text !== null) {
      let parsed;
      try { parsed = YAML.parse(text); } catch (error) { throw leftAlone(`is not valid YAML (${String(error.message).split("\n")[0]})`); }
      if (Array.isArray(parsed)) existing = parsed;
      else if (parsed !== null && parsed !== undefined) throw leftAlone("is not a list of groups");
    }
    const kept = existing.filter((group) => !(group && typeof group === "object" && Object.keys(group)[0] === homepageGroup));
    const services = [{ [homepageGroup]: entries }, ...kept];
    const pending = `${servicesPath}.${randomUUID()}.tmp`;
    await writeFile(pending, `# The "${homepageGroup}" group is managed by BoxPilot and rewritten on every sync; other groups are kept.\n${YAML.stringify(services)}`, { mode: 0o644 });
    // Replace in one step: a truncating write can leave torn YAML that the next sync would discard.
    await rename(pending, servicesPath);
    // Written only where nothing is: "wx" creates it exclusively, so a link the container left at
    // that name (even one to a file that does not exist yet, /etc/nologin) is never written through.
    await writeFile(path.join(configDirectory, "docker.yaml"), "boxpilot:\n  socket: /var/run/docker.sock\n", { mode: 0o644, flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    await replaceFileWithoutFollowing(rememberedPath, JSON.stringify({ host: linkHost, syncedAt: clock().toISOString() }), { mode: 0o600 });
    progress?.(`Homepage now lists ${entries.length} installed app(s) in its ${homepageGroup} group`, "stdout");
    return { synced: true, services: entries.length, groupsKept: kept.length, host: linkHost };
  }

  /** Best-effort dashboard refresh after an install or uninstall; never fails the main job. */
  async function refreshHomepage(changedId, progress) {
    if (changedId === "homepage") return;
    try {
      const state = await readState("homepage");
      if (!state?.installed) return;
      await syncHomepage({}, { progress });
    } catch (error) {
      progress?.(`Homepage dashboard not refreshed: ${error.message}`, "stderr");
    }
  }

  /**
   * What is at `relative` in an app's folder, as a backup would archive it, never following a link:
   * `{ state: "present" }`, `{ state: "absent" }`, `{ state: "link", at, target }` for a link on the
   * way or at the name, or `{ state: "other", at }` for a project file that is not a plain file.
   */
  async function archivedEntry(directory, relative, kind) {
    const parts = relative.split("/").filter(Boolean);
    let current = directory;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const info = await lstat(current).catch((error) => { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; });
      if (!info) return { state: "absent" };
      const at = parts.slice(0, index + 1).join("/");
      if (info.isSymbolicLink()) return { state: "link", at, target: await readlink(current).catch(() => "somewhere else") };
      if (index < parts.length - 1 && !info.isDirectory()) return { state: "absent" };
      if (index === parts.length - 1 && kind === "file" && !info.isFile()) return { state: "other", at };
    }
    return { state: "present" };
  }

  /** Why a backup was refused for what archivedEntry found. */
  function unfitWords(manifest, directory, unfit) {
    const links = unfit.filter((entry) => entry.state === "link");
    const said = unfit.map((entry) => (entry.state === "link" ? `${entry.at} is a link to ${entry.target}` : `${entry.at} is not a plain file`)).join(", and ");
    const one = links.length === 1;
    const why = links.length
      ? `: a backup would hold only the link${one ? "" : "s"}, none of what ${one ? "it points" : "they point"} at, and a restore refuses a link where BoxPilot writes ${manifest.name}'s files as root. Move the data back into ${links.map((entry) => path.join(directory, entry.at)).join(" and ")}, or mount the other disk there itself rather than linking to it, then back up again.`
      : `, which BoxPilot never writes there, and a restore refuses. Remove ${unfit.length === 1 ? "it" : "them"}, then save ${manifest.name}'s settings again, which writes its project files afresh.`;
    return `${manifest.name} was not backed up; nothing was stopped. In its folder ${said}${why}`;
  }

  /** `checkpointReason` and `preserve` are for checkpoint() only; the registry operation passes neither. */
  async function backup({ id, keep = 5, checkpointReason = null, preserve = null }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state) throw new Error(`${manifest.name} has no data to back up`);
    if (keep !== null && (!Number.isInteger(keep) || keep < 1 || keep > 30)) throw new Error("keep must be a whole number between 1 and 30");
    const directory = dirFor(id);
    // What goes into the archive is looked at first, never through a link (R5B3-1): tar archives a
    // link as a link, so a data folder the owner moved to another disk and linked back made backups
    // holding only the link, which the rehearsal passed and every restore refuses.
    const unfit = [];
    const contents = [];
    const add = async (relative, kind) => {
      const found = await archivedEntry(directory, relative, kind);
      if (found.state === "present") contents.push(relative);
      else if (found.state !== "absent") unfit.push(found);
    };
    await add("boxpilot.json", "file");
    // Uninstalled apps have no compose.yaml.
    for (const name of ["compose.yaml", ".env"]) await add(name, "file");
    const skippedHostPaths = [];
    const skippedVolumes = [];
    for (const volume of manifest.volumes) {
      // Anything not going into the archive is recorded, so the owner is told what a backup leaves out
      // — whether it is a folder they chose or a volume the manifest does not archive.
      if (!volume.backup || !volume.path) {
        if (volume.hostPath) skippedHostPaths.push(volume.hostPath);
        else if (volume.path) skippedVolumes.push(volume.label ?? volume.id);
        continue;
      }
      await add(volume.path, "folder");   // absent: not created yet
    }
    for (const sidecar of manifest.sidecars ?? []) {
      for (const volume of sidecar.volumes) {
        if (!volume.backup) continue;
        await add(volume.path, "folder");
      }
    }
    if (unfit.length) throw new Error(unfitWords(manifest, directory, unfit));
    const status = await containerStatus(id);
    const wasRunning = status.running;
    const backupDirectory = backupDirFor(id);
    // Names are second-granular; a checkpoint followed by a restore's safety copy can land in
    // the same second, so step forward until the name is free instead of overwriting.
    let stamp = null; let artifact = null;
    for (let offset = 0; offset < 120; offset += 1) {
      stamp = new Date(clock().getTime() + offset * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      artifact = path.join(backupDirectory, `${stamp}.tar.gz`);
      if (!(await stat(artifact).then(() => true, () => false))) break;
      if (offset === 119) throw new Error("Could not find a free backup name");
    }
    // The archive is written under a name no listing reads, and takes its own only once it is whole
    // and described, so a backup cut off part-way is never counted as one, pruned against, or mirrored.
    const partial = `${artifact}.partial`;
    // Said on disk before the app stops. A power cut or a restart mid-backup leaves the app stopped
    // by hand, which Docker's unless-stopped never undoes, and half an archive; the helper's next
    // start reads this and puts both right (resumeInterruptedBackup).
    // A marker already here is a backup cut off whose resume is still waiting for Docker: the app it
    // stopped is started again after this one, as the resume would have, and its half archive goes.
    const cutOff = await readFileWithoutFollowing(interruptedBackupMarker(id)).then((text) => { try { return JSON.parse(text); } catch { return null; } }, () => null);
    const restartAfter = wasRunning || cutOff?.restart === true;
    if (typeof cutOff?.partial === "string" && /^\d{8}T\d{6}Z\.tar\.gz\.partial$/.test(cutOff.partial)) await rm(path.join(backupDirectory, cutOff.partial), { force: true }).catch(() => {});
    await replaceFileWithoutFollowing(interruptedBackupMarker(id), JSON.stringify({ startedAt: clock().toISOString(), partial: path.basename(partial), restart: restartAfter }), { mode: 0o600 });
    const started = clock().getTime();
    let downtimeMs = null;
    let restartError = null;
    let meta = null;
    try {
      if (wasRunning) {
        progress?.(`Stopping ${manifest.name} for a consistent backup...`, "stdout");
        const stop = await compose(id, ["stop"], { timeout: backupLimitsMs.stop, progress });
        if (!stop.ok) throw new Error(`docker compose stop failed: ${redact(stop.stderr).split("\n").slice(-3).join(" ")}`);
      }
      try {
        await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
        progress?.(`$ tar -czf ${stamp}.tar.gz ${contents.join(" ")}`, "stdout");
        const archive = await runCommand(tarBinary, ["-czf", partial, "-C", directory, ...contents], { timeout: backupLimitsMs.archive, maxBuffer: 4 * 1024 * 1024 });
        if (!archive.ok) throw new Error(`tar failed: ${archive.stderr.split("\n").slice(-2).join(" ")}`);
      } catch (error) {
        await rm(partial, { force: true }).catch(() => {});
        // Said with the failure: a start that did not work left the app down while the job spoke
        // only of tar (a full disk fails both).
        const back = restartAfter ? await compose(id, ["start"], { timeout: backupLimitsMs.start, progress }).catch((failure) => ({ ok: false, stderr: failure.message })) : { ok: true };
        if (!back.ok) throw new Error(`${String(error.message).replace(/[.\s]+$/, "")}. ${manifest.name} did not start again either: ${redact(back.stderr ?? "").split("\n").slice(-3).join(" ") || "docker compose start failed"}`);
        throw error;
      } finally {
        if (wasRunning) downtimeMs = clock().getTime() - started;
      }
      if (restartAfter) {
        const start = await compose(id, ["start"], { timeout: backupLimitsMs.start, progress });
        if (!start.ok) restartError = redact(start.stderr).split("\n").slice(-3).join(" ");
      }
      await syncFile(partial);
      const [checksumSha256, artifactStat] = await Promise.all([sha256File(partial), stat(partial)]);
      meta = { id, createdAt: clock().toISOString(), artifact: path.basename(artifact), checksumSha256, sizeBytes: artifactStat.size, downtimeMs, contents, skippedVolumes, skippedHostPaths, image: state.image?.reference ?? null, ...(checkpointReason ? { checkpoint: { reason: checkpointReason } } : {}) };
      await writeFileDurably(path.join(backupDirectory, `${stamp}.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });
      await rename(partial, artifact);
      if (restartError) throw new Error(`The backup succeeded (${path.basename(artifact)}), but ${manifest.name} did not start again: ${restartError}`);
    } finally {
      // Not reached when the process dies mid-backup, which is when the marker is wanted.
      await rm(interruptedBackupMarker(id), { force: true }).catch(() => {});
    }
    let pruned = [];
    // A machine snapshot restores each app from the backup that was its newest when the snapshot was
    // taken, usually older than the newest few kept here, so none of those goes (housekeeping keeps
    // them too). A snapshot that cannot be read could name any of them: then nothing goes this time.
    let referenced = null;
    if (keep !== null) {
      try {
        referenced = (await snapshotBackupReferences({ snapshotRoot: machineSnapshotRoot, run: runCommand, tarBinary })).get(id) ?? new Set();
      } catch (error) {
        // Named, with where to remove it: one damaged snapshot keeps every app's older copies.
        const damaged = Array.isArray(error.unreadable) && error.unreadable.length;
        progress?.(`Kept every older backup of ${manifest.name}: ${error.message}, and one it restores from may be among them.${damaged ? ` If ${error.unreadable.length === 1 ? "it is" : "they are"} damaged, remove ${error.unreadable.length === 1 ? "it" : "them"} from Housekeeping on the System page; until then no app's older backups are removed.` : ""}`, "stderr");
      }
    }
    if (referenced) {
      // Each kind is counted against its own kind only. An archive without metadata is treated as
      // the owner's, so a checkpoint never removes something it cannot identify as a checkpoint.
      const names = (await readdir(backupDirectory)).filter((name) => backupNamePattern.test(name)).sort().reverse();
      const sameKind = [];
      for (const name of names) {
        let entryMeta = null;
        try { entryMeta = JSON.parse(await readFile(path.join(backupDirectory, name.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { entryMeta = null; }
        if (Boolean(entryMeta?.checkpoint) === Boolean(checkpointReason)) sameKind.push(name);
      }
      const behind = sameKind.slice(keep).filter((name) => name !== preserve);
      pruned = behind.filter((name) => !referenced.has(name));
      if (pruned.length < behind.length) progress?.(`Kept ${behind.length - pruned.length} older cop${behind.length - pruned.length === 1 ? "y" : "ies"} a machine snapshot restores ${manifest.name} from`, "stdout");
      for (const name of pruned) {
        await rm(path.join(backupDirectory, name), { force: true });
        await rm(path.join(backupDirectory, name.replace(/\.tar\.gz$/, ".json")), { force: true });
      }
    }
    progress?.(`Backup ${meta.artifact} written (${meta.sizeBytes} bytes)${pruned.length ? `; pruned ${pruned.length} old cop${pruned.length === 1 ? "y" : "ies"}` : ""}`, "stdout");
    return { backedUp: true, ...meta, pruned };
  }

  /**
   * What an app backup leaves out on purpose, which a restore therefore keeps from the app folder it
   * replaces: the folders marked `backup: false` of the app and its sidecars (downloaded models, a
   * cache, an export folder, a mailbox) and the config files the manifest ships (a prometheus.yml),
   * which the deployer writes and the compose file mounts. Relative to the app folder, shortest first.
   * `all` also names what BoxPilot itself keeps beside an app's project and no backup holds (the
   * address Homepage's links are written for): a restore deleted it with the folder it replaced.
   */
  function keptOutOfBackup(manifest) {
    const folders = [...manifest.volumes, ...(manifest.sidecars ?? []).flatMap((sidecar) => sidecar.volumes ?? [])].filter((volume) => volume.path && !volume.backup).map((volume) => volume.path);
    const files = (manifest.files ?? []).map((file) => path.posix.normalize(file.path)).filter((relative) => !relative.startsWith("..") && !path.posix.isAbsolute(relative));
    return { folders, files, all: [...new Set([...folders, ...files, homepageSyncFile])].sort((a, b) => a.length - b.length) };
  }

  /**
   * Why a link the owner left at a folder backups leave out (R5B3-4: downloaded models moved to
   * another disk) cannot be carried into a restored app folder, or null when it can: where it leads,
   * every link resolved (a not-yet-mounted tail too), must pass what an install checks a folder the
   * owner chooses against, a protected system location, and must not be inside BoxPilot's own
   * folders (another app's, this app's own, the backups). A backup never brings such a link: one in
   * an archive at a folder BoxPilot manages is refused before anything changes (linksWhereBoxPilotWrites),
   * and so is a backup of an archived folder that is one (archivedEntry). This one is the owner's,
   * on this server, in the folder the restore replaces.
   */
  async function ownersLinkRefusal(link) {
    const real = await resolveExisting(link, { realpath: realpathOf });
    if (isDeniedHostPath(real)) return `${real}, a protected system location`;
    const inside = (base) => { const relative = path.relative(path.resolve(base), real); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
    if ([root, backupRoot, machineSnapshotRoot].some(inside)) return `${real}, inside BoxPilot's own folders`;
    return null;
  }

  /**
   * Take set-user-id and set-group-id off every regular file under `root`, an archive just unpacked.
   *
   * tar as root reproduces whatever mode an archive names, and an app backup is only as trustworthy
   * as whoever last held the file: a set-user-id binary in it would come back root's, in a folder a
   * container mounts. `--no-same-owner` is not the answer here, as it is for a machine snapshot: it
   * hands every file to root, and an app whose data must belong to its container user (a Postgres
   * data directory, a PUID 1000 app's files) cannot start or write after the restore. Nor is
   * `--no-same-permissions`, which applies the helper's umask (0077) and takes group and other
   * access from files a container reads as another user. So owners and permissions stay as archived,
   * and only these two bits go. Links are never followed; folders keep set-group-id, which grants
   * nothing.
   *
   * And take out everything that is neither a regular file, a folder nor a link (sweep 4). tar as
   * root makes the named pipes an archive lists (the helper's PrivateDevices stops device nodes, and
   * an archive cannot hold a socket, but one is removed all the same): a pipe where BoxPilot or an
   * app later reads waits for ever, and a backup BoxPilot made holds none, since the apps that use
   * one make it again when they start. Removed with a warning naming each rather than refusing the
   * restore, so an app's real data with a stray pipe in it still comes back. Every entry is looked
   * at with lstat, and nothing is followed. Returns both lists, relative to `root`.
   */
  async function settleUnpacked(root, progress = null) {
    const cleared = [];
    const removed = [];
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(full); continue; }
        const info = await lstat(full);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { await walk(full); continue; }
        const relative = path.relative(root, full).split(path.sep).join("/");
        if (!info.isFile()) { await unlink(full); removed.push(relative); continue; }
        if (!(info.mode & 0o6000)) continue;
        await chmod(full, info.mode & 0o1777);
        cleared.push(relative);
      }
    };
    await walk(root);
    cleared.sort(); removed.sort();
    const some = (list) => `${list.slice(0, 10).join(", ")}${list.length > 10 ? ", ..." : ""}`;
    if (cleared.length) progress?.(`Cleared set-user-id and set-group-id from ${cleared.length} file${cleared.length === 1 ? "" : "s"} the backup marked so: ${some(cleared)}`, "stderr");
    if (removed.length) progress?.(specialFilesWords(removed), "stderr");
    return { cleared, removed };
  }

  /** The warning for what settleUnpacked took out of a restore. */
  function specialFilesWords(removed) {
    const one = removed.length === 1;
    return `Not restored: ${removed.slice(0, 10).join(", ")}${removed.length > 10 ? `, and ${removed.length - 10} more` : ""}, ${one ? "a pipe, socket or device" : "pipes, sockets or devices"} in the backup, which BoxPilot does not unpack as root into a folder a container mounts. An app that uses one makes it again when it starts.`;
  }

  /** Whether `relative` is under `base` through real folders only: "present", "absent", or "unsafe" (a link or a file on the way). */
  async function entryAt(base, relative) {
    const parts = relative.split("/");
    let current = base;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const info = await lstat(current).catch((error) => { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; });
      if (!info) return "absent";
      if (index < parts.length - 1 && (info.isSymbolicLink() || !info.isDirectory())) return "unsafe";
    }
    return "present";
  }

  /**
   * Where a backup unpacked into `directory` has a symbolic link at a place BoxPilot writes as root,
   * relative to `directory`, sorted: its project files and their temporary names, the folders it
   * makes and hands to the app's user, and the folders on the way to the config files it ships.
   * A file there that is not a regular file (a pipe, a device) is named too: every later read of it
   * would wait or read a device. So is one with another name (a hard link, R5S2-2): the archive can
   * make boxpilot.json or compose.yaml the same file as one in the app's data folder.
   *
   * A backup is only as trustworthy as whoever last held the file, and tar puts a link wherever the
   * archive says. One at `.env.tmp` made the restore's own rewrite of the project write `.env` over
   * whatever it pointed at; one at `data` would have every later deploy create and chown folders
   * through it, and Docker mount whatever it points at into the container. BoxPilot never writes a
   * link at any of these names, so a backup it made holds none.
   */
  async function linksWhereBoxPilotWrites(directory, manifest) {
    const volumes = [...manifest.volumes, ...(manifest.sidecars ?? []).flatMap((sidecar) => sidecar.volumes ?? [])].filter((volume) => volume.path).map((volume) => volume.path);
    const shipped = keptOutOfBackup(manifest).files;
    const found = new Set();
    for (const relative of [...projectFileNames, ...scratchFileNames, ...volumes, ...shipped]) {
      const parts = path.posix.normalize(relative).split("/").filter((part) => part && part !== ".");
      let current = directory;
      for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        const info = await lstat(current).catch((error) => { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; });
        if (!info) break;
        const name = parts.slice(0, index + 1).join("/");
        if (info.isSymbolicLink()) { found.add(name); break; }
        if ((projectFileNames.includes(name) || scratchFileNames.includes(name)) && !info.isFile()) { found.add(name); break; }
        // A hard link is a regular file too (R5S2-2): boxpilot.json the same file as data/x is a file
        // the container rewrites through its own volume, after every check here has looked at it.
        if (index === parts.length - 1 && !volumes.includes(relative) && info.isFile() && info.nlink > 1) { found.add(name); break; }
      }
    }
    return [...found].sort();
  }

  /**
   * Why a restore of `what` from a backup with `planted` (linksWhereBoxPilotWrites) was refused. A
   * data folder there can be the owner's own doing rather than a crafted archive: one moved to another
   * disk with a link left in its place was archived as that link until backups refused it (R5B3-1).
   */
  function plantedWords(manifest, planted, what = manifest.name) {
    const one = planted.length === 1;
    const folders = new Set([...manifest.volumes, ...(manifest.sidecars ?? []).flatMap((sidecar) => sidecar.volumes ?? [])].filter((volume) => volume.path).map((volume) => path.posix.normalize(volume.path).replace(/\/$/, "")));
    const linkedFolders = planted.filter((name) => folders.has(name));
    const how = linkedFolders.length
      ? ` If ${linkedFolders.join(" and ")} ${linkedFolders.length === 1 ? "was a link" : "were links"} in ${manifest.name}'s folder when this backup was taken (to another disk, say), the backup holds only that link and none of what it pointed at; backups now refuse such a folder instead of taking it.`
      : "";
    return `${what} was not restored; nothing was changed. In this backup ${planted.join(", ")} ${one ? "is a link, or not a plain file," : "are links, or not plain files,"} where BoxPilot writes ${manifest.name}'s own files as root: restored, the next change to ${manifest.name} would have written through ${one ? "it" : "them"} to somewhere else on this server.${how}`;
  }

  /** Backups on disk for one app, newest first. The filesystem is the source of truth. */
  /**
   * How many backups each app has, from one walk of the backup root. The recovery kit needs only
   * the counts, and asking per app cost a helper round trip and a directory walk each.
   */
  async function countAppBackups() {
    const backupRootPath = path.resolve(backupRoot);
    let entries;
    try {
      entries = await readdir(backupRootPath, { withFileTypes: true });
    } catch (error) {
      // A root that does not exist yet genuinely holds nothing; one that cannot be read is
      // unknown, and reporting it as zero would tell the owner every app is unprotected.
      if (error.code !== "ENOENT") return { available: false, counts: {}, reason: error.message };
      entries = [];
    }
    const counts = {};
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const names = await readdir(path.join(backupRootPath, entry.name)).catch(() => []);
      counts[entry.name] = names.filter((name) => backupNamePattern.test(name)).length;
    }
    return { available: true, counts };
  }

  /**
   * Which installed apps actually have a backup, and how old the newest one is.
   *
   * BoxPilot warned when its own database backup went stale and when nothing had been mirrored
   * off-box, but never that an *application* had never been backed up at all — so a server could
   * reach a dozen apps holding passwords, photos and documents with nothing protecting any of
   * them, and nothing saying so. An app counts as protectable when at least one of its volumes is
   * marked for backup; the rest (caches, downloaded models) are excluded on purpose and should not
   * be reported as unprotected.
   */
  async function backupProtection() {
    const { manifests } = await catalog.all();
    const backupRootPath = path.resolve(backupRoot);
    const apps = [];
    let readable = true;
    for (const manifest of manifests) {
      const state = await readState(manifest.id);
      if (!state?.installed) continue;
      const protectable = keepsBackupData(manifest);
      const directory = path.join(backupRootPath, manifest.id);
      let names = [];
      try { names = (await readdir(directory)).filter((name) => backupNamePattern.test(name)); }
      catch (error) { if (error.code !== "ENOENT") readable = false; names = []; }
      let newestAt = null;
      for (const name of names.sort().reverse().slice(0, 1)) {
        const meta = await readFile(path.join(directory, name.replace(/\.tar\.gz$/, ".json")), "utf8").then(JSON.parse).catch(() => null);
        const artifact = await stat(path.join(directory, name)).catch(() => null);
        newestAt = meta?.createdAt ?? artifact?.mtime?.toISOString() ?? null;
      }
      apps.push({ id: manifest.id, name: manifest.name, protectable, backups: names.length, newestAt });
    }
    // A root that cannot be read is unknown, not empty: reporting zero would tell the owner every
    // app is unprotected and invite them to "fix" something that may be fine.
    return { available: readable, apps, generatedAt: clock().toISOString() };
  }

  async function listAppBackups({ id }) {
    await ensureManifest(id);
    const backupDirectory = backupDirFor(id);
    let names = [];
    try { names = (await readdir(backupDirectory)).filter((name) => backupNamePattern.test(name)).sort().reverse(); } catch { names = []; }
    const backups = [];
    for (const name of names) {
      let meta = null;
      try { meta = JSON.parse(await readFile(path.join(backupDirectory, name.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { meta = null; }
      const artifactStat = await stat(path.join(backupDirectory, name)).catch(() => null);
      backups.push({ artifact: name, createdAt: meta?.createdAt ?? artifactStat?.mtime?.toISOString() ?? null, sizeBytes: meta?.sizeBytes ?? artifactStat?.size ?? null, checksumSha256: meta?.checksumSha256 ?? null, downtimeMs: meta?.downtimeMs ?? null, skippedHostPaths: meta?.skippedHostPaths ?? [], skippedVolumes: meta?.skippedVolumes ?? [], image: meta?.image ?? null });
    }
    return { id, directory: backupDirectory, backups };
  }

  /**
   * Rehearse a restore without performing one (M20.3). A checksum proves the bytes are the bytes
   * that were written; it does not prove the archive can be opened, or that what comes out is the
   * app.
   *
   * Nothing is written to disk to find that out. An earlier version of this unpacked the archive
   * into scratch space beside the backups, which was wrong twice over: the off-box mirrors copy
   * that tree and never delete, so a half-extracted `.env` would be pushed to the destination and
   * stay there; and a large app would fill the filesystem holding every backup and every app's
   * live data, unattended, at half past three in the morning.
   *
   * Reading the archive proves as much. `tar -tzf` has to decompress the entire stream to reach
   * every header, so a corrupt byte, a truncated member, or a bad gzip checksum anywhere fails it,
   * and the output is a list of names rather than the data. The compose file is then read on its
   * own, because being able to redeploy from the archive is the thing being rehearsed.
   */
  async function verifyAppBackup({ id, backup: backupName = null }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const backupDirectory = backupDirFor(id);
    const names = await readdir(backupDirectory).catch(() => []);
    const available = names.filter((name) => backupNamePattern.test(name)).sort().reverse();
    const target = backupName ?? available[0] ?? null;
    if (!target) throw new Error(`${manifest.name} has no backup to check`);
    if (!backupNamePattern.test(target)) throw new Error("Backup name is invalid");
    const artifact = path.join(backupDirectory, target);
    const info = await stat(artifact).catch(() => null);
    if (!info) throw new Error(`Backup ${target} does not exist`);
    const startedAt = clock().getTime();
    let meta = null;
    try { meta = JSON.parse(await readFile(path.join(backupDirectory, target.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { meta = null; }

    const fail = (reason) => ({ verified: false, id, backup: target, checkedAt: clock().toISOString(), sizeBytes: info.size, reason, durationMs: clock().getTime() - startedAt });

    if (meta?.checksumSha256) {
      progress?.(`Checking the checksum of ${target}...`, "stdout");
      const actual = await sha256File(artifact);
      if (actual !== meta.checksumSha256) return fail("The archive does not match the checksum recorded when it was written, so it has been damaged since.");
    }
    // Stream the member list rather than buffering it. `tar -tzf` prints one name per file, and an
    // app with a large mail store or photo library has enough files that the whole list would blow
    // a fixed stdout buffer and read as damage on a perfectly good archive. onLine counts them and
    // keeps only the top-level names, so memory stays flat however many files the backup holds.
    progress?.(`$ tar -tzf ${target} (reads the whole archive; writes nothing)`, "stdout");
    const topLevel = new Set();
    let memberCount = 0;
    const shipped = new Set(keptOutOfBackup(manifest).files);
    const shippedInArchive = new Set();
    // The folders a backup archives, each seen as a folder (`data/`, or something under it) or only
    // as a bare name: tar lists a folder with its slash, so `data` alone is a link or a file there,
    // and the backup holds none of the folder's data (R5B3-1).
    const folders = [...manifest.volumes, ...(manifest.sidecars ?? []).flatMap((sidecar) => sidecar.volumes ?? [])].filter((volume) => volume.backup && volume.path).map((volume) => path.posix.normalize(volume.path).replace(/\/$/, ""));
    const bare = new Set();
    const asFolder = new Set();
    const listed = await runCommand(tarBinary, ["-tzf", artifact], {
      timeout: 60 * 60_000,
      onLine: (line, stream) => {
        if (stream !== "stdout") return;   // tar warns on stderr; a warning is not an archive member
        const name = String(line ?? "").trim();
        if (!name) return;
        memberCount += 1;
        const first = name.replace(/^\.\//, "").split("/")[0];
        if (first) topLevel.add(first);
        const member = name.replace(/^\.\//, "").replace(/\/$/, "");
        if (shipped.has(member)) shippedInArchive.add(member);
        const raw = name.replace(/^\.\//, "");
        for (const folder of folders) {
          if (raw === folder) bare.add(folder);
          else if (raw.startsWith(`${folder}/`)) asFolder.add(folder);
        }
      },
    });
    if (!listed.ok) return fail(`The archive could not be read all the way through: ${redact(listed.stderr).split("\n").slice(-2).join(" ")}`);
    const expected = meta?.contents ?? ["compose.yaml"];
    const missing = expected.filter((entry) => !topLevel.has(entry.split("/")[0]));
    if (missing.length) return fail(`The archive is missing ${missing.join(", ")}, which the backup says it contains.`);
    const linked = folders.filter((folder) => bare.has(folder) && !asFolder.has(folder));
    if (linked.length) return fail(`The archive holds ${linked.join(" and ")} as a link, not the folder and what is in it: ${linked.length === 1 ? "it was a link" : "they were links"} in ${manifest.name}'s folder when the backup was taken (to another disk, say), so the backup has none of that data, and a restore refuses it.`);

    // Read the compose file out on its own. No --occurrence: that is GNU tar only, and this has to
    // behave the same wherever it runs. It costs a second pass over the archive, which a weekly
    // background rehearsal can afford.
    const compose = await runCommand(tarBinary, ["-xzOf", artifact, "compose.yaml"], { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    if (!compose.ok || !compose.stdout.trim()) return fail("The archive has no compose.yaml, so it could not be redeployed from.");
    let archivedCompose;
    try { archivedCompose = YAML.parse(compose.stdout); } catch (error) { return fail(`The compose file in the archive is not valid YAML: ${error.message}`); }

    // A config file the manifest ships is never archived: the restore keeps it from the app folder
    // (keptOutOfBackup). One the archived compose file mounts that the folder no longer has would
    // come back as a directory Docker makes in its place, and the app would not start.
    const mountedSources = new Set(Object.values(archivedCompose?.services ?? {}).flatMap((service) => (Array.isArray(service?.volumes) ? service.volumes : []))
      .map((volume) => (typeof volume === "string" ? volume.split(":")[0] : volume?.source))
      .filter((source) => typeof source === "string" && source.startsWith("./"))
      .map((source) => path.posix.normalize(source)));
    const lost = [];
    for (const relative of shipped) {
      if (!mountedSources.has(relative) || shippedInArchive.has(relative)) continue;
      if ((await entryAt(dirFor(id), relative)) !== "present") lost.push(relative);
    }
    if (lost.length) return fail(`Restoring it would leave ${lost.join(", ")} missing: the backup does not hold ${lost.length === 1 ? "that config file" : "those config files"} (${manifest.name} ships them, so no backup does) and ${manifest.name}'s folder no longer has ${lost.length === 1 ? "it" : "them"} to keep, so Docker would make a folder in ${lost.length === 1 ? "its" : "their"} place and ${manifest.name} would not start. Saving ${manifest.name}'s settings again writes ${lost.length === 1 ? "it" : "them"} back.`);

    const durationMs = clock().getTime() - startedAt;
    progress?.(`${target} reads cleanly: ${memberCount} entr${memberCount === 1 ? "y" : "ies"}, compose.yaml valid`, "stdout");
    return { verified: true, id, backup: target, checkedAt: clock().toISOString(), sizeBytes: info.size, entries: topLevel.size, members: memberCount, contents: expected, checksumVerified: Boolean(meta?.checksumSha256), durationMs, reason: null };
  }

  /**
   * Whether a backup's saved settings can write its compose file again for this server, or why it is
   * started exactly as archived instead (`verbatim`): there are none ("no-settings"), the owner
   * edited the file by hand ("edited"), or they no longer fit the catalog ("unfit", with `errors`).
   * `{ values }` when they can. The restore and the review before it both decide here, so what the
   * dialog says will be started verbatim is what the restore starts verbatim.
   */
  function archivedSettingsFit(manifest, state, existingEnv) {
    if (!state || typeof state !== "object") return { verbatim: "no-settings" };
    if (state.rawEdited) return { verbatim: "edited" };
    const { values, errors } = resolveValues(manifest, withSavedSecrets(manifest, sanitizeStoredValues(manifest, state.values ?? {}), existingEnv));
    if (errors.length) return { verbatim: "unfit", errors };
    return { verbatim: null, values };
  }

  /** The first link on the way to `folder` from /, as `{ path, target }`, or null. Never follows one. */
  async function linkOnTheWay(folder) {
    let current = "/";
    for (const part of folder.split("/").filter(Boolean)) {
      current = path.posix.join(current, part);
      const info = await lstat(current).catch(() => null);
      if (!info) return null;
      if (info.isSymbolicLink()) return { path: current, target: await readlink(current).catch(() => "somewhere else") };
    }
    return null;
  }

  /**
   * Why the data folders saved settings point an app at cannot be used, as an install or a settings
   * change would refuse them (sweep 4, writeProject's checkedDataFolders): not a clean absolute path,
   * a `..` on the way, a protected system location, a link anywhere on the way, or a real location
   * that is not the one named. Empty when they can. A restore takes these from boxpilot.json in the
   * backup, which is only as trustworthy as whoever last held it, starts the app on them without a
   * deploy, and every later deploy mounts them. The manifest's own defaults are checked for links too
   * (R5S2-1); the system mounts a manifest declares by name (Docker's socket, /proc) are not folders
   * of data and are left alone, as a deploy leaves them.
   */
  async function dataFolderProblems(manifest, storedValues) {
    const chosen = sanitizeStoredValues(manifest, storedValues ?? {}).volumes;
    const problems = [];
    for (const volume of manifest.volumes) {
      if (!volume.hostPath) continue;
      const value = volume.configurable && Object.hasOwn(chosen, volume.id) ? chosen[volume.id] : volume.hostPath;
      const label = volume.label ?? volume.id;
      if (value !== volume.hostPath) {
        const error = resolveValues(manifest, { volumes: { [volume.id]: value } }).errors.find((entry) => entry.startsWith(`values.volumes.${volume.id}:`));
        if (error) { problems.push(`${label} is set to ${JSON.stringify(String(value).slice(0, 200))}, which ${error.replace(/^values\.volumes\.[^:]+:\s*/, "")}`); continue; }
      }
      if (isDeniedHostPath(value)) continue;
      const folder = value.replace(/\/+$/, "") || "/";
      const link = await linkOnTheWay(folder);
      if (link) { problems.push(`${label} is set to ${folder}, and ${link.path} on the way there is a link to ${link.target}`); continue; }
      const real = await resolveExisting(folder, { realpath: realpathOf });
      if (isDeniedHostPath(real)) problems.push(`${label} is set to ${folder}, which is ${real} on this server, a protected system location`);
      else if (real !== path.resolve(folder)) problems.push(`${label} is set to ${folder}, which is ${real} on this server: a link on the way leads somewhere else`);
    }
    return problems;
  }

  /** A path as the compose file names it: POSIX, and absolute (a Windows test run's C:\ becomes /C:/). */
  const posixPath = (value) => {
    const forward = value.split(path.sep).join("/");
    return forward.startsWith("/") ? forward : `/${forward}`;
  };

  /** The data folders saved settings point the app at (the catalog's default where they name none). */
  function chosenDataFolders(manifest, state) {
    const chosen = sanitizeStoredValues(manifest, state && typeof state === "object" ? state.values ?? {} : {}).volumes;
    return manifest.volumes.filter((volume) => volume.configurable && volume.hostPath).map((volume) => chosen[volume.id] ?? volume.hostPath).filter((folder) => typeof folder === "string" && folder.startsWith("/"));
  }

  /**
   * What a compose file mounts from the app's own folder that is a link in what the backup unpacked
   * (`staged`): `./data` there pointing at `/` is mounted as `/`, since Docker follows it. Listed as
   * powerful settings, like a mount of what it points at.
   */
  async function linkedAppFolderMounts(compose, manifest, roots, staged) {
    const findings = [];
    for (const mount of appFolderMounts(compose, { manifest, managedRoots: roots })) {
      const parts = path.posix.relative(roots[0], mount.path).split("/").filter(Boolean);
      let current = staged;
      for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        const info = await lstat(current).catch(() => null);
        if (!info) break;
        if (!info.isSymbolicLink()) continue;
        const target = await readlink(current).catch(() => "somewhere else");
        findings.push({ service: mount.service, setting: mount.setting, value: mount.shown, detail: `mounts ${parts.slice(0, index + 1).join("/")} from the app's folder, which in this backup is a link to ${target}`, system: true });
        break;
      }
    }
    return findings;
  }

  /**
   * What a backup's project would do if restored (sweep 4): whether its compose file would be
   * started exactly as archived (`verbatim`, `reason`), every setting in it that reaches past what
   * the catalog grants the app (`findings`, catalog/compose-review.mjs), the file's `sha256`, and
   * whether this server already runs that same file (`sameAsRunning`), in which case restoring it
   * grants nothing new. `folderProblems` are data folders an install would refuse.
   *
   * `files` are the archive's compose.yaml, boxpilot.json and .env as text (null when absent);
   * `staged`, when the archive has been unpacked, is where, so the app-folder paths the file mounts
   * can be checked for links. Nothing here is returned to anyone but the helper's caller: no file
   * contents, no secrets.
   */
  async function reviewArchivedProject(manifest, { compose = null, stateText = null, envText = null } = {}, { staged = null } = {}) {
    let state = null;
    try { state = stateText ? JSON.parse(stateText) : null; } catch { state = null; }
    const folderProblems = await dataFolderProblems(manifest, state && typeof state === "object" ? state.values : null);
    const fit = archivedSettingsFit(manifest, state, parseEnvFile(envText ?? ""));
    const result = { verbatim: Boolean(fit.verbatim), reason: fit.verbatim ?? null, folderProblems, findings: [], sha256: null, sameAsRunning: false };
    if (typeof compose !== "string" || !compose.trim()) return result;
    const roots = [posixPath(dirFor(manifest.id)), ...chosenDataFolders(manifest, state)];
    const findings = powerfulComposeSettings(compose, { manifest, appId: manifest.id, managedRoots: roots });
    if (staged) findings.push(...await linkedAppFolderMounts(compose, manifest, roots, staged));
    // The app as it runs now, before anything is replaced. A setting a variable decides is the same
    // only when the .env that decides it is the same too.
    const running = await readFileWithoutFollowing(path.join(dirFor(manifest.id), "compose.yaml")).catch(() => null);
    const runningEnv = findings.some((finding) => finding.variable) ? await readFileWithoutFollowing(path.join(dirFor(manifest.id), ".env")).catch(() => null) : null;
    const sameAsRunning = sameCompose(compose, running) && (!findings.some((finding) => finding.variable) || sameCompose(envText ?? "", runningEnv ?? ""));
    return { ...result, findings, sha256: composeSha256(compose), sameAsRunning };
  }

  /** What the review says, for the restore dialogs: the review and whether the restore needs `allowCompose`. */
  function reviewSummary(manifest, review) {
    const refused = review.verbatim ? review.findings.filter((finding) => finding.refuse) : [];
    const powerful = review.verbatim ? review.findings.filter((finding) => !finding.refuse) : [];
    const refusals = [...review.folderProblems, ...refused.map((finding) => composeFindingsText([finding]))];
    return {
      id: manifest.id, name: manifest.name, verbatim: review.verbatim, reason: review.reason,
      findings: powerful, refusals, sha256: review.verbatim ? review.sha256 : null, sameAsRunning: review.sameAsRunning,
      needsAllow: refusals.length === 0 && powerful.length > 0 && !review.sameAsRunning,
    };
  }

  const verbatimWhy = { edited: "it was edited by hand", "no-settings": "the backup holds no saved settings to write it again from", unfit: "its saved settings no longer fit the catalog" };

  /**
   * The restore's gate on a compose file it is about to start exactly as archived (sweep 4). Nothing
   * to say when it grants nothing past the catalog, or this server already runs that very file. A
   * file that pulls in others, or does not parse, is refused whatever was allowed. Otherwise it is
   * refused unless `allowCompose` is its sha256: the restore dialogs list these settings and a
   * typed confirmation stages the restore with that hash. Returns the warning an allowed one leaves.
   */
  function composeGate(manifest, review, allowCompose) {
    const why = verbatimWhy[review.reason] ?? "it could not be written again from the catalog";
    const refused = review.findings.filter((finding) => finding.refuse);
    if (refused.length) throw Object.assign(new Error(`${manifest.name} was not restored; nothing was changed. Its compose file would be started exactly as it was backed up, since ${why}, and ${composeFindingsText(refused)}, so BoxPilot cannot tell what it would start.`), { code: "compose_refused" });
    if (!review.findings.length || review.sameAsRunning) return null;
    const list = composeFindingsText(review.findings);
    if (allowCompose && allowCompose === review.sha256) return `${manifest.name}'s compose file was started exactly as it was backed up, with the settings you allowed: ${list}.`;
    const next = allowCompose
      ? "It is not the compose file that was allowed: the backup has changed since it was reviewed, so review it again."
      : "To start it anyway, allow these settings in the restore dialog, which lists them.";
    throw Object.assign(new Error(`${manifest.name} was not restored; nothing was changed. Its compose file would be started exactly as it was backed up, since ${why}, and it gives ${manifest.name} more than the catalog does: ${list}. ${next} (compose sha256 ${review.sha256})`), { code: "compose_not_allowed" });
  }

  /** Why a restore was refused for the data folders a backup's settings name (dataFolderProblems). */
  const folderWords = (manifest, problems, what = manifest.name) => `${what} was not restored; nothing was changed. The backup's settings point ${manifest.name} at data folders an install would refuse: ${problems.join("; ")}.`;

  /**
   * The review of an app data archive at `archive` without unpacking it (archive-members.mjs): for
   * the restore dialogs, and a machine snapshot's check before it changes anything. A preview: the
   * restore checks what it actually unpacked.
   */
  async function reviewArchive({ id, archive }) {
    const manifest = await ensureManifest(id);
    const members = await readArchiveMembers(archive, ["compose.yaml", "boxpilot.json", ".env"], { maxBytes: 1024 * 1024 });
    const text = (name) => (members.has(name) ? members.get(name).toString("utf8") : null);
    return reviewSummary(manifest, await reviewArchivedProject(manifest, { compose: text("compose.yaml"), stateText: text("boxpilot.json"), envText: text(".env") }));
  }

  /** A machine snapshot's settings for one app, checked before the snapshot restore changes anything (dataFolderProblems). */
  async function dataFoldersRefused({ id, values }) {
    return dataFolderProblems(await ensureManifest(id), values);
  }

  /** app.backup.review: what restoring this backup would start, before it is restored. */
  async function reviewAppBackup({ id, backup: backupName }) {
    await ensureManifest(id);
    const { artifact } = backupArtifactFor(id, backupName);
    await stat(artifact).catch(() => { throw new Error(`Backup ${backupName} does not exist`); });
    return { backup: backupName, ...await reviewArchive({ id, archive: artifact }) };
  }

  /**
   * The compose project of a backup unpacked into `directory`, written again for this server.
   *
   * A backup's compose file carries the server it was taken on: the tailnet address every
   * `tailnet: address` port binds, device paths, a GPU reservation. Started as it was on a rebuilt
   * server or a node that re-joined Tailscale, `up` failed with "cannot assign requested address"
   * and the app was left down. So it is written again from the backup's own saved settings, as
   * Reinstall writes a missing one, on the images the backup's compose file ran (the data in it was
   * written by those, a sidecar's database included), with the devices this server's compose file
   * names (the web process resolved those; this process has no real /dev), else the backup's.
   *
   * A compose file edited by hand is the owner's own and is kept as it is, with a warning; so is one
   * whose saved settings no longer fit the catalog. Throws when this server cannot take the
   * settings (tailnet only with no tailnet address, a device it does not have).
   * Returns `{ rendered, values }` when it wrote the project again, and `warning` when it did not.
   */
  async function projectForThisServer(manifest, directory, archivedCompose, { progress = null } = {}) {
    const state = await readFileWithoutFollowing(path.join(directory, "boxpilot.json")).then(JSON.parse).catch(() => null);
    const existingEnv = parseEnvFile(await readFileWithoutFollowing(path.join(directory, ".env")).catch(() => ""));
    const fit = archivedSettingsFit(manifest, state, existingEnv);
    if (fit.verbatim === "no-settings") return { rendered: null };
    if (fit.verbatim === "edited") return { rendered: null, warning: `${manifest.name}'s compose file was edited by hand, so it was restored exactly as it was backed up. If it names an address, a device or a GPU this server does not have, ${manifest.name} will not start until it is edited again.` };
    if (fit.verbatim === "unfit") return { rendered: null, warning: `${manifest.name}'s settings in this backup no longer fit the catalog (${fit.errors.join("; ")}), so its compose file was restored exactly as it was backed up.` };
    const { values } = fit;
    const ran = deployedImages(archivedCompose);
    const foreign = Object.entries(ran).filter(([service, reference]) => {
      const catalog = service === manifest.id ? manifest.image.reference : (manifest.sidecars ?? []).find((sidecar) => sidecar.id === service)?.image;
      return catalog && !catalogImagePin(reference, catalog);
    });
    const pinned = {
      ...manifest,
      image: { ...manifest.image, reference: catalogImagePin(ran[manifest.id], manifest.image.reference) ?? catalogImagePin(state.image?.reference, manifest.image.reference) ?? manifest.image.reference },
      sidecars: (manifest.sidecars ?? []).map((sidecar) => (catalogImagePin(ran[sidecar.id], sidecar.image) ? { ...sidecar, image: ran[sidecar.id] } : sidecar)),
    };
    // Named with the image that is used instead: when the catalog moved the app to another repository,
    // that image's tag can be a newer release than the one that wrote the data.
    for (const [service, reference] of foreign) {
      const used = service === manifest.id ? pinned.image.reference : pinned.sidecars.find((sidecar) => sidecar.id === service)?.image;
      progress?.(`The backup ran ${service} on ${reference}, which is not from ${manifest.name}'s catalog repository; it is restored on ${used}, which may be a different release than the one that wrote this data`, "stderr");
    }
    const current = await readFileWithoutFollowing(path.join(dirFor(manifest.id), "compose.yaml")).catch(() => null);
    const rendered = await renderProject(pinned, values, { existingEnv, devices: composeDevices(current ?? archivedCompose) });
    // Only these two files. The folders a backup leaves out (downloaded models, a cache) and the
    // config files the manifest ships are carried over from the app folder the restore replaces,
    // and only where the unpacked backup has none: made here, empty, they stood in for the real ones.
    // `directory` is the unpacked archive, so any of these names may be a link it planted (to
    // /etc/cron.d/x, to BoxPilot's own code): each is removed, never followed, and the new file is
    // created exclusively and renamed into place (replaceFileWithoutFollowing).
    const names = [".env", "compose.yaml"];
    for (const name of names) for (const entry of [name, `${name}.tmp`]) await rm(path.join(directory, entry), { recursive: true, force: true });
    for (const [name, content] of [[".env", rendered.envFile], ["compose.yaml", rendered.composeYaml]]) {
      await replaceFileWithoutFollowing(path.join(directory, name), content, { mode: 0o600 });
    }
    if (rendered.composeYaml !== archivedCompose) progress?.(`Wrote ${manifest.name}'s compose file again from the settings in the backup, for this server's addresses and devices, on ${pinned.image.reference}`, "stdout");
    return { rendered, values };
  }

  /** Restore a backup over the app directory: checksum check, extract, port check, safety backup, stop, swap, start. */
  async function restoreAppBackup({ id, backup: backupName, allowCompose = null }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    if (typeof backupName !== "string" || !backupNamePattern.test(backupName)) throw new Error("Backup name is invalid");
    const kept = keptOutOfBackup(manifest);
    const live = dirFor(id);
    const staged = `${live}.restoring`;
    const displaced = `${live}.replaced`;
    for (const candidate of [staged, displaced]) {
      const existing = await lstat(candidate).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (existing) throw new Error(`An earlier restore left ${path.basename(candidate)}. Preserve it and review the restore job before trying again; it may contain the only original data.`);
    }
    const backupDirectory = backupDirFor(id);
    const artifact = path.join(backupDirectory, backupName);
    await stat(artifact).catch(() => { throw new Error(`Backup ${backupName} does not exist`); });
    let meta = null;
    try { meta = JSON.parse(await readFile(path.join(backupDirectory, backupName.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { meta = null; }
    if (meta?.checksumSha256) {
      progress?.("Verifying the backup checksum...", "stdout");
      const actual = await sha256File(artifact);
      if (actual !== meta.checksumSha256) throw new Error(`Backup ${backupName} failed its checksum; it may be damaged. Nothing was changed.`);
    }
    // Extract beside the app and swap, so the result is the backup and nothing else. Unpacking over
    // the live directory would leave every file written since — for a database that means old control
    // files next to newer WAL segments, which is neither the backup nor the present state.
    // A data archive can have come from a drive or a mirror (a machine snapshot copies it in).
    await assertArchiveFits({ run: runCommand, tarBinary, artifactPath: artifact, directory: path.dirname(staged), reserveBytes: restoreReserveBytes, free: freeBytesOf, what: `Backup ${backupName}` });
    await mkdir(staged, { mode: 0o700 });
    progress?.(`$ tar -xzf ${backupName}`, "stdout");
    // Everything inside keeps the archive's owners and modes, which container users need.
    const extract = await runCommand(tarBinary, ["-xzf", artifact, "-C", staged], { timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    if (!extract.ok) {
      await rm(staged, { recursive: true, force: true });
      throw new Error(`tar extraction failed: ${extract.stderr.split("\n").slice(-2).join(" ")}. The live application directory was not replaced.`);
    }
    // An archive's "./" entry gives the folder it is unpacked into its own mode and owner (0777, say),
    // and becomes the app folder: it is set back to what BoxPilot made. (--no-overwrite-dir would
    // also skip the owners of folders an archive lists after their files.)
    await chmod(staged, 0o700);
    if (typeof process.getuid === "function") await lchown(staged, process.getuid(), process.getgid?.() ?? process.getuid());
    // The backup's compose file is what `up` binds, and the app may have moved since it was written
    // (to tailnet only, with Serve now holding its old port on the tailnet address). Asked before
    // anything is stopped: found by `up` instead, the app was left down with "address already in
    // use", and the .replaced folder it left refused every retry.
    let ports;
    let deployed = { rendered: null };
    // The compose file `up` will start, as the port checks see it.
    let starting = "";
    const warnings = [];
    try {
      // Names BoxPilot only writes under and renames away, and the marker of a backup in progress:
      // nothing a restore brings back, and a link at one would be written through. Then refuse a
      // backup with a link where BoxPilot writes (linksWhereBoxPilotWrites), before anything stops.
      for (const name of scratchFileNames) await rm(path.join(staged, name), { recursive: true, force: true });
      const planted = await linksWhereBoxPilotWrites(staged, manifest);
      if (planted.length) throw new Error(plantedWords(manifest, planted));
      // Set-id bits off every file, and pipes, sockets and devices out of the tree (settleUnpacked).
      const unpacked = await settleUnpacked(staged, progress);
      if (unpacked.removed.length) warnings.push(specialFilesWords(unpacked.removed));
      // The project's own files, which every later deploy reads and `up` starts, as new files of their
      // own with the archived content (R5S2-2): whatever else the archive did, nothing in the data a
      // container writes can be the same file as these. What the checks below read, and the compose
      // gate hashes, is then exactly what is started.
      for (const name of ["boxpilot.json", "compose.yaml", ".env"]) {
        const content = await readFileWithoutFollowing(path.join(staged, name), { encoding: null }).catch(() => null);
        if (content !== null) await replaceFileWithoutFollowing(path.join(staged, name), content, { mode: 0o600 });
      }
      const stagedCompose = path.join(staged, "compose.yaml");
      let project = (await lstat(stagedCompose).catch(() => null))?.isFile() ? await readFile(stagedCompose, "utf8") : "";
      // What the backup's settings point the app at, and what its compose file would hand the
      // containers if it is started as archived, checked before anything stops (sweep 4).
      const unpackedText = (name) => readFileWithoutFollowing(path.join(staged, name)).catch(() => null);
      const review = await reviewArchivedProject(manifest, { compose: project, stateText: await unpackedText("boxpilot.json"), envText: await unpackedText(".env") }, { staged });
      if (review.folderProblems.length) throw new Error(folderWords(manifest, review.folderProblems));
      // Written again for this server first: the port check and `up` are of what will be started.
      if (project) {
        try {
          deployed = await projectForThisServer(manifest, staged, project, { progress });
        } catch (error) {
          throw keepTimeout(error, new Error(`${manifest.name} was not restored; nothing was changed. ${error.message}`));
        }
        if (deployed.warning) { warnings.push(deployed.warning); progress?.(deployed.warning, "stderr"); }
        if (deployed.rendered) project = deployed.rendered.composeYaml;
        else {
          // Started exactly as archived: only what this server already runs, or what the owner allowed.
          const allowed = composeGate(manifest, review, allowCompose);
          if (allowed) { warnings.push(allowed); progress?.(allowed, "stderr"); }
        }
      }
      starting = project;
      ports = await assertPortsFree(manifest, project, { progress, refused: `${manifest.name} was not restored; nothing was changed.` });
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      throw error;
    }
    // Taken only now, with nothing left to refuse: it stops and starts the app and counts toward the
    // newest few an app keeps, so one taken before a refusal that says "nothing was changed" was a
    // change, and a few retries pushed the very archive being restored out at the next prune.
    let safetyBackupSaved = false;
    let safetyArtifact = null;
    try {
      progress?.("Taking a safety backup of the current state first...", "stdout");
      const safety = await backup({ id, keep: null }, { progress });
      safetyBackupSaved = true;
      safetyArtifact = safety.artifact;
      progress?.(`Current state saved as ${safety.artifact}`, "stdout");
    } catch (error) {
      progress?.(`Safety backup failed (${error.message}); the original directory will be retained after the restore`, "stderr");
    }
    // Asked again (R5B3-3): the safety copy had the app stopped for a while, and a program waiting
    // for one of its ports (Serve retrying, a restart elsewhere) could take it then. Found by `up`
    // after the swap instead, the app was left down and the .replaced folder refused every retry.
    try {
      ports = await assertPortsFree(manifest, starting, { progress, refused: safetyArtifact ? `${manifest.name} was not restored; its current state was saved as ${safetyArtifact} first, and nothing else was changed.` : `${manifest.name} was not restored.` });
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      throw error;
    }
    const status = await containerStatus(id);
    if (status.running) {
      const stop = await compose(id, ["stop"], { timeout: 120_000, progress });
      if (!stop.ok) {
        await rm(staged, { recursive: true, force: true });
        throw new Error(`docker compose stop failed: ${redact(stop.stderr).split("\n").slice(-3).join(" ")}. The live application directory was not replaced.`);
      }
    }
    if (await stat(live).then(() => true, () => false)) await rename(live, displaced);
    try {
      await rename(staged, live);
    } catch (error) {
      // Put the app back exactly as it was rather than leaving it with no directory at all.
      let recovered = false;
      if (await stat(displaced).then(() => true, () => false)) recovered = await rename(displaced, live).then(() => true, () => false);
      await rm(staged, { recursive: true, force: true });
      throw new Error(`Could not swap in the restored files (${error.message}). ${recovered ? "The original directory was put back; check whether the app needs starting." : "The original may remain in the .replaced directory; preserve it and inspect before retrying."}`);
    }
    // What the archive leaves out on purpose comes across from the folder it replaced
    // (keptOutOfBackup). Swapping the archive in alone deleted the downloaded models, the export
    // folder and the mailbox with the old folder, and left Docker to make a directory where
    // Prometheus's config file belongs. Moved, not copied (models can be most of a disk), and moved
    // back if the restored app does not come up, so .replaced is always the whole original.
    const carried = [];
    const putBack = async () => {
      for (const relative of [...carried].reverse()) await rename(path.join(live, relative), path.join(displaced, relative)).catch(() => {});
    };
    if (await lstat(displaced).then(() => true, () => false)) {
      const linked = [];
      const refusedLinks = [];
      const carriedLinks = [];
      for (const relative of kept.all) {
        if ((await entryAt(displaced, relative)) !== "present") continue;
        const here = await entryAt(live, relative);
        if (here === "present") continue;   // an older backup that did hold it: the archive's copy stands
        // A link there is carried only at a folder backups leave out (R5B3-4), and only when where it
        // leads is somewhere an install would let the owner choose (ownersLinkRefusal). One at a file
        // BoxPilot writes, or one leading into a protected place (left by a backup restored before
        // links were refused), stays behind: Docker would mount, and the next deploy write through,
        // whatever it names.
        if ((await lstat(path.join(displaced, relative))).isSymbolicLink()) {
          if (!kept.folders.includes(relative)) { linked.push(relative); continue; }
          const refusal = await ownersLinkRefusal(path.join(displaced, relative));
          if (refusal) { refusedLinks.push(`${relative} is a link to ${refusal}`); continue; }
          carriedLinks.push(relative);
        }
        try {
          if (here === "unsafe") throw new Error("a link or a file in the restored folder stands in its way");
          await placeWithoutFollowing(path.join(displaced, relative), live, relative, path.join(displaced, ".boxpilot-aside"));
          carried.push(relative);
        } catch (error) {
          await putBack();
          throw new Error(`Restored the files, but could not keep ${relative} from the app folder (${error.message}), so ${manifest.name} was not started. The original directory remains in ${path.basename(displaced)}; preserve it.`);
        }
      }
      if (carried.length) progress?.(`Kept from the app folder, as backups leave them out: ${carried.join(", ")}${carriedLinks.length ? ` (${carriedLinks.join(", ")} as the link${carriedLinks.length === 1 ? "" : "s"} you made)` : ""}`, "stdout");
      if (linked.length) {
        const warning = `Not kept from the app folder: ${linked.join(", ")} ${linked.length === 1 ? "is a link" : "are links"} there, and BoxPilot does not bring a link back where it writes ${manifest.name}'s files as root. What ${linked.length === 1 ? "it points" : "they point"} at is left as it is.`;
        warnings.push(warning);
        progress?.(warning, "stderr");
      }
      if (refusedLinks.length) {
        const warning = `Not kept from the app folder: ${refusedLinks.join("; ")}, which BoxPilot does not mount into ${manifest.name}. What ${refusedLinks.length === 1 ? "it points" : "they point"} at is left as it is; ${manifest.name} starts with ${refusedLinks.length === 1 ? "that folder" : "those folders"} empty.`;
        warnings.push(warning);
        progress?.(warning, "stderr");
      }
    }
    const missing = [];
    for (const relative of kept.files) if ((await entryAt(live, relative)) === "absent") missing.push(relative);
    if (missing.length) progress?.(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} in neither the backup nor the app folder; ${manifest.name} may not start without ${missing.length === 1 ? "it" : "them"}`, "stderr");
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    if (!up.ok) {
      await putBack();
      throw new Error(`Restored the files, but docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}. The original directory remains in ${path.basename(displaced)} for recovery.`);
    }
    let healthy;
    try { healthy = await waitHealthy(manifest, progress); }
    catch (error) {
      await putBack();
      throw new Error(`${error.message}. Preserve ${path.basename(displaced)}; it holds the original directory when one existed.`);
    }
    if (safetyBackupSaved) await rm(displaced, { recursive: true, force: true });
    const retainedOriginal = !safetyBackupSaved && await lstat(displaced).then(() => true, () => false);
    if (retainedOriginal) progress?.(`Restore passed its health check. ${path.basename(displaced)} was retained because no safety backup was saved.`, "stderr");
    warnings.push(...(ports?.warnings ?? []));
    return {
      restored: true, id, name: manifest.name, backup: backupName, image: healthy.image, health: healthy.health, retainedOriginal,
      // Who can reach it and on which ports, as written for this server: a snapshot restore publishes
      // a tailnet-only app's web ports with Tailscale Serve from these.
      ...(deployed.rendered ? { exposure: deployed.values.exposure ?? "lan", hostPorts: deployed.rendered.hostPorts } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  function backupArtifactFor(id, backupName) {
    if (typeof backupName !== "string" || !backupNamePattern.test(backupName)) throw new Error("Backup name is invalid");
    return { backupDirectory: backupDirFor(id), artifact: path.join(backupDirFor(id), backupName) };
  }

  /**
   * `tar -tzv` listing of one backup: relative path, size, and kind, at most `limit` of them.
   * `filter` keeps the paths that contain it (any case), and `path` the one with exactly that path.
   *
   * Streamed a line at a time (R5B3-6): buffered whole, a backup with a large photo library or mail
   * store overflowed the 64 MB cap and failed "maxBuffer exceeded", and only the first 5000 names
   * ever reached the dialog, so its filter could not find a file past them. The archive is read to
   * the end whatever the limit, so `matched` says how many there were and `truncated` whether more
   * matched than came back.
   */
  async function listAppBackupFiles({ id, backup: backupName, limit = 5000, filter = null, path: exactPath = null }) {
    await ensureManifest(id);
    const { artifact } = backupArtifactFor(id, backupName);
    await stat(artifact).catch(() => { throw new Error(`Backup ${backupName} does not exist`); });
    const needle = typeof filter === "string" && filter.trim() ? filter.trim().toLowerCase() : null;
    const files = [];
    let matched = 0;
    // GNU tar: "mode owner/group size YYYY-MM-DD HH:MM name"; bsdtar: "mode links owner group size Mon DD HH:MM|YYYY name".
    const gnu = /^([-dlcbps][rwxsStT-]{9})\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/;
    const bsd = /^([-dlcbps][rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+[A-Za-z]{3}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/;
    const listing = await runCommand(tarBinary, ["-tzvf", artifact], {
      timeout: 10 * 60_000,
      onLine: (line, stream) => {
        if (stream !== "stdout") return;   // tar warns on stderr; a warning is not an archive member
        const match = String(line ?? "").match(gnu) ?? String(line ?? "").match(bsd);
        if (!match) return;
        const relative = match[3].replace(/ -> .*$/, "").replace(/^\.\//, "").replace(/\/$/, "");
        if (!relative || relative === ".") return;
        if (exactPath !== null ? relative !== exactPath : needle !== null && !relative.toLowerCase().includes(needle)) return;
        matched += 1;
        if (files.length < limit) files.push({ path: relative, sizeBytes: Number(match[2]), type: match[1].startsWith("d") ? "directory" : match[1].startsWith("l") ? "link" : "file" });
      },
    });
    if (!listing.ok) throw new Error(`Could not read the archive: ${listing.stderr.split("\n").slice(-2).join(" ")}`);
    return { id, backup: backupName, files, truncated: matched > files.length, matched, ...(needle !== null ? { filter: needle } : {}) };
  }

  /**
   * Move `source` to `base/relativePath` without ever resolving a symlink on the way. Every folder
   * between base and the destination must be a real directory (missing ones are created one level
   * at a time); the destination itself, whatever it is, is moved aside to `aside` rather than
   * written through, and put back if the move fails.
   */
  async function placeWithoutFollowing(source, base, relativePath, aside) {
    const parts = relativePath.split("/");
    let current = base;
    for (const part of ["", ...parts.slice(0, -1)]) {
      current = part ? path.join(current, part) : current;
      const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (!info) { await mkdir(current, { mode: 0o755 }); continue; }
      if (info.isSymbolicLink()) throw new Error(`${path.relative(base, current) || "The app folder"} is a symbolic link; restoring through it could write outside the app, so nothing was restored`);
      if (!info.isDirectory()) throw new Error(`${path.relative(base, current)} is not a folder, so ${relativePath} cannot be restored inside it`);
    }
    const target = path.join(base, relativePath);
    const displaced = await lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
    if (displaced) await rename(target, aside);
    try {
      await rename(source, target);
    } catch (error) {
      if (displaced) await rename(aside, target).catch(() => {});
      throw error;
    }
  }

  /** Restore one path (file or directory) from a backup after a checkpoint; everything else stays as it is. */
  async function restoreAppBackupPath({ id, backup: backupName, path: relativePath }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const { backupDirectory, artifact } = backupArtifactFor(id, backupName);
    if (typeof relativePath !== "string" || !relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("Path must be a relative path inside the backup");
    const listing = await listAppBackupFiles({ id, backup: backupName, path: relativePath, limit: 1 });
    const member = listing.files.find((entry) => entry.path === relativePath);
    if (!member) throw new Error(`${relativePath} is not in ${backupName}`);
    let meta = null;
    try { meta = JSON.parse(await readFile(path.join(backupDirectory, backupName.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { meta = null; }
    if (meta?.checksumSha256) {
      progress?.("Verifying the backup checksum...", "stdout");
      if ((await sha256File(artifact)) !== meta.checksumSha256) throw new Error(`Backup ${backupName} failed its checksum; it may be damaged. Nothing was changed.`);
    }
    await assertArchiveFits({ run: runCommand, tarBinary, artifactPath: artifact, directory: path.dirname(dirFor(id)), members: [relativePath], reserveBytes: restoreReserveBytes, free: freeBytesOf, what: `${relativePath} in ${backupName}` });
    const saved = await checkpoint({ id, reason: "file restore", preserve: backupName }, { progress });
    const status = await containerStatus(id);
    if (status.running) {
      const stop = await compose(id, ["stop"], { timeout: 120_000, progress });
      if (!stop.ok) throw new Error(`docker compose stop failed: ${redact(stop.stderr).split("\n").slice(-3).join(" ")}`);
    }
    // Extract into a fresh folder of our own, never into the live one: tar runs as root and follows a
    // directory symlink it finds on the way, and a container can plant one in its own volume
    // (data/config -> /etc). The result is then moved into place one checked component at a time.
    const live = dirFor(id);
    const staged = `${live}.restoring-path`;
    let failure = null;
    const warnings = [];
    try {
      await rm(staged, { recursive: true, force: true });
      await mkdir(staged, { mode: 0o700 });
      progress?.(`$ tar -xzf ${backupName} ${relativePath}`, "stdout");
      // "--" before the member name (M50): one starting with "-" would be read as an option.
      const extract = await runCommand(tarBinary, ["-xzf", artifact, "-C", staged, "--", relativePath], { timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      if (!extract.ok) throw new Error(`tar extraction failed: ${extract.stderr.split("\n").slice(-2).join(" ")}. The checkpoint ${saved.artifact} holds the pre-restore state.`);
      const planted = await linksWhereBoxPilotWrites(staged, manifest);
      if (planted.length) throw new Error(plantedWords(manifest, planted, relativePath));
      const unpacked = await settleUnpacked(staged, progress);
      if (unpacked.removed.length) warnings.push(specialFilesWords(unpacked.removed));
      // Settings or a compose file brought back on their own are what every later deploy, start and
      // update goes by, so they are checked as a whole restore checks them (sweep 4).
      const liveText = (name) => readFileWithoutFollowing(path.join(live, name)).catch(() => null);
      if (relativePath === "boxpilot.json") {
        let state = null;
        try { state = JSON.parse(await readFileWithoutFollowing(path.join(staged, "boxpilot.json"))); } catch { state = null; }
        const problems = await dataFolderProblems(manifest, state && typeof state === "object" ? state.values : null);
        if (problems.length) throw new Error(folderWords(manifest, problems, relativePath));
      }
      if (relativePath === "compose.yaml") {
        const compose = await readFileWithoutFollowing(path.join(staged, "compose.yaml")).catch(() => null);
        const review = compose === null ? null : await reviewArchivedProject(manifest, { compose, stateText: await liveText("boxpilot.json"), envText: await liveText(".env") }, { staged: live });
        const refused = review?.findings.some((finding) => finding.refuse);
        if (review && (refused || (review.findings.length && !review.sameAsRunning))) {
          throw new Error(`compose.yaml was not restored; nothing was changed. ${manifest.name} would be started with it exactly as it is, and ${refused ? composeFindingsText(review.findings.filter((finding) => finding.refuse)) : `it gives ${manifest.name} more than the catalog does: ${composeFindingsText(review.findings)}`}. Restore the whole backup instead, which writes the compose file again from the catalog, or lists such settings and asks you to allow them.`);
        }
      }
      await placeWithoutFollowing(path.join(staged, relativePath), live, relativePath, path.join(staged, ".previous"));
    } catch (error) {
      failure = error;
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
    }
    // Started again as it was running, after the same port check a start has: the restored path may
    // be its compose file, and something may have taken a port while it was stopped. A start that
    // does not work fails the job, saying the path came back, as a backup does when its app will not.
    let notStarted = null;
    if (status.running) {
      const done = failure ? `${manifest.name} was not started again either.` : `${relativePath} was restored from ${backupName}, but ${manifest.name} was not started again.`;
      try {
        const project = (await readProjectFiles(id)).compose;
        if (project !== null) await assertPortsFree(manifest, project, { progress, refused: done });
        const start = await compose(id, ["start"], { timeout: 180_000, progress });
        if (!start.ok) notStarted = new Error(`${failure ? `${manifest.name} did not start again either` : `${relativePath} was restored from ${backupName}, but ${manifest.name} did not start again`}: ${redact(start.stderr).split("\n").filter(Boolean).slice(-2).join(" ") || "docker compose start failed"}`);
      } catch (error) {
        notStarted = error;
      }
      if (notStarted) progress?.(notStarted.message, "stderr");
    }
    if (failure) throw notStarted ? Object.assign(new Error(`${String(failure.message).replace(/[.\s]+$/, "")}. ${notStarted.message}`), { code: notStarted.code }) : failure;
    if (notStarted) throw notStarted;
    return { restored: true, id, backup: backupName, path: relativePath, type: member.type, sizeBytes: member.sizeBytes, checkpoint: saved, ...(warnings.length ? { warnings } : {}) };
  }

  async function deleteAppBackup({ id, backup: backupName }) {
    await ensureManifest(id);
    if (typeof backupName !== "string" || !backupNamePattern.test(backupName)) throw new Error("Backup name is invalid");
    const backupDirectory = backupDirFor(id);
    await stat(path.join(backupDirectory, backupName)).catch(() => { throw new Error(`Backup ${backupName} does not exist`); });
    await rm(path.join(backupDirectory, backupName), { force: true });
    await rm(path.join(backupDirectory, backupName.replace(/\.tar\.gz$/, ".json")), { force: true });
    return { deleted: true, id, backup: backupName };
  }

  return { interruptedBackups, resumeInterruptedBackup, backupMany, checkpoint, backup, countAppBackups, backupProtection, listAppBackups, verifyAppBackup, reviewAppBackup, reviewArchive, dataFoldersRefused, restoreAppBackup, listAppBackupFiles, restoreAppBackupPath, deleteAppBackup };
}
