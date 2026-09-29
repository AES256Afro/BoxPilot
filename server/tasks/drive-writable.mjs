import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";
import { managedDriveEntries, verificationAllows, verifyFstab } from "./drive-shutdown.mjs";
import { appUserId, hostMountAt, managedDrive, permissionlessFilesystems, remountDrive } from "./storage.mjs";

/**
 * "Let apps write to the drive" (M35): Repair's fix for an exFAT, FAT or NTFS drive mounted without
 * an owner.
 *
 * Those filesystems keep no owners of their own, so the mount decides who owns every file on them,
 * and one mounted without `uid=` hands the whole drive to root: every app that runs as a normal user
 * is read-only there, and so is anyone writing through a file share. Repair used to offer "Remount
 * it", which mounted the same fstab line again and changed nothing. This changes the line: it adds
 * uid= and gid= for the user apps run as (the same the Storage page's "writable by your apps" puts
 * in a new entry), then reconnects the drive through the busy pipeline so the new owner takes
 * effect, and proves it by the owner of the mounted folder.
 *
 * Nothing on the drive is written. fstab is copied beside itself first, the new file is checked with
 * findmnt --verify before it replaces the old one by a rename, and the old line is put back if the
 * drive will not mount with the new one.
 */

const fstabPath = "/etc/fstab";
const candidatePath = "/etc/fstab.boxpilot-new";
const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";

/** The options with the owner set: any uid=/gid= already there is replaced, everything else kept in order. */
export function withOwnerOptions(options, uid = appUserId, gid = appUserId) {
  const kept = String(options ?? "").split(",").filter((option) => option && !/^(uid|gid)=/.test(option));
  return [...kept, `uid=${uid}`, `gid=${gid}`].join(",");
}

const defaultFiles = { readFile, writeFile, rename, unlink, stat, readable: (target) => readdir(target).then(() => true, () => false) };

export async function storageWritable({ name } = {}, { run = fixedRun, log = null, files = defaultFiles, sleep = undefined, processes = undefined, now = () => new Date(), uid = appUserId, gid = appUserId } = {}) {
  const drive = await managedDrive(name, files);
  if (!drive.readWrite) throw new Error(`${drive.mountpoint} is mounted read-only on purpose (its fstab entry says ro), so nothing was changed`);
  const before = await files.readFile(fstabPath, "utf8");
  const entry = managedDriveEntries(before).find((row) => row.name === name);
  if (!entry?.drive) throw new Error(`The ${name} entry is not a drive BoxPilot manages (${entry?.reason ?? "no entry"}); nothing was changed`);
  // "auto" says nothing; what the kernel mounted it as does.
  const fstype = entry.fstype === "auto" ? (await hostMountAt(run, drive.mountpoint))?.fstype ?? "auto" : entry.fstype;
  if (!permissionlessFilesystems.includes(String(fstype).toLowerCase())) {
    throw new Error(`${drive.mountpoint} is ${fstype}, which keeps the owner of each file on the drive itself, so its mount has no owner to change. Nothing was changed; the folder's own owner decides who can write there.`);
  }
  const options = withOwnerOptions(entry.options, uid, gid);
  const lines = before.split("\n");
  const tokens = [...entry.tokens];
  tokens[entry.optionsAt] = options;
  lines[entry.index] = tokens.join("");
  const content = lines.join("\n");
  const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const backup = `${fstabPath}.boxpilot-${stamp}`;

  // With the drive unmounted and nothing using it: the one moment its entry can change and the
  // next mount read it. Returns how to put it back, which remountDrive uses if the mount refuses.
  const rewrite = async () => {
    if (options === entry.options) { log?.(`${drive.mountpoint}'s entry already gives it to ${uid}:${gid}`, "stdout"); return { summary: { changed: false, options } }; }
    await files.writeFile(backup, before, { mode: 0o644, flag: "wx" });
    log?.(`Saved the current fstab as ${backup}`, "stdout");
    await files.writeFile(candidatePath, content, { mode: 0o644 });
    const current = await verifyFstab(run, fstabPath);
    const proposed = await verifyFstab(run, candidatePath);
    if (!verificationAllows(current, proposed)) {
      await files.unlink(candidatePath).catch(() => {});
      throw new Error(`findmnt --verify rejected the new entry, so fstab was left as it was: ${proposed.text || "no details"}`);
    }
    await files.rename(candidatePath, fstabPath);
    await run(systemctl, ["daemon-reload"], { timeout: 60_000 });
    log?.(`${drive.mountpoint}: ${entry.options} -> ${options}`, "stdout");
    const undo = async () => {
      log?.(`Putting ${drive.mountpoint}'s old entry back`, "stderr");
      await files.writeFile(candidatePath, before, { mode: 0o644 });
      await files.rename(candidatePath, fstabPath);
      await run(systemctl, ["daemon-reload"], { timeout: 60_000 }).catch(() => {});
    };
    return { summary: { changed: true, backup, previousOptions: entry.options, options }, undo };
  };

  const done = await remountDrive(drive, { run, log, files, sleep, processes, rewrite });
  // The mount's owner is the proof: what every app and share now writes as.
  const owner = await files.stat(drive.mountpoint).then((info) => ({ uid: info.uid, gid: info.gid }), () => null);
  if (!owner || owner.uid !== uid) {
    throw new Error(`${drive.mountpoint} mounted again with ${options}, but its folder still belongs to ${owner ? `user ${owner.uid}` : "an owner that could not be read"}. The entry is saved; check the drive's filesystem type on the Storage page.`);
  }
  log?.(`${drive.mountpoint} now belongs to ${uid}:${gid}, so apps and file shares can write there`, "stdout");
  return { writable: true, name, mountpoint: drive.mountpoint, fstype, owner: `${uid}:${gid}`, options, ...done };
}
