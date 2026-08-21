import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  rm: "/usr/bin/rm",
  lvextend: "/usr/sbin/lvextend",
};

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
export async function storageMount({ uuid, name, fstype = "auto", readOnly = false } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, mkdir } } = {}) {
  if (typeof uuid !== "string" || !uuidPattern.test(uuid)) throw new Error("UUID is invalid");
  if (typeof name !== "string" || !mountNamePattern.test(name)) throw new Error("Name must be lower-case letters, digits, and hyphens (max 32)");
  if (typeof fstype !== "string" || !/^[a-z0-9]{2,12}$/.test(fstype)) throw new Error("Filesystem type is invalid");
  const device = await run(binaries.blkid, ["-U", uuid], { timeout: 15_000 });
  if (!device.ok || !device.stdout.trim()) throw new Error(`No filesystem with UUID ${uuid} was found`);
  assertNotProtected(device.stdout.trim(), await deviceTree(run, device.stdout.trim()));
  const mountpoint = `/mnt/${name}`;
  const mounted = await run(binaries.findmnt, ["-n", mountpoint], { timeout: 15_000 });
  if (mounted.ok && mounted.stdout.trim()) throw new Error(`${mountpoint} is already mounted`);
  await files.mkdir(mountpoint, { recursive: true, mode: 0o755 });
  const options = readOnly ? "ro,nofail" : "defaults,nofail";
  const previous = await appendFstabEntry({ run, files, log }, name, `UUID=${uuid} ${mountpoint} ${fstype} ${options} 0 2`);
  await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 });
  log?.(`$ mount ${mountpoint}`, "stdout");
  const mountResult = await run(binaries.mount, [mountpoint], { timeout: 60_000 });
  if (!mountResult.ok) {
    await files.writeFile(fstabPath, previous);
    await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 }).catch(() => {});
    throw new Error(`mount failed and the fstab entry was removed again: ${mountResult.stderr.split("\n").slice(-2).join(" ")}`);
  }
  const check = await run(binaries.findmnt, ["-n", "-b", "-o", "SOURCE,FSTYPE,SIZE", mountpoint], { timeout: 15_000 });
  return { mounted: true, name, mountpoint, uuid, device: device.stdout.trim(), detail: check.stdout.trim() || null, persistent: true };
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
export async function storageLvmExtend({ path: volume } = {}, { run = fixedRun, log = null } = {}) {
  if (typeof volume !== "string" || !logicalVolumePattern.test(volume)) throw new Error("Logical volume path is invalid");
  const nodes = await deviceTree(run, volume);
  const node = nodes.find((entry) => entry.path === volume);
  if (!node || node.type !== "lvm") throw new Error(`${volume} is not an LVM logical volume`);
  if (!["ext4", "ext3", "ext2", "xfs"].includes(node.fstype ?? "")) throw new Error(`${volume} holds ${node.fstype ?? "no filesystem"}; only ext4 and xfs can be grown online`);
  const mountpoint = (node.mountpoints ?? []).filter(Boolean)[0] ?? null;
  if (!mountpoint) throw new Error(`${volume} is not mounted; mount it first so the filesystem can be grown online`);
  const before = await run(binaries.findmnt, ["-n", "-b", "-o", "SIZE,AVAIL", mountpoint], { timeout: 15_000 });
  log?.(`$ lvextend -r -l +100%FREE ${volume}`, "stdout");
  const result = await run(binaries.lvextend, ["-r", "-l", "+100%FREE", volume], { timeout: 10 * 60_000, onLine: log ?? undefined });
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
