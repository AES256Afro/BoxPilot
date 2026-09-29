import { access, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { parseSmbConf, smbConfPath } from "./samba.mjs";
import { mountpointFor, reservedMountNames } from "../backup-mount.mjs";
import { mountedFrom } from "./mount-agreement.mjs";

/**
 * Root-side storage tasks executed by scripts/boxpilot-run.mjs inside boxpilot-run@.service.
 * Mount operations must act in the host mount namespace (the helper's sandbox has its own, and so
 * does this runner: see hostNamespace), and /etc/fstab is writable only here. Every fstab entry
 * BoxPilot adds sits under a `# boxpilot:<name>` marker line and carries `nofail`, so a missing
 * disk never blocks boot, and a drive's entry is ordered around Docker (withDockerOrder).
 * A mount named <name> is at /mnt/<name>, except the backup destination (see server/backup-mount.mjs).
 */

export const mountNamePattern = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Names the mount ops must not touch. Shares are `# boxpilot:share-<name>` entries and the swap
 * file is `# boxpilot:swap`, all in the same fstab under the same marker scheme, and
 * mountNamePattern admits both spellings. storage.unmount "share-nas" found no mount at
 * /mnt/share-nas, so it skipped the umount and deleted the share's fstab line anyway - leaving the
 * share mounted with nothing to remount it at boot and its credential file orphaned. "swap" would
 * have removed the swap entry without swapoff. Each of those has its own operation.
 */
function assertPlainMountName(name) {
  if (typeof name !== "string" || !mountNamePattern.test(name)) throw new Error("Name is invalid");
  if (name.startsWith("share-")) throw new Error(`${name} is a network share, not a drive; reconnect it with share.reconnect ("Reconnect the share" in Repair)`);
  if (name === "swap") throw new Error("swap is the swap file, not a mount; use the swap file operation for it");
}

/** /mnt/boxpilot holds the backup destination; a drive mounted over it would take its place. */
export function assertNotReservedMountName(name) {
  if (reservedMountNames.includes(name)) throw new Error(`${name} is reserved: /mnt/${name} holds BoxPilot's backup destination. Pick another name.`);
}
export const uuidPattern = /^[0-9a-fA-F][0-9a-fA-F-]{3,40}$/;
export const devicePattern = /^\/dev\/[a-z][a-z0-9/]{1,30}$/;
export const labelPattern = /^[A-Za-z0-9_-]{1,16}$/;
const fstabPath = "/etc/fstab";
const marker = (name) => `# boxpilot:${name}`;

const binaries = {
  blkid: "/usr/sbin/blkid",
  lsblk: "/usr/bin/lsblk",
  findmnt: process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  mount: "/usr/bin/mount",
  umount: "/usr/bin/umount",
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  docker: process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  fsckFat: "/usr/sbin/fsck.fat",
  e2fsck: "/usr/sbin/e2fsck",
  fsckExfat: "/usr/sbin/fsck.exfat",
  smbcontrol: "/usr/bin/smbcontrol",
  smbstatus: "/usr/bin/smbstatus",
  wipefs: "/usr/sbin/wipefs",
  mkfsExt4: "/usr/sbin/mkfs.ext4",
  fallocate: "/usr/bin/fallocate",
  mkswap: "/usr/sbin/mkswap",
  swapon: "/usr/sbin/swapon",
  swapoff: "/usr/sbin/swapoff",
  chmod: "/usr/bin/chmod",
  chown: "/usr/bin/chown",
  rm: "/usr/bin/rm",
  lvextend: "/usr/sbin/lvextend",
  lvcreate: "/usr/sbin/lvcreate",
  lvremove: "/usr/sbin/lvremove",
  lvconvert: "/usr/sbin/lvconvert",
  lvs: "/usr/sbin/lvs",
  vgs: "/usr/sbin/vgs",
};
const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");

/**
 * mount(8) and umount(8), switched into PID 1's mount namespace to do their work.
 *
 * These tasks run in boxpilot-run@.service, whose PrivateTmp= gives it a mount namespace of its
 * own that does not propagate back to the host: a mount made there was visible to the task alone
 * and gone when it exited, and an unmount took the drive away from the task and nothing else. The
 * task's own findmnt agreed with it, so each reported success. tests/ubuntu/drive-shutdown-order.sh
 * shows both on real systemd, and that -N (util-linux 2.33+) makes them read fstab and act in the
 * host's namespace, from where the change propagates back into the task's own.
 */
export const hostNamespace = Object.freeze(["-N", "/proc/1/ns/mnt"]);
const mountArgs = (...args) => [...hostNamespace, ...args];
export const snapshotPrefix = "boxpilot-snap-";
export const snapshotNamePattern = /^boxpilot-snap-[0-9]{8}-[0-9]{4}(-[a-z0-9-]{1,24})?$/;
/** Device-mapper escapes "-" as "--": a snapshot named boxpilot-snap-x appears as vg-boxpilot--snap--x. */
const snapshotDmPattern = /-boxpilot--snap--/;

/** Signatures that mean the device belongs to LVM/RAID/LUKS: never mount or format it directly. */
export const memberFstypes = Object.freeze(["LVM2_member", "linux_raid_member", "crypto_LUKS", "bcache", "ceph_bluestore", "zfs_member"]);
/** A device carrying any of these is the system disk. */
export const systemMountpoints = Object.freeze(["/", "/boot", "/boot/efi", "/usr", "/var", "/home", "/efi"]);
export const logicalVolumePattern = /^\/dev\/mapper\/[A-Za-z0-9._+-]{1,64}$/;

/** Full device subtree (LVM and dm children included; this runs as root in the host namespace). */
async function deviceTree(run, device) {
  const tree = await run(binaries.lsblk, ["-J", "-o", "PATH,TYPE,FSTYPE,RO,MOUNTPOINTS", device], { timeout: 15_000 });
  if (!tree.ok) throw new Error(`${device} was not found`);
  try {
    const parsed = JSON.parse(tree.stdout);
    const flatten = (list) => list.flatMap((node) => [node, ...flatten(node.children ?? [])]);
    return flatten(parsed.blockdevices ?? []);
  } catch { throw new Error("Could not read the device layout"); }
}

/** Throw when touching `device` could take the system or a volume group down with it. */
export function assertNotProtected(device, nodes) {
  if (snapshotDmPattern.test(device) || /-(real|cow)$/.test(device)) throw new Error(`${device} is an LVM snapshot (or its internal device); manage it from the Snapshots panel`);
  const mountedAt = nodes.flatMap((node) => (node.mountpoints ?? []).filter(Boolean));
  const system = mountedAt.filter((target) => systemMountpoints.includes(target));
  if (system.length) throw new Error(`${device} is the system disk (${system.join(", ")} lives on it); BoxPilot will not touch it`);
  const member = nodes.find((node) => memberFstypes.includes(node.fstype ?? ""));
  if (member) {
    const what = member.fstype === "LVM2_member" ? "an LVM physical volume" : member.fstype === "crypto_LUKS" ? "an encrypted container" : member.fstype === "linux_raid_member" ? "a RAID member" : `a ${member.fstype} member`;
    const volumes = nodes.filter((node) => node.type === "lvm").map((node) => node.path);
    throw new Error(`${member.path} is ${what}${volumes.length ? ` holding ${volumes.join(", ")}` : ""}; it cannot be mounted or formatted directly`);
  }
  if (mountedAt.length) throw new Error(`${device} is in use (mounted at ${mountedAt.join(", ")}); unmount everything on it first`);
}

/** Split fstab into blocks; a `# boxpilot:<name>` marker owns exactly the following line. */
export function parseManagedFstab(content) {
  const lines = String(content ?? "").split("\n");
  const managed = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^# boxpilot:([a-z0-9-]+)\s*$/);
    if (match && index + 1 < lines.length) managed.push({ name: match[1], line: lines[index + 1], markerIndex: index });
  }
  return managed;
}

export function removeManagedEntry(content, name) {
  const lines = String(content ?? "").split("\n");
  const index = lines.findIndex((line) => line.trim() === marker(name));
  if (index === -1) return null;
  lines.splice(index, 2);
  return lines.join("\n");
}

async function fstabVerify(run) {
  // findmnt --verify exits non-zero on parse errors or impossible entries; nofail keeps warnings soft.
  const result = await run(binaries.findmnt, ["--verify"], { timeout: 30_000 });
  return result;
}

export async function appendFstabEntry({ run, files, log }, name, entry) {
  const before = await files.readFile(fstabPath, "utf8");
  if (parseManagedFstab(before).some((existing) => existing.name === name)) throw new Error(`An entry named ${name} already exists in fstab`);
  const content = `${before.replace(/\n*$/, "\n")}${marker(name)}\n${entry}\n`;
  await files.writeFile(fstabPath, content);
  const verify = await fstabVerify(run);
  if (!verify.ok) {
    await files.writeFile(fstabPath, before);
    throw new Error(`fstab verification rejected the new entry; fstab was restored: ${verify.stderr.split("\n").slice(-2).join(" ")}`);
  }
  log?.(`Added to fstab: ${entry}`, "stdout");
  return before;
}

/**
 * Two options on every drive entry: the drive is mounted before Docker starts, and unmounted only
 * after Docker has stopped (M26).
 *
 * `nofail` keeps a missing drive from holding up boot by taking the mount out of local-fs.target's
 * ordering, and that was the only thing ordering it before Docker: docker.service comes after
 * local-fs.target only by way of sysinit.target. With nothing between them, a boot can start the
 * containers before the drive is mounted - they bind the empty folder underneath, and whatever they
 * save lands on the system disk - and a shutdown can unmount the drive while Docker is still
 * stopping them. Stop order is start order reversed, so one Before= orders both.
 *
 * The device timeout is what that costs when the drive really is missing: Docker waits for it at
 * most this long instead of systemd's default 90 s. Not less, because a large USB disk starting
 * from cold can take 15-20 s to show its partition table, and a drive that misses the window is
 * not mounted at all until someone mounts it.
 */
export const driveDeviceTimeout = "30s";
export const dockerOrderOption = "x-systemd.before=docker.service";

/** The fstab options with the Docker ordering added where missing. A device timeout already there is the owner's and is kept. */
export function withDockerOrder(options) {
  const list = String(options ?? "").split(",").filter(Boolean);
  const added = [
    ...(list.includes(dockerOrderOption) ? [] : [dockerOrderOption]),
    ...(list.some((option) => option.startsWith("x-systemd.device-timeout=")) ? [] : [`x-systemd.device-timeout=${driveDeviceTimeout}`]),
  ];
  return [...list, ...added].join(",");
}

/** Mount a filesystem by UUID at /mnt/<name> (see mountpointFor) with a verified, nofail fstab entry. */
export const appUserId = 1000;
export const permissionlessFilesystems = Object.freeze(["exfat", "vfat", "ntfs", "ntfs3", "msdos"]);

export async function storageMount({ uuid, name, fstype = "auto", readOnly = false, appWritable = false, uid = appUserId, gid = appUserId } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, mkdir } } = {}) {
  if (typeof uuid !== "string" || !uuidPattern.test(uuid)) throw new Error("UUID is invalid");
  if (typeof name !== "string" || !mountNamePattern.test(name)) throw new Error("Name must be lower-case letters, digits, and hyphens (max 32)");
  assertPlainMountName(name);   // and not swap or share-*: creating one would plant a marker swapFileSet and shareUnmount act on as their own
  assertNotReservedMountName(name);
  if (typeof fstype !== "string" || !/^[a-z0-9]{2,12}$/.test(fstype)) throw new Error("Filesystem type is invalid");
  if (![uid, gid].every((value) => Number.isInteger(value) && value >= 0 && value <= 65_535)) throw new Error("Owner uid/gid are invalid");
  const device = await run(binaries.blkid, ["-U", uuid], { timeout: 15_000 });
  if (!device.ok || !device.stdout.trim()) throw new Error(`No filesystem with UUID ${uuid} was found`);
  const dev = device.stdout.trim();
  assertNotProtected(dev, await deviceTree(run, dev));
  const mountpoint = mountpointFor(name);
  const mounted = await run(binaries.findmnt, ["-n", mountpoint], { timeout: 15_000 });
  if (mounted.ok && mounted.stdout.trim()) throw new Error(`${mountpoint} is already mounted`);
  await files.mkdir(mountpoint, { recursive: true, mode: 0o755 });
  // Boot-time fsck only helps the journaling Linux filesystems that ship one; a removable
  // exFAT/NTFS/FAT drive has no fsck installed by default, so anything else gets passno 0 to keep
  // boot clean. When the type was left to auto-detect, pin the detected type into the entry too, so
  // a USB disk that is slow to settle mounts by an explicit type rather than being skipped.
  let entryFstype = fstype;
  if (fstype === "auto") {
    const detected = (await run(binaries.blkid, ["-o", "value", "-s", "TYPE", dev], { timeout: 15_000 }).catch(() => ({ stdout: "" }))).stdout.trim();
    if (/^[a-z0-9]{2,12}$/.test(detected)) entryFstype = detected;
  }
  const fsckPass = ["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "jfs", "reiserfs"].includes(entryFstype) ? "2" : "0";
  // Make an external drive usable by apps: a filesystem without Unix permissions (exFAT, FAT, NTFS)
  // carries ownership as a mount option, so hand the whole volume to the apps user in the entry; a
  // Linux filesystem keeps its own on-disk permissions, so we chown the top of it after mounting.
  const permissionless = permissionlessFilesystems.includes(entryFstype);
  const giveToApps = appWritable && !readOnly;
  const options = withDockerOrder(readOnly ? "ro,nofail"
    : giveToApps && permissionless ? `rw,nofail,uid=${uid},gid=${gid}`
      : "defaults,nofail");
  const previous = await appendFstabEntry({ run, files, log }, name, `UUID=${uuid} ${mountpoint} ${entryFstype} ${options} 0 ${fsckPass}`);
  await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 });
  log?.(`$ mount ${mountpoint}`, "stdout");
  const mountResult = await run(binaries.mount, mountArgs(mountpoint), { timeout: 60_000 });
  // mount can exit 0 while quietly skipping a `nofail` entry it judges not ready, or while leaving
  // nothing mounted for an unclean exFAT/NTFS volume. Trusting the exit code alone once reported
  // success with nothing mounted, leaving a live fstab entry that then blocked every retry, so
  // confirm the filesystem is really there before committing to it.
  const check = mountResult.ok
    ? await run(binaries.findmnt, ["-n", "-b", "-o", "SOURCE,FSTYPE,SIZE", mountpoint], { timeout: 15_000 })
    : { ok: false, stdout: "", stderr: "" };
  if (!mountResult.ok || !check.stdout.trim()) {
    await files.writeFile(fstabPath, previous);
    await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 }).catch(() => {});
    const reason = mountResult.ok
      ? "mount reported success but nothing is mounted there — a drive ejected unsafely (exFAT/NTFS) or still spinning up can do this; reconnect or repair the drive and try again"
      : tail(mountResult.stderr);
    throw new Error(`mount failed and the fstab entry was removed again: ${reason}`);
  }
  // A Linux filesystem already mounted; give the top of it to the apps user so containers running as
  // that uid can create their own folders. Only the mountpoint itself, never a recursive sweep.
  if (giveToApps && !permissionless) {
    const owned = await run(binaries.chown, [`${uid}:${gid}`, mountpoint], { timeout: 30_000 });
    if (owned.ok) log?.(`Owner of ${mountpoint} set to ${uid}:${gid} so apps can write there`, "stdout");
    else log?.(`Could not set the owner of ${mountpoint}; apps may not be able to write there: ${tail(owned.stderr)}`, "stderr");
  }
  return { mounted: true, name, mountpoint, uuid, device: dev, detail: check.stdout.trim(), owner: giveToApps ? `${uid}:${gid}` : null, persistent: true };
}

/** Unmount and remove a BoxPilot-managed fstab entry. Foreign entries are refused. */
export async function storageUnmount({ name } = {}, { run = fixedRun, log = null, files = { readFile, writeFile } } = {}) {
  assertPlainMountName(name);
  const content = await files.readFile(fstabPath, "utf8");
  const without = removeManagedEntry(content, name);
  if (without === null) throw new Error(`${name} is not a BoxPilot-managed mount; edit fstab yourself for entries you created`);
  const mountpoint = mountpointFor(name);
  const mounted = await run(binaries.findmnt, ["-n", mountpoint], { timeout: 15_000 });
  if (mounted.ok && mounted.stdout.trim()) {
    log?.(`$ umount ${mountpoint}`, "stdout");
    const result = await run(binaries.umount, mountArgs(mountpoint), { timeout: 60_000 });
    if (!result.ok) throw new Error(`umount failed (is something using it?): ${result.stderr.split("\n").slice(-2).join(" ")}`);
  }
  await files.writeFile(fstabPath, without);
  await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 });
  log?.(`Removed the ${name} entry from fstab; the directory ${mountpoint} was kept`, "stdout");
  return { unmounted: true, name, mountpoint, directoryKept: true };
}

/** Erase a block device and create a fresh ext4 filesystem. The guards are absolute. */
export async function storageFormat({ device, label = null } = {}, { run = fixedRun, log = null } = {}) {
  if (typeof device !== "string" || !devicePattern.test(device)) throw new Error("Device path is invalid");
  if (label !== null && (typeof label !== "string" || !labelPattern.test(label))) throw new Error("Label may use letters, digits, underscore, hyphen (max 16)");
  const nodes = await deviceTree(run, device);
  if (nodes.some((node) => node.ro)) throw new Error(`${device} is read-only`);
  assertNotProtected(device, nodes);
  log?.(`$ wipefs -a ${device}`, "stdout");
  const wipe = await run(binaries.wipefs, ["-a", device], { timeout: 60_000 });
  if (!wipe.ok) throw new Error(`wipefs failed: ${wipe.stderr.split("\n").slice(-2).join(" ")}`);
  log?.(`$ mkfs.ext4 -F ${label ? `-L ${label} ` : ""}${device}`, "stdout");
  const mkfs = await run(binaries.mkfsExt4, ["-F", ...(label ? ["-L", label] : []), device], { timeout: 30 * 60_000, onLine: log ?? undefined });
  if (!mkfs.ok) throw new Error(`mkfs.ext4 failed: ${mkfs.stderr.split("\n").slice(-2).join(" ")}`);
  const blkid = await run(binaries.blkid, ["-o", "value", "-s", "UUID", device], { timeout: 15_000 });
  return { formatted: true, device, fstype: "ext4", label, uuid: blkid.ok ? blkid.stdout.trim() : null };
}

/** Create (or remove) a managed swap file at /swap.boxpilot with a nofail fstab entry. */
export async function swapFileSet({ sizeGiB = null, remove = false } = {}, { run = fixedRun, log = null, files = { readFile, writeFile } } = {}) {
  const swapPath = "/swap.boxpilot";
  if (remove) {
    const content = await files.readFile(fstabPath, "utf8");
    const without = removeManagedEntry(content, "swap");
    await run(binaries.swapoff, [swapPath], { timeout: 5 * 60_000 });
    if (without !== null) { await files.writeFile(fstabPath, without); await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 }); }
    await run(binaries.rm, ["-f", swapPath], { timeout: 30_000 });
    log?.(`Removed ${swapPath} and its fstab entry`, "stdout");
    return { removed: true, path: swapPath };
  }
  if (!Number.isInteger(sizeGiB) || sizeGiB < 1 || sizeGiB > 64) throw new Error("Swap size must be a whole number of GiB between 1 and 64");
  const existing = await files.readFile(fstabPath, "utf8");
  if (parseManagedFstab(existing).some((entry) => entry.name === "swap")) throw new Error("A BoxPilot swap file already exists; remove it before creating a new one");
  log?.(`$ fallocate -l ${sizeGiB}G ${swapPath}`, "stdout");
  const allocate = await run(binaries.fallocate, ["-l", `${sizeGiB}G`, swapPath], { timeout: 5 * 60_000 });
  if (!allocate.ok) throw new Error(`Could not allocate the swap file: ${allocate.stderr.split("\n").slice(-2).join(" ")}`);
  try {
    await run(binaries.chmod, ["600", swapPath], { timeout: 15_000 });
    const mkswap = await run(binaries.mkswap, [swapPath], { timeout: 60_000 });
    if (!mkswap.ok) throw new Error(`mkswap failed: ${mkswap.stderr.split("\n").slice(-2).join(" ")}`);
    await appendFstabEntry({ run, files, log }, "swap", `${swapPath} none swap sw,nofail 0 0`);
    const swapon = await run(binaries.swapon, [swapPath], { timeout: 60_000 });
    if (!swapon.ok) throw new Error(`swapon failed: ${swapon.stderr.split("\n").slice(-2).join(" ")}`);
  } catch (error) {
    await run(binaries.rm, ["-f", swapPath], { timeout: 30_000 }).catch(() => {});
    throw error;
  }
  return { created: true, path: swapPath, sizeGiB };
}

/**
 * Grow a mounted LVM logical volume into all free space of its volume group, online.
 * Ubuntu's installer leaves most of the disk unallocated by default; this claims it without
 * a reboot. `lvextend -r` resizes the filesystem (ext4/xfs) in the same step.
 */
async function volumeGroupOf(run, volume) {
  const result = await run(binaries.lvs, ["--noheadings", "--options", "vg_name,lv_name", volume], { timeout: 15_000 });
  if (!result.ok) return null;
  const [vg, lv] = result.stdout.trim().split(/\s+/);
  return vg ? { vg, lv } : null;
}

async function volumeGroupFreeBytes(run, vg) {
  const result = await run(binaries.vgs, ["--noheadings", "--units", "b", "--nosuffix", "--options", "vg_free", vg], { timeout: 15_000 });
  const value = Number.parseInt(result.stdout.trim(), 10);
  return result.ok && Number.isInteger(value) ? value : null;
}

export async function storageLvmExtend({ path: volume, reserveGiB = 32 } = {}, { run = fixedRun, log = null } = {}) {
  if (typeof volume !== "string" || !logicalVolumePattern.test(volume)) throw new Error("Logical volume path is invalid");
  if (!Number.isInteger(reserveGiB) || reserveGiB < 0 || reserveGiB > 1024) throw new Error("reserveGiB must be a whole number between 0 and 1024");
  const nodes = await deviceTree(run, volume);
  const node = nodes.find((entry) => entry.path === volume);
  if (!node || node.type !== "lvm") throw new Error(`${volume} is not an LVM logical volume`);
  if (!["ext4", "ext3", "ext2", "xfs"].includes(node.fstype ?? "")) throw new Error(`${volume} holds ${node.fstype ?? "no filesystem"}; only ext4 and xfs can be grown online`);
  const mountpoint = (node.mountpoints ?? []).filter(Boolean)[0] ?? null;
  if (!mountpoint) throw new Error(`${volume} is not mounted; mount it first so the filesystem can be grown online`);
  const before = await run(binaries.findmnt, ["-n", "-b", "-o", "SIZE,AVAIL", mountpoint], { timeout: 15_000 });
  // Leave room for snapshots: grow by (free - reserve) when a reserve is requested and the group size is known.
  let sizeArguments = ["-l", "+100%FREE"];
  if (reserveGiB > 0) {
    const group = await volumeGroupOf(run, volume);
    const free = group ? await volumeGroupFreeBytes(run, group.vg) : null;
    if (free !== null) {
      const grow = free - reserveGiB * 1024 ** 3;
      if (grow < 256 * 1024 ** 2) return { extended: false, path: volume, mountpoint, reason: `Only ${(free / 1024 ** 3).toFixed(1)} GiB is free and ${reserveGiB} GiB is kept for snapshots`, detail: before.stdout.trim() || null };
      sizeArguments = ["-L", `+${grow}B`];
    }
  }
  log?.(`$ lvextend -r ${sizeArguments.join(" ")} ${volume}`, "stdout");
  const result = await run(binaries.lvextend, ["-r", ...sizeArguments, volume], { timeout: 10 * 60_000, onLine: log ?? undefined });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!result.ok) {
    if (/matches existing size|No free extents|not enough free space|already/i.test(output)) {
      return { extended: false, path: volume, mountpoint, reason: "The volume group has no free space left", detail: before.stdout.trim() || null };
    }
    throw new Error(`lvextend failed: ${output.split("\n").filter(Boolean).slice(-2).join(" ")}`);
  }
  const after = await run(binaries.findmnt, ["-n", "-b", "-o", "SIZE,AVAIL", mountpoint], { timeout: 15_000 });
  const sizes = (text) => { const [size, avail] = String(text ?? "").trim().split(/\s+/).map((value) => Number.parseInt(value, 10)); return { sizeBytes: Number.isInteger(size) ? size : null, availableBytes: Number.isInteger(avail) ? avail : null }; };
  return { extended: true, path: volume, mountpoint, before: sizes(before.stdout), after: sizes(after.stdout) };
}

/** Create a copy-on-write snapshot of a logical volume (a restore point before updates). */
export async function storageLvmSnapshotCreate({ path: volume, sizeGiB = 10, suffix = null } = {}, { run = fixedRun, log = null, now = () => new Date() } = {}) {
  if (typeof volume !== "string" || !logicalVolumePattern.test(volume) || snapshotDmPattern.test(volume)) throw new Error("Logical volume path is invalid");
  if (!Number.isInteger(sizeGiB) || sizeGiB < 1 || sizeGiB > 2048) throw new Error("sizeGiB must be a whole number between 1 and 2048");
  if (suffix !== null && !/^[a-z0-9-]{1,24}$/.test(String(suffix))) throw new Error("suffix may use lower-case letters, digits, and hyphens (max 24)");
  const group = await volumeGroupOf(run, volume);
  if (!group) throw new Error(`${volume} is not an LVM logical volume`);
  const free = await volumeGroupFreeBytes(run, group.vg);
  if (free !== null && free < sizeGiB * 1024 ** 3) throw new Error(`Volume group ${group.vg} has only ${(free / 1024 ** 3).toFixed(1)} GiB free; choose a smaller snapshot size or free space first`);
  const stamp = now().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  const name = `${snapshotPrefix}${stamp}${suffix ? `-${suffix}` : ""}`;
  if (!snapshotNamePattern.test(name)) throw new Error("Snapshot name is invalid");
  log?.(`$ lvcreate -s -L ${sizeGiB}G -n ${name} ${volume}`, "stdout");
  const result = await run(binaries.lvcreate, ["-s", "-L", `${sizeGiB}G`, "-n", name, volume], { timeout: 5 * 60_000 });
  if (!result.ok) throw new Error(`lvcreate failed: ${tail(`${result.stderr}\n${result.stdout}`)}`);
  const path = `/dev/mapper/${group.vg.replace(/-/g, "--")}-${name.replace(/-/g, "--")}`;
  return { created: true, name, path, origin: volume, volumeGroup: group.vg, sizeGiB, createdAt: now().toISOString() };
}

/** Remove a BoxPilot snapshot. Only names with the BoxPilot prefix are accepted. */
export async function storageLvmSnapshotDelete({ path: snapshot } = {}, { run = fixedRun, log = null } = {}) {
  if (typeof snapshot !== "string" || !logicalVolumePattern.test(snapshot) || !snapshotDmPattern.test(snapshot)) throw new Error("Only BoxPilot snapshots (boxpilot-snap-...) can be removed from here");
  log?.(`$ lvremove -f ${snapshot}`, "stdout");
  const result = await run(binaries.lvremove, ["-f", snapshot], { timeout: 5 * 60_000 });
  if (!result.ok) throw new Error(`lvremove failed: ${tail(`${result.stderr}\n${result.stdout}`)}`);
  return { removed: true, path: snapshot };
}

/**
 * Roll the origin back to a snapshot (lvconvert --merge). For a mounted origin such as /
 * the merge is scheduled and happens on the next activation, i.e. after a reboot; the
 * snapshot disappears once merged.
 */
export async function storageLvmSnapshotRollback({ path: snapshot } = {}, { run = fixedRun, log = null } = {}) {
  if (typeof snapshot !== "string" || !logicalVolumePattern.test(snapshot) || !snapshotDmPattern.test(snapshot)) throw new Error("Only BoxPilot snapshots (boxpilot-snap-...) can be rolled back to");
  log?.(`$ lvconvert --merge ${snapshot}`, "stdout");
  const result = await run(binaries.lvconvert, ["--merge", snapshot], { timeout: 5 * 60_000 });
  const output = `${result.stderr}\n${result.stdout}`;
  if (!result.ok) throw new Error(`lvconvert failed: ${tail(output)}`);
  // An origin that is in use (a mounted /) merges on its next activation, which is a reboot; one that
  // is not merges now. LVM says which; only a deferred merge needs the reboot.
  const deferred = /next activation|delaying merge|can't merge|will merge|will occur/i.test(output);
  log?.(deferred ? "The merge is scheduled; reboot to apply it. The snapshot is consumed by the merge." : "Merged; no reboot is needed. The snapshot was consumed by the merge.", "stdout");
  return { rollbackScheduled: true, path: snapshot, rebootRequired: deferred, detail: output.split("\n").filter(Boolean).slice(-2).join(" ") };
}

/**
 * The managed drive entry named `name`: its fstab line and where it mounts. The marker owns
 * whatever line follows it, and not every managed entry is a mount under /mnt: the swap file's
 * marker is `# boxpilot:swap` over an entry whose target is `none`. Taking the mountpoint from the
 * entry itself, rather than assuming /mnt/<name>, is what keeps an op from unmounting a path the
 * entry has nothing to do with.
 */
export async function managedDrive(name, files) {
  assertPlainMountName(name);
  const content = await files.readFile(fstabPath, "utf8");
  const entry = parseManagedFstab(content).find((row) => row.name === name);   // parseManagedFstab returns { name, line, markerIndex }
  if (!entry) throw new Error(`${name} is not a BoxPilot-managed mount; remount it yourself for entries you created`);
  const [source = "", mountpoint = "", fstype = "", options = ""] = entry.line.trim().split(/\s+/);
  if (mountpoint !== mountpointFor(name)) throw new Error(`The ${name} entry is not a drive mounted at ${mountpointFor(name)}; nothing was changed`);
  return { name, source, mountpoint, fstype, options, readWrite: !options.split(",").includes("ro") };
}

/**
 * What is mounted at `mountpoint` in the host's namespace (PID 1's), the top mount when several are
 * stacked there, or null. The runner's own namespace is a copy that can differ from the host's.
 */
export async function hostMountAt(run, mountpoint) {
  const result = await run(binaries.findmnt, ["--task", "1", "-n", "-o", "SOURCE,FSTYPE,MAJ:MIN,OPTIONS", "--mountpoint", mountpoint], { timeout: 15_000 });
  if (!result.ok) return null;
  const line = result.stdout.split("\n").map((row) => row.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  const [source, fstype = null, majMin = null, options = ""] = line.split(/\s+/);
  return { source, fstype, majMin, options, readOnly: options.split(",").includes("ro") };
}

/**
 * Whether the device an fstab entry names is on this server now: `UUID=`, `LABEL=`, `PARTUUID=` or
 * a /dev path. Asked before anything is stopped, so a drive that is not plugged in costs nothing.
 * A spelling it does not know is not refused: the mount itself will say.
 */
export async function deviceFor(run, source) {
  const [tag, value] = String(source ?? "").split(/=(.*)/s);
  const ask = tag === "UUID" ? ["-U", value] : tag === "LABEL" ? ["-L", value] : tag === "PARTUUID" ? ["-t", `PARTUUID=${value}`, "-o", "device"] : null;
  if (ask && value) {
    const found = await run(binaries.blkid, ask, { timeout: 15_000 });
    return { known: true, device: found.ok ? found.stdout.trim().split("\n")[0] || null : null };
  }
  if (devicePattern.test(source)) {
    const listed = await run(binaries.lsblk, ["-dno", "PATH", source], { timeout: 15_000 });
    return { known: true, device: listed.ok && listed.stdout.trim() ? source : null };
  }
  return { known: false, device: null };
}

const listOf = (names) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * Mount a managed drive again from its fstab entry, the way an operator does it when the drive is
 * busy, and prove it came back.
 *
 * Reconnecting on the owner's server was refused four times with "target is busy": the apps with
 * the folder bound held one copy of the filesystem, and a PC with the file share mapped held it
 * through smbd, and the old remount told the owner to stop things by hand. This goes through the
 * same pipeline as the drive check (withDriveUnmounted), in this order:
 *
 * 1. The drive's device is looked for first. One that is not plugged in is said at once, and nothing
 *    is stopped or unmounted for it.
 * 2. Every running container with a bind at or under the folder is stopped. It must be, not merely
 *    restarted afterwards: a filesystem stays alive while any container still holds it, and mounting
 *    the same device again then reuses it as it is - still read-only after errors, or refused with
 *    "would change RO state".
 * 3. The host's mount is unmounted in PID 1's namespace, closing the file shares on it and retrying
 *    when their clients are what holds it (unmountFromHost). A mount whose drive is gone (it does
 *    not read) and that still will not let go is detached lazily; a healthy one is never, because
 *    whoever holds it would keep writing into a filesystem no path reaches.
 * 4. It is mounted again from fstab, which finds the drive by its UUID wherever the kernel has put
 *    it, and must then read, and be read-write when fstab asks for read-write.
 * 5. The containers are started again, with the folder as it is mounted now.
 *
 * `rewrite` runs with the drive unmounted and nothing using it, just before the mount: the place to
 * change its fstab entry (storage.writable). It returns `{ summary, undo }`: the summary is kept on
 * the result, and `undo` puts the entry back when mount refuses the changed one.
 *
 * When something other than an app still holds it, or it does not mount again, the apps are left as
 * the drive allows: started again on the old mount when it was never unmounted, and left stopped
 * when it is not mounted at all, so nothing they write lands in the empty folder underneath.
 */
export async function remountDrive(drive, { run = fixedRun, log = null, files = defaultRemountFiles, sleep = pause, processes = undefined, rewrite = null } = {}) {
  const { mountpoint } = drive;
  const before = await hostMountAt(run, mountpoint);
  const present = await deviceFor(run, drive.source);
  if (present.known && !present.device) {
    throw new Error(`The drive for ${mountpoint} (${drive.source}) is not connected to this server right now, so nothing was stopped or unmounted. Check that it is plugged in and powered on, then try again.`);
  }
  // A dead filesystem returns an I/O error on the very listing that was empty in File Explorer; a
  // live one does not. The device-name test cannot tell: a drive that dropped and came back usually
  // reclaims the same name, so the node exists again while the old mount is still broken.
  const dead = before ? !(await files.readable(mountpoint)) : false;
  if (before) log?.(`${mountpoint} is mounted from ${before.source}${before.readOnly ? ", read-only" : ""}${dead ? ", and does not read: its drive is gone" : ""}`, dead || before.readOnly ? "stderr" : "stdout");
  else log?.(`${mountpoint} is not mounted`, "stdout");

  const bound = await containersBoundTo(run, mountpoint);
  const stopped = [];
  for (const container of bound) {
    log?.(`$ docker stop ${container}`, "stdout");
    const result = await run(binaries.docker, ["stop", container], { timeout: 120_000 });
    if (result.ok) stopped.push(container); else log?.(`could not stop ${container}: ${tail(result.stderr)}`, "stderr");
  }
  const started = []; const restartFailed = [];
  const startApps = async () => {
    for (const container of stopped) {
      log?.(`$ docker start ${container}`, "stdout");
      const result = await run(binaries.docker, ["start", container], { timeout: 120_000 });
      if (result.ok) started.push(container); else { restartFailed.push(container); log?.(`could not start ${container}: ${tail(result.stderr)}`, "stderr"); }
    }
  };
  // Apps left stopped because there is no drive under the folder to give them.
  const leftStopped = () => (stopped.length ? ` ${listOf(stopped)} ${stopped.length === 1 ? "was" : "were"} stopped and left stopped, so nothing writes into the empty folder under ${mountpoint}; ${stopped.length === 1 ? "it starts" : "they start"} again when this reconnect succeeds.` : "");

  let sharing = { clients: [], shares: [] };
  let detachedLazily = false;
  if (before) {
    const unmounted = await unmountFromHost(mountpoint, { run, log, files, sleep });
    sharing = { clients: unmounted.clients ?? [], shares: unmounted.shares ?? [] };
    if (!unmounted.ok && dead) {
      log?.(`${mountpoint} still will not let go and its drive is gone; detaching it lazily`, "stderr");
      const lazy = await run(binaries.umount, mountArgs("-l", mountpoint), { timeout: 60_000 });
      if (!lazy.ok) { await startApps(); throw new Error(`Could not detach the dead mount at ${mountpoint}: ${tail(lazy.stderr)}.${started.length ? ` ${listOf(started)} ${started.length === 1 ? "was" : "were"} started again as they were.` : ""}`); }
      detachedLazily = true;
    } else if (!unmounted.ok) {
      const holders = before.majMin ? await processesUsing(before.majMin, processes) : [];
      await startApps();
      const who = holders.length ? ` by ${holders.map((holder) => `${holder.command} (${holder.pid})`).join(", ")}` : "";
      const smb = holders.some((holder) => holder.command === "smbd") || sharing.shares.length
        ? ` A computer connected to ${sharing.shares.length ? `the ${listOf(sharing.shares)} share${sharing.shares.length === 1 ? "" : "s"}` : "a file share on it"} kept reconnecting faster than it could be unmounted; disconnect it (or close File Explorer there) and try again.`
        : " Close whatever is using it - a shell sitting in the folder, a copy in progress - and try again.";
      throw new Error(`${mountpoint} is still in use${who}, so it was left mounted as it was: ${tail(unmounted.result?.stderr) || "target is busy"}.${smb}${started.length ? ` ${listOf(started)} ${started.length === 1 ? "was" : "were"} started again on it.` : ""}`);
    }
  }

  let rewritten = null;
  let undo = null;
  try {
    if (rewrite) ({ summary: rewritten = null, undo = null } = (await rewrite()) ?? {});
  } catch (error) {
    // Nothing was changed on the drive; put it back the way it was mounted, and the apps with it.
    const back = await run(binaries.mount, mountArgs(mountpoint), { timeout: 120_000 });
    if (back.ok && (await hostMountAt(run, mountpoint))) await startApps();
    throw new Error(`${error.message}${back.ok ? `. ${mountpoint} was mounted again as it was${started.length ? `, and ${listOf(started)} started again` : ""}.` : `. ${mountpoint} could not be mounted again: ${tail(back.stderr)}.${leftStopped()}`}`);
  }

  log?.(`$ mount ${mountpoint}`, "stdout");
  const mounted = await run(binaries.mount, mountArgs(mountpoint), { timeout: 120_000 });
  if (!mounted.ok && undo) {
    // The changed entry is what mount refused: the old one goes back, and the drive with it.
    await undo();
    const back = await run(binaries.mount, mountArgs(mountpoint), { timeout: 120_000 });
    if (back.ok && (await hostMountAt(run, mountpoint))) await startApps();
    throw new Error(`mount refused the changed entry (${tail(mounted.stderr)}), so the old entry was put back${back.ok ? ` and ${mountpoint} mounted as it was${started.length ? `, with ${listOf(started)} started again` : ""}.` : `, and ${mountpoint} could not be mounted with it either: ${tail(back.stderr)}.${leftStopped()}`}`);
  }
  if (!mounted.ok) throw new Error(`Could not mount ${mountpoint} again: ${tail(mounted.stderr)}. The drive may be unplugged or failing; check its cable, then try again.${leftStopped()}`);
  const after = await hostMountAt(run, mountpoint);
  if (!after) throw new Error(`${mountpoint} did not come back after remounting. The drive may be unplugged.${leftStopped()}`);
  // findmnt saying it is mounted is the same evidence that lied during the incident. A real read
  // is the test: a filesystem that answers a listing is one that works.
  if (!(await files.readable(mountpoint))) throw new Error(`${mountpoint} mounted from ${after.source} but does not read. The drive may be failing; check its cable and its SMART health before trying again.${leftStopped()}`);
  log?.(`${mountpoint} is mounted from ${after.source}${before && before.source !== after.source ? ` (it was ${before.source}, which no longer exists)` : ""} and reads`, "stdout");
  // Docker resolves a bind when a container starts, so the apps see the folder as it is mounted now.
  await startApps();
  // Mounted afresh and still read-only is the filesystem's own answer: the kernel found errors in it
  // at mount. Saying the reconnect worked would send the owner back to the same button.
  if (drive.readWrite && after.readOnly) {
    throw new Error(`${mountpoint} was mounted again but is still read-only: the kernel found errors on the drive while mounting it. Check the drive (Repair offers the check) before anything writes to it again.${started.length ? ` ${listOf(started)} ${started.length === 1 ? "was" : "were"} started again and can read it.` : ""}`);
  }
  if (sharing.clients.length || sharing.shares.length) log?.(`File sharing: ${sharing.clients.length ? `${listOf(sharing.clients)} reconnect${sharing.clients.length === 1 ? "s" : ""} by ${sharing.clients.length === 1 ? "itself" : "themselves"}` : "clients reconnect by themselves"}`, "stdout");
  return {
    remounted: true, name: drive.name, mountpoint, source: after.source, previousSource: before?.source ?? null,
    deviceChanged: Boolean(before && before.source !== after.source), readOnlyBefore: Boolean(before?.readOnly), detachedLazily,
    stopped, restarted: started, restartFailed, sharingClosedFor: sharing.clients, shares: sharing.shares, rewritten,
  };
}

const defaultRemountFiles = { readFile, readable: (target) => readdir(target).then(() => true, () => false) };

/**
 * Reconnect a managed drive (Repair's "Reconnect the drive"): the drive that dropped off USB and
 * came back under another name, the one the kernel turned read-only after errors, and the one that
 * is simply busy - apps and file-sharing clients included. See remountDrive.
 */
export async function storageRemount({ name } = {}, { run = fixedRun, log = null, files = defaultRemountFiles, sleep = pause, processes = undefined } = {}) {
  const drive = await managedDrive(name, files);
  return remountDrive(drive, { run, log, files, sleep, processes });
}

const defaultCheckFiles ={ readFile, readable: (target) => readdir(target).then(() => true, () => false), exists: (file) => access(file).then(() => true, () => false) };
const readOnlyCheckers = (device) => ({ exfat: [binaries.fsckExfat, ["-n", device]], ext4: [binaries.e2fsck, ["-fn", device]], ext3: [binaries.e2fsck, ["-fn", device]], ext2: [binaries.e2fsck, ["-fn", device]], vfat: [binaries.fsckFat, ["-n", device]] });

/**
 * Mount a drive again from its fstab entry in PID 1's namespace, and prove it is there from the
 * device expected before anything is started on it. mount can exit 0 having mounted nothing - a
 * nofail entry whose device it cannot find is skipped without an error, and just after a checker
 * has written to the drive udev can still be reading it again - so a mount that is not there is
 * tried once more, a second later. One from another device is not retried.
 */
async function mountAgain(run, mountpoint, { sources, log, sleep }) {
  let found = null;
  for (let tries = 1; tries <= 2; tries += 1) {
    log?.(`$ mount ${mountpoint}`, "stdout");
    const mounted = await run(binaries.mount, mountArgs(mountpoint), { timeout: 120_000 });
    found = await mountedFrom(run, mountpoint, sources);
    if (found.ok || found.mount) return found;
    if (!mounted.ok) found = { ...found, reason: `mount failed: ${tail(mounted.stderr) || "it gave no reason"}` };
    if (tries === 1) {
      log?.(`${mountpoint} is not mounted (${found.reason}); trying once more`, "stderr");
      await sleep(1_000);
    }
  }
  return found;
}

/**
 * Do `work` with a managed drive unmounted from the host, the way an operator would by hand: the
 * containers using it stopped, file-sharing clients let go of it, and everything mounted and
 * started again afterwards whatever `work` did. `prepare` runs before anything is stopped, so a
 * refusal there costs nothing.
 *
 * The apps are started again only once the drive is proven back (mountAgain). They used to be
 * started whatever mount said, and one started on a drive that did not come back binds the empty
 * folder underneath and writes to the system disk. Left stopped, they are named.
 */
async function withDriveUnmounted(name, { verb, purpose, prepare, work }, { run, log, files, sleep, processes }) {
  assertPlainMountName(name);
  const content = await files.readFile(fstabPath, "utf8");
  const entry = parseManagedFstab(content).find((row) => row.name === name);
  if (!entry) throw new Error(`${name} is not a BoxPilot-managed mount`);
  const [entrySource = "", mountpoint = ""] = entry.line.trim().split(/\s+/);
  if (mountpoint !== mountpointFor(name)) throw new Error(`The ${name} entry is not a drive mounted at ${mountpointFor(name)}; nothing was changed`);
  const where = await run(binaries.findmnt, ["-n", "-o", "SOURCE,FSTYPE,MAJ:MIN", mountpoint], { timeout: 15_000 });
  const [device, fstype, majMin] = where.ok ? where.stdout.trim().split(/\s+/) : [];
  if (!device) throw new Error(`${mountpoint} is not mounted, so there is nothing to ${verb} yet. Reconnect the drive first.`);
  const drive = { mountpoint, device, fstype };
  const prepared = await prepare(drive);

  const bound = await containersBoundTo(run, mountpoint);
  for (const container of bound) { log?.(`$ docker stop ${container}`, "stdout"); await run(binaries.docker, ["stop", container], { timeout: 120_000 }); }
  const started = []; const restartFailed = [];
  const restart = async () => {
    for (const container of bound) {
      log?.(`$ docker start ${container}`, "stdout");
      const result = await run(binaries.docker, ["start", container], { timeout: 120_000 });
      if (result.ok) started.push(container); else { restartFailed.push(container); log?.(`could not start ${container}: ${tail(result.stderr)}`, "stderr"); }
    }
  };
  const unmounted = await unmountFromHost(mountpoint, { run, log, files, sleep });
  if (!unmounted.ok) {
    const holders = majMin ? await processesUsing(majMin, processes) : [];
    await restart();
    throw new Error(`${mountpoint} is still in use${holders.length ? ` by ${holders.map((holder) => `${holder.command} (${holder.pid})`).join(", ")}` : ""}, so nothing was done to it: ${tail(unmounted.result.stderr)}. Stop whatever is using it - a copy in progress, a shell sitting in it - and try again.`);
  }
  let outcome;
  let failure = null;
  try {
    outcome = await work({ ...drive, prepared });
  } catch (error) {
    failure = error;
  }
  const back = await mountAgain(run, mountpoint, { sources: [device, (await deviceFor(run, entrySource)).device], log, sleep });
  if (back.ok) await restart();
  else log?.(`${mountpoint} did not mount again: ${back.reason}`, "stderr");
  const notBack = back.ok ? "" : `${mountpoint} did not mount again after it was unmounted ${purpose}: ${String(back.reason).replace(/[.\s]+$/, "")}.${bound.length
    ? ` ${listOf(bound)} ${bound.length === 1 ? "was" : "were"} left stopped, so nothing writes into the empty folder under it; reconnect the drive from Repair, then start ${bound.length === 1 ? "it" : "them"} again.`
    : " Reconnect the drive from Repair."}`;
  if (failure) throw back.ok ? failure : new Error(`${String(failure.message).replace(/[.\s]+$/, "")}. ${notBack}`);
  if (!back.ok) throw new Error(notBack);
  return { ...drive, outcome, restarted: started, restartFailed, sharingClosedFor: unmounted.clients ?? [] };
}

/**
 * Check a drive's filesystem without changing a byte of it.
 *
 * After a drive drops off USB and comes back, the honest next step is a check before anything
 * writes to it again - exFAT in particular keeps its whole directory table in one place. A check
 * while mounted read-write can report damage that is only a write in progress, so the drive is
 * unmounted for it: the containers bound to it are stopped first and started again afterwards,
 * the way an operator would do it by hand. The checker runs with -n: it reports, it never repairs.
 * Repairing is a separate decision with the report in hand.
 */
export async function storageCheck({ name } = {}, { run = fixedRun, log = null, files = defaultCheckFiles, sleep = pause, processes = undefined } = {}) {
  const done = await withDriveUnmounted(name, {
    verb: "check",
    purpose: "for the check",
    prepare: async ({ mountpoint, device, fstype }) => {
      const checker = readOnlyCheckers(device)[fstype];
      if (!checker) throw new Error(`BoxPilot has no read-only checker for ${fstype} filesystems`);
      // Before anything is stopped or unmounted: a checker that is not installed would only be found
      // missing with the drive already detached. Ubuntu does not install fsck.exfat by default.
      if (!(await files.exists(checker[0]))) {
        throw new Error(`${path.basename(checker[0])} is not installed, so ${mountpoint} was not checked; nothing was stopped or unmounted. Install the drive check tools from Repair first.`);
      }
      return checker;
    },
    work: async ({ device, fstype, prepared: checker }) => {
      // The dirty mark, read while nothing has the drive mounted: the only time it means anything.
      const flags = fstype === "exfat" ? exfatVolumeFlags(await (files.bootSector ?? readBootSector)(device)) : null;
      log?.(`$ ${path.basename(checker[0])} ${checker[1].join(" ")}`, "stdout");
      const checked = await run(checker[0], checker[1], { timeout: 25 * 60_000, onLine: (line, stream) => log?.(line, stream) });
      return { checked, markedDirty: flags ? flags.dirty : null, checker: path.basename(checker[0]) };
    },
  }, { run, log, files, sleep, processes });
  const { mountpoint, device, fstype, outcome: { checked, markedDirty, checker } } = done;
  // fsck exit codes: 0 clean, 1 errors found (and would have been corrected without -n), 4 errors left, 8 operational error.
  const clean = checked.ok;
  const summary = (checked.stdout + "\n" + checked.stderr).split("\n").filter(Boolean).slice(-4).join(" ").slice(0, 400);
  log?.(clean ? `${mountpoint} checked clean` : `${mountpoint}: the checker found problems (exit ${checked.code})`, clean ? "stdout" : "stderr");
  // fsck.exfat -n calls a consistent volume clean whether or not it carries the mark, and Linux
  // keeps a mark it found at mount (tests/ubuntu/drive-shutdown-order.sh, part 3), so without
  // this the check says "clean" and the kernel goes on warning at every mount, with nothing to
  // say which of them to believe.
  if (markedDirty) log?.(`${mountpoint} is still marked as not properly unmounted. ${clean ? "The folder table is consistent, so the mark is left over from an earlier drop or unclean shutdown; Repair offers to clear it. " : ""}Linux keeps that mark until a repairing check clears it, and says "Volume was not properly unmounted" every time the drive is mounted until then; this check only reads, so it leaves the mark as it is.`, "stderr");
  return { checked: true, name, mountpoint, device, fstype, checker, clean, markedDirty, exitCode: checked.code, summary, restarted: done.restarted, restartFailed: done.restartFailed, checkedAt: new Date().toISOString() };
}

/**
 * Clear the exFAT "not properly unmounted" mark from a drive whose folder table is consistent.
 *
 * Linux keeps that mark once it has seen it (exfatVolumeFlags), so a drive that dropped once
 * warns at every mount for good, and the read-only check cannot clear it. A repairing run does,
 * and on a consistent volume the mark is all it changes - so this runs the read-only pass first,
 * with the drive unmounted, and only when that finds nothing wrong runs `fsck.exfat -y`. A volume
 * with real damage is refused: repairing it is a decision to make with that report in hand.
 */
export async function storageClearMark({ name } = {}, { run = fixedRun, log = null, files = defaultCheckFiles, sleep = pause, processes = undefined } = {}) {
  const done = await withDriveUnmounted(name, {
    verb: "clear",
    purpose: "to clear its mark",
    prepare: async ({ mountpoint, fstype }) => {
      if (fstype !== "exfat") throw new Error(`${mountpoint} is ${fstype}; only exFAT keeps a not-properly-unmounted mark this way, so there is nothing to clear`);
      if (!(await files.exists(binaries.fsckExfat))) throw new Error(`fsck.exfat is not installed, so nothing was stopped or unmounted. Install the drive check tools from Repair first.`);
    },
    work: async ({ mountpoint, device }) => {
      const read = async () => exfatVolumeFlags(await (files.bootSector ?? readBootSector)(device));
      const before = await read();
      if (!before?.dirty) { log?.(`${mountpoint} is not marked; nothing to clear`, "stdout"); return { wasMarked: false, cleared: false }; }
      log?.(`$ fsck.exfat -n ${device}`, "stdout");
      const checked = await run(binaries.fsckExfat, ["-n", device], { timeout: 25 * 60_000, onLine: (line, stream) => log?.(line, stream) });
      if (!checked.ok) throw new Error(`the read-only check found problems (exit ${checked.code}), so the mark was left and nothing was changed: ${tail(`${checked.stdout}\n${checked.stderr}`)}. Repairing a damaged volume is a separate decision.`);
      log?.(`$ fsck.exfat -y ${device}`, "stdout");
      const repaired = await run(binaries.fsckExfat, ["-y", device], { timeout: 25 * 60_000, onLine: (line, stream) => log?.(line, stream) });
      const after = await read();
      if (!repaired.ok || after?.dirty) throw new Error(`fsck.exfat -y did not clear the mark (exit ${repaired.code}): ${tail(`${repaired.stdout}\n${repaired.stderr}`)}`);
      log?.(`Cleared the mark on ${mountpoint}; the folder table was consistent, so the mark is all that changed`, "stdout");
      return { wasMarked: true, cleared: true };
    },
  }, { run, log, files, sleep, processes });
  return { name, mountpoint: done.mountpoint, device: done.device, ...done.outcome, restarted: done.restarted, restartFailed: done.restartFailed, clearedAt: new Date().toISOString() };
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const underPath = (child, parent) => child === parent || child.startsWith(`${parent.replace(/\/+$/, "")}/`);

/** Samba shares that reach into a mount: served from a folder on it, or from a folder above it. */
export function sharesOnMount(smbConf, mountpoint) {
  return parseSmbConf(smbConf).shares.filter((share) => underPath(share.path, mountpoint) || underPath(mountpoint, share.path)).map((share) => share.name);
}

/** Who is connected to which share, from `smbstatus -S --json`, or its table when JSON is not on offer. */
export async function smbConnections(run) {
  // --json is Samba 4.17's. 4.15 (Ubuntu 22.04) refuses it, "Invalid option --json: unknown
  // option", and prints nothing on stdout, so the table is asked for then.
  const asJson = await run(binaries.smbstatus, ["-S", "--json"], { timeout: 15_000 });
  if (asJson.ok && asJson.stdout.trim().startsWith("{")) return parseSmbstatusShares(asJson.stdout);
  const table = await run(binaries.smbstatus, ["-S"], { timeout: 15_000 });
  return table.ok ? parseSmbstatusShares(table.stdout) : [];
}

/** The service and machine of each connection in smbstatus's JSON, or in its table (the same layout in 4.15, 4.19 and 4.23). */
export function parseSmbstatusShares(text) {
  const raw = String(text ?? "").trim();
  try {
    const parsed = JSON.parse(raw);
    return Object.values(parsed?.tcons ?? {}).map((tcon) => ({ service: String(tcon?.service ?? ""), machine: String(tcon?.machine ?? "") })).filter((row) => row.service && row.machine);
  } catch {
    return raw.split("\n").map((line) => line.match(/^(.+?)\s+(\d+)\s+(\S+)\s+\w{3}\s/)).filter(Boolean).map(([, service, , machine]) => ({ service: service.trim(), machine }));
  }
}

/**
 * Unmount a drive in the host's namespace, getting file-sharing clients off it first when they
 * are what holds it.
 *
 * A Windows PC with the share mapped as a drive keeps directory handles open on it, and Explorer
 * reconnects within about a second of `smbcontrol close-share`, so closing once and then
 * unmounting loses the race. Closing and unmounting straight after, up to thirty times, won it on
 * the first try on the owner's server. Once the drive is unmounted a client that reconnects sees
 * only the empty folder underneath, which holds nothing.
 *
 * `unmount` is the one attempt, repeated after each close: umount -N for a drive, and for a
 * network share the stop of its mount unit (server/tasks/shares.mjs), with `command` saying which.
 */
export async function unmountFromHost(mountpoint, { run = fixedRun, log = null, files = { readFile }, sleep = pause, tries = 30, command = `umount ${mountpoint}`, unmount = () => run(binaries.umount, mountArgs(mountpoint), { timeout: 60_000 }) } = {}) {
  log?.(`$ ${command}`, "stdout");
  const first = await unmount();
  if (first.ok) return { ok: true, result: first, clients: [] };
  const shares = sharesOnMount(await files.readFile(smbConfPath, "utf8").catch(() => ""), mountpoint);
  if (!shares.length) return { ok: false, result: first, clients: [] };
  const clients = [...new Set((await smbConnections(run)).filter((row) => shares.includes(row.service)).map((row) => row.machine))];
  let result = first;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    for (const share of shares) await run(binaries.smbcontrol, ["smbd", "close-share", share], { timeout: 10_000 });
    result = await unmount();
    if (result.ok) {
      log?.(`Closed file-sharing connections${clients.length ? ` from ${clients.join(", ")}` : ""} to ${shares.join(", ")} so ${mountpoint} could be unmounted${attempt > 1 ? ` (try ${attempt})` : ""}`, "stdout");
      return { ok: true, result, clients, shares };
    }
    await sleep(300);
  }
  return { ok: false, result, clients, shares };
}

/** glibc's makedev, which is how Node reports st_dev. */
const makedev = (major, minor) => (major % 4096) * 256 + (minor % 256) + Math.floor(minor / 256) * 1_048_576 + Math.floor(major / 4096) * 2 ** 32;

/**
 * Processes with a file, a working directory or a root on the filesystem `majMin` ("8:2"), in any
 * mount namespace - what `fuser -m` reports, from /proc, since fuser (psmisc) is not on every
 * server. Compared by device number, so a path's spelling in another namespace does not matter.
 */
export async function processesUsing(majMin, { proc = "/proc", fs = { readdir, stat }, maxFiles = 4096 } = {}) {
  const [major, minor] = String(majMin ?? "").split(":").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return [];
  const device = makedev(major, minor);
  const onDevice = (target) => fs.stat(target).then((info) => Number(info.dev) === device, () => false);
  const found = [];
  for (const entry of await fs.readdir(proc).catch(() => [])) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const base = `${proc}/${entry}`;
    let holds = (await onDevice(`${base}/cwd`)) || (await onDevice(`${base}/root`));
    if (!holds) {
      const descriptors = (await fs.readdir(`${base}/fd`).catch(() => [])).slice(0, maxFiles);
      for (const descriptor of descriptors) if (await onDevice(`${base}/fd/${descriptor}`)) { holds = true; break; }
    }
    if (holds) found.push({ pid: Number(entry), command: (await readFile(`${base}/comm`, "utf8").catch(() => "?")).trim() });
  }
  return found;
}

/** The first sector of a block device, read-only, or null when it cannot be read. */
export async function readBootSector(device) {
  let handle;
  try {
    handle = await open(device, "r");
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    return bytesRead === 512 ? buffer : null;
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

/**
 * The exFAT boot sector's VolumeFlags. VolumeDirty (bit 1) is what the kernel reads at mount to
 * print "Volume was not properly unmounted". It is set by the first write and cleared by a clean
 * unmount (not by sync) - unless it was already set when the volume was mounted: then Linux leaves
 * it set, as the exFAT specification asks, until a checker has repaired the volume. So a drive that
 * once dropped off mid-write reports an unclean unmount at every mount, however cleanly it has been
 * unmounted since. Measured on real exFAT in tests/ubuntu/drive-shutdown-order.sh.
 */
export function exfatVolumeFlags(bootSector) {
  if (!bootSector || bootSector.length < 512 || bootSector.toString("latin1", 3, 11) !== "EXFAT   ") return null;
  const flags = bootSector[106] | (bootSector[107] << 8);
  return { dirty: (flags & 0x2) !== 0, mediaFailure: (flags & 0x4) !== 0 };
}

/** Running containers with a bind at or under the mountpoint. A prefix is not a parent: /mnt/x-backup is not under /mnt/x. */
export async function containersBoundTo(run, mountpoint) {
  const ids = await run(binaries.docker, ["ps", "-q"], { timeout: 15_000 });
  if (!ids.ok || !ids.stdout.trim()) return [];
  const listed = await run(binaries.docker, ["inspect", "--format", "{{.Name}}\t{{range .Mounts}}{{.Source}}\t{{end}}", ...ids.stdout.trim().split(/\s+/)], { timeout: 30_000 });
  if (!listed.ok) return [];
  const under = (source) => source === mountpoint || source.startsWith(`${mountpoint}/`);
  return listed.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")).filter(([, ...sources]) => sources.some(under)).map(([name]) => name.replace(/^\//, ""));
}
