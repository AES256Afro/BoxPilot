import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";
import { appendFstabEntry, mountNamePattern, removeManagedEntry } from "./storage.mjs";

/**
 * Root-side network-share tasks (SMB/CIFS and NFS) executed by scripts/boxpilot-run.mjs.
 *
 * A share becomes a `# boxpilot:share-<name>` fstab entry at /mnt/<name> with nofail,
 * _netdev, and systemd automount, so a NAS that is off never blocks boot and reconnects by
 * itself. SMB credentials live in /etc/boxpilot/secrets/share-<name>.cred (root, 0600) and
 * are referenced from fstab; they never appear on a command line. The server only ever acts
 * as a client here: nothing is exposed to the LAN.
 */

export const shareKinds = Object.freeze(["smb", "nfs"]);
export const hostPattern = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/;
export const smbSharePattern = /^[A-Za-z0-9_][A-Za-z0-9 ._$-]{0,79}$/;
export const nfsExportPattern = /^\/[A-Za-z0-9._+/-]{0,254}$/;
export const credentialPattern = /^[^\s\r\n=\\]{1,64}$/;
export const secretsDirectory = "/etc/boxpilot/secrets";
export const credentialsPath = (name) => `${secretsDirectory}/share-${name}.cred`;

const fstabPath = "/etc/fstab";
const binaries = {
  mount: "/usr/bin/mount",
  umount: "/usr/bin/umount",
  findmnt: process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  systemdEscape: "/usr/bin/systemd-escape",
  mountCifs: "/sbin/mount.cifs",
  mountNfs: "/sbin/mount.nfs",
};

export function validateShare({ kind, host, share, name, username = null, password = null, domain = null } = {}) {
  if (!shareKinds.includes(kind)) return "kind must be smb or nfs";
  if (typeof host !== "string" || !hostPattern.test(host)) return "host must be a hostname or IP address";
  if (typeof name !== "string" || !mountNamePattern.test(name)) return "name must be lower-case letters, digits, and hyphens (max 32)";
  if (kind === "smb" && (typeof share !== "string" || !smbSharePattern.test(share))) return "share name may use letters, digits, spaces, dot, underscore, hyphen";
  if (kind === "nfs" && (typeof share !== "string" || !nfsExportPattern.test(share))) return "export must be an absolute path like /volume1/media";
  if (username !== null && (typeof username !== "string" || !credentialPattern.test(username))) return "username is invalid";
  if (domain !== null && (typeof domain !== "string" || !credentialPattern.test(domain))) return "domain is invalid";
  if (password !== null && (typeof password !== "string" || password.length > 256 || /[\r\n]/.test(password))) return "password is invalid";
  if (kind === "nfs" && (username || password)) return "NFS mounts do not take a username or password";
  return null;
}

/** The fstab line for a share. Pure, so the UI preview and the task agree. */
export function buildShareEntry({ kind, host, share, name, readOnly = false, guest = true }) {
  const mountpoint = `/mnt/${name}`;
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

/** Turn mount's terse errors into something the owner can act on. */
export function explainMountError(kind, text) {
  const output = String(text ?? "");
  if (/Permission denied|access denied|NT_STATUS_LOGON_FAILURE|error\(13\)|Operation not permitted|NT_STATUS_ACCESS_DENIED/i.test(output)) {
    return kind === "smb"
      ? "The NAS refused the credentials. Check the username and password; on a WD My Cloud Home you must first enable local network access and set a local password in the My Cloud Home app."
      : "The NFS server refused this client. Check that the export allows this server's address.";
  }
  if (/No such device|error\(112\)|Host is down|Connection timed out|Network is unreachable|No route to host|could not resolve|Unable to find suitable address/i.test(output)) return "The host did not answer. Check the address and that the device is switched on and reachable from this server.";
  if (/No such file or directory|error\(2\)|NT_STATUS_BAD_NETWORK_NAME|error\(-6\)/i.test(output)) return "The share does not exist on that host. Check the share name (List shares can show them).";
  if (/Operation not supported|wrong fs type|bad option|unknown filesystem type/i.test(output)) return kind === "smb" ? "cifs-utils is missing or the SMB dialect is not supported; install cifs-utils from the Storage page." : "nfs-common is missing; install it from the Storage page.";
  return output.split("\n").filter(Boolean).slice(-2).join(" ") || "mount failed";
}

async function unitFor(run, mountpoint, suffix) {
  const escaped = await run(binaries.systemdEscape, ["-p", `--suffix=${suffix}`, mountpoint], { timeout: 10_000 });
  return escaped.ok ? escaped.stdout.trim() : null;
}

/** Mount a share permanently at /mnt/<name>. Rolls back fstab and credentials if the first mount fails. */
export async function shareMount({ kind, host, share, name, username = null, password = null, domain = null, readOnly = false } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, mkdir, unlink }, exists = (file) => access(file).then(() => true, () => false) } = {}) {
  const problem = validateShare({ kind, host, share, name, username, password, domain });
  if (problem) throw new Error(`Invalid share: ${problem}`);
  if (typeof readOnly !== "boolean") throw new Error("readOnly must be true or false");
  if (kind === "smb" && !(await exists(binaries.mountCifs))) throw new Error("cifs-utils is not installed; install it from the Storage page, then try again");
  if (kind === "nfs" && !(await exists(binaries.mountNfs))) throw new Error("nfs-common is not installed; install it from the Storage page, then try again");
  const guest = kind === "nfs" || !username;
  const { source, mountpoint, entry } = buildShareEntry({ kind, host, share, name, readOnly, guest });
  const mounted = await run(binaries.findmnt, ["-n", mountpoint], { timeout: 15_000 });
  if (mounted.ok && mounted.stdout.trim()) throw new Error(`${mountpoint} is already mounted`);

  let credentialsStored = false;
  if (!guest) {
    await files.mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
    const lines = [`username=${username}`, `password=${password ?? ""}`, ...(domain ? [`domain=${domain}`] : [])];
    await files.writeFile(credentialsPath(name), `${lines.join("\n")}\n`, { mode: 0o600 });
    credentialsStored = true;
    log?.(`Stored credentials for ${username} in ${credentialsPath(name)} (root only)`, "stdout");
  }
  await files.mkdir(mountpoint, { recursive: true, mode: 0o755 });
  let previous;
  try {
    previous = await appendFstabEntry({ run, files, log }, `share-${name}`, entry);
  } catch (error) {
    if (credentialsStored) await files.unlink(credentialsPath(name)).catch(() => {});
    throw error;
  }
  await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 });
  log?.(`$ mount ${mountpoint}`, "stdout");
  const result = await run(binaries.mount, [mountpoint], { timeout: 90_000 });
  if (!result.ok) {
    await files.writeFile(fstabPath, previous);
    await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 }).catch(() => {});
    if (credentialsStored) await files.unlink(credentialsPath(name)).catch(() => {});
    throw new Error(`${explainMountError(kind, `${result.stderr}\n${result.stdout}`)} The fstab entry was removed again.`);
  }
  const check = await run(binaries.findmnt, ["-n", "-b", "-o", "SOURCE,FSTYPE,SIZE,AVAIL", mountpoint], { timeout: 15_000 });
  const [, , sizeText, availText] = check.stdout.trim().split(/\s+/);
  const automount = await unitFor(run, mountpoint, "automount");
  if (automount) await run(binaries.systemctl, ["start", automount], { timeout: 30_000 }).catch(() => {});
  log?.(`${source} is mounted at ${mountpoint}${readOnly ? " (read-only)" : ""}; it reconnects by itself after reboots`, "stdout");
  return { mounted: true, name, kind, source, mountpoint, readOnly, credentialsStored, sizeBytes: Number.parseInt(sizeText ?? "", 10) || null, availableBytes: Number.parseInt(availText ?? "", 10) || null, persistent: true };
}

/** Unmount a share and forget it: fstab entry, automount unit, and stored credentials. */
export async function shareUnmount({ name } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, unlink } } = {}) {
  if (typeof name !== "string" || !mountNamePattern.test(name)) throw new Error("Name is invalid");
  const content = await files.readFile(fstabPath, "utf8");
  const without = removeManagedEntry(content, `share-${name}`);
  if (without === null) throw new Error(`${name} is not a BoxPilot-managed share`);
  const mountpoint = `/mnt/${name}`;
  const automount = await unitFor(run, mountpoint, "automount");
  if (automount) await run(binaries.systemctl, ["stop", automount], { timeout: 30_000 }).catch(() => {});
  const mounted = await run(binaries.findmnt, ["-n", mountpoint], { timeout: 15_000 });
  if (mounted.ok && mounted.stdout.trim()) {
    log?.(`$ umount ${mountpoint}`, "stdout");
    const result = await run(binaries.umount, [mountpoint], { timeout: 60_000 });
    if (!result.ok) throw new Error(`umount failed (is an app still using it?): ${result.stderr.split("\n").filter(Boolean).slice(-2).join(" ")}`);
  }
  await files.writeFile(fstabPath, without);
  await run(binaries.systemctl, ["daemon-reload"], { timeout: 30_000 });
  const credentialsRemoved = await files.unlink(credentialsPath(name)).then(() => true, () => false);
  log?.(`Removed the ${name} share from fstab${credentialsRemoved ? " and deleted its stored credentials" : ""}; ${mountpoint} was kept`, "stdout");
  return { unmounted: true, name, mountpoint, credentialsRemoved, directoryKept: true };
}
