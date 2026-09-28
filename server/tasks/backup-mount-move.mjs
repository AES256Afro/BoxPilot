import { mkdir, readFile, readdir, rmdir, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";
import { backupMountParent, backupMountpoint, legacyBackupMountpoint } from "../backup-mount.mjs";
import { parseManagedFstab } from "./storage.mjs";

/**
 * Move the backup destination from /mnt/boxpilot-backup to /mnt/boxpilot/backup (root side).
 *
 * Why it moves is in server/backup-mount.mjs: the helper's sandbox can be given the folder above an
 * automount point, never the point itself. This rewrites the mount point of the one fstab entry at
 * the old place - a BoxPilot share or drive, or a line the owner wrote - and nothing else in that
 * line or in fstab, so the credentials file, the options and the marker stay as they were. It runs
 * from the upgrade script (scripts/boxpilot-backup-mount-move.mjs) and as `storage.backup.relocate`
 * for an install whose upgrade could not move it.
 *
 * Order matters. The old mount is released first, while its units still exist: a mount that is in
 * use stays exactly where it is and fstab is not touched. Only then is fstab rewritten, from a copy
 * kept beside it, and the new automount (or drive) started and checked; if any of that fails, the
 * copy goes back and the old mount point is started again. A NAS that is off does not stop the move:
 * an automount is a door, and moving the door needs nothing from the NAS.
 */

const fstabPath = "/etc/fstab";
export const fstabCopyPattern = /^\/etc\/fstab\.boxpilot-\d{8}T\d{6}Z$/;
const binaries = {
  findmnt: process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  systemdEscape: "/usr/bin/systemd-escape",
};
const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-2).join(" ");

/** fstab entries (not comments) whose mount point is exactly `target`. Pure. */
export function fstabEntriesAt(content, target) {
  return String(content ?? "").split("\n")
    .map((line, index) => ({ line, index, fields: line.trim().split(/\s+/) }))
    .filter(({ line, fields }) => line.trim() && !line.trim().startsWith("#") && fields[1] === target);
}

/** The same fstab with one entry's mount point changed; every other byte is kept. Pure. */
export function relocateEntry(content, index, target) {
  const lines = String(content ?? "").split("\n");
  lines[index] = lines[index].replace(/^(\s*\S+\s+)\S+/, (_match, head) => `${head}${target}`);
  return lines.join("\n");
}

/** What a move would do to this fstab: nothing, refuse (and why), or the new content. Pure. */
export function planBackupMountMove(content) {
  const legacy = fstabEntriesAt(content, legacyBackupMountpoint);
  if (legacy.length === 0) {
    return { action: "none", reason: fstabEntriesAt(content, backupMountpoint).length ? `the backup destination is already at ${backupMountpoint}` : `fstab has no entry at ${legacyBackupMountpoint}` };
  }
  if (legacy.length > 1) return { action: "refuse", reason: `fstab has ${legacy.length} entries at ${legacyBackupMountpoint}; keep one and try again` };
  const inTheWay = String(content ?? "").split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[0] && !fields[0].startsWith("#") && (fields[1] === backupMountParent || fields[1]?.startsWith(`${backupMountParent}/`)));
  if (inTheWay.length) return { action: "refuse", reason: `fstab already mounts something at ${inTheWay[0][1]}, where the backup destination would go` };
  const [{ line, index, fields }] = legacy;
  const automount = (fields[3] ?? "").split(",").includes("x-systemd.automount");
  const managedName = parseManagedFstab(content).find((entry) => entry.line === line)?.name ?? null;
  return { action: "move", index, line, automount, managedName, fstype: fields[2] ?? null, content: relocateEntry(content, index, backupMountpoint) };
}

function stampOf(date) {
  return date.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function unitBase(run, mountpoint) {
  const escaped = await run(binaries.systemdEscape, ["-p", mountpoint], { timeout: 10_000 });
  if (!escaped.ok || !escaped.stdout.trim()) throw new Error(`systemd-escape failed for ${mountpoint}: ${tail(escaped.stderr)}`);
  return escaped.stdout.trim();
}

/** The filesystem types mounted exactly at a path, top one last: ["autofs"], ["autofs", "cifs"], []. */
async function mountedAt(run, mountpoint) {
  const listed = await run(binaries.findmnt, ["-rn", "-o", "TARGET,FSTYPE"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  if (!listed.ok) throw new Error(`findmnt failed: ${tail(listed.stderr)}`);
  return listed.stdout.split("\n").map((row) => row.trim().split(/\s+/)).filter(([target]) => target === mountpoint).map(([, fstype]) => fstype);
}
const real = (types) => types.some((type) => type !== "autofs");

async function systemctl(run, args, log) {
  log?.(`$ systemctl ${args.join(" ")}`, "stdout");
  return run(binaries.systemctl, args, { timeout: 60_000 });
}

/** Bring one mount point up from fstab: its automount, or the drive itself when it was mounted. */
async function startAt(run, log, base, { automount, wasMounted, block = true }) {
  if (automount) return systemctl(run, ["start", `${base}.automount`], log);
  if (wasMounted) return systemctl(run, ["start", ...(block ? [] : ["--no-block"]), `${base}.mount`], log);
  return { ok: true, stdout: "", stderr: "" };
}

/** Release one mount point: the mounted filesystem first (refused while in use), then its automount. */
async function releaseAt(run, log, mountpoint, base) {
  if (real(await mountedAt(run, mountpoint))) {
    await systemctl(run, ["stop", `${base}.mount`], log);
    if (real(await mountedAt(run, mountpoint))) {
      throw new Error(`${mountpoint} is in use, so it was left where it is: stop whatever has it open (an app, a file share, a copy) and try again`);
    }
  }
  if ((await mountedAt(run, mountpoint)).includes("autofs")) {
    await systemctl(run, ["stop", `${base}.automount`], log);
    if ((await mountedAt(run, mountpoint)).length) throw new Error(`the automount at ${mountpoint} did not stop, so it was left where it is`);
  }
}

export async function moveBackupMount(_parameters = {}, { run = fixedRun, log = null, files = { readFile, writeFile, mkdir, readdir, rmdir }, now = () => new Date() } = {}) {
  // The folder the helper is given always exists, moved or not: a sandbox path that is missing when
  // the helper starts is skipped, and the destination mounted later would then be read-only to it.
  await files.mkdir(backupMountParent, { recursive: true, mode: 0o755 });
  const before = await files.readFile(fstabPath, "utf8");
  const plan = planBackupMountMove(before);
  if (plan.action === "none") {
    log?.(`Nothing to move: ${plan.reason}`, "stdout");
    return { moved: false, reason: plan.reason, from: legacyBackupMountpoint, to: backupMountpoint };
  }
  if (plan.action === "refuse") throw new Error(`The backup destination was not moved: ${plan.reason}. fstab was not changed.`);
  if ((await mountedAt(run, backupMountParent)).length) throw new Error(`${backupMountParent} is itself a mount point; the backup destination was not moved and fstab was not changed`);
  if ((await mountedAt(run, backupMountpoint)).length) throw new Error(`Something is already mounted at ${backupMountpoint}; the backup destination was not moved and fstab was not changed`);
  await files.mkdir(backupMountpoint, { recursive: true, mode: 0o755 });
  // Mounting over a folder with files in it hides them; that is not a thing to do to somebody quietly.
  const inside = await files.readdir(backupMountpoint);
  if (inside.length) throw new Error(`${backupMountpoint} already has files in it (${inside.slice(0, 3).join(", ")}); move them away and try again. fstab was not changed.`);

  const [oldBase, newBase] = [await unitBase(run, legacyBackupMountpoint), await unitBase(run, backupMountpoint)];
  const wasMounted = real(await mountedAt(run, legacyBackupMountpoint));
  log?.(`Moving ${plan.managedName ? `the BoxPilot ${plan.managedName.startsWith("share-") ? "share" : "drive"} ${plan.managedName}` : "an fstab entry"} from ${legacyBackupMountpoint} to ${backupMountpoint}: ${plan.line.trim()}`, "stdout");
  await releaseAt(run, log, legacyBackupMountpoint, oldBase);

  const verifiedBefore = await run(binaries.findmnt, ["--verify"], { timeout: 30_000 });
  const fstabCopy = `${fstabPath}.boxpilot-${stampOf(now())}`;
  let fstabWritten = false;
  try {
    await files.writeFile(fstabCopy, before, { mode: 0o644 });
    log?.(`Saved the current fstab as ${fstabCopy}`, "stdout");
    fstabWritten = true;
    await files.writeFile(fstabPath, plan.content);
    const verified = await run(binaries.findmnt, ["--verify"], { timeout: 30_000 });
    // Judged against fstab as it was: a warning that was already there is not this move's doing.
    if (verifiedBefore.ok && !verified.ok) throw new Error(`findmnt --verify rejected the moved entry: ${tail(verified.stderr || verified.stdout)}`);
    const reloaded = await systemctl(run, ["daemon-reload"], log);
    if (!reloaded.ok) throw new Error(`systemctl daemon-reload failed: ${tail(reloaded.stderr)}`);
    const started = await startAt(run, log, newBase, { automount: plan.automount, wasMounted });
    if (!started.ok) throw new Error(`could not start ${backupMountpoint}: ${tail(started.stderr)}`);
    const types = await mountedAt(run, backupMountpoint);
    if (plan.automount && !types.includes("autofs")) throw new Error(`the automount at ${backupMountpoint} is not in place`);
    if (!plan.automount && wasMounted && !real(types)) throw new Error(`the drive did not mount at ${backupMountpoint}`);
  } catch (error) {
    log?.(`Putting everything back: ${error.message}`, "stderr");
    if (fstabWritten) await files.writeFile(fstabPath, before).catch(() => {});
    await systemctl(run, ["stop", `${newBase}.mount`, `${newBase}.automount`], log).catch(() => {});
    await systemctl(run, ["daemon-reload"], log).catch(() => {});
    await startAt(run, log, oldBase, { automount: plan.automount, wasMounted }).catch(() => {});
    throw new Error(`The backup destination was not moved (${error.message}); ${fstabWritten ? `fstab was restored from ${fstabCopy}` : "fstab was not changed"} and ${legacyBackupMountpoint} is set up as before.`);
  }
  // The old folder goes when it is empty; one with anything left in it stays.
  const oldFolderRemoved = await files.rmdir(legacyBackupMountpoint).then(() => true, () => false);
  log?.(`The backup destination is at ${backupMountpoint}${plan.automount ? " (mounted on first use)" : wasMounted ? " and mounted" : ""}; the previous fstab is ${fstabCopy}`, "stdout");
  return { moved: true, from: legacyBackupMountpoint, to: backupMountpoint, entry: plan.line.trim(), managedName: plan.managedName, automount: plan.automount, remounted: !plan.automount && wasMounted, fstabCopy, oldFolderRemoved };
}

/**
 * Put back what one move changed, for an upgrade that is being rolled back: the old code looks for
 * the destination at the old place. Only a move is undone - fstab must still be exactly what the
 * move wrote - so a later edit is never overwritten from a stale copy.
 */
export async function undoBackupMountMove({ fstabCopy } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, mkdir } } = {}) {
  if (typeof fstabCopy !== "string" || !fstabCopyPattern.test(fstabCopy)) throw new Error("The fstab copy must be /etc/fstab.boxpilot-<stamp>");
  const saved = await files.readFile(fstabCopy, "utf8");
  const plan = planBackupMountMove(saved);
  if (plan.action !== "move") throw new Error(`${fstabCopy} has no backup destination at ${legacyBackupMountpoint} to put back`);
  const current = await files.readFile(fstabPath, "utf8");
  if (current !== plan.content) throw new Error(`fstab changed after the move, so it was left alone; ${fstabCopy} has the version from before it`);
  const [oldBase, newBase] = [await unitBase(run, legacyBackupMountpoint), await unitBase(run, backupMountpoint)];
  const wasMounted = real(await mountedAt(run, backupMountpoint));
  await releaseAt(run, log, backupMountpoint, newBase);
  await files.writeFile(fstabPath, saved);
  await systemctl(run, ["daemon-reload"], log);
  await files.mkdir(legacyBackupMountpoint, { recursive: true, mode: 0o755 });
  // A drive that is not plugged in would hold a blocking start for the device timeout; do not wait.
  const started = await startAt(run, log, oldBase, { automount: plan.automount, wasMounted, block: false });
  log?.(`fstab is back as it was before the move, and ${legacyBackupMountpoint} is set up again`, "stdout");
  return { restored: true, to: legacyBackupMountpoint, started: started.ok };
}
