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

  return { inspect, create, sync };
}
