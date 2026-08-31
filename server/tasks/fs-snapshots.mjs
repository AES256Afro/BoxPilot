import { access, mkdir } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

/**
 * Filesystem snapshots (M23.2): btrfs and ZFS, where they exist, alongside the LVM snapshots the
 * Storage page already manages. Everything here re-derives its targets from the live system —
 * a btrfs target must be a mounted btrfs filesystem, a ZFS target must be a listed dataset — so a
 * request can never name an arbitrary path or dataset it invented.
 *
 * Rollback is deliberately absent: it discards data newer than the snapshot, and there is no
 * btrfs/ZFS filesystem in reach to verify the behaviour against. Create, list, and delete are
 * one-step, well-defined commands that injected-run tests can pin down completely.
 */

export const snapshotNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const snapshotKinds = Object.freeze(["btrfs", "zfs"]);
const btrfsSnapshotDirectory = ".boxpilot-snapshots";

const binaries = {
  btrfs: "/usr/bin/btrfs",
  zfs: "/usr/sbin/zfs",
  findmnt: process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
};

const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");

async function present(binary, files) {
  return files.access(binary).then(() => true, () => false);
}

/** Mounted btrfs filesystems, from findmnt itself — the only targets the mutations accept. */
async function btrfsMounts(run) {
  const result = await run(binaries.findmnt, ["-t", "btrfs", "--json", "-o", "TARGET,SOURCE"], { timeout: 15_000 });
  if (!result.ok) return [];
  try {
    return (JSON.parse(result.stdout).filesystems ?? [])
      .filter((entry) => typeof entry?.target === "string" && entry.target.startsWith("/"))
      .map((entry) => ({ target: entry.target, source: entry.source ?? null }));
  } catch { return []; }
}

/** ZFS datasets, from `zfs list` itself — the only targets the mutations accept. */
async function zfsDatasets(run) {
  const result = await run(binaries.zfs, ["list", "-H", "-o", "name,mountpoint"], { timeout: 15_000 });
  if (!result.ok) return [];
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, mountpoint] = line.split("\t");
    return { name, mountpoint: mountpoint && mountpoint.startsWith("/") ? mountpoint : null };
  }).filter((entry) => entry.name);
}

async function listBtrfsSnapshots(run, target) {
  // -s lists snapshots only; -o keeps it to this filesystem rather than every subvolume on the disk.
  const result = await run(binaries.btrfs, ["subvolume", "list", "-s", "-o", target], { timeout: 30_000 });
  if (!result.ok) return [];
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const match = line.match(/ path (.+)$/);
    return match ? { path: match[1], name: match[1].split("/").pop() } : null;
  }).filter(Boolean);
}

async function listZfsSnapshots(run, dataset) {
  const result = await run(binaries.zfs, ["list", "-H", "-t", "snapshot", "-o", "name,used", "-d", "1", dataset], { timeout: 30_000 });
  if (!result.ok) return [];
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [full, used] = line.split("\t");
    const name = full?.split("@")[1];
    return name ? { path: full, name, used: used ?? null } : null;
  }).filter(Boolean);
}

/** What snapshot-capable filesystems exist and what snapshots they hold. Read-only. */
export async function fsSnapshotsInspect(_parameters = {}, { run = fixedRun, files = { access } } = {}) {
  const [btrfsTool, zfsTool] = await Promise.all([present(binaries.btrfs, files), present(binaries.zfs, files)]);
  const btrfs = { toolPresent: btrfsTool, filesystems: [] };
  if (btrfsTool) {
    for (const mount of await btrfsMounts(run)) {
      btrfs.filesystems.push({ ...mount, snapshots: await listBtrfsSnapshots(run, mount.target) });
    }
  }
  const zfs = { toolPresent: zfsTool, datasets: [] };
  if (zfsTool) {
    for (const dataset of await zfsDatasets(run)) {
      zfs.datasets.push({ ...dataset, snapshots: await listZfsSnapshots(run, dataset.name) });
    }
  }
  return { btrfs, zfs, supported: btrfs.filesystems.length > 0 || zfs.datasets.length > 0 };
}

function checkName(name) {
  if (typeof name !== "string" || !snapshotNamePattern.test(name)) throw new Error("Snapshot name may use letters, digits, dot, underscore, hyphen (max 32)");
  return name;
}

/** Create a read-only snapshot of a mounted btrfs filesystem or a ZFS dataset. */
export async function fsSnapshotCreate({ kind, target, name } = {}, { run = fixedRun, log = null, files = { access, mkdir } } = {}) {
  checkName(name);
  if (kind === "btrfs") {
    const mounts = await btrfsMounts(run);
    const mount = mounts.find((entry) => entry.target === target);
    if (!mount) throw new Error(`${target} is not a mounted btrfs filesystem`);
    const directory = `${mount.target}/${btrfsSnapshotDirectory}`;
    await files.mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = `${directory}/${name}`;
    const created = await run(binaries.btrfs, ["subvolume", "snapshot", "-r", mount.target, destination], { timeout: 60_000 });
    if (!created.ok) throw new Error(`btrfs snapshot failed: ${tail(created.stderr)}`);
    log?.(`Read-only btrfs snapshot ${destination}`, "stdout");
    return { created: true, kind, target: mount.target, name, path: destination };
  }
  if (kind === "zfs") {
    const datasets = await zfsDatasets(run);
    const dataset = datasets.find((entry) => entry.name === target);
    if (!dataset) throw new Error(`${target} is not a ZFS dataset on this server`);
    const full = `${dataset.name}@${name}`;
    const created = await run(binaries.zfs, ["snapshot", full], { timeout: 60_000 });
    if (!created.ok) throw new Error(`zfs snapshot failed: ${tail(created.stderr)}`);
    log?.(`ZFS snapshot ${full}`, "stdout");
    return { created: true, kind, target: dataset.name, name, path: full };
  }
  throw new Error("kind must be btrfs or zfs");
}

/** Delete one snapshot created here (btrfs: only under the managed snapshot folder; zfs: only an @snapshot). */
export async function fsSnapshotDelete({ kind, target, name } = {}, { run = fixedRun, log = null } = {}) {
  checkName(name);
  if (kind === "btrfs") {
    const mounts = await btrfsMounts(run);
    const mount = mounts.find((entry) => entry.target === target);
    if (!mount) throw new Error(`${target} is not a mounted btrfs filesystem`);
    const path = `${mount.target}/${btrfsSnapshotDirectory}/${name}`;
    const removed = await run(binaries.btrfs, ["subvolume", "delete", path], { timeout: 60_000 });
    if (!removed.ok) throw new Error(`btrfs subvolume delete failed: ${tail(removed.stderr)}`);
    log?.(`Deleted btrfs snapshot ${path}`, "stdout");
    return { deleted: true, kind, path };
  }
  if (kind === "zfs") {
    const datasets = await zfsDatasets(run);
    const dataset = datasets.find((entry) => entry.name === target);
    if (!dataset) throw new Error(`${target} is not a ZFS dataset on this server`);
    // The @ makes this a snapshot reference; zfs destroy of a bare dataset name is never built here.
    const full = `${dataset.name}@${name}`;
    const removed = await run(binaries.zfs, ["destroy", full], { timeout: 60_000 });
    if (!removed.ok) throw new Error(`zfs destroy failed: ${tail(removed.stderr)}`);
    log?.(`Deleted ZFS snapshot ${full}`, "stdout");
    return { deleted: true, kind, path: full };
  }
  throw new Error("kind must be btrfs or zfs");
}
