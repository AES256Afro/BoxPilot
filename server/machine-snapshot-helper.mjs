/**
 * Machine snapshot: one root-only archive with everything needed to redeploy this box —
 * a fresh verified controller database backup, every installed app's compose project
 * (compose.yaml, .env, boxpilot.json — settings and secrets, not data volumes), references
 * to the app data backups, netplan/ufw/fstab, and each libvirt domain's XML definition.
 *
 * Also the off-box mirror: copies the local backup roots (controller backups, application
 * backups, machine snapshots) onto the independent backup mount, hash-verified, no deletes.
 *
 * The archive contains secrets (app .env files), so it is written 0600 root-only and the
 * operator is told to keep copies only on encrypted or physically controlled media.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { copyFileExclusively, mkdirWithoutFollowing, readFileWithoutFollowing, replaceFileWithoutFollowing, syncDirectory } from "./durable-file.mjs";
import { fixedRun } from "./exec.mjs";
import { createControllerBackupHelper } from "./controller-backup-helper.mjs";
import { backupMountpoint } from "./backup-mount.mjs";

export const snapshotNamePattern = /^machine-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz$/;
/**
 * What a snapshot or restore that stopped half way leaves beside the snapshots (`.staging-*`,
 * `.restore-*`), and what a restore stages for review (`restored/`). They hold the controller
 * database and every app's .env unencrypted, and no mirror copies them.
 */
const isSnapshotScratch = (relative) => {
  const [first] = relative.split(path.sep);
  return first.startsWith(".staging-") || first.startsWith(".restore-") || first === "restored";
};
/**
 * An app backup is written as `<stamp>.tar.gz.partial` and renamed once it is whole. Copied, half an
 * archive would sit on the destination for good (the mirrors never delete); read while it grows or
 * is renamed, it fails the copy.
 */
const isInProgress = (relative) => relative.endsWith(".partial");
/** The deployer's own id rule; a snapshot's manifest is only as trustworthy as whoever last held the file. */
const appIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const appBackupNamePattern = /^\d{8}T\d{6}Z\.tar\.gz$/;
/** An app data archive not yet whole: written by an app backup, or copied in for a restore. */
const appBackupPartialPattern = /^\d{8}T\d{6}Z\.tar\.gz\.partial$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => digest.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(digest.digest("hex")));
  });
}

/** Flush a file's data to disk before it is renamed into place. */
async function syncFile(file) {
  const handle = await open(file, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** An app data archive's record (`<stamp>.json` beside it) as written, or null. Never read through a link. */
const recordText = (directory, name) => readFileWithoutFollowing(path.join(directory, name.replace(/\.tar\.gz$/, ".json"))).catch(() => null);

/** The checksum an app data archive's record says it was written with, or null. */
async function recordedChecksum(directory, name) {
  const text = await recordText(directory, name);
  if (text === null) return null;
  try {
    const checksum = JSON.parse(text)?.checksumSha256;
    return typeof checksum === "string" && /^[a-f0-9]{64}$/.test(checksum) ? checksum : null;
  } catch { return null; }
}

/**
 * Copy one app data archive, and its record when it has one, from the mirror or a drive into this
 * server's own store (`<storeRoot>/<id>`), where the deployer restores from. Written as
 * `<name>.partial` (what an app backup writes, and what no listing, restore or mirror reads), created
 * exclusively from a regular file only (copyFileExclusively: a link at either end is refused, never
 * followed), checked against the checksum its record holds (against the original's size when it has
 * none), and only then given its own name, with the record beside it. Copied straight to its own
 * name, a restart mid-copy left half an archive there that the next restore preferred (tar:
 * unexpected EOF) and the next sync copied over the mirror's whole one. A copy that does not check
 * out is removed, and the restore told why.
 */
async function copyArchiveIn(fromDirectory, storeRoot, id, name) {
  const source = path.join(fromDirectory, name);
  const record = await recordText(fromDirectory, name);
  const checksum = await recordedChecksum(fromDirectory, name);
  const original = await lstat(source);
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  const toDirectory = await mkdirWithoutFollowing(storeRoot, id);
  const target = path.join(toDirectory, name);
  const partial = `${target}.partial`;
  // Whatever an earlier attempt left at that name goes first; a link there goes, never its target.
  await rm(partial, { recursive: true, force: true });
  try {
    await copyFileExclusively(source, partial, { mode: 0o600 });
    if (checksum) {
      if ((await sha256File(partial)) !== checksum) throw new Error(`The copy of ${name} does not match the checksum recorded when it was written, so it was not used.`);
    } else {
      const copied = await lstat(partial);
      if (copied.size !== original.size) throw new Error(`The copy of ${name} is ${copied.size} bytes where the original is ${original.size}, so it was not used.`);
    }
    await syncFile(partial);
    if (record !== null) await replaceFileWithoutFollowing(path.join(toDirectory, name.replace(/\.tar\.gz$/, ".json")), record, { mode: 0o600 });
    await rename(partial, target);
    await syncDirectory(toDirectory);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Record how far a restore got in the app's own state file, without disturbing the rest of it. The
 * app's folder is what its restored backup held, so a link at either name is never followed.
 */
async function stamp(appDirectory, fields) {
  const file = path.join(appDirectory, "boxpilot.json");
  const state = await readFileWithoutFollowing(file).then(JSON.parse).catch(() => ({}));
  await replaceFileWithoutFollowing(file, `${JSON.stringify({ ...state, ...fields }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Copy `source` to `target` (0600) when it is there; false when it is not. The copy is made under a
 * name of its own, created exclusively, and renamed into place, so a link at `target` is replaced,
 * never written through. A source that is a link, or not a regular file, counts as not there: what
 * is copied comes out of a snapshot, off a drive, or out of an app's folder, any of which may hold a
 * link to a file only root can read. `followSource` is for root's own files (/etc/fstab may be a link).
 */
async function copyIfExists(source, target, { followSource = false } = {}) {
  const info = await (followSource ? stat(source) : lstat(source)).catch(() => null);
  if (!info?.isFile()) return false;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFileExclusively(source, temporary, { mode: 0o600, followSource });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (["ENOENT", "ELOOP", "EINVAL"].includes(error?.code)) return false;
    throw error;
  }
  return true;
}

/**
 * What under `root` is neither a folder nor a regular file (a symbolic link, a pipe, a device),
 * relative to it, sorted. A snapshot BoxPilot made holds only folders and copies of files; a link in
 * one unpacked as root would have every read and copy after it follow it out of the folder.
 */
async function nonFilesUnder(root, relative = "") {
  const found = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) found.push(...await nonFilesUnder(root, entryRelative));
    else if (!entry.isFile()) found.push(entryRelative.split(path.sep).join("/"));
  }
  return found.sort();
}

async function walkFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, entryRelative));
    else if (entry.isFile()) files.push(entryRelative);
  }
  return files;
}

/**
 * What a machine snapshot, or a restore of one, leaves beside the snapshots when it is cut off part
 * way (a power cut, a restart): the archive still being written (`machine-snapshot-*.tar.gz.partial`),
 * the folder it was assembled in (`.staging-<uuid>`), and the one a restore unpacked into
 * (`.restore-<uuid>`). The folders hold the controller database and every app's .env in the clear,
 * and nothing ever reads any of them again. The kind, or null. `restored/` is a finished restore's
 * work, kept for review, and is not one of them.
 */
export function snapshotLeftoverKind(name) {
  if (/^\.staging-[a-f0-9-]{36}$/i.test(name)) return "staging";
  if (/^\.restore-[a-f0-9-]{36}$/i.test(name)) return "restore";
  if (/^machine-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz\.partial$/.test(name)) return "partial";
  return null;
}

/** What each snapshot archive references, by its path, while its size and time are unchanged. */
const referenceCache = new Map();

/** App id to the data archive a snapshot restores it from: its newest when the snapshot was taken. */
async function readSnapshotReferences(artifactPath, { run, tarBinary }) {
  const readMember = async (member) => {
    const result = await run(tarBinary, ["-xzf", artifactPath, "--no-same-owner", "--no-same-permissions", "-O", member], { timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    if (!result.ok) throw new Error(`Machine snapshot ${path.basename(artifactPath)} could not be read`);
    try { return JSON.parse(result.stdout); } catch { throw new Error(`Machine snapshot ${path.basename(artifactPath)} could not be read`); }
  };
  const named = new Map();
  for (const app of (await readMember("./manifest.json")).contents?.apps ?? []) {
    if (typeof app?.id !== "string" || !appIdPattern.test(app.id)) continue;
    const newest = (await readMember(`./apps/${app.id}/backups.json`)).backups?.[0]?.artifact;
    if (typeof newest === "string") named.set(app.id, newest);
  }
  return named;
}

/**
 * The application backups the machine snapshots in `snapshotRoot` restore from: app id to the set
 * of archive names. A snapshot restores each app from the backup that was its newest when it was
 * taken, which is usually older than the newest few an app keeps, so whatever prunes app backups
 * (the app's own keep-N, housekeeping) asks this first. `names` limits it to those archives.
 *
 * Throws when a snapshot cannot be read: a caller about to delete backups then deletes none. The
 * error names every snapshot that could not be (`unreadable`), so the owner can find each one and,
 * if it is damaged, remove it (housekeeping): until then nothing is pruned. Each snapshot is read
 * once while its size and time stay the same, as a nightly run of app backups asks once per app.
 */
export async function snapshotBackupReferences({ snapshotRoot, names = null, run = fixedRun, tarBinary = process.env.BOXPILOT_TAR_BINARY ?? "/usr/bin/tar" } = {}) {
  const root = path.resolve(snapshotRoot);
  const listed = names ?? await readdir(root).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const references = new Map();
  const seen = new Set();
  const unreadable = [];
  for (const name of listed.filter((entry) => snapshotNamePattern.test(entry)).sort()) {
    const artifactPath = path.join(root, name);
    const info = await stat(artifactPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) continue;   // retention removed it since the listing
    seen.add(artifactPath);
    const key = `${info.size}:${info.mtimeMs}`;
    let named = referenceCache.get(artifactPath)?.key === key ? referenceCache.get(artifactPath).named : null;
    if (!named) {
      try { named = await readSnapshotReferences(artifactPath, { run, tarBinary }); } catch { unreadable.push(name); continue; }
      referenceCache.set(artifactPath, { key, named });
    }
    for (const [id, archive] of named) {
      if (!references.has(id)) references.set(id, new Set());
      references.get(id).add(archive);
    }
  }
  for (const cached of referenceCache.keys()) if (path.dirname(cached) === root && !seen.has(cached) && !names) referenceCache.delete(cached);
  if (unreadable.length) {
    const list = unreadable.length === 1 ? unreadable[0] : `${unreadable.slice(0, -1).join(", ")} and ${unreadable.at(-1)}`;
    throw Object.assign(new Error(`Machine snapshot${unreadable.length === 1 ? "" : "s"} ${list} could not be read`), { unreadable });
  }
  return references;
}

export function createMachineSnapshotHelper({
  run = fixedRun,
  controllerBackups = createControllerBackupHelper(),
  snapshotRoot = process.env.BOXPILOT_MACHINE_SNAPSHOT_ROOT ?? "/var/lib/boxpilot-managed/machine-snapshots",
  catalogRoot = process.env.BOXPILOT_CATALOG_ROOT ?? "/var/lib/boxpilot-managed/catalog",
  applicationBackupRoot = path.join(process.env.BOXPILOT_APPLICATION_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups", "catalog"),
  controllerBackupRoot = process.env.BOXPILOT_CONTROLLER_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups/boxpilot-controller",
  mountRoot = process.env.BOXPILOT_BACKUP_SYNC_MOUNT ?? process.env.BOXPILOT_CONTROLLER_BACKUP_MOUNT ?? backupMountpoint,
  netplanDirectory = "/etc/netplan",
  ufwDirectory = "/etc/ufw",
  fstabPath = "/etc/fstab",
  virshBinary = process.env.BOXPILOT_VIRSH_BINARY ?? "/usr/bin/virsh",
  tarBinary = process.env.BOXPILOT_TAR_BINARY ?? "/usr/bin/tar",
  findmntBinary = process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  libvirtUri = process.env.BOXPILOT_LIBVIRT_URI ?? "qemu:///system",
  keep = 3,
  now = () => new Date(),
  // Tests run every path on one tmpdir filesystem; production keeps the device check.
  requireIndependentDevice = true,
} = {}) {
  const resolvedSnapshotRoot = path.resolve(snapshotRoot);
  const resolvedMountRoot = path.resolve(mountRoot);
  const mirrorRoot = path.join(resolvedMountRoot, "boxpilot-local-mirror");
  const appProjectFiles = ["compose.yaml", ".env", "boxpilot.json"];

  async function listSnapshots() {
    const entries = await readdir(resolvedSnapshotRoot).catch(() => []);
    const snapshots = [];
    for (const name of entries.filter((entry) => snapshotNamePattern.test(entry)).sort().reverse()) {
      const meta = await readFile(path.join(resolvedSnapshotRoot, `${name}.meta.json`), "utf8").then(JSON.parse).catch(() => null);
      const info = await stat(path.join(resolvedSnapshotRoot, name)).catch(() => null);
      snapshots.push({ artifact: name, sizeBytes: meta?.sizeBytes ?? info?.size ?? null, checksumSha256: meta?.checksumSha256 ?? null, createdAt: meta?.createdAt ?? info?.mtime?.toISOString() ?? null, contents: meta?.contents ?? null, containsSecrets: true });
    }
    return snapshots;
  }

  async function mountState() {
    try {
      const result = await run(findmntBinary, ["--json", "--mountpoint", resolvedMountRoot, "--output", "TARGET,SOURCE,FSTYPE"], { timeout: 15_000 });
      if (!result.ok) throw new Error("not mounted");
      const filesystem = JSON.parse(result.stdout).filesystems?.[0];
      if (!filesystem || path.resolve(filesystem.target) !== resolvedMountRoot) throw new Error("not an exact mountpoint");
      const [mountMetadata, localMetadata, capacity] = await Promise.all([
        stat(resolvedMountRoot),
        stat(path.dirname(resolvedSnapshotRoot)).catch(() => stat("/var/lib")),
        statfs(resolvedMountRoot),
      ]);
      if (requireIndependentDevice && mountMetadata.dev === localMetadata.dev) throw new Error("the backup mount shares the local filesystem");
      return { mounted: true, target: resolvedMountRoot, sourceType: filesystem.fstype ?? null, independentFilesystem: true, freeBytes: Number(capacity.bavail) * Number(capacity.bsize), blocker: null };
    } catch (error) {
      return { mounted: false, target: resolvedMountRoot, sourceType: null, independentFilesystem: false, freeBytes: null, blocker: `Mount an independent filesystem at ${resolvedMountRoot} (Storage page) before syncing: ${error.message}` };
    }
  }

  async function lastSync() {
    // Not through a link the drive holds: what is read goes back to the web process.
    return readFileWithoutFollowing(path.join(mirrorRoot, ".boxpilot-sync.json")).then(JSON.parse).catch(() => null);
  }

  async function inspect() {
    const mount = await mountState();
    return {
      snapshotRoot: resolvedSnapshotRoot,
      snapshots: await listSnapshots(),
      keep,
      // A share that did not mount is not asked again for its sync record: behind an automount,
      // every read of that path is another mount attempt waited out, and the page is waiting too.
      sync: { destination: mirrorRoot, mount, lastSync: mount.mounted ? await lastSync() : null },
      boundary: { mutationPerformed: false, secretsReturned: false },
    };
  }

  async function collectApps(staging) {
    const entries = await readdir(catalogRoot, { withFileTypes: true }).catch(() => []);
    const apps = [];
    // Only app folders. A restore that could not finish leaves `<id>.replaced` or `<id>.restoring`
    // beside the app, boxpilot.json and all, and a snapshot that listed it offered a restore of an
    // "installed app" whose name the restore itself refuses.
    for (const entry of entries.filter((item) => item.isDirectory() && appIdPattern.test(item.name))) {
      const id = entry.name;
      const stateFile = path.join(catalogRoot, id, "boxpilot.json");
      const appState = await readFileWithoutFollowing(stateFile).then(JSON.parse).catch(() => null);
      if (!appState) continue;
      let copied = 0;
      for (const file of appProjectFiles) {
        if (await copyIfExists(path.join(catalogRoot, id, file), path.join(staging, "apps", id, file))) copied += 1;
      }
      const backups = [];
      for (const backupName of (await readdir(path.join(applicationBackupRoot, id)).catch(() => [])).filter((name) => name.endsWith(".tar.gz")).sort().reverse()) {
        const info = await stat(path.join(applicationBackupRoot, id, backupName)).catch(() => null);
        backups.push({ artifact: backupName, sizeBytes: info?.size ?? null });
      }
      await mkdir(path.join(staging, "apps", id), { recursive: true, mode: 0o700 });
      await writeFile(path.join(staging, "apps", id, "backups.json"), `${JSON.stringify({ id, backupDirectory: path.join(applicationBackupRoot, id), backups }, null, 2)}\n`, { mode: 0o600 });
      apps.push({ id, installed: appState.installed === true, projectFiles: copied, backups: backups.length });
    }
    return apps;
  }

  async function collectSystem(staging) {
    const collected = { netplanFiles: 0, ufwFiles: 0, fstab: false };
    for (const name of (await readdir(netplanDirectory).catch(() => [])).filter((file) => /\.ya?ml$/.test(file))) {
      if (await copyIfExists(path.join(netplanDirectory, name), path.join(staging, "system", "netplan", name), { followSource: true })) collected.netplanFiles += 1;
    }
    for (const name of ["user.rules", "user6.rules", "ufw.conf"]) {
      if (await copyIfExists(path.join(ufwDirectory, name), path.join(staging, "system", "ufw", name), { followSource: true })) collected.ufwFiles += 1;
    }
    collected.fstab = await copyIfExists(fstabPath, path.join(staging, "system", "fstab"), { followSource: true });
    return collected;
  }

  async function collectVms(staging) {
    const domains = [];
    const listed = await run(virshBinary, ["--connect", libvirtUri, "list", "--all", "--name"], { timeout: 30_000 }).catch(() => ({ ok: false, stdout: "" }));
    if (!listed.ok) return { domains, available: false };
    for (const name of listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      const dump = await run(virshBinary, ["--connect", libvirtUri, "dumpxml", name], { timeout: 30_000 }).catch(() => ({ ok: false }));
      if (!dump.ok) continue;
      await mkdir(path.join(staging, "vms"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(staging, "vms", `${name}.xml`), dump.stdout, { mode: 0o600 });
      domains.push(name);
    }
    return { domains, available: true };
  }

  async function applyRetention() {
    const names = (await readdir(resolvedSnapshotRoot).catch(() => [])).filter((entry) => snapshotNamePattern.test(entry)).sort().reverse();
    const removed = [];
    for (const name of names.slice(keep)) {
      await rm(path.join(resolvedSnapshotRoot, name), { force: true });
      await rm(path.join(resolvedSnapshotRoot, `${name}.meta.json`), { force: true });
      removed.push(name);
    }
    return removed;
  }

  async function create({ snapshotId = randomUUID() } = {}) {
    if (!uuidPattern.test(String(snapshotId))) throw new Error("Snapshot id must be a UUID");
    await mkdir(resolvedSnapshotRoot, { recursive: true, mode: 0o700 });
    const startedAt = now();
    const stamp = startedAt.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const artifactName = `machine-snapshot-${stamp}-${snapshotId.slice(0, 8)}.tar.gz`;
    const artifactPath = path.join(resolvedSnapshotRoot, artifactName);
    // Written under a name no listing, mirror or retention reads (isInProgress), and renamed once it
    // is whole and described: tar writing straight to the snapshot's own name meant a disk that filled
    // part-way left half an archive that was listed, mirrored off the box and took a retention slot.
    const partial = `${artifactPath}.partial`;
    const metaPath = `${artifactPath}.meta.json`;
    let metaWritten = false;
    const staging = path.join(resolvedSnapshotRoot, `.staging-${snapshotId}`);
    try {
      await mkdir(staging, { recursive: false, mode: 0o700 });

      // A fresh verified controller backup is part of every snapshot (and recorded web-side).
      const controllerBackup = await controllerBackups.createBackup({ backupId: randomUUID() });
      await copyIfExists(controllerBackup.artifactPath, path.join(staging, "controller", "boxpilot.sqlite3"), { followSource: true });
      await copyIfExists(controllerBackup.manifestPath, path.join(staging, "controller", "manifest.json"), { followSource: true });

      const apps = await collectApps(staging);
      const system = await collectSystem(staging);
      const vms = await collectVms(staging);

      const files = await walkFiles(staging);
      const inventory = [];
      for (const file of files.sort()) inventory.push({ path: file, sha256: await sha256File(path.join(staging, file)) });
      const manifest = {
        schemaVersion: 1,
        snapshotId,
        createdAt: startedAt.toISOString(),
        containsSecrets: true,
        note: "This archive contains application secrets (.env files) and the controller database. Store copies only on encrypted or physically controlled media.",
        contents: { apps, system, vms, controllerBackup: { backupId: controllerBackup.backupId, checksumSha256: controllerBackup.checksumSha256, sizeBytes: controllerBackup.sizeBytes } },
        files: inventory,
      };
      await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

      const archive = await run(tarBinary, ["-czf", partial, "-C", staging, "."], { timeout: 30 * 60_000 });
      if (!archive.ok) throw new Error(`Machine snapshot archive failed: ${archive.stderr?.split("\n").slice(-2).join(" ") ?? "tar error"}`);
      await chmod(partial, 0o600);
      const artifactInfo = await stat(partial);
      const checksumSha256 = await sha256File(partial);
      await writeFile(metaPath, `${JSON.stringify({ schemaVersion: 1, snapshotId, artifact: artifactName, createdAt: startedAt.toISOString(), sizeBytes: artifactInfo.size, checksumSha256, containsSecrets: true, contents: manifest.contents }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      metaWritten = true;
      await rename(partial, artifactPath);
      const removedByRetention = await applyRetention();

      return {
        created: true,
        snapshotId,
        artifact: artifactName,
        artifactPath,
        sizeBytes: artifactInfo.size,
        checksumSha256,
        containsSecrets: true,
        contents: manifest.contents,
        controllerBackup,
        warnings: controllerBackup.warnings ?? [],
        removedByRetention,
        boundary: { dataVolumesIncluded: false, deletesOutsideRetention: false, networkUsed: false },
      };
    } catch (error) {
      // Half an archive is nothing to keep, and a description of one that never took its name is
      // only ever this run's own (written "wx", so it was not there before).
      await rm(partial, { force: true }).catch(() => {});
      if (metaWritten && !(await stat(artifactPath).then(() => true, () => false))) await rm(metaPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Remove what a snapshot or a restore cut off part way left (snapshotLeftoverKind), and the
   * description written for an archive that never took its name. Called when the helper starts,
   * before it takes a request: both run in the helper, so neither can be running then. Only real
   * folders and files are removed; a link with one of those names is left alone.
   *
   * So is an app data archive left unfinished in the app backup store (`<stamp>.tar.gz.partial`):
   * one a restore was copying in from the mirror or a drive, or one an app backup was writing. Only
   * the helper writes either, and nothing ever finishes one.
   */
  async function sweepInterrupted() {
    const removed = [];
    const appBackups = path.resolve(applicationBackupRoot);
    for (const app of await readdir(appBackups, { withFileTypes: true }).catch(() => [])) {
      if (!app.isDirectory() || !appIdPattern.test(app.name)) continue;
      for (const entry of await readdir(path.join(appBackups, app.name), { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || !appBackupPartialPattern.test(entry.name)) continue;
        await rm(path.join(appBackups, app.name, entry.name), { force: true });
        removed.push(`${app.name}/${entry.name}`);
      }
    }
    for (const entry of await readdir(resolvedSnapshotRoot, { withFileTypes: true }).catch(() => [])) {
      const kind = snapshotLeftoverKind(entry.name);
      if (!kind || (kind === "partial" ? !entry.isFile() : !entry.isDirectory())) continue;
      await rm(path.join(resolvedSnapshotRoot, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
      if (kind !== "partial") continue;
      const artifact = entry.name.replace(/\.partial$/, "");
      const meta = path.join(resolvedSnapshotRoot, `${artifact}.meta.json`);
      const exists = (target) => stat(target).then(() => true, () => false);
      if (!(await exists(path.join(resolvedSnapshotRoot, artifact))) && await exists(meta)) {
        await rm(meta, { force: true });
        removed.push(`${artifact}.meta.json`);
      }
    }
    return { removed };
  }

  /** Mirror the local backup roots onto the independent mount. Copies and verifies; never deletes. */
  async function sync() {
    const mount = await mountState();
    if (!mount.mounted) throw new Error(mount.blocker);
    const sources = [
      { name: "controller-backups", root: path.resolve(controllerBackupRoot) },
      { name: "application-backups", root: path.resolve(applicationBackupRoot) },
      { name: "machine-snapshots", root: resolvedSnapshotRoot },
    ];
    let fileCount = 0; let copiedCount = 0; let copiedBytes = 0;
    const warnings = [];
    for (const source of sources) {
      for (const relative of await walkFiles(source.root)) {
        if (source.root === resolvedSnapshotRoot && isSnapshotScratch(relative)) continue;
        if (isInProgress(relative)) continue;
        fileCount += 1;
        const from = path.join(source.root, relative);
        const to = path.join(mirrorRoot, source.name, relative);
        // The drive is only as trustworthy as whoever last held it, so nothing on it is followed: a
        // link where a copy belongs is no copy (it is replaced), and one on the way to it refuses the
        // sync. Followed, root wrote each backup over whatever the link named.
        const [fromInfo, toInfo] = [await stat(from), await lstat(to).catch(() => null)];
        if (toInfo?.isFile() && toInfo.size === fromInfo.size) continue;
        const sourceHash = await sha256File(from);
        // A copy here is never deleted, and one of a different size is replaced: an app data archive
        // goes only as its record says it was written. Half of one left under its own name (a copy
        // in for a restore cut off before it learnt not to) went over the mirror's whole one.
        if (source.name === "application-backups" && appBackupNamePattern.test(path.basename(relative))) {
          const recorded = await recordedChecksum(path.dirname(from), path.basename(relative));
          const reason = recorded && recorded !== sourceHash ? "it does not match the checksum recorded when it was written, so it may be damaged"
            : !recorded && toInfo?.isFile() ? "it has no record to check it against, and the copy on the backup drive differs from it" : null;
          if (reason) { warnings.push(`${source.name}/${relative.split(path.sep).join("/")} was not copied: ${reason}.`); continue; }
        }
        await mkdirWithoutFollowing(resolvedMountRoot, path.relative(resolvedMountRoot, path.dirname(to)), { mode: 0o700 });
        const partial = `${to}.boxpilot-partial`;
        await rm(partial, { recursive: true, force: true });
        await copyFileExclusively(from, partial, { mode: 0o600, followSource: true });
        const copyHash = await sha256File(partial);
        if (sourceHash !== copyHash) {
          await rm(partial, { force: true });
          throw new Error(`Mirror verification failed for ${source.name}/${relative}`);
        }
        await rename(partial, to);
        copiedCount += 1;
        copiedBytes += fromInfo.size;
      }
    }
    const completedAt = now().toISOString();
    await mkdirWithoutFollowing(resolvedMountRoot, path.relative(resolvedMountRoot, mirrorRoot), { mode: 0o700 });
    // What was left out goes in the record too (R5B4-7): said only in the job, the Off-box tab and
    // Home showed "Last synced ... N files" as if every backup had reached the drive.
    const record = { completedAt, fileCount, copiedCount, copiedBytes, skippedCount: warnings.length, skipped: warnings.slice(0, 20) };
    await replaceFileWithoutFollowing(path.join(mirrorRoot, ".boxpilot-sync.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return { synced: true, destination: mirrorRoot, completedAt, fileCount, copiedCount, copiedBytes, verified: true, ...(warnings.length ? { warnings } : {}), boundary: { deletesPerformed: false, networkUsed: false } };
  }

  // ---- Restore ------------------------------------------------------------------------------------
  const sourceRoots = () => ({ local: resolvedSnapshotRoot, mirror: path.join(mirrorRoot, "machine-snapshots") });

  /** Snapshots available to restore from: local root and the off-box mirror (when mounted). */
  async function sources() {
    const roots = sourceRoots();
    const mount = await mountState();
    const result = { sources: [], mount };
    for (const [source, root] of Object.entries(roots)) {
      if (source === "mirror" && !mount.mounted) { result.sources.push({ source, root, available: false, snapshots: [] }); continue; }
      const entries = (await readdir(root).catch(() => [])).filter((entry) => snapshotNamePattern.test(entry)).sort().reverse();
      const snapshots = [];
      for (const name of entries) {
        const meta = await readFile(path.join(root, `${name}.meta.json`), "utf8").then(JSON.parse).catch(() => null);
        const info = await stat(path.join(root, name)).catch(() => null);
        snapshots.push({ artifact: name, sizeBytes: meta?.sizeBytes ?? info?.size ?? null, createdAt: meta?.createdAt ?? info?.mtime?.toISOString() ?? null, checksumSha256: meta?.checksumSha256 ?? null, apps: meta?.contents?.apps?.length ?? null });
      }
      result.sources.push({ source, root, available: true, snapshots });
    }
    return result;
  }

  /**
   * Machine snapshots on any filesystem this server has mounted, whether BoxPilot put them there or
   * not.
   *
   * This is what makes a rebuild possible. `sources()` knows two places — the local store and the
   * configured off-box mirror — and a server that has just been reinstalled has neither: no
   * snapshots of its own, and no destination set up, because the settings that described the
   * destination were on the disk that died. The snapshot is sitting right there on the drive, and
   * BoxPilot could not see it. So: mount the drive or the share from the Storage page, and this
   * finds what is on it.
   *
   * The search is deliberately shallow. These live in known places — the mirror's own layout, or
   * loose in a folder someone copied them to — and walking a multi-terabyte NAS looking for a file
   * would take longer than rebuilding by hand.
   */
  async function discover() {
    const seen = new Set(Object.values(sourceRoots()).map((root) => path.resolve(root)));
    const found = [];
    // Drives that are mounted and did not answer when read. Reported apart from "no snapshots",
    // because a soft network mount mid-hiccup looks exactly like an empty drive otherwise, and an
    // owner mid-rebuild deserves "the drive did not answer, try again" over an invented all-clear.
    const unanswered = [];
    for (const mount of await mountedFilesystems()) {
      let failed = null;
      for (const relative of ["boxpilot-local-mirror/machine-snapshots", "machine-snapshots", "."]) {
        const root = path.resolve(path.join(mount.target, relative));
        if (seen.has(root)) continue;
        seen.add(root);
        const { snapshots, unreadable } = await snapshotsIn(root);
        if (unreadable) failed = unreadable;
        // An idle automount's source is "systemd-1", which means nothing to a person; the
        // mountpoint is the name the owner knows the drive by, so it stands in as the source.
        const source = mount.fstype === "autofs" ? mount.target : mount.source;
        if (snapshots.length) found.push({ root, mount: { target: mount.target, source, filesystem: mount.fstype }, snapshots });
      }
      if (failed && !found.some((location) => location.mount.target === mount.target)) {
        unanswered.push({ target: mount.target, source: mount.source, error: failed });
      }
    }
    return { locations: found, unanswered };
  }

  /**
   * Filesystems worth probing: the real ones, plus autofs — which is not a filesystem but a door.
   *
   * BoxPilot's own share mounting writes fstab entries with `x-systemd.automount`, so a network
   * share that has been idle is not in the mount table at all: only an autofs entry stands where
   * it was, and the share reappears the moment something reads the path. `findmnt --real` hides
   * autofs entirely, which meant discovery could not see the very drives this product mounts —
   * a backup share that had been idle for a few minutes reported "no snapshots anywhere" with
   * three snapshots on it. So the full table is read and filtered here, where autofs is kept:
   * probing the door is exactly what opens it.
   */
  async function mountedFilesystems() {
    const pseudo = new Set(["proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "securityfs", "pstore", "bpf", "hugetlbfs", "mqueue", "debugfs", "tracefs", "fusectl", "configfs", "ramfs", "binfmt_misc", "squashfs", "overlay", "nsfs", "efivarfs", "rpc_pipefs"]);
    const result = await run(findmntBinary, ["--json", "--output", "TARGET,SOURCE,FSTYPE"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }).catch(() => null);
    if (!result?.ok) return [];
    const flatten = (nodes) => (nodes ?? []).flatMap((node) => [node, ...flatten(node.children)]);
    return flatten(JSON.parse(result.stdout).filesystems)
      .filter((node) => node.target && !pseudo.has(node.fstype))
      // A snapshot found under the running install is the local store by another name.
      .filter((node) => node.target === "/" || !node.target.startsWith("/proc"));
  }

  /**
   * The snapshots directly in one directory, with whatever their sidecar metadata says.
   *
   * A directory that does not exist and a drive that failed to answer are opposite findings, and
   * the first version of this collapsed them: every readdir error became an empty list. Discovery
   * probes candidate paths that mostly do not exist, so absence stays quiet — but a mounted drive
   * answering EIO is a drive with the snapshots on it and a network hiccup in front of them, and
   * reporting "nothing there" for that is an invented all-clear. Seen live: the same CIFS mount
   * listed three snapshots on one read and errored the read before it, and discovery said zero.
   */
  async function snapshotsIn(root) {
    let names = null;
    let unreadable = null;
    try {
      names = await readdir(root);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) unreadable = String(error?.code ?? error?.message ?? error);
      names = [];
    }
    const entries = names.filter((entry) => snapshotNamePattern.test(entry)).sort().reverse();
    const snapshots = [];
    for (const name of entries.slice(0, 50)) {
      const meta = await readFile(path.join(root, `${name}.meta.json`), "utf8").then(JSON.parse).catch(() => null);
      const info = await stat(path.join(root, name)).catch(() => null);
      snapshots.push({
        artifact: name,
        sizeBytes: meta?.sizeBytes ?? info?.size ?? null,
        createdAt: meta?.createdAt ?? info?.mtime?.toISOString() ?? null,
        checksumSha256: meta?.checksumSha256 ?? null,
        apps: meta?.contents?.apps?.length ?? null,
      });
    }
    return { snapshots, unreadable };
  }

  /**
   * Where an artifact lives. A discovered location arrives as a path from the browser, which is not
   * a thing to take anyone's word for — so it is only accepted when this process can find it again
   * itself. The client chooses among what discovery returned; it never names a path of its own.
   */
  async function resolveDiscovered(root, artifact) {
    if (typeof artifact !== "string" || !snapshotNamePattern.test(artifact)) throw new Error("Snapshot name is invalid");
    const wanted = path.resolve(String(root ?? ""));
    const { locations } = await discover();
    const location = locations.find((candidate) => candidate.root === wanted);
    if (!location) throw new Error("That drive is no longer mounted, or no longer has snapshots on it");
    if (!location.snapshots.some((snapshot) => snapshot.artifact === artifact)) throw new Error("That snapshot is not on that drive any more");
    return { root: wanted, mount: path.resolve(location.mount.target), artifactPath: path.join(wanted, artifact), metaPath: path.join(wanted, `${artifact}.meta.json`) };
  }

  function resolveArtifact(source, artifact) {
    const root = sourceRoots()[source];
    if (!root) throw new Error("Snapshot source must be local, mirror, or a drive BoxPilot found");
    if (typeof artifact !== "string" || !snapshotNamePattern.test(artifact)) throw new Error("Snapshot name is invalid");
    return { root, artifactPath: path.join(root, artifact), metaPath: path.join(root, `${artifact}.meta.json`) };
  }

  async function readManifestFromArchive(artifactPath) {
    const result = await run(tarBinary, ["-xzf", artifactPath, "--no-same-owner", "--no-same-permissions", "-O", "./manifest.json"], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    if (!result.ok) throw new Error(`Could not read the snapshot manifest: ${result.stderr.split("\n").slice(-2).join(" ")}`);
    try { return JSON.parse(result.stdout); } catch { throw new Error("The snapshot manifest is not valid JSON"); }
  }

  /**
   * Where an app's data archives can be, in the order they are tried: this server's own store, the
   * configured mirror, and, for a snapshot found on a drive (`place` is `{ source, root, mount }`),
   * the application backups beside it there. A server rebuilt from an old backup drive has neither
   * of the first two, and every app came back empty with its archives beside the snapshot on the
   * same drive. Beside it is `<root>/../application-backups/<id>` for a snapshot in a folder (the
   * mirror's own layout, or `machine-snapshots`), and `<root>/application-backups/<id>` for one lying
   * loose at the top of the drive, where the folder above is not the drive's at all. Either way it
   * must be on the drive: a place outside the mount is never looked in.
   */
  function archiveDirectories(id, place = null) {
    const candidates = [
      { location: "local", directory: path.join(path.resolve(applicationBackupRoot), id) },
      { location: "mirror", directory: path.join(mirrorRoot, "application-backups", id) },
    ];
    if (place?.source === "discovered" && place.root && place.mount) {
      const root = path.resolve(place.root);
      const mount = path.resolve(place.mount);
      const directory = path.join(root === mount ? root : path.dirname(root), "application-backups", id);
      const within = path.relative(mount, directory);
      const onTheDrive = within !== "" && !within.startsWith("..") && !path.isAbsolute(within);
      if (onTheDrive && !candidates.some((candidate) => candidate.directory === directory)) candidates.push({ location: "drive", directory });
    }
    return candidates;
  }

  /** Where an app data archive referenced by the snapshot can be found right now (archiveDirectories). */
  async function locateAppArchive(id, name, place = null) {
    for (const candidate of archiveDirectories(id, place)) {
      if (await stat(path.join(candidate.directory, name)).then(() => true).catch(() => false)) return { ...candidate, name };
    }
    return null;
  }

  /** The data archives a snapshot's `backups.json` lists for one app, newest first, as plain archive names. */
  const listedArchives = (listing) => (Array.isArray(listing?.backups) ? listing.backups : [])
    .map((entry) => entry?.artifact).filter((name) => typeof name === "string" && appBackupNamePattern.test(name));

  /** When a snapshot was taken, as the stamp its name carries (`20260821T020000Z`). */
  const takenAt = (artifact) => /^machine-snapshot-(\d{8}T\d{6}Z)-/.exec(String(artifact ?? ""))?.[1] ?? null;

  /**
   * The archive an app is restored from: the one the snapshot names (the first it lists), or, when
   * that one is gone (an app backup's own keep-N pruning took it before it learnt not to), the next
   * the snapshot itself lists that is still here, marked `fallback` so the restore says so. Never
   * one it does not list, nor one dated after it (`place.takenAt`): the newest archive there is was
   * the safety copy a failed attempt took of the app installed empty, and was restored as its data.
   */
  async function dataArchiveFor(id, listed, place = null) {
    const before = listed.filter((name) => !place?.takenAt || name.slice(0, 16) <= place.takenAt);
    for (const name of before) {
      const located = await locateAppArchive(id, name, place);
      if (located) return name === listed[0] ? located : { ...located, fallback: true };
    }
    return null;
  }

  /**
   * A tailnet-only app has no way in until Tailscale Serve publishes its web ports: the deployer
   * binds them to 127.0.0.1 for Serve to front. The app.install operation publishes them; a restore
   * called the deployer directly, and said "installed" about an app nothing could open (Zulip).
   * `deployed` is what the deployer last said it wrote; `entry` is the app's line in the summary.
   */
  async function publishForTailnet(entry, deployed, { serve, progress }) {
    if (deployed?.exposure !== "tailnet") return;
    const name = deployed.name ?? entry.id;
    let published;
    try {
      published = serve
        ? await serve(deployed)
        : { warnings: [`${name} is installed for your tailnet only, and nothing published it there yet, so nothing can open it: on its Reach tab, choose Publish on the tailnet.`] };
    } catch (error) {
      published = { warnings: [`${name} is installed for your tailnet only, but publishing it with Tailscale Serve failed (${error.message}). Until it is published nothing can open it: on its Reach tab, choose Publish on the tailnet.`] };
    }
    if (published?.urls?.length) entry.urls = published.urls;
    for (const warning of published?.warnings ?? []) {
      entry.warnings.push(warning);
      progress?.(`[${entry.id}] ${warning}`, "stderr");
    }
  }

  /** What a restore says when the snapshot's own archive was gone and another it lists was used. */
  const fallbackWords = (named, used) => `The data archive this snapshot names, ${named}, is no longer there, so its data came from ${used}, an older backup the snapshot also lists.`;
  /** And when none it lists is left. */
  const noArchiveWords = (named) => `The data archive this snapshot names, ${named}, is no longer there, nor is any older one it lists, so the app was installed without its data. A backup taken after the snapshot is not used in its place.`;

  /** Manifest summary plus, per app, whether its newest data archive is reachable. */
  /** Local store, configured mirror, or a drive discovery just found. */
  async function locate(source, artifact, root) {
    return source === "discovered" ? resolveDiscovered(root, artifact) : resolveArtifact(source, artifact);
  }

  /**
   * The settings a review lists, one line each (as catalog/compose-review.mjs composeFindingsText says
   * them). Written out here: the root task runner reaches this module through housekeeping, and runs
   * with Node's own modules only, so nothing here may import the YAML parser the review needs.
   */
  const findingsText = (findings) => (Array.isArray(findings) ? findings : []).map((finding) => `${finding.service ? `${finding.service}: ` : "the file "}${finding.detail}`).join("; ");

  /**
   * What restoring each app's data archive would start (sweep 4): the deployer's review of the
   * archive where it lies (app-helper reviewArchive), without unpacking it. Null where there is no
   * archive to restore or no deployer to ask; `{ error }` where the archive could not be read.
   */
  async function composeReviewFor(appHelper, id, located) {
    if (!located || typeof appHelper?.reviewArchive !== "function") return null;
    try {
      return await appHelper.reviewArchive({ id, archive: path.join(located.directory, located.name) });
    } catch (error) {
      return { error: String(error?.message ?? error).slice(0, 300) };
    }
  }

  async function describe({ source, artifact, root = null }, { apps: appHelper = null } = {}) {
    const { artifactPath, metaPath, root: snapshotDirectory, mount = null } = await locate(source, artifact, root);
    const place = { source, root: snapshotDirectory, mount, takenAt: takenAt(artifact) };
    await stat(artifactPath).catch(() => { throw new Error(`Snapshot ${artifact} was not found in the ${source} source`); });
    const meta = await readFile(metaPath, "utf8").then(JSON.parse).catch(() => null);
    const manifest = await readManifestFromArchive(artifactPath);
    const apps = [];
    // A snapshot taken before collectApps kept to app ids can list a restore's leftover folder as an
    // installed app; offered, it was ticked with the rest and the whole restore refused for it.
    for (const app of (manifest.contents?.apps ?? []).filter((entry) => typeof entry?.id === "string" && appIdPattern.test(entry.id))) {
      const listing = await run(tarBinary, ["-xzf", artifactPath, "--no-same-owner", "--no-same-permissions", "-O", `./apps/${app.id}/backups.json`], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ ok: false }));
      let listed = [];
      if (listing.ok) { try { listed = listedArchives(JSON.parse(listing.stdout)); } catch { listed = []; } }
      const newest = listed[0] ?? null;
      const located = listed.length ? await dataArchiveFor(app.id, listed, place) : null;
      // `dataArchive` is the one a restore would use: the snapshot's own, or an older one it lists.
      // `compose` is what restoring it would start, when its compose file is started as archived.
      const compose = await composeReviewFor(appHelper, app.id, located);
      apps.push({ id: app.id, installed: app.installed, projectFiles: app.projectFiles, newestBackup: newest, dataAvailable: Boolean(located), dataLocation: located?.location ?? null, dataArchive: located?.name ?? null, ...(compose ? { compose } : {}) });
    }
    // A snapshot carries VM definitions, never their disks: those live in the encrypted VM
    // repository, so say whether it is reachable rather than implying the VMs are inside.
    const archivedVms = manifest.contents?.vms ?? null;
    const diskRepository = path.join(resolvedMountRoot, "restic-vm");
    const vms = archivedVms && { ...archivedVms, disksIncluded: false, diskRepository, diskRepositoryReachable: await stat(diskRepository).then((info) => info.isDirectory()).catch(() => false) };
    return { source, artifact, createdAt: manifest.createdAt ?? meta?.createdAt ?? null, checksumSha256: meta?.checksumSha256 ?? null, apps, system: manifest.contents?.system ?? null, vms: vms ?? null, containsSecrets: true };
  }

  /**
   * Rehydrate from a snapshot. Apps: project files are restored, the app is (re)installed through the
   * generic deployer using the archived settings and secrets, then (optionally) its newest data
   * archive is restored. System files are staged for review, never applied. VM definitions are listed.
   * `devicesByApp` is the devices the web process found for each app that wants one (this process
   * may have no real /dev); without it an app that needs a device is refused, as at any install.
   * `serve(deployed)` publishes a tailnet-only app's web ports with Tailscale Serve, as the
   * app.install operation does (ops/apps.mjs serveTailnetOnly); without it such an app is restored
   * with a warning that nothing can open it yet.
   * `allowCompose` is, per app id, the sha256 of a data archive's compose file the owner allowed to
   * be started exactly as archived although it gives the app more than the catalog does (sweep 4).
   */
  async function restore({ source, artifact, root = null, apps: selected = "all", restoreData = true, devicesByApp = null, allowCompose = null }, { apps: appHelper, progress = null, serve = null } = {}) {
    if (!appHelper) throw new Error("Application deployer is unavailable");
    const { artifactPath, metaPath, root: snapshotDirectory, mount = null } = await locate(source, artifact, root);
    const place = { source, root: snapshotDirectory, mount, takenAt: takenAt(artifact) };
    await stat(artifactPath).catch(() => { throw new Error(`Snapshot ${artifact} was not found in the ${source} source`); });
    const meta = await readFile(metaPath, "utf8").then(JSON.parse).catch(() => null);
    if (!meta?.checksumSha256) throw new Error(`${artifact}.meta.json is missing its checksum, so this archive cannot be verified. Copy the .meta.json file next to the archive and try again. Nothing was changed.`);
    progress?.("Verifying the snapshot checksum...", "stdout");
    if ((await sha256File(artifactPath)) !== meta.checksumSha256) throw new Error("The snapshot failed its checksum; it may be damaged. Nothing was changed.");
    const staging = path.join(resolvedSnapshotRoot, `.restore-${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const summary = { source, artifact, apps: [], system: null, vms: [], controllerBackupStaged: null };
    try {
      progress?.(`$ tar -xzf ${artifact}`, "stdout");
      // As root, tar would otherwise reproduce whatever owner, mode and set-user-id bits the archive
      // names — including a set-user-id root binary put there by whoever last held the file.
      const extract = await run(tarBinary, ["-xzf", artifactPath, "--no-same-owner", "--no-same-permissions", "-C", staging], { timeout: 30 * 60_000 });
      if (!extract.ok) throw new Error(`Could not extract the snapshot: ${extract.stderr.split("\n").slice(-2).join(" ")}`);
      // Everything after this reads and copies out of the unpacked snapshot as root, and the
      // snapshot is only as trustworthy as whoever last held the file.
      const planted = await nonFilesUnder(staging);
      if (planted.length) throw new Error(`The snapshot holds ${planted.slice(0, 5).join(", ")}${planted.length > 5 ? ", ..." : ""}, ${planted.length === 1 ? "a link or a special file" : "links or special files"}, which a snapshot BoxPilot made never does. Nothing was changed.`);
      const manifest = JSON.parse(await readFileWithoutFollowing(path.join(staging, "manifest.json")));
      progress?.("Verifying file inventory...", "stdout");
      for (const file of manifest.files ?? []) {
        // Only a file inside the snapshot is one of its files: a path out of it is not read.
        const inside = typeof file?.path === "string" ? path.resolve(staging, file.path) : null;
        const actual = inside?.startsWith(`${staging}${path.sep}`) ? await sha256File(inside).catch(() => null) : null;
        if (actual !== file.sha256) throw new Error(`Snapshot content ${file.path} failed verification. Nothing was changed.`);
      }
      const wanted = (manifest.contents?.apps ?? []).filter((app) => selected === "all" ? app.installed : Array.isArray(selected) && selected.includes(app.id));
      // Each id becomes a directory created and written as root, so one that is not a plain app id
      // (or resolves anywhere but directly inside the catalog) refuses the whole restore up front.
      for (const app of wanted) {
        const valid = typeof app?.id === "string" && appIdPattern.test(app.id) && path.dirname(path.resolve(catalogRoot, app.id)) === path.resolve(catalogRoot);
        if (!valid) throw new Error(`The snapshot names ${JSON.stringify(String(app?.id).slice(0, 80))}, which is not a valid application id. Nothing was changed.`);
      }
      // Before anything is changed (sweep 4): the data folders each app's settings point it at must
      // pass what an install checks, and a data archive whose compose file would be started exactly
      // as archived, giving the app more than the catalog does, needs the owner to have allowed that
      // very file. The data restore checks again what it actually unpacks.
      const blocked = [];
      for (const app of wanted) {
        const live = await Promise.resolve().then(() => appHelper.internals.readState(app.id)).catch(() => null);
        if (live?.installed && live.restoredFrom !== artifact) continue;   // refused on its own below, untouched
        if (!live?.installed && typeof appHelper.dataFoldersRefused === "function") {
          let archivedState = null;
          try { archivedState = JSON.parse(await readFileWithoutFollowing(path.join(staging, "apps", app.id, "boxpilot.json"))); } catch { archivedState = null; }
          const problems = await appHelper.dataFoldersRefused({ id: app.id, values: archivedState?.values ?? {} });
          if (problems.length) blocked.push(`${app.id}: its settings point it at data folders an install would refuse: ${problems.join("; ")}`);
        }
        if (!restoreData || live?.restoredDataFrom) continue;
        const listing = await readFileWithoutFollowing(path.join(staging, "apps", app.id, "backups.json")).then(JSON.parse).catch(() => null);
        const listed = listedArchives(listing);
        const review = await composeReviewFor(appHelper, app.id, listed.length ? await dataArchiveFor(app.id, listed, place) : null);
        if (!review || review.error) continue;
        if (review.refusals?.length) blocked.push(`${app.id}: ${review.refusals.join("; ")}`);
        else if (review.needsAllow && allowCompose?.[app.id] !== review.sha256) blocked.push(`${app.id}: its data archive's compose file would be started exactly as it was backed up, and gives it more than the catalog does: ${findingsText(review.findings)} (compose sha256 ${review.sha256}). Allow these settings in the restore dialog, which lists them, or leave ${app.id} out`);
      }
      if (blocked.length) throw new Error(`The snapshot was not restored; nothing was changed. ${blocked.join(". ")}.`);
      for (const app of wanted) {
        const entry = { id: app.id, installed: false, dataRestored: false, alreadyRestored: false, error: null, warnings: [] };
        summary.apps.push(entry);
        // What the deployer last said it wrote (who can reach the app, on which ports): from the
        // install, or from the data restore, which writes the compose file again for this server.
        let deployed = null;
        try {
          const stateRaw = await readFileWithoutFollowing(path.join(staging, "apps", app.id, "boxpilot.json")).catch(() => null);
          const archivedState = stateRaw ? JSON.parse(stateRaw) : null;
          const live = await appHelper.internals.readState(app.id);
          const target = path.join(catalogRoot, app.id);
          // Each app is stamped as it completes, so a restore interrupted half way through can be
          // run again: what finished is left alone and what did not is picked up where it stopped.
          const alreadyInstalled = live?.installed === true && live.restoredFrom === artifact;
          if (live?.installed && !alreadyInstalled) throw new Error("already installed on this box; uninstall it first if you want the snapshot's version");
          if (alreadyInstalled) {
            entry.installed = true;
            entry.alreadyRestored = true;
            progress?.(`[${app.id}] already installed from this snapshot`, "stdout");
          } else {
            progress?.(`[${app.id}] restoring project files`, "stdout");
            await mkdir(target, { recursive: true, mode: 0o700 });
            for (const file of [".env"]) await copyIfExists(path.join(staging, "apps", app.id, file), path.join(target, file));
            await replaceFileWithoutFollowing(path.join(target, "boxpilot.json"), JSON.stringify({ ...(archivedState ?? { id: app.id }), installed: false, restoredFrom: artifact }, null, 2), { mode: 0o600 });
            progress?.(`[${app.id}] installing with the archived settings`, "stdout");
            // Saved settings, not an owner's entry: a snapshot from an older release can name a setting
            // the catalog has since dropped, and never holds a secret, which comes from the .env above.
            const devices = devicesByApp && Object.hasOwn(devicesByApp, app.id) && Array.isArray(devicesByApp[app.id]) ? devicesByApp[app.id] : null;
            deployed = await appHelper.install({ id: app.id, values: archivedState?.values ?? {}, ...(devices ? { devices } : {}) }, { progress, storedValues: true });
            await stamp(target, { restoredFrom: artifact });
            entry.installed = true;
          }
          if (live?.restoredDataFrom && alreadyInstalled) {
            entry.dataRestored = true;
            progress?.(`[${app.id}] data already restored from ${live.restoredDataFrom}`, "stdout");
            continue;
          }
          if (restoreData) {
            const listing = await readFileWithoutFollowing(path.join(staging, "apps", app.id, "backups.json")).then(JSON.parse).catch(() => null);
            // The names are joined onto backup directories and copied between them, so only plain
            // archive names are followed.
            const listed = listedArchives(listing);
            const newest = listed[0] ?? null;
            const located = listed.length ? await dataArchiveFor(app.id, listed, place) : null;
            if (!located && newest) {
              const warning = noArchiveWords(newest);
              entry.warnings.push(warning);
              progress?.(`[${app.id}] ${warning}`, "stderr");
            } else if (!located) { progress?.(`[${app.id}] no data archive available; installed fresh`, "stderr"); }
            else {
              if (located.fallback) {
                const warning = fallbackWords(newest, located.name);
                entry.warnings.push(warning);
                progress?.(`[${app.id}] ${warning}`, "stderr");
              }
              if (located.location !== "local") {
                progress?.(`[${app.id}] copying ${located.name} from ${located.location === "mirror" ? "the mirror" : "the drive the snapshot is on"}`, "stdout");
                await copyArchiveIn(located.directory, path.resolve(applicationBackupRoot), app.id, located.name);
              }
              progress?.(`[${app.id}] restoring data from ${located.name}`, "stdout");
              const allowed = typeof allowCompose?.[app.id] === "string" ? { allowCompose: allowCompose[app.id] } : {};
              const restored = await appHelper.restoreAppBackup({ id: app.id, backup: located.name, ...allowed }, { progress });
              if (restored?.hostPorts) deployed = restored;
              for (const warning of restored?.warnings ?? []) entry.warnings.push(warning);
              await stamp(target, { restoredFrom: artifact, restoredDataFrom: located.name });
              entry.dataRestored = true;
            }
          }
        } catch (error) {
          entry.error = error.message;
          progress?.(`[${app.id}] ${error.message}`, "stderr");
        }
        if (deployed) await publishForTailnet(entry, deployed, { serve, progress });
      }
      // System files and VM definitions are staged for the operator; applying them blindly could cut off access.
      const reviewRoot = path.join(resolvedSnapshotRoot, "restored", now().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z"));
      for (const area of ["system", "vms", "controller"]) {
        const from = path.join(staging, area);
        if (await lstat(from).then((info) => info.isDirectory()).catch(() => false)) {
          for (const relative of await walkFiles(from)) await copyIfExists(path.join(from, relative), path.join(reviewRoot, area, relative));
        }
      }
      summary.system = { stagedAt: path.join(reviewRoot, "system"), applied: false, contents: manifest.contents?.system ?? null };
      summary.vms = (manifest.contents?.vms?.domains ?? []).map((name) => ({ name, definitionStagedAt: path.join(reviewRoot, "vms", `${name}.xml`), defined: false }));
      summary.controllerBackupStaged = path.join(reviewRoot, "controller");
      summary.restored = summary.apps.filter((entry) => entry.installed).length;
      summary.failed = summary.apps.filter((entry) => entry.error).length;
      // Said on the job as well as per app: an app restored without the data it should have had, or
      // with no way in yet, is the owner's to act on. So is one that was not restored at all, or whose
      // data restore was refused (R5B4-2): said only in its own line, the job read "Completed." in
      // green. First, as the job shows only so many.
      const warnings = [
        ...summary.apps.filter((entry) => entry.error).map((entry) => `${entry.id}: ${entry.error}`),
        ...summary.apps.flatMap((entry) => entry.warnings.map((warning) => `${entry.id}: ${warning}`)),
      ];
      if (warnings.length) summary.warnings = warnings;
      return summary;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Review directories are named by when the restore ran; nothing else may be discarded. */
  const reviewNamePattern = /^\d{8}T\d{6}Z$/;
  /** Files small enough and textual enough to show in a browser; the rest are listed, not inlined. */
  const inlineLimit = 48 * 1024;

  /**
   * What past restores left for review, newest first.
   *
   * A restore deliberately does not touch the network, the firewall, fstab, or VM definitions —
   * a wrong write to any of them takes the machine off the network it was just rescued onto. It
   * stages them instead. But staging them into a root-only directory that nothing ever displayed
   * made "staged for review" a fiction: the owner cannot review a directory they cannot see and
   * would need root to read. This is the reader that makes the review real.
   */
  async function listRestores() {
    const root = path.join(resolvedSnapshotRoot, "restored");
    const names = (await readdir(root).catch(() => [])).filter((name) => reviewNamePattern.test(name)).sort().reverse();
    const restores = [];
    for (const name of names) {
      const base = path.join(root, name);
      const files = [];
      for (const relative of await walkFiles(base)) {
        const full = path.join(base, relative);
        const info = await stat(full).catch(() => null);
        if (!info?.isFile()) continue;
        const area = relative.split(path.sep)[0];
        let content = null;
        if (info.size <= inlineLimit) {
          const text = await readFile(full, "utf8").catch(() => null);
          // A database copy or anything else binary is listed, never inlined.
          if (text !== null && !text.includes("\u0000")) content = text;
        }
        files.push({ path: relative.split(path.sep).join("/"), area, sizeBytes: info.size, content });
      }
      restores.push({ name, stagedAt: base, files });
    }
    return { restores };
  }

  /**
   * Remove one review directory, once the owner is done with it. Only a direct child of the
   * review root with a restore's timestamp name is accepted: this is the only deletion in the
   * snapshot tree that takes a name from the browser, and it must not be able to name anything else.
   */
  async function discardRestore({ name } = {}) {
    if (typeof name !== "string" || !reviewNamePattern.test(name)) throw new Error("That is not a restore review directory");
    const target = path.join(resolvedSnapshotRoot, "restored", name);
    if (!(await stat(target).then((info) => info.isDirectory()).catch(() => false))) {
      throw new Error("That restore review directory is no longer there");
    }
    await rm(target, { recursive: true, force: true });
    return { discarded: true, name };
  }

  return { inspect, create, sync, sources, discover, describe, restore, listRestores, discardRestore, sweepInterrupted, internals: { locateAppArchive, resolveArtifact, resolveDiscovered, snapshotsIn } };
}
