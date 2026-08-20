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
};

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

async function appendFstabEntry({ run, files, log }, name, entry) {
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
  const tree = await run(binaries.lsblk, ["-J", "-o", "PATH,TYPE,RO,MOUNTPOINTS", device], { timeout: 15_000 });
  if (!tree.ok) throw new Error(`${device} was not found`);
  let nodes = [];
  try {
    const parsed = JSON.parse(tree.stdout);
    const flatten = (list) => list.flatMap((node) => [node, ...flatten(node.children ?? [])]);
    nodes = flatten(parsed.blockdevices ?? []);
  } catch { throw new Error("Could not read the device layout"); }
  if (nodes.some((node) => node.ro)) throw new Error(`${device} is read-only`);
  const mountedAt = nodes.flatMap((node) => (node.mountpoints ?? []).filter(Boolean));
  if (mountedAt.length) throw new Error(`${device} is in use (mounted at ${mountedAt.join(", ")}); unmount everything on it first`);
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
