import { access, copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

/**
 * Root-side Samba (SMB file server) tasks executed by scripts/boxpilot-run.mjs.
 *
 * BoxPilot owns /etc/samba/smb.conf once it applies a configuration: the file is rendered
 * from a declarative set of shares, validated with testparm, and smbd is reloaded. By default
 * Samba binds only to loopback and tailscale0, so shares are reachable from the owner's
 * tailnet and from nothing else; "lan" scope adds the LAN interface. Samba users are Linux
 * accounts without a shell in the sambashare group; passwords go to smbpasswd on stdin.
 */

export const smbConfPath = "/etc/samba/smb.conf";
export const smbConfBackupPath = "/etc/samba/smb.conf.before-boxpilot";
export const managedMarker = "# Managed by BoxPilot";
export const shareNamePattern = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,30}$/;
export const workgroupPattern = /^[A-Za-z0-9_-]{1,15}$/;
export const sambaUsernamePattern = /^[a-z_][a-z0-9_-]{0,31}$/;
export const scopes = Object.freeze(["tailscale", "lan"]);
export const reservedShareNames = Object.freeze(["global", "homes", "printers", "print$", "ipc$"]);
export const sharePathDenyPrefixes = Object.freeze(["/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/run", "/var/run", "/opt", "/snap", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var/lib/libvirt", "/var/lib/docker", "/var/lib/boxpilot", "/var/lib/boxpilot-managed", "/var/lib/docker", "/var/lib/samba"]);
export const maxShares = 32;

const binaries = {
  smbd: "/usr/sbin/smbd",
  testparm: "/usr/bin/testparm",
  smbpasswd: "/usr/bin/smbpasswd",
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  getent: "/usr/bin/getent",
  groupadd: "/usr/sbin/groupadd",
  useradd: "/usr/sbin/useradd",
  usermod: "/usr/sbin/usermod",
  ip: "/usr/sbin/ip",
  ss: "/usr/bin/ss",
  find: "/usr/bin/find",
  du: "/usr/bin/du",
  rm: "/usr/bin/rm",
  aptGet: "/usr/bin/apt-get",
  ufw: "/usr/sbin/ufw",
};

/**
 * Windows finds file servers with WS-Discovery, not the NetBIOS browsing Samba's nmbd speaks:
 * Windows 10 and 11 ship with SMB1 and the Computer Browser service off, so a healthy Samba
 * server is reachable by typing \\host\share but never appears under Network. wsdd answers the
 * discovery multicast on Samba's behalf, which is the whole of the difference.
 */
export const discoveryPorts = Object.freeze([
  { port: 3702, protocol: "udp", label: "WS-Discovery" },   // the multicast probe Windows sends
  { port: 5357, protocol: "tcp", label: "WS-Discovery metadata" }, // the reply Windows then fetches
]);

function cleanPath(value) {
  if (typeof value !== "string" || !/^\/[^\0\r\n]*$/.test(value) || value.includes("/../") || value.endsWith("/..") || value.length > 512) return null;
  const normalized = value.replace(/\/+$/, "") || "/";
  if (normalized === "/" || sharePathDenyPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return null;
  return normalized;
}

/** Validate the declarative configuration; returns null or a message. */
export function validateSambaConfig({ workgroup = "WORKGROUP", scope = "tailscale", shares = [] } = {}) {
  if (!workgroupPattern.test(String(workgroup))) return "workgroup may use letters, digits, underscore, hyphen (max 15)";
  if (!scopes.includes(scope)) return "scope must be tailscale or lan";
  if (!Array.isArray(shares)) return "shares must be a list";
  if (shares.length > maxShares) return `at most ${maxShares} shares`;
  const names = new Set();
  for (const share of shares) {
    if (!share || typeof share !== "object") return "each share must be an object";
    if (typeof share.name !== "string" || !shareNamePattern.test(share.name) || reservedShareNames.includes(share.name.toLowerCase())) return `share name "${share.name}" is invalid`;
    if (names.has(share.name.toLowerCase())) return `share name "${share.name}" is used twice`;
    names.add(share.name.toLowerCase());
    if (cleanPath(share.path) === null) return `share "${share.name}": path must be an absolute folder outside system locations`;
    if (share.comment !== undefined && share.comment !== null && (typeof share.comment !== "string" || share.comment.length > 80 || /[\r\n]/.test(share.comment))) return `share "${share.name}": comment is too long`;
    for (const flag of ["readOnly", "guest", "recycle"]) if (share[flag] !== undefined && typeof share[flag] !== "boolean") return `share "${share.name}": ${flag} must be true or false`;
    if (share.users !== undefined && !(Array.isArray(share.users) && share.users.every((user) => typeof user === "string" && sambaUsernamePattern.test(user)))) return `share "${share.name}": users must be a list of usernames`;
    if (share.guest && share.users?.length) return `share "${share.name}": a guest share cannot also be limited to users`;
  }
  return null;
}

/** Render smb.conf. Pure, so the preview and the applied file are the same text. */
export function renderSmbConf({ workgroup = "WORKGROUP", scope = "tailscale", lanInterface = null, shares = [], forceUsers = {} } = {}) {
  const interfaces = ["lo", "tailscale0", ...(scope === "lan" && lanInterface ? [lanInterface] : [])];
  const lines = [
    managedMarker,
    "# Edit shares from the BoxPilot Storage page; manual changes here are overwritten on Apply.",
    "",
    "[global]",
    `   workgroup = ${workgroup}`,
    "   server string = %h (BoxPilot)",
    "   server role = standalone server",
    `   interfaces = ${interfaces.join(" ")}`,
    "   bind interfaces only = yes",
    "   smb ports = 445",
    `   disable netbios = ${scope === "lan" ? "no" : "yes"}`,
    "   security = user",
    "   map to guest = Bad User",
    "   guest account = nobody",
    "   server min protocol = SMB2_02",
    "   server smb encrypt = desired",
    "   logging = file",
    "   log file = /var/log/samba/log.%m",
    "   max log size = 1000",
    "   vfs objects = fruit streams_xattr",
    "   fruit:metadata = stream",
    "   fruit:model = MacSamba",
    "   fruit:veto_appledouble = no",
    "   fruit:nfs_aces = no",
    "   fruit:wipe_intentionally_left_blank_rfork = yes",
    "   fruit:delete_empty_adfiles = yes",
    "   fruit:posix_rename = yes",
    "   load printers = no",
    "   printing = bsd",
    "   printcap name = /dev/null",
    "   disable spoolss = yes",
  ];
  for (const share of shares) {
    lines.push("", `[${share.name}]`, `   comment = ${share.comment?.trim() || share.name}`, `   path = ${cleanPath(share.path) ?? share.path}`, "   browseable = yes", `   read only = ${share.readOnly ? "yes" : "no"}`, `   guest ok = ${share.guest ? "yes" : "no"}`);
    if (!share.guest && share.users?.length) lines.push(`   valid users = ${share.users.join(" ")}`);
    if (forceUsers[share.name]) lines.push(`   force user = ${forceUsers[share.name]}`);
    lines.push("   force group = sambashare", "   create mask = 0664", "   directory mask = 0775");
    // Recycle bin: a delete over the network moves the file into a hidden .recycle folder on the
    // share instead of erasing it, so an accidental delete from another machine is recoverable.
    // recycle is listed last so it is the module that actually performs the unlink (as a move).
    if (share.recycle) lines.push(
      "   vfs objects = fruit streams_xattr recycle",
      "   recycle:repository = .recycle",
      "   recycle:keeptree = yes",
      "   recycle:versions = yes",
      "   recycle:touch = yes",
      "   recycle:directory_mode = 0770",
      "   recycle:exclude = *.tmp|~$*",
      "   recycle:maxsize = 0",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Parse smb.conf back into the declarative shape (for the Storage page). */
export function parseSmbConf(content) {
  const text = String(content ?? "");
  const sections = new Map();
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) { current = header[1]; if (!sections.has(current)) sections.set(current, {}); continue; }
    const pair = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (pair && current) sections.get(current)[pair[1].trim().toLowerCase()] = pair[2].trim();
  }
  const global = sections.get("global") ?? {};
  const yes = (value) => /^(yes|true|1)$/i.test(String(value ?? ""));
  const interfaces = (global.interfaces ?? "").split(/\s+/).filter(Boolean);
  const shares = [];
  for (const [name, values] of sections) {
    // Ubuntu ships [printers] and [print$]; adopting them into the draft would make every Apply fail.
    if (name === "global" || reservedShareNames.includes(name.toLowerCase()) || !values.path) continue;
    shares.push({
      name,
      path: values.path,
      comment: values.comment ?? null,
      readOnly: values["read only"] !== undefined ? yes(values["read only"]) : values.writable !== undefined ? !yes(values.writable) : true,
      guest: yes(values["guest ok"]),
      users: (values["valid users"] ?? "").split(/[\s,]+/).filter(Boolean),
      forceUser: values["force user"] ?? null,
      recycle: (values["vfs objects"] ?? "").split(/\s+/).includes("recycle"),
    });
  }
  return {
    managed: text.startsWith(managedMarker),
    workgroup: global.workgroup ?? "WORKGROUP",
    scope: interfaces.some((name) => name !== "lo" && name !== "tailscale0") || (interfaces.length === 0 && text.length > 0 && !text.startsWith(managedMarker)) ? "lan" : "tailscale",
    interfaces,
    shares,
  };
}

async function defaultLanInterface(run) {
  const result = await run(binaries.ip, ["-j", "-4", "route", "show", "default"], { timeout: 10_000 });
  try { return result.ok ? JSON.parse(result.stdout)[0]?.dev ?? null : null; } catch { return null; }
}

async function ownerOf(run, files, directory) {
  const info = await files.stat(directory);
  if (!info.isDirectory()) throw new Error(`${directory} is not a folder`);
  if (info.uid === 0) return null;
  const entry = await run(binaries.getent, ["passwd", String(info.uid)], { timeout: 10_000 });
  return entry.ok && entry.stdout ? entry.stdout.split(":")[0] : null;
}

const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");

/** Render, validate, and apply the whole configuration; reload smbd; verify it listens. */
export async function sambaApply({ workgroup = "WORKGROUP", scope = "tailscale", shares = [] } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, rename, copyFile, stat, access } } = {}) {
  const problem = validateSambaConfig({ workgroup, scope, shares });
  if (problem) throw new Error(`Invalid configuration: ${problem}`);
  const installed = await files.access(binaries.smbd).then(() => true, () => false);
  if (!installed) throw new Error("Samba is not installed; install it from the Storage page first");
  const forceUsers = {};
  for (const share of shares) {
    const owner = await ownerOf(run, files, cleanPath(share.path));
    if (owner) forceUsers[share.name] = owner;
    else log?.(`${share.path} is owned by root: every user will be read-only there unless you change the folder's owner`, "stderr");
  }
  const lanInterface = scope === "lan" ? await defaultLanInterface(run) : null;
  if (scope === "lan" && !lanInterface) throw new Error("Could not determine the LAN interface (no default route)");
  const group = await run(binaries.getent, ["group", "sambashare"], { timeout: 10_000 });
  if (!group.ok || !group.stdout) await run(binaries.groupadd, ["--system", "sambashare"], { timeout: 10_000 });
  const previous = await files.readFile(smbConfPath, "utf8").catch(() => null);
  if (previous !== null && !previous.startsWith(managedMarker)) {
    await files.copyFile(smbConfPath, smbConfBackupPath);
    log?.(`Kept the original ${smbConfPath} as ${smbConfBackupPath}`, "stdout");
  }
  const rendered = renderSmbConf({ workgroup, scope, lanInterface, shares, forceUsers });
  await files.writeFile(`${smbConfPath}.tmp`, rendered, { mode: 0o644 });
  await files.rename(`${smbConfPath}.tmp`, smbConfPath);
  const check = await run(binaries.testparm, ["-s", "--suppress-prompt", smbConfPath], { timeout: 30_000 });
  if (!check.ok) {
    if (previous !== null) await files.writeFile(smbConfPath, previous, { mode: 0o644 });
    throw new Error(`Samba rejected the configuration (restored the previous one): ${tail(check.stderr)}`);
  }
  log?.(`Wrote ${smbConfPath}: ${shares.length} share(s), interfaces ${["lo", "tailscale0", ...(lanInterface ? [lanInterface] : [])].join(" ")}`, "stdout");
  const enable = await run(binaries.systemctl, ["enable", "--now", "smbd"], { timeout: 60_000 });
  if (!enable.ok) throw new Error(`Could not start smbd: ${tail(enable.stderr)}`);
  await run(binaries.systemctl, ["reload-or-restart", "smbd"], { timeout: 60_000 });
  await run(binaries.systemctl, [scope === "lan" ? "enable" : "disable", scope === "lan" ? "--now" : "--now", "nmbd"], { timeout: 60_000 }).catch(() => {});
  const listening = await run(binaries.ss, ["-H", "-l", "-n", "-t"], { timeout: 10_000 });
  const bound = listening.ok ? listening.stdout.split("\n").filter((line) => /:445\s/.test(line)).map((line) => line.trim().split(/\s+/)[3]).filter(Boolean) : [];
  return { applied: true, scope, workgroup, shares: shares.map((share) => share.name), interfaces: ["lo", "tailscale0", ...(lanInterface ? [lanInterface] : [])], listening: bound, forceUsers };
}

/** Create or update a Samba user (a shell-less Linux account in sambashare). Password via stdin only. */
export async function sambaUserSet({ username, password } = {}, { run = fixedRun, log = null } = {}) {
  if (typeof username !== "string" || !sambaUsernamePattern.test(username)) throw new Error("Username must be lower-case letters, digits, underscore, or hyphen (max 32)");
  if (typeof password !== "string" || password.length < 8 || password.length > 128 || /[\r\n]/.test(password)) throw new Error("Password must be 8 to 128 characters");
  const existing = await run(binaries.getent, ["passwd", username], { timeout: 10_000 });
  let created = false;
  if (!existing.ok || !existing.stdout) {
    const add = await run(binaries.useradd, ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", "--groups", "sambashare", "--comment", "BoxPilot Samba user", username], { timeout: 30_000 });
    if (!add.ok) throw new Error(`Could not create the account: ${tail(add.stderr)}`);
    created = true;
    log?.(`Created Linux account ${username} (no shell, no home) in group sambashare`, "stdout");
  } else {
    await run(binaries.usermod, ["-a", "-G", "sambashare", username], { timeout: 30_000 }).catch(() => {});
  }
  const set = await run(binaries.smbpasswd, ["-s", "-a", username], { timeout: 30_000, input: `${password}\n${password}\n` });
  if (!set.ok) throw new Error(`smbpasswd failed: ${tail(set.stderr) || tail(set.stdout)}`);
  await run(binaries.smbpasswd, ["-e", username], { timeout: 30_000 }).catch(() => {});
  log?.(`Samba password set for ${username}`, "stdout");
  return { username, created, updated: !created };
}

/** Remove the Samba password entry; the Linux account stays (it owns no files, but removal is the owner's call). */
export async function sambaUserRemove({ username } = {}, { run = fixedRun, log = null } = {}) {
  if (typeof username !== "string" || !sambaUsernamePattern.test(username)) throw new Error("Username is invalid");
  const result = await run(binaries.smbpasswd, ["-x", username], { timeout: 30_000 });
  if (!result.ok && !/Failed to find entry|does not exist/i.test(`${result.stderr}${result.stdout}`)) throw new Error(`smbpasswd failed: ${tail(result.stderr)}`);
  log?.(`Removed Samba access for ${username}; the Linux account was kept`, "stdout");
  return { username, removed: true, accountKept: true };
}

/** The size of a share's recycle bin in bytes, or 0 if there is nothing recycled (or it cannot be read). */
export async function recycleSizeBytes(run, sharePath) {
  const base = cleanPath(sharePath);
  if (!base) return 0;
  const result = await run(binaries.du, ["-sb", "--", `${base}/.recycle`], { timeout: 15_000 }).catch(() => null);
  return result?.ok ? (Number.parseInt(result.stdout.split(/\s+/)[0], 10) || 0) : 0;
}

/**
 * Empty a share's recycle bin. With olderThanDays > 0 only files last touched before that are
 * removed (for a scheduled auto-clean); otherwise the whole .recycle folder is cleared. The path is
 * resolved from the applied smb.conf by share name, so only a real share's own .recycle is ever
 * touched, never an arbitrary path.
 */
export async function sambaRecycleEmpty({ share, olderThanDays = 0 } = {}, { run = fixedRun, log = null, files = { readFile } } = {}) {
  if (typeof share !== "string" || !shareNamePattern.test(share)) throw new Error("Share name is invalid");
  const days = Number.isFinite(Number(olderThanDays)) ? Math.trunc(Number(olderThanDays)) : 0;
  if (days < 0 || days > 3650) throw new Error("olderThanDays must be between 0 and 3650");
  const config = parseSmbConf(await files.readFile(smbConfPath, "utf8").catch(() => ""));
  const entry = config.shares.find((row) => row.name === share);
  if (!entry) throw new Error(`No share named ${share} is configured`);
  const base = cleanPath(entry.path);
  if (!base) throw new Error(`Share ${share} has an unusable path`);
  const recycleDir = `${base}/.recycle`;
  const freedBytes = await recycleSizeBytes(run, base);
  if (days > 0) {
    const removed = await run(binaries.find, [recycleDir, "-type", "f", "-mtime", `+${days}`, "-delete"], { timeout: 300_000 });
    if (!removed.ok && !/No such file/i.test(removed.stderr)) throw new Error(`Could not clean the recycle bin: ${tail(removed.stderr)}`);
    await run(binaries.find, [recycleDir, "-mindepth", "1", "-type", "d", "-empty", "-delete"], { timeout: 120_000 }).catch(() => {});
  } else {
    const removed = await run(binaries.rm, ["-rf", "--", recycleDir], { timeout: 300_000 });
    if (!removed.ok) throw new Error(`Could not empty the recycle bin: ${tail(removed.stderr)}`);
  }
  log?.(`Emptied the recycle bin for ${share}${days ? ` (files older than ${days} days)` : ""}`, "stdout");
  return { emptied: true, share, path: recycleDir, olderThanDays: days, freedBytes };
}

/** Is wsdd present, and is it running? Read-only, used by samba.inspect to describe discovery. */
export async function discoveryState(run, files = { access }) {
  const installed = await Promise.all(["/usr/bin/wsdd", "/usr/sbin/wsdd"].map((candidate) => files.access(candidate).then(() => true, () => false)));
  const present = installed.some(Boolean);
  if (!present) return { installed: false, running: false };
  const active = await run(binaries.systemctl, ["is-active", "wsdd"], { timeout: 10_000 }).catch(() => null);
  return { installed: true, running: active ? active.stdout.trim() === "active" : false };
}

/**
 * Turn Windows discovery on or off. On: install wsdd if the box does not have it, enable the
 * service, and allow the two discovery ports so the multicast can actually arrive. Off: stop and
 * disable the service and withdraw those rules. Shares themselves are untouched either way —
 * this only decides whether Windows lists the server without being told its name.
 */
export async function sambaDiscoverySet({ enabled = true } = {}, { run = fixedRun, log = null, files = { access } } = {}) {
  const on = enabled === true || enabled === "true";
  if (!on) {
    await run(binaries.systemctl, ["disable", "--now", "wsdd"], { timeout: 60_000 }).catch(() => {});
    for (const entry of discoveryPorts) {
      await run(binaries.ufw, ["--force", "delete", "allow", `${entry.port}/${entry.protocol}`], { timeout: 30_000 }).catch(() => {});
    }
    log?.("Windows discovery is off; shares stay reachable by typing the server name", "stdout");
    return { enabled: false, ...(await discoveryState(run, files)) };
  }
  const before = await discoveryState(run, files);
  if (!before.installed) {
    log?.("Installing wsdd so Windows can discover this server", "stdout");
    const install = await run(binaries.aptGet, ["install", "-y", "--no-install-recommends", "wsdd"], {
      timeout: 300_000,
      env: { DEBIAN_FRONTEND: "noninteractive" },
    });
    if (!install.ok) throw new Error(`Could not install wsdd: ${tail(install.stderr) || "apt-get failed"}. Check that updates are working, then try again.`);
  }
  const after = await discoveryState(run, files);
  if (!after.installed) throw new Error("wsdd did not install; Windows discovery is unavailable on this server");
  const enable = await run(binaries.systemctl, ["enable", "--now", "wsdd"], { timeout: 60_000 });
  if (!enable.ok) throw new Error(`Could not start wsdd: ${tail(enable.stderr)}`);
  // Discovery is multicast: without these two rules Windows never hears the reply, and the
  // feature looks broken in exactly the way it looked broken before wsdd was there at all.
  const allowed = [];
  for (const entry of discoveryPorts) {
    const rule = await run(binaries.ufw, ["allow", `${entry.port}/${entry.protocol}`, "comment", `BoxPilot ${entry.label}`], { timeout: 30_000 });
    if (rule.ok) allowed.push(`${entry.port}/${entry.protocol}`);
    else log?.(`Could not allow ${entry.port}/${entry.protocol} (${tail(rule.stderr)}); Windows may still not list this server`, "stderr");
  }
  log?.("Windows discovery is on; this server appears under Network in File Explorer", "stdout");
  return { enabled: true, ...(await discoveryState(run, files)), allowed };
}
