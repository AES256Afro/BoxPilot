/**
 * "Check and clear the boot partition's mark" (root side, boxpilot-run@).
 *
 * After the power cut of 2026-09-29 the owner's kernel said, at every boot since, "FAT-fs
 * (nvme0n1p1): Volume was not properly unmounted. Some data may be corrupt. Please run fsck." That
 * is /boot/efi, the small FAT partition the computer starts from. Linux sets a mark on a FAT
 * filesystem when it mounts it and clears it when it unmounts it cleanly; a power cut leaves it
 * set, and Linux never clears a mark it found set, so the warning repeats until a repairing check
 * does. Ubuntu's boot-time fsck would clear it, but only when fsck.fat is installed.
 *
 * The mark cannot be read while the partition is mounted - the kernel keeps it set on a mounted
 * FAT filesystem - so the check needs it unmounted:
 *
 *   1. nothing is installing packages or updating the bootloader (they write there), and the
 *      partition is an ordinary mount, not an automount;
 *   2. it is unmounted in the host's namespace, which fails, and changes nothing, if anything has a
 *      file open on it;
 *   3. `fsck.fat -n` reads it without writing. Anything beyond the mark (and the backup boot
 *      sector differing in that one bit, which is how the mark looks from there) stops here: it is
 *      mounted again as it was;
 *   4. `fsck.fat -a` clears the mark, and `fsck.fat -n` must then find nothing at all;
 *   5. it is mounted again, from fstab, and read.
 *
 * Whatever happens after the unmount, it is mounted again before the task ends.
 */
import { access, readdir, readFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";
import { inspectPackageLocks } from "../package-health.mjs";
import { hostNamespace } from "./storage.mjs";

/** Where Ubuntu and systemd mount the EFI system partition, most usual first. */
export const bootPartitionTargets = Object.freeze(["/boot/efi", "/efi", "/boot"]);
export const fatTypes = Object.freeze(["vfat", "msdos", "fat"]);

const binaries = {
  findmnt: process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  mount: "/usr/bin/mount",
  umount: "/usr/bin/umount",
  fsckFat: "/usr/sbin/fsck.fat",
};
/** Programs that write to the boot partition in the course of their work. */
export const bootWriters = Object.freeze(["dpkg", "apt", "apt-get", "aptitude", "unattended-upgr", "grub-install", "update-grub", "bootctl", "kernel-install", "fwupdmgr", "fwupdtool", "shim-install"]);
const tail = (text) => String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(-4).join(" / ");

/**
 * What `fsck.fat -n` said, and whether the not-properly-unmounted mark is all of it.
 *
 * The mark is FAT32's state byte at offset 0x41 (0x25 on FAT16). The kernel sets it in the boot
 * sector only, never in the backup copy, so a marked FAT32 partition also reports "differences
 * between boot sector and its backup" at 65:01/00: that difference is the mark too. Every other line
 * - a free-space count that is off, a lost cluster, a bad directory entry - is more than the mark.
 */
export function parseFsckFat(output) {
  const lines = String(output ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  let dirty = false;
  let backupDiffers = false;
  let inDifferences = false;
  let summary = null;
  const differences = [];
  const other = [];
  for (const line of lines) {
    if (/^(fsck\.(fat|vfat|msdos)|dosfsck) \d/i.test(line)) { inDifferences = false; continue; }
    if (/: \d+ files?, \d+\/\d+ clusters$/.test(line)) { summary = line; inDifferences = false; continue; }
    if (/Dirty bit is set/i.test(line)) { dirty = true; inDifferences = false; continue; }
    if (/^There are differences between boot sector and its backup/i.test(line)) { backupDiffers = true; inDifferences = true; continue; }
    if (/^This is mostly harmless\. Differences:/i.test(line)) { inDifferences = true; continue; }
    const offsets = inDifferences ? [...line.matchAll(/(\d+):([0-9a-f]{2})\/([0-9a-f]{2})/gi)] : [];
    if (offsets.length && line.replace(/(\d+):([0-9a-f]{2})\/([0-9a-f]{2})/gi, "").replace(/[\s,]/g, "") === "") {
      for (const [, offset, original, backup] of offsets) differences.push({ offset: Number(offset), original: Number.parseInt(original, 16), backup: Number.parseInt(backup, 16) });
      continue;
    }
    inDifferences = false;
    if (/^(Automatically removing dirty bit|Not automatically fixing this|Leaving filesystem unchanged|Performing changes|Checking we can access the last sector of the filesystem)\.?$/i.test(line)) continue;
    other.push(line);
  }
  const backupIsTheMark = backupDiffers && differences.length > 0 && differences.every((entry) => entry.offset === 65 && (entry.original & 1) === 1 && (entry.original ^ entry.backup) === 1);
  const beyond = [...other, ...(backupDiffers && !backupIsTheMark ? ["the boot sector differs from its backup copy in more than the mark"] : [])];
  return { dirty, backupDiffers, backupIsTheMark, differences, summary, other, beyond, onlyTheMark: dirty && beyond.length === 0, clean: !dirty && beyond.length === 0 && !backupDiffers };
}

/** What PID 1's namespace has mounted exactly at `target`, bottom first. */
export async function hostMountsAt(run, target) {
  const result = await run(binaries.findmnt, ["--task", "1", "-n", "-r", "-o", "SOURCE,FSTYPE,OPTIONS", "--mountpoint", target], { timeout: 15_000 });
  if (!result.ok) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [source, fstype = null, options = ""] = line.split(/\s+/);
    // findmnt -r escapes spaces and the like as \x20.
    return { source: source.replace(/\\x([0-9a-f]{2})/gi, (_all, hex) => String.fromCharCode(Number.parseInt(hex, 16))), fstype, options };
  });
}

/** Processes named as a boot-partition writer, from /proc/<pid>/comm. */
export async function bootWritersRunning({ list = () => readdir("/proc"), read = (file) => readFile(file, "utf8") } = {}) {
  const pids = (await list().catch(() => [])).filter((entry) => /^\d+$/.test(entry));
  const names = await Promise.all(pids.map((pid) => read(`/proc/${pid}/comm`).then((name) => ({ pid: Number(pid), name: name.trim() }), () => null)));
  return names.filter((entry) => entry && bootWriters.includes(entry.name));
}

const defaultFiles = {
  exists: (file) => access(file).then(() => true, () => false),
  readdir: (directory) => readdir(directory),
};

export async function clearBootPartitionMark(_parameters = {}, { run = fixedRun, log = null, files = defaultFiles, targets = bootPartitionTargets, writers = bootWritersRunning, locks = inspectPackageLocks, now = () => new Date() } = {}) {
  const say = (line) => log?.(line, "stdout");
  if (!(await files.exists(binaries.fsckFat))) throw new Error("fsck.fat is not installed (it comes with the dosfstools package), so nothing was unmounted. Install it first; Repair offers it.");

  // 1. Which partition, and that it is safe to take away for a minute.
  let found = null;
  for (const target of targets) {
    const mounts = await hostMountsAt(run, target);
    if (!mounts.length) continue;
    if (mounts.some((mount) => mount.fstype === "autofs")) throw new Error(`${target} is mounted on demand by systemd (an automount), which would mount it again the moment anything looks at it. Nothing was changed. Check it by hand: sudo systemctl stop ${target.slice(1).replaceAll("/", "-")}.automount, then sudo fsck.fat -a on its partition, then start the automount again.`);
    const top = mounts.at(-1);
    if (fatTypes.includes(top.fstype)) { found = { target, ...top }; break; }
  }
  if (!found) throw new Error(`No FAT boot partition is mounted at ${targets.join(", ")}, so there is nothing to check here. Nothing was changed.`);
  const { target, source: device, options } = found;
  if (!/^\/dev\/[A-Za-z0-9/_.-]+$/.test(device)) throw new Error(`${target} is mounted from ${device}, which is not a partition this can check. Nothing was changed.`);
  say(`${target} is ${found.fstype} on ${device} (${options})`);
  const running = await writers();
  if (running.length) throw new Error(`${[...new Set(running.map((entry) => entry.name))].join(", ")} ${running.length === 1 ? "is" : "are"} running, and may be writing to ${target}. Nothing was changed; try again once ${running.length === 1 ? "it has" : "they have"} finished.`);
  const held = await locks();
  if (held.available && held.holders.length) throw new Error(`Package work is in progress (${held.holders.map((entry) => entry.file).join(", ")} ${held.holders.length === 1 ? "is" : "are"} locked), and it may write to ${target}. Nothing was changed; try again once it has finished.`);

  // 2. Unmount, in the host's namespace: this runner's own is not the one the server uses.
  say(`$ umount ${target}`);
  const unmounted = await run(binaries.umount, [...hostNamespace, target], { timeout: 60_000 });
  if (!unmounted.ok || (await hostMountsAt(run, target)).some((mount) => fatTypes.includes(mount.fstype))) {
    throw new Error(`${target} could not be unmounted (${tail(unmounted.stderr) || "it is still mounted"}): something has a file open on it. It was left mounted and nothing was changed.`);
  }

  let outcome;
  let failure = null;
  try {
    // 3. Read it, writing nothing.
    say(`$ fsck.fat -n ${device}`);
    const first = await run(binaries.fsckFat, ["-n", device], { timeout: 5 * 60_000 });
    const before = parseFsckFat(`${first.stdout}\n${first.stderr}`);
    for (const line of `${first.stdout}\n${first.stderr}`.split("\n").filter((entry) => entry.trim())) say(`  ${line.trim()}`);
    if (first.code !== 0 && first.code !== 1) throw new Error(`fsck.fat could not read ${device} (exit ${first.code ?? "?"}): ${tail(`${first.stdout}\n${first.stderr}`)}`);
    if (before.clean) {
      say(`${device} is clean: the mark is not set, so there is nothing to clear`);
      outcome = { cleared: false, alreadyClean: true, clean: true, summary: before.summary };
    } else if (!before.onlyTheMark) {
      const freeCount = before.beyond.some((line) => /Free cluster summary wrong/i.test(line));
      throw new Error(`The check found more than the not-properly-unmounted mark on ${device}: ${before.beyond.slice(0, 4).join(" / ")}. Nothing was changed.${freeCount ? " A free-space count that is off is harmless, but it is more than the mark, so it is left for you to decide." : ""} To repair it anyway: sudo umount ${target} && sudo fsck.fat -a ${device} && sudo mount ${target}.`);
    } else {
      // 4. Clear it, and read it again: nothing may be left.
      say(`$ fsck.fat -a ${device}`);
      const repaired = await run(binaries.fsckFat, ["-a", device], { timeout: 5 * 60_000 });
      for (const line of `${repaired.stdout}\n${repaired.stderr}`.split("\n").filter((entry) => entry.trim())) say(`  ${line.trim()}`);
      if (repaired.code !== 0 && repaired.code !== 1) throw new Error(`fsck.fat -a failed on ${device} (exit ${repaired.code ?? "?"}): ${tail(`${repaired.stdout}\n${repaired.stderr}`)}`);
      say(`$ fsck.fat -n ${device}`);
      const second = await run(binaries.fsckFat, ["-n", device], { timeout: 5 * 60_000 });
      const after = parseFsckFat(`${second.stdout}\n${second.stderr}`);
      if (second.code !== 0 || !after.clean) throw new Error(`The mark is still there after fsck.fat -a (exit ${second.code ?? "?"}): ${tail(`${second.stdout}\n${second.stderr}`)}`);
      say(`Cleared the mark on ${device}; the check found nothing else`);
      outcome = { cleared: true, alreadyClean: false, clean: true, summary: after.summary ?? before.summary };
    }
  } catch (error) {
    failure = error;
  }

  // 5. Mounted again whatever happened: from fstab, or as it was when fstab does not name it.
  say(`$ mount ${target}`);
  let back = await run(binaries.mount, [...hostNamespace, target], { timeout: 60_000 });
  let mounted = (await hostMountsAt(run, target)).find((mount) => fatTypes.includes(mount.fstype)) ?? null;
  if (!mounted) {
    say(`$ mount -t ${found.fstype} -o ${options} ${device} ${target}`);
    back = await run(binaries.mount, [...hostNamespace, "-t", found.fstype, "-o", options, device, target], { timeout: 60_000 });
    mounted = (await hostMountsAt(run, target)).find((mount) => fatTypes.includes(mount.fstype)) ?? null;
  }
  if (!mounted) {
    const why = `${target} could not be mounted again (${tail(back.stderr) || "mount gave no reason"}). The server still starts without it, but kernel and bootloader updates need it: mount it with sudo mount ${target}.`;
    throw new Error(failure ? `${failure.message} ${why}` : why);
  }
  if (failure) throw new Error(`${failure.message} ${target} was mounted again as it was.`);
  const listed = await files.readdir(target).then((entries) => entries.length, () => null);
  if (listed === null) throw new Error(`${target} was mounted again from ${mounted.source}, but could not be read.`);
  say(`${target} is mounted again from ${mounted.source} and reads (${listed} entr${listed === 1 ? "y" : "ies"} at the top)`);
  return { target, device, fstype: found.fstype, ...outcome, remounted: true, checkedAt: now().toISOString() };
}
