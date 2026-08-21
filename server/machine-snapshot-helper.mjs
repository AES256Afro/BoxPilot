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
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "./exec.mjs";
import { createControllerBackupHelper } from "./controller-backup-helper.mjs";

const snapshotNamePattern = /^machine-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz$/;
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

async function copyIfExists(source, target) {
  try {
    await stat(source);
  } catch {
    return false;
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target);
  await chmod(target, 0o600);
  return true;
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

export function createMachineSnapshotHelper({
  run = fixedRun,
  controllerBackups = createControllerBackupHelper(),
  snapshotRoot = process.env.BOXPILOT_MACHINE_SNAPSHOT_ROOT ?? "/var/lib/boxpilot-managed/machine-snapshots",
  catalogRoot = process.env.BOXPILOT_CATALOG_ROOT ?? "/var/lib/boxpilot-managed/catalog",
  applicationBackupRoot = path.join(process.env.BOXPILOT_APPLICATION_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups", "catalog"),
  controllerBackupRoot = process.env.BOXPILOT_CONTROLLER_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups/boxpilot-controller",
  mountRoot = process.env.BOXPILOT_BACKUP_SYNC_MOUNT ?? process.env.BOXPILOT_CONTROLLER_BACKUP_MOUNT ?? "/mnt/boxpilot-backup",
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
    return readFile(path.join(mirrorRoot, ".boxpilot-sync.json"), "utf8").then(JSON.parse).catch(() => null);
  }

  async function inspect() {
    return {
      snapshotRoot: resolvedSnapshotRoot,
      snapshots: await listSnapshots(),
      keep,
      sync: { destination: mirrorRoot, mount: await mountState(), lastSync: await lastSync() },
      boundary: { mutationPerformed: false, secretsReturned: false },
    };
  }

  async function collectApps(staging) {
    const entries = await readdir(catalogRoot, { withFileTypes: true }).catch(() => []);
    const apps = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const id = entry.name;
      const stateFile = path.join(catalogRoot, id, "boxpilot.json");
      const appState = await readFile(stateFile, "utf8").then(JSON.parse).catch(() => null);
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
      if (await copyIfExists(path.join(netplanDirectory, name), path.join(staging, "system", "netplan", name))) collected.netplanFiles += 1;
    }
    for (const name of ["user.rules", "user6.rules", "ufw.conf"]) {
      if (await copyIfExists(path.join(ufwDirectory, name), path.join(staging, "system", "ufw", name))) collected.ufwFiles += 1;
    }
    collected.fstab = await copyIfExists(fstabPath, path.join(staging, "system", "fstab"));
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
    const staging = path.join(resolvedSnapshotRoot, `.staging-${snapshotId}`);
    try {
      await mkdir(staging, { recursive: false, mode: 0o700 });

      // A fresh verified controller backup is part of every snapshot (and recorded web-side).
      const controllerBackup = await controllerBackups.createBackup({ backupId: randomUUID() });
      await copyIfExists(controllerBackup.artifactPath, path.join(staging, "controller", "boxpilot.sqlite3"));
      await copyIfExists(controllerBackup.manifestPath, path.join(staging, "controller", "manifest.json"));

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

      const archive = await run(tarBinary, ["-czf", artifactPath, "-C", staging, "."], { timeout: 30 * 60_000 });
      if (!archive.ok) throw new Error(`Machine snapshot archive failed: ${archive.stderr?.split("\n").slice(-2).join(" ") ?? "tar error"}`);
      await chmod(artifactPath, 0o600);
      const artifactInfo = await stat(artifactPath);
      const checksumSha256 = await sha256File(artifactPath);
      await writeFile(`${artifactPath}.meta.json`, `${JSON.stringify({ schemaVersion: 1, snapshotId, artifact: artifactName, createdAt: startedAt.toISOString(), sizeBytes: artifactInfo.size, checksumSha256, containsSecrets: true, contents: manifest.contents }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
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
        removedByRetention,
        boundary: { dataVolumesIncluded: false, deletesOutsideRetention: false, networkUsed: false },
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
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
    for (const source of sources) {
      for (const relative of await walkFiles(source.root)) {
        fileCount += 1;
        const from = path.join(source.root, relative);
        const to = path.join(mirrorRoot, source.name, relative);
        const [fromInfo, toInfo] = [await stat(from), await stat(to).catch(() => null)];
        if (toInfo && toInfo.size === fromInfo.size) continue;
        await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        const partial = `${to}.boxpilot-partial`;
        await copyFile(from, partial);
        await chmod(partial, 0o600);
        const [sourceHash, copyHash] = await Promise.all([sha256File(from), sha256File(partial)]);
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
    await mkdir(mirrorRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(mirrorRoot, ".boxpilot-sync.json"), `${JSON.stringify({ completedAt, fileCount, copiedCount, copiedBytes }, null, 2)}\n`, { mode: 0o600 });
    return { synced: true, destination: mirrorRoot, completedAt, fileCount, copiedCount, copiedBytes, verified: true, boundary: { deletesPerformed: false, networkUsed: false } };
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

  function resolveArtifact(source, artifact) {
    const root = sourceRoots()[source];
    if (!root) throw new Error("Snapshot source must be local or mirror");
    if (typeof artifact !== "string" || !snapshotNamePattern.test(artifact)) throw new Error("Snapshot name is invalid");
    return { root, artifactPath: path.join(root, artifact), metaPath: path.join(root, `${artifact}.meta.json`) };
  }

  async function readManifestFromArchive(artifactPath) {
    const result = await run(tarBinary, ["-xzf", artifactPath, "-O", "./manifest.json"], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    if (!result.ok) throw new Error(`Could not read the snapshot manifest: ${result.stderr.split("\n").slice(-2).join(" ")}`);
    try { return JSON.parse(result.stdout); } catch { throw new Error("The snapshot manifest is not valid JSON"); }
  }

  /** Where an app data archive referenced by the snapshot can be found right now (local first, then mirror). */
  async function locateAppArchive(id, name) {
    const candidates = [
      { location: "local", directory: path.join(path.resolve(applicationBackupRoot), id) },
      { location: "mirror", directory: path.join(mirrorRoot, "application-backups", id) },
    ];
    for (const candidate of candidates) {
      if (await stat(path.join(candidate.directory, name)).then(() => true).catch(() => false)) return { ...candidate, name };
    }
    return null;
  }

  /** Manifest summary plus, per app, whether its newest data archive is reachable. */
  async function describe({ source, artifact }) {
    const { artifactPath, metaPath } = resolveArtifact(source, artifact);
    await stat(artifactPath).catch(() => { throw new Error(`Snapshot ${artifact} was not found in the ${source} source`); });
    const meta = await readFile(metaPath, "utf8").then(JSON.parse).catch(() => null);
    const manifest = await readManifestFromArchive(artifactPath);
    const apps = [];
    for (const app of manifest.contents?.apps ?? []) {
      const listing = await run(tarBinary, ["-xzf", artifactPath, "-O", `./apps/${app.id}/backups.json`], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ ok: false }));
      let newest = null;
      if (listing.ok) { try { newest = JSON.parse(listing.stdout).backups?.[0]?.artifact ?? null; } catch { newest = null; } }
      const located = newest ? await locateAppArchive(app.id, newest) : null;
      apps.push({ id: app.id, installed: app.installed, projectFiles: app.projectFiles, newestBackup: newest, dataAvailable: Boolean(located), dataLocation: located?.location ?? null });
    }
    return { source, artifact, createdAt: manifest.createdAt ?? meta?.createdAt ?? null, checksumSha256: meta?.checksumSha256 ?? null, apps, system: manifest.contents?.system ?? null, vms: manifest.contents?.vms ?? null, containsSecrets: true };
  }

  /**
   * Rehydrate from a snapshot. Apps: project files are restored, the app is (re)installed through the
   * generic deployer using the archived settings and secrets, then (optionally) its newest data
   * archive is restored. System files are staged for review, never applied. VM definitions are listed.
   */
  async function restore({ source, artifact, apps: selected = "all", restoreData = true }, { apps: appHelper, progress = null } = {}) {
    if (!appHelper) throw new Error("Application deployer is unavailable");
    const { artifactPath, metaPath } = resolveArtifact(source, artifact);
    await stat(artifactPath).catch(() => { throw new Error(`Snapshot ${artifact} was not found in the ${source} source`); });
    const meta = await readFile(metaPath, "utf8").then(JSON.parse).catch(() => null);
    if (meta?.checksumSha256) {
      progress?.("Verifying the snapshot checksum...", "stdout");
      if ((await sha256File(artifactPath)) !== meta.checksumSha256) throw new Error("The snapshot failed its checksum; it may be damaged. Nothing was changed.");
    }
    const staging = path.join(resolvedSnapshotRoot, `.restore-${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const summary = { source, artifact, apps: [], system: null, vms: [], controllerBackupStaged: null };
    try {
      progress?.(`$ tar -xzf ${artifact}`, "stdout");
      const extract = await run(tarBinary, ["-xzf", artifactPath, "-C", staging], { timeout: 30 * 60_000 });
      if (!extract.ok) throw new Error(`Could not extract the snapshot: ${extract.stderr.split("\n").slice(-2).join(" ")}`);
      const manifest = JSON.parse(await readFile(path.join(staging, "manifest.json"), "utf8"));
      progress?.("Verifying file inventory...", "stdout");
      for (const file of manifest.files ?? []) {
        const actual = await sha256File(path.join(staging, file.path)).catch(() => null);
        if (actual !== file.sha256) throw new Error(`Snapshot content ${file.path} failed verification. Nothing was changed.`);
      }
      const wanted = (manifest.contents?.apps ?? []).filter((app) => selected === "all" ? app.installed : Array.isArray(selected) && selected.includes(app.id));
      for (const app of wanted) {
        const entry = { id: app.id, installed: false, dataRestored: false, error: null };
        summary.apps.push(entry);
        try {
          const stateRaw = await readFile(path.join(staging, "apps", app.id, "boxpilot.json"), "utf8").catch(() => null);
          const archivedState = stateRaw ? JSON.parse(stateRaw) : null;
          const live = await appHelper.internals.readState(app.id);
          if (live?.installed) throw new Error("already installed on this box; uninstall it first if you want the snapshot's version");
          progress?.(`[${app.id}] restoring project files`, "stdout");
          const target = path.join(catalogRoot, app.id);
          await mkdir(target, { recursive: true, mode: 0o700 });
          for (const file of [".env"]) await copyIfExists(path.join(staging, "apps", app.id, file), path.join(target, file));
          await writeFile(path.join(target, "boxpilot.json"), JSON.stringify({ ...(archivedState ?? { id: app.id }), installed: false, restoredFrom: artifact }, null, 2), { mode: 0o600 });
          progress?.(`[${app.id}] installing with the archived settings`, "stdout");
          await appHelper.install({ id: app.id, values: archivedState?.values ?? {} }, { progress });
          entry.installed = true;
          if (restoreData) {
            const listing = await readFile(path.join(staging, "apps", app.id, "backups.json"), "utf8").then(JSON.parse).catch(() => null);
            const newest = listing?.backups?.[0]?.artifact ?? null;
            const located = newest ? await locateAppArchive(app.id, newest) : null;
            if (!located) { progress?.(`[${app.id}] no data archive available; installed fresh`, "stderr"); }
            else {
              if (located.location === "mirror") {
                progress?.(`[${app.id}] copying ${newest} from the mirror`, "stdout");
                const localDirectory = path.join(path.resolve(applicationBackupRoot), app.id);
                await mkdir(localDirectory, { recursive: true, mode: 0o700 });
                for (const name of [newest, newest.replace(/\.tar\.gz$/, ".json")]) await copyIfExists(path.join(located.directory, name), path.join(localDirectory, name));
              }
              progress?.(`[${app.id}] restoring data from ${newest}`, "stdout");
              await appHelper.restoreAppBackup({ id: app.id, backup: newest }, { progress });
              entry.dataRestored = true;
            }
          }
        } catch (error) {
          entry.error = error.message;
          progress?.(`[${app.id}] ${error.message}`, "stderr");
        }
      }
      // System files and VM definitions are staged for the operator; applying them blindly could cut off access.
      const reviewRoot = path.join(resolvedSnapshotRoot, "restored", now().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z"));
      for (const area of ["system", "vms", "controller"]) {
        const from = path.join(staging, area);
        if (await stat(from).then((info) => info.isDirectory()).catch(() => false)) {
          for (const relative of await walkFiles(from)) await copyIfExists(path.join(from, relative), path.join(reviewRoot, area, relative));
        }
      }
      summary.system = { stagedAt: path.join(reviewRoot, "system"), applied: false, contents: manifest.contents?.system ?? null };
      summary.vms = (manifest.contents?.vms?.domains ?? []).map((name) => ({ name, definitionStagedAt: path.join(reviewRoot, "vms", `${name}.xml`), defined: false }));
      summary.controllerBackupStaged = path.join(reviewRoot, "controller");
      summary.restored = summary.apps.filter((entry) => entry.installed).length;
      summary.failed = summary.apps.filter((entry) => entry.error).length;
      return summary;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  return { inspect, create, sync, sources, describe, restore, internals: { locateAppArchive, resolveArtifact } };
}
