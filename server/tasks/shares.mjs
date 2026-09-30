import { access, mkdir, readFile, rmdir, unlink } from "node:fs/promises";
import { writeFileDurably as writeFile } from "../durable-file.mjs";
import { fixedRun } from "../exec.mjs";
import { appendFstabEntry, containersBoundTo, mountNamePattern, parseManagedFstab, processesUsing, removeManagedEntry, unmountFromHost } from "./storage.mjs";
import { mountpointFor, reservedMountNames } from "../backup-mount.mjs";
import { hostMountsAt as mountsInHostTable, realMount, startMountUnit } from "./mount-agreement.mjs";

/**
 * Root-side network-share tasks (SMB/CIFS and NFS) executed by scripts/boxpilot-run.mjs.
 *
 * A share becomes a `# boxpilot:share-<name>` fstab entry at /mnt/<name> (the backup destination,
 * boxpilot-backup, at /mnt/boxpilot/backup: server/backup-mount.mjs) with nofail, _netdev, and
 * systemd automount, so a NAS that is off never blocks boot and reconnects by itself. SMB credentials live in /etc/boxpilot/secrets/share-<name>.cred (root, 0600) and
 * are referenced from fstab; they never appear on a command line. The server only ever acts
 * as a client here: nothing is exposed to the LAN.
 *
 * The share is mounted and unmounted by starting and stopping the units systemd makes from that
 * fstab line, never by running mount or umount here. These tasks run in boxpilot-run@.service,
 * whose PrivateTmp= gives them a mount namespace of their own that does not propagate back to the
 * host, so the first mount share.mount made there was the task's alone and gone when it exited; the
 * host only ever had the automount. A drive's mount and umount take -N /proc/1/ns/mnt for that
 * (hostNamespace in storage.mjs), but mount(8) does not mount a share itself: it hands it to
 * mount.cifs or mount.nfs and passes -N on, and both reject it. mount.nfs fails; with mount.cifs,
 * mount exits 0 having mounted nothing anywhere. PID 1 runs mount, its helper and umount in the
 * host's namespace, from the same line a reboot uses. tests/ubuntu/share-mount-host.sh shows each
 * of these on real systemd, 255 and 259.
 */

export const shareKinds = Object.freeze(["smb", "nfs"]);
export const hostPattern = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/;
/**
 * A share, optionally followed by a folder inside it: `Backups` or `alex/BoxPilot-Backup`.
 *
 * The subfolder matters more than it looks. Some NAS boxes will not let you create shares at all —
 * a WD My Cloud Home offers exactly Public, TimeMachineBackup and one per user, for ever — so
 * "make a share for backups" is not a thing their owner can do. cifs mounts a path inside a share
 * happily; refusing to pass one on just meant backups had to live in the root of somebody's
 * personal files. Each segment is validated on its own, so `..` cannot climb out of the share.
 */
export const smbShareSegmentPattern = /^[A-Za-z0-9_][A-Za-z0-9 ._$-]{0,79}$/;
export const smbSharePattern = /^[A-Za-z0-9_][A-Za-z0-9 ._$/-]{0,255}$/;
export function validSmbShare(share) {
  if (typeof share !== "string" || !smbSharePattern.test(share)) return false;
  const segments = share.split("/");
  return segments.length <= 8 && segments.every((segment) => smbShareSegmentPattern.test(segment));
}
export const nfsExportPattern = /^\/[A-Za-z0-9._+/-]{0,254}$/;
export const credentialPattern = /^[^\s\r\n=\\]{1,64}$/;
export const secretsDirectory = "/etc/boxpilot/secrets";
export const credentialsPath = (name) => `${secretsDirectory}/share-${name}.cred`;

const fstabPath = "/etc/fstab";
const binaries = {
  findmnt: process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  systemdEscape: "/usr/bin/systemd-escape",
  journalctl: "/usr/bin/journalctl",
  docker: process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  mountCifs: "/sbin/mount.cifs",
  mountNfs: "/sbin/mount.nfs",
};
const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-2).join(" ");
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function validateShare({ kind, host, share, name, username = null, password = null, domain = null } = {}) {
  if (!shareKinds.includes(kind)) return "kind must be smb or nfs";
  if (typeof host !== "string" || !hostPattern.test(host)) return "host must be a hostname or IP address";
  if (typeof name !== "string" || !mountNamePattern.test(name)) return "name must be lower-case letters, digits, and hyphens (max 32)";
  if (reservedMountNames.includes(name)) return `${name} is reserved: /mnt/${name} holds BoxPilot's backup destination`;
  if (kind === "smb" && !validSmbShare(share)) return "share name may use letters, digits, spaces, dot, underscore, hyphen, and / for a folder inside the share";
  if (kind === "nfs" && (typeof share !== "string" || !nfsExportPattern.test(share))) return "export must be an absolute path like /volume1/media";
  if (username !== null && (typeof username !== "string" || !credentialPattern.test(username))) return "username is invalid";
  if (domain !== null && (typeof domain !== "string" || !credentialPattern.test(domain))) return "domain is invalid";
  if (password !== null && (typeof password !== "string" || password.length > 256 || /[\r\n]/.test(password))) return "password is invalid";
  if (kind === "nfs" && (username || password)) return "NFS mounts do not take a username or password";
  return null;
}

/** The fstab line for a share. Pure, so the UI preview and the task agree. */
export function buildShareEntry({ kind, host, share, name, readOnly = false, guest = true }) {
  const mountpoint = mountpointFor(name);
  const common = ["nofail", "_netdev", "x-systemd.automount", "x-systemd.idle-timeout=300", "x-systemd.mount-timeout=30"];
  if (kind === "smb") {
    const source = `//${host}/${share.replace(/ /g, "\\040")}`;
    const options = [guest ? "guest" : `credentials=${credentialsPath(name)}`, "uid=1000", "gid=1000", "file_mode=0664", "dir_mode=0775", "iocharset=utf8", ...(readOnly ? ["ro"] : []), ...common];
    return { source, mountpoint, fstype: "cifs", entry: `${source} ${mountpoint} cifs ${options.join(",")} 0 0` };
  }
  const source = `${host}:${share}`;
  const options = [readOnly ? "ro" : "rw", ...common];
  return { source, mountpoint, fstype: "nfs", entry: `${source} ${mountpoint} nfs ${options.join(",")} 0 0` };
}

/**
 * Turn mount's terse errors into something the owner can act on. `text` is everything said about
 * the attempt; `detail` is what to quote when none of it is recognised, which for a mount unit is
 * the helper's own words rather than systemd's lines saying that the unit failed.
 */
export function explainMountError(kind, text, detail = text) {
  const output = String(text ?? "");
  if (/Permission denied|access denied|NT_STATUS_LOGON_FAILURE|error\(13\)|Operation not permitted|NT_STATUS_ACCESS_DENIED/i.test(output)) {
    return kind === "smb"
      ? "The NAS refused the credentials. Check the username and password; on a WD My Cloud Home you must first enable local network access and set a local password in the My Cloud Home app."
      : "The NFS server refused this client. Check that the export allows this server's address.";
  }
  if (/No such device|error\(112\)|Host is down|Connection timed out|error\(115\)|Operation now in progress|Mounting timed out|Timed out mounting|result 'timeout'|Network is unreachable|No route to host|could not resolve|Unable to find suitable address/i.test(output)) return "The host did not answer. Check the address and that the device is switched on and reachable from this server.";
  if (/No such file or directory|error\(2\)|NT_STATUS_BAD_NETWORK_NAME|error\(-6\)/i.test(output)) return "The share does not exist on that host. Check the share name (List shares can show them).";
  if (/Operation not supported|wrong fs type|bad option|unknown filesystem type/i.test(output)) return kind === "smb" ? "cifs-utils is missing or the SMB dialect is not supported; install cifs-utils from the Storage page." : "nfs-common is missing; install it from the Storage page.";
  return String(detail ?? "").split("\n").filter(Boolean).slice(-2).join(" ") || "mount failed";
}

/** The share's automount and mount units, named from the mount point as systemd-fstab-generator names them. */
async function unitsFor(run, mountpoint) {
  const escaped = await run(binaries.systemdEscape, ["-p", mountpoint], { timeout: 10_000 });
  const base = escaped.ok ? escaped.stdout.trim() : "";
  if (!base) throw new Error(`systemd-escape failed for ${mountpoint}: ${tail(escaped.stderr)}`);
  return { mount: `${base}.mount`, automount: `${base}.automount` };
}

/**
 * What the host has mounted exactly at `mountpoint`, bottom first: the automount's autofs, then the
 * share over it. Read from PID 1's table, because the task's own can hold mounts the host does not;
 * listed rather than looked up by path, so nothing waits on a share whose NAS has gone.
 */
async function hostMountsAt(run, mountpoint) {
  const mounts = await mountsInHostTable(run, mountpoint);
  if (!mounts) throw new Error("findmnt could not read the host's mount table");
  return mounts;
}
/** The share itself among the mounts at its mount point: anything but the automount's autofs. */
const shareIn = realMount;

/**
 * What the unit's mount or umount printed, and what systemd said about the unit, since `since`.
 * PID 1 runs them, so their words go to the journal instead of back through systemctl.
 *
 * From `since` to the millisecond. Rounded down to the whole second, the read reached back to
 * whatever the unit logged earlier in that second: a share.mount of a NAS that did not answer,
 * started in the second a wrong password for the same share was refused, read that refusal too and
 * said the NAS refused the credentials.
 */
async function unitJournal(run, unit, since) {
  await run(binaries.journalctl, ["--sync"], { timeout: 15_000 });
  const read = await run(binaries.journalctl, ["--no-pager", "-o", "cat", "-u", unit, `--since=@${(since.getTime() / 1000).toFixed(3)}`], { timeout: 15_000 });
  return read.ok ? read.stdout : "";
}
/**
 * The mount unit's last attempt: its journal from the last line with which systemd began mounting
 * it ("Mounting <unit> - <path>..."), or all of it when there is none. What an earlier attempt said
 * never explains why this one failed, whatever the clock did in between.
 */
function lastAttempt(journal) {
  const lines = String(journal ?? "").split("\n");
  const start = lines.findLastIndex((line) => /^Mounting /.test(line));
  return start === -1 ? lines.join("\n") : lines.slice(start).join("\n");
}
/** A unit's journal without systemd's own lines about it, which say only that it failed. */
function helperWords(journal, unit) {
  return String(journal ?? "").split("\n")
    .filter((line) => line.trim() && !line.startsWith(`${unit}:`) && !/^(Mounting|Mounted|Unmounting|Unmounted|Failed to mount|Failed unmounting|Timed out mounting|Timed out unmounting) /.test(line))
    .join("\n");
}

/** One unmount: stop the share's mount unit, then ask the host's own table whether the share went. */
async function stopShare(run, unit, mountpoint) {
  const stopped = await run(binaries.systemctl, ["stop", unit], { timeout: 60_000 });
  return { ...stopped, ok: !shareIn(await hostMountsAt(run, mountpoint)) };
}

/** processesUsing, for ten seconds at most: a stat of a file on a share whose NAS has gone can wait for it. */
async function holdersOf(majMin, processes) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve([]), 10_000); });
  try {
    return await Promise.race([processesUsing(majMin, processes), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Mount a share permanently at /mnt/<name>. Rolls back fstab and credentials if the first mount fails. */
export async function shareMount({ kind, host, share, name, username = null, password = null, domain = null, readOnly = false } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, mkdir, unlink, rmdir }, exists = (file) => access(file).then(() => true, () => false), now = () => new Date() } = {}) {
  const problem = validateShare({ kind, host, share, name, username, password, domain });
  if (problem) throw new Error(`Invalid share: ${problem}`);
  if (typeof readOnly !== "boolean") throw new Error("readOnly must be true or false");
  if (kind === "smb" && !(await exists(binaries.mountCifs))) throw new Error("cifs-utils is not installed; install it from the Storage page, then try again");
  if (kind === "nfs" && !(await exists(binaries.mountNfs))) throw new Error("nfs-common is not installed; install it from the Storage page, then try again");
  const guest = kind === "nfs" || !username;
  const { source, mountpoint, entry } = buildShareEntry({ kind, host, share, name, readOnly, guest });
  if ((await hostMountsAt(run, mountpoint)).length) throw new Error(`${mountpoint} is already mounted`);
  const units = await unitsFor(run, mountpoint);

  let credentialsStored = false;
  if (!guest) {
    await files.mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
    const lines = [`username=${username}`, `password=${password ?? ""}`, ...(domain ? [`domain=${domain}`] : [])];
    await files.writeFile(credentialsPath(name), `${lines.join("\n")}\n`, { mode: 0o600 });
    credentialsStored = true;
    log?.(`Stored credentials for ${username} in ${credentialsPath(name)} (root only)`, "stdout");
  }
  // `mkdir` with recursive reports the first path it created, or nothing when the directory was
  // already there. Only a directory this call brought into existence is ours to take away again.
  const createdMountpoint = await files.mkdir(mountpoint, { recursive: true, mode: 0o755 });
  let previous;
  try {
    previous = await appendFstabEntry({ run, files, log }, `share-${name}`, entry);
  } catch (error) {
    if (credentialsStored) await files.unlink(credentialsPath(name)).catch(() => {});
    if (createdMountpoint) await files.rmdir(mountpoint).catch(() => {});
    throw error;
  }
  await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 });
  // The automount first: systemd will not start one on a path that is already mounted. Then the
  // share itself, now, so a wrong password or a NAS that is not there is found while the owner is
  // watching rather than at the first backup.
  const since = now();
  const armed = await run(binaries.systemctl, ["start", units.automount], { timeout: 30_000 });
  const started = armed.ok ? await run(binaries.systemctl, ["start", units.mount], { timeout: 90_000 }) : armed;
  const mounted = started.ok && shareIn(await hostMountsAt(run, mountpoint).catch(() => []));
  if (!mounted) {
    const failed = armed.ok ? units.mount : units.automount;
    const said = lastAttempt(await unitJournal(run, failed, since));
    await run(binaries.systemctl, ["stop", units.mount, units.automount], { timeout: 60_000 });
    // A failed unit stays in `systemctl --failed` after its fstab line has gone. Cleared while the
    // line is still there, so the unit is still loaded and the reload then lets it go.
    await run(binaries.systemctl, ["reset-failed", failed], { timeout: 30_000 });
    await files.writeFile(fstabPath, previous);
    await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 });
    if (credentialsStored) await files.unlink(credentialsPath(name)).catch(() => {});
    // The empty mountpoint used to survive a failed attempt, so three tries left three directories
    // under /mnt that looked for all the world like working mounts. `rmdir` refuses a directory
    // with anything in it, so a folder that already held files is never touched.
    if (createdMountpoint) await files.rmdir(mountpoint).catch(() => {});
    const reason = armed.ok
      ? explainMountError(kind, `${said}\n${started.stderr}`, helperWords(said, failed) || tail(started.stderr) || `systemd started ${failed} but nothing is mounted at ${mountpoint}`)
      : `The automount at ${mountpoint} did not start: ${tail(said) || tail(armed.stderr)}`;
    throw new Error(`${reason}${/[.!?]$/.test(reason) ? "" : "."} The fstab entry and the empty mount folder were removed again.`);
  }
  const detail = await run(binaries.findmnt, ["--task", "1", "-ln", "-b", "-o", "FSTYPE,SIZE,AVAIL", "--mountpoint", mountpoint], { timeout: 15_000 });
  const [, sizeText, availText] = detail.stdout.split("\n").map((row) => row.trim().split(/\s+/)).find(([fstype]) => fstype && fstype !== "autofs") ?? [];
  log?.(`${source} is mounted at ${mountpoint}${readOnly ? " (read-only)" : ""}; it reconnects by itself after reboots`, "stdout");
  return { mounted: true, name, kind, source, mountpoint, readOnly, credentialsStored, sizeBytes: Number.parseInt(sizeText ?? "", 10) || null, availableBytes: Number.parseInt(availText ?? "", 10) || null, persistent: true };
}

/**
 * Unmount a share and forget it: fstab entry, automount unit, and stored credentials.
 *
 * Nothing is forgotten while something still uses the share. An app with the folder in a container
 * holds a mount of its own, which unmounting the host's does not touch: it would go on writing to
 * the NAS through a folder nobody else can see, and bind the empty one at its next restart. Those
 * apps are named and nothing is done. File-sharing clients of a Samba share that reaches into the
 * folder are disconnected, as for a drive (unmountFromHost); anything else holding it is named.
 */
export async function shareUnmount({ name } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, unlink }, sleep = pause, processes = undefined, now = () => new Date() } = {}) {
  if (typeof name !== "string" || !mountNamePattern.test(name)) throw new Error("Name is invalid");
  const content = await files.readFile(fstabPath, "utf8");
  const without = removeManagedEntry(content, `share-${name}`);
  if (without === null) throw new Error(`${name} is not a BoxPilot-managed share`);
  const mountpoint = mountpointFor(name);
  const units = await unitsFor(run, mountpoint);
  const apps = await containersBoundTo(run, mountpoint);
  if (apps.length) throw new Error(`${mountpoint} is in use by ${apps.join(", ")}, so the share was left mounted and in fstab. Stop ${apps.length === 1 ? "that app" : "those apps"} or take the folder out of ${apps.length === 1 ? "it" : "them"}, then try again.`);

  // Stopping the mount unit is the unmount, and it is refused while the share is in use. The
  // automount is stopped only after that, because stopping it is never refused: it takes the share
  // over it off the host too, in use or not, and whatever was using it goes on doing so through a
  // mount nobody can see. That is what share.unmount used to do. Anything that reaches the folder
  // between the two stops mounts the share again through the automount, so it is released once
  // more with that gone.
  const since = now();
  const release = () => unmountFromHost(mountpoint, { run, log, files, sleep, command: `systemctl stop ${units.mount}`, unmount: () => stopShare(run, units.mount, mountpoint) });
  let released = shareIn(await hostMountsAt(run, mountpoint)) ? await release() : { ok: true, clients: [] };
  if (released.ok) {
    await run(binaries.systemctl, ["stop", units.automount], { timeout: 60_000 });
    if (shareIn(await hostMountsAt(run, mountpoint))) released = await release();
  }
  const left = await hostMountsAt(run, mountpoint);
  const share = shareIn(left);
  if (share) {
    const holders = share.majMin ? await holdersOf(share.majMin, processes) : [];
    const why = (helperWords(await unitJournal(run, units.mount, since), units.mount).split("\n").filter(Boolean).at(-1) ?? tail(released.result?.stderr)).replace(/[.\s]+$/, "");
    if (holders.length || /busy/i.test(why)) {
      throw new Error(`${mountpoint} is still in use${holders.length ? ` by ${holders.map((holder) => `${holder.command} (${holder.pid})`).join(", ")}` : ""}, so the share was left mounted and in fstab${why ? `: ${why}` : ""}. Stop whatever is using it - a copy in progress, a shell sitting in it - and try again.`);
    }
    throw new Error(`${mountpoint} could not be unmounted, so the share was left in fstab${why ? `: ${why}` : ""}.`);
  }
  if (left.length) throw new Error(`The automount at ${mountpoint} did not stop, so the share was left in fstab`);

  // A NAS that was off at some point leaves the mount unit failed, listed long after its line is
  // gone; cleared while the units are still loaded from that line.
  await run(binaries.systemctl, ["reset-failed", units.mount, units.automount], { timeout: 30_000 });
  await files.writeFile(fstabPath, without);
  await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 });
  const credentialsRemoved = await files.unlink(credentialsPath(name)).then(() => true, () => false);
  log?.(`Unmounted ${mountpoint} and removed the ${name} share from fstab${credentialsRemoved ? " and its stored credentials" : ""}; the folder was kept`, "stdout");
  return { unmounted: true, name, mountpoint, credentialsRemoved, directoryKept: true, sharingClosedFor: released.clients ?? [] };
}

/**
 * Reconnect a share: the share's counterpart of storage.remount, which refuses shares. A share whose
 * NAS restarted or whose connection dropped while in use can be left mounted read-only or answering
 * nothing; mounting it again from its fstab line connects afresh. As in share.mount and
 * share.unmount, systemd does the unmount and the mount, so they happen on the host.
 *
 * The fstab entry, the automount and the stored credentials are kept. Apps with the folder in a
 * container hold a copy of the old mount of their own, which the host's unmount does not touch, so
 * they are restarted afterwards to see the new one (Docker resolves a bind when a container
 * starts). Anything else still using the share - a shell, a copy - leaves it alone, named.
 */
export async function shareReconnect({ name } = {}, { run = fixedRun, log = null, files = { readFile }, sleep = pause, clock = () => Date.now(), processes = undefined, now = () => new Date() } = {}) {
  if (typeof name !== "string" || !mountNamePattern.test(name)) throw new Error("Name is invalid");
  const entry = parseManagedFstab(await files.readFile(fstabPath, "utf8")).find((row) => row.name === `share-${name}`);
  if (!entry) throw new Error(`${name} is not a BoxPilot-managed share`);
  const fstype = entry.line.trim().split(/\s+/)[2] ?? "";
  const kind = fstype.startsWith("nfs") ? "nfs" : "smb";
  const mountpoint = mountpointFor(name);
  const units = await unitsFor(run, mountpoint);
  const apps = await containersBoundTo(run, mountpoint);

  const since = now();
  if (shareIn(await hostMountsAt(run, mountpoint))) {
    const released = await unmountFromHost(mountpoint, { run, log, files, sleep, command: `systemctl stop ${units.mount}`, unmount: () => stopShare(run, units.mount, mountpoint) });
    if (!released.ok) {
      const share = shareIn(await hostMountsAt(run, mountpoint));
      const holders = share?.majMin ? await holdersOf(share.majMin, processes) : [];
      const why = (helperWords(await unitJournal(run, units.mount, since), units.mount).split("\n").filter(Boolean).at(-1) ?? tail(released.result?.stderr)).replace(/[.\s]+$/, "");
      throw new Error(`${mountpoint} is in use${holders.length ? ` by ${holders.map((holder) => `${holder.command} (${holder.pid})`).join(", ")}` : ""}, so it was left as it was${why ? `: ${why}` : ""}. Stop whatever is using it - a copy in progress, a shell sitting in it - and try again.`);
    }
  }
  // The automount is still there; starting it again is a no-op unless something had stopped it.
  // Then the share itself, now, so a NAS that is still away is found while the owner is watching.
  // As for a drive after a cancelled reboot (startMountUnit): the unit must agree the share is gone
  // before it is started, a start that did nothing is made once more, and only PID 1's table says
  // it mounted. The apps are restarted only after that.
  const mountedFrom = now();
  await run(binaries.systemctl, ["start", units.automount], { timeout: 30_000 });
  const back = await startMountUnit(run, units.mount, mountpoint, { log, sleep, clock });
  if (!back.ok) {
    const stderr = back.result?.stderr ?? "";
    const said = lastAttempt(await unitJournal(run, units.mount, mountedFrom));
    const reason = explainMountError(kind, `${said}\n${stderr}`, helperWords(said, units.mount) || tail(stderr) || `systemd started ${units.mount} but nothing is mounted at ${mountpoint}`);
    throw new Error(`${reason}${/[.!?]$/.test(reason) ? "" : "."} ${mountpoint} is not mounted now; its fstab entry is kept, so it mounts by itself once the NAS answers.`);
  }
  const options = await run(binaries.findmnt, ["--task", "1", "-ln", "-o", "FSTYPE,FS-OPTIONS", "--mountpoint", mountpoint], { timeout: 15_000 });
  const [, filesystemOptions = ""] = options.stdout.split("\n").map((row) => row.trim().split(/\s+/)).find(([type]) => type && type !== "autofs") ?? [];
  const readOnly = filesystemOptions.split(",").includes("ro") && !entry.line.trim().split(/\s+/)[3]?.split(",").includes("ro");
  log?.(`${mountpoint} is mounted again${readOnly ? ", read-only" : ""}`, readOnly ? "stderr" : "stdout");

  const restarted = []; const restartFailed = [];
  for (const container of apps) {
    log?.(`$ docker restart ${container}`, "stdout");
    const result = await run(binaries.docker, ["restart", container], { timeout: 120_000 });
    if (result.ok) restarted.push(container); else { restartFailed.push(container); log?.(`could not restart ${container}: ${tail(result.stderr)}`, "stderr"); }
  }
  // Mounted afresh and still read-only is the NAS's answer, not a stale connection: saying the
  // reconnect worked would send the owner back to the same button.
  if (readOnly) throw new Error(`${mountpoint} was mounted again but is still read-only, so the NAS is serving it read-only to this server. Check the share's permissions for this user on the NAS.${restarted.length ? ` ${restarted.join(", ")} ${restarted.length === 1 ? "was" : "were"} restarted.` : ""}`);
  return { reconnected: true, name, mountpoint, restarted, restartFailed };
}
