import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

/**
 * Root-side storage tasks executed by scripts/boxpilot-run.mjs inside boxpilot-run@.service.
 * Mount operations must run in the host mount namespace (the helper's sandbox has its own),
 * and /etc/fstab is writable only here. Every fstab entry BoxPilot adds sits under a
 * `# boxpilot:<name>` marker line and carries `nofail`, so a missing disk never blocks boot.
 */

export const mountNamePattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
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

/** Mount a filesystem by UUID at /mnt/<name> with a verified, nofail fstab entry. */
export const appUserId = 1000;
export const permissionlessFilesystems = Object.freeze(["exfat", "vfat", "ntfs", "ntfs3", "msdos"]);

export async function storageMount({ uuid, name, fstype = "auto", readOnly = false, appWritable = false, uid = appUserId, gid = appUserId } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, mkdir } } = {}) {
  if (typeof uuid !== "string" || !uuidPattern.test(uuid)) throw new Error("UUID is invalid");
  if (typeof name !== "string" || !mountNamePattern.test(name)) throw new Error("Name must be lower-case letters, digits, and hyphens (max 32)");
  if (typeof fstype !== "string" || !/^[a-z0-9]{2,12}$/.test(fstype)) throw new Error("Filesystem type is invalid");
  if (![uid, gid].every((value) => Number.isInteger(value) && value >= 0 && value <= 65_535)) throw new Error("Owner uid/gid are invalid");
  const device = await run(binaries.blkid, ["-U", uuid], { timeout: 15_000 });
  if (!device.ok || !device.stdout.trim()) throw new Error(`No filesystem with UUID ${uuid} was found`);
  const dev = device.stdout.trim();
  assertNotProtected(dev, await deviceTree(run, dev));
  const mountpoint = `/mnt/${name}`;
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
  const options = readOnly ? "ro,nofail"
    : giveToApps && permissionless ? `rw,nofail,uid=${uid},gid=${gid}`
      : "defaults,nofail";
  const previous = await appendFstabEntry({ run, files, log }, name, `UUID=${uuid} ${mountpoint} ${entryFstype} ${options} 0 ${fsckPass}`);
  await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 });
  log?.(`$ mount ${mountpoint}`, "stdout");
  const mountResult = await run(binaries.mount, [mountpoint], { timeout: 60_000 });
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
  if (typeof name !== "string" || !mountNamePattern.test(name)) throw new Error("Name is invalid");
  const content = await files.readFile(fstabPath, "utf8");
  const without = removeManagedEntry(content, name);
  if (without === null) throw new Error(`${name} is not a BoxPilot-managed mount; edit fstab yourself for entries you created`);
  const mountpoint = `/mnt/${name}`;
  const mounted = await run(binaries.findmnt, ["-n", mountpoint], { timeout: 15_000 });
  if (mounted.ok && mounted.stdout.trim()) {
    log?.(`$ umount ${mountpoint}`, "stdout");
    const result = await run(binaries.umount, [mountpoint], { timeout: 60_000 });
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
  const deferred = /next activation|Can't merge.*open|will merge/i.test(output) || true;
  log?.(deferred ? "The merge is scheduled; reboot to apply it. The snapshot is consumed by the merge." : "Merged", "stdout");
  return { rollbackScheduled: true, path: snapshot, rebootRequired: deferred, detail: output.split("\n").filter(Boolean).slice(-2).join(" ") };
}

/**
 * Re-attach a managed mount to whatever device now carries its UUID, keeping the fstab entry.
 *
 * A USB drive that drops off the bus for a moment comes back under a different kernel name, and the
 * old mount stays in the table pointing at a device that no longer exists. Nothing reports an error:
 * `findmnt` still lists it, `df` still prints the size it cached, and only an actual read returns
 * EIO. Anything serving that folder — a network share, an app's bind mount — quietly serves nothing.
 * Unmounting (lazily, because a dead device will not release cleanly) and mounting again makes fstab
 * resolve the UUID afresh and land on the device that is really there.
 */
export async function storageRemount({ name } = {}, { run = fixedRun, log = null, files = { readFile, readable: (target) => readdir(target).then(() => true, () => false) } } = {}) {
  if (typeof name !== "string" || !mountNamePattern.test(name)) throw new Error("Name is invalid");
  const content = await files.readFile(fstabPath, "utf8");
  const entry = parseManagedFstab(content).find((row) => row.name === name);   // parseManagedFstab returns { name, line, markerIndex }
  if (!entry) throw new Error(`${name} is not a BoxPilot-managed mount; remount it yourself for entries you created`);
  // The marker owns whatever line follows it, and not every managed entry is a mount under /mnt:
  // the swap file's marker is `# boxpilot:swap` over an entry whose target is `none`. Taking the
  // mountpoint from the entry itself, rather than assuming /mnt/<name>, is what keeps this op from
  // unmounting a path the entry has nothing to do with.
  const mountpoint = entry.line.trim().split(/\s+/)[1] ?? "";
  if (mountpoint !== `/mnt/${name}`) throw new Error(`The ${name} entry is not a drive mounted at /mnt/${name}; nothing was changed`);

  const sourceOf = async () => {
    const result = await run(binaries.findmnt, ["-n", "-o", "SOURCE", mountpoint], { timeout: 15_000 });
    return result.ok ? result.stdout.trim() || null : null;
  };
  const before = await sourceOf();
  if (before) {
    log?.(`$ umount ${mountpoint}`, "stdout");
    const plain = await run(binaries.umount, [mountpoint], { timeout: 60_000 });
    if (!plain.ok) {
      // A refused umount is usually EBUSY — something is still using a healthy folder — and lazily
      // detaching that splits the writers: whoever holds the old filesystem keeps writing into one
      // no path reaches any more, and those writes are lost silently. So only detach lazily when the
      // mount is actually dead. The device-name test cannot tell: a drive that dropped and came back
      // reclaims the same name (/dev/sdb2 → /dev/sdb2), so the node exists again while the old mount
      // is still broken. What is unambiguous is whether the mount still reads: a dead filesystem
      // returns an I/O error on the very listing that was empty in File Explorer, a live one does not.
      const mountReadable = await files.readable(mountpoint);
      if (mountReadable) throw new Error(`${mountpoint} is in use, so it was left alone: ${tail(plain.stderr)}. Stop whatever is using it — an app with that folder mounted, or the file server — and try again.`);
      log?.(`${mountpoint} is not readable, so its drive is gone; detaching lazily`, "stderr");
      const lazy = await run(binaries.umount, ["-l", mountpoint], { timeout: 60_000 });
      if (!lazy.ok) throw new Error(`Could not detach ${mountpoint}: ${tail(lazy.stderr)}`);
    }
  }
  log?.(`$ mount ${mountpoint}`, "stdout");
  const mounted = await run(binaries.mount, [mountpoint], { timeout: 120_000 });
  if (!mounted.ok) throw new Error(`Could not mount ${mountpoint} again: ${tail(mounted.stderr)}. The drive may be unplugged; check it is connected and try again.`);
  const after = await sourceOf();
  if (!after) throw new Error(`${mountpoint} did not come back after remounting. The drive may be unplugged.`);
  log?.(`${mountpoint} is mounted from ${after}${before && before !== after ? ` (it was ${before}, which no longer exists)` : ""}`, "stdout");
  return { remounted: true, name, mountpoint, source: after, previousSource: before, deviceChanged: Boolean(before && before !== after) };
}
