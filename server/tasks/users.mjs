import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "../exec.mjs";

/**
 * Root-side user and SSH tasks executed by scripts/boxpilot-run.mjs inside boxpilot-run@.service.
 * GitHub key import needs the network; the rest needs to write /etc and /home, which the
 * helper's ProtectSystem=strict forbids. Each task re-validates its parameters.
 */

export const usernamePattern = /^[a-z_][a-z0-9_-]{0,31}$/;
export const githubUserPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,38})?$/;
export const publicKeyPattern = /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]*)?$/;
const sshdDropInPath = "/etc/ssh/sshd_config.d/00-boxpilot.conf";

function assertUsername(username) {
  if (typeof username !== "string" || !usernamePattern.test(username)) throw new Error("Username must be lower-case letters, digits, underscore, or hyphen (max 32)");
}

/** Filter pasted or fetched text down to valid public key lines. */
export function validKeyLines(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).filter((line) => publicKeyPattern.test(line));
}

async function userEntry(run, username) {
  const result = await run("/usr/bin/getent", ["passwd", username], { timeout: 10_000 });
  if (!result.ok || !result.stdout) return null;
  const [name, , uid, gid, , home, shell] = result.stdout.split(":");
  return { name, uid: Number(uid), gid: Number(gid), home, shell };
}

async function defaultFetchKeys(githubUser) {
  const response = await fetch(`https://github.com/${githubUser}.keys`, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${githubUser}.keys. Check the username`);
  return response.text();
}

/**
 * Append new keys to <home>/.ssh/authorized_keys - as the user, not as root.
 *
 * This task runs as root and the target user owns everything under their home, which makes every
 * path component theirs to replace. An earlier version read and wrote the file as root and checked
 * for symlinks first; the review of that version found the check could not close the window - the
 * user swaps `~/.ssh` for a link to `/root/.ssh` between the check and the write, and root has just
 * written their key into root's own authorized_keys and handed the file to them. Every variant of
 * root-touches-a-user-owned-path has some version of that window. sshd's answer is StrictModes;
 * ours is simpler: do the whole thing as the user. A symlink can then only lead somewhere the user
 * could already write, and there is nothing left for root to get wrong.
 *
 * Two runs as the user: one to read what is already there, one to append what is new, with the key
 * lines on stdin so they never touch argv. The home comes from passwd, not from $HOME, because
 * runuser without -l keeps the caller's environment.
 */
async function appendAuthorizedKeys(run, log, _files, entry, keys) {
  const asUser = (script, options = {}) => run("/usr/sbin/runuser", ["-u", entry.name, "--", "/bin/sh", "-c", script, "sh", entry.home], { timeout: 15_000, ...options });
  // `mkdir -p` first so a home with no .ssh yet reads as empty rather than failing; both as the user.
  const existing = await asUser('umask 077; mkdir -p "$1/.ssh" && cat "$1/.ssh/authorized_keys" 2>/dev/null; exit 0');
  if (!existing.ok) throw new Error(`Could not read ${entry.name}'s authorized keys as ${entry.name}: ${existing.stderr}`);
  const current = new Set(validKeyLines(existing.stdout));
  const added = keys.filter((key) => !current.has(key));
  if (added.length > 0) {
    const written = await asUser('umask 077; mkdir -p "$1/.ssh" && chmod 700 "$1/.ssh" && cat >> "$1/.ssh/authorized_keys" && chmod 600 "$1/.ssh/authorized_keys"', { input: `${added.join("\n")}\n` });
    if (!written.ok) throw new Error(`Could not write ${entry.name}'s authorized keys as ${entry.name}: ${written.stderr}`);
  }
  log?.(`${added.length} key(s) added for ${entry.name}; ${current.size} already present`, "stdout");
  return { added: added.length, total: current.size + added.length };
}

export async function userAdd({ username, githubUser = null } = {}, { run = fixedRun, log = null, files = { readFile, writeFile }, fetchKeys = defaultFetchKeys } = {}) {
  assertUsername(username);
  if (githubUser !== null && (typeof githubUser !== "string" || !githubUserPattern.test(githubUser))) throw new Error("GitHub username is invalid");
  if (await userEntry(run, username)) throw new Error(`User ${username} already exists`);
  log?.(`$ useradd --create-home --shell /bin/bash ${username}`, "stdout");
  const result = await run("/usr/sbin/useradd", ["--create-home", "--shell", "/bin/bash", username], { timeout: 30_000 });
  if (!result.ok) throw new Error(`useradd failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  const entry = await userEntry(run, username);
  if (!entry) throw new Error(`User ${username} was not created`);
  let importedKeys = null;
  if (githubUser) {
    const keys = validKeyLines(await fetchKeys(githubUser));
    if (keys.length === 0) throw new Error(`No public keys found at github.com/${githubUser}.keys. The account was still created`);
    importedKeys = await appendAuthorizedKeys(run, log, files, entry, keys);
  }
  return { username, uid: entry.uid, home: entry.home, passwordLoginDisabled: true, importedKeys };
}

export async function userKeysImport({ username, githubUser = null, keys = null } = {}, { run = fixedRun, log = null, files = { readFile, writeFile }, fetchKeys = defaultFetchKeys } = {}) {
  assertUsername(username);
  if (username === "root") throw new Error("Keys are never added for root; give an administrator account sudo instead");
  const entry = await userEntry(run, username);
  if (!entry) throw new Error(`User ${username} does not exist`);
  let candidate = [];
  if (githubUser !== null) {
    if (typeof githubUser !== "string" || !githubUserPattern.test(githubUser)) throw new Error("GitHub username is invalid");
    candidate = validKeyLines(await fetchKeys(githubUser));
    if (candidate.length === 0) throw new Error(`No public keys found at github.com/${githubUser}.keys`);
  } else if (typeof keys === "string") {
    candidate = validKeyLines(keys);
    if (candidate.length === 0) throw new Error("No valid public key lines were provided");
  } else {
    throw new Error("Provide a GitHub username or pasted public keys");
  }
  const imported = await appendAuthorizedKeys(run, log, files, entry, candidate);
  return { username, source: githubUser ? `github:${githubUser}` : "pasted", ...imported };
}

export async function userSudoSet({ username, sudo } = {}, { run = fixedRun, log = null } = {}) {
  assertUsername(username);
  if (typeof sudo !== "boolean") throw new Error("sudo must be true or false");
  if (username === "root") throw new Error("root's privileges cannot be changed from here");
  if (!(await userEntry(run, username))) throw new Error(`User ${username} does not exist`);
  const members = await run("/usr/bin/getent", ["group", "sudo"], { timeout: 10_000 });
  const current = members.ok ? (members.stdout.split(":")[3] ?? "").split(",").filter(Boolean) : [];
  if (sudo === current.includes(username)) return { username, sudo, changed: false };
  if (!sudo && current.length === 1 && current[0] === username) throw new Error(`${username} is the only sudo user; removing it would leave no administrator`);
  log?.(sudo ? `$ usermod -aG sudo ${username}` : `$ gpasswd -d ${username} sudo`, "stdout");
  const result = sudo
    ? await run("/usr/sbin/usermod", ["-aG", "sudo", username], { timeout: 30_000 })
    : await run("/usr/bin/gpasswd", ["-d", username, "sudo"], { timeout: 30_000 });
  if (!result.ok) throw new Error(`Could not change sudo membership: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  return { username, sudo, changed: true };
}

/** Count users that already have at least one valid authorized key (so key-only login works). */
async function usersWithKeys(run, files) {
  const passwd = await files.readFile("/etc/passwd", "utf8").catch(() => "");
  const homes = passwd.split("\n").map((line) => line.split(":")).filter((fields) => fields.length >= 7)
    .filter(([, , uid, , , , shell]) => (Number(uid) >= 1000 || Number(uid) === 0) && !/nologin|false$/.test(shell))
    .map(([name, , , , , home]) => ({ name, home }));
  const withKeys = [];
  for (const { name, home } of homes) {
    const content = await files.readFile(path.join(home, ".ssh", "authorized_keys"), "utf8").catch(() => "");
    if (validKeyLines(content).length > 0) withKeys.push(name);
  }
  return withKeys;
}

export async function sshPasswordAuthSet({ enabled } = {}, { run = fixedRun, log = null, files = { readFile, writeFile, unlink } } = {}) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  if (!enabled) {
    const keyed = await usersWithKeys(run, files);
    if (keyed.length === 0) throw new Error("No user has an SSH key yet. Import a key first so key-only login still works.");
    // A key is only a way in if sshd will accept keys at all.
    const effective = await run("/usr/sbin/sshd", ["-T"], { timeout: 15_000 });
    if (effective.ok && /^pubkeyauthentication\s+no$/im.test(effective.stdout)) {
      throw new Error("This server's SSH configuration has key logins turned off (PubkeyAuthentication no), so turning off password logins would leave no way in over SSH.");
    }
    if (!effective.ok) throw new Error("Could not read the effective SSH configuration, so BoxPilot cannot confirm key logins would still work. Nothing was changed.");
    log?.(`Users with keys: ${keyed.join(", ")}`, "stdout");
  }
  const content = `# Managed by BoxPilot (Users & SSH page). sshd uses the first value it reads,\n# and this file sorts before the distribution drop-ins.\nPasswordAuthentication ${enabled ? "yes" : "no"}\n`;
  const previous = await files.readFile(sshdDropInPath, "utf8").catch(() => null);
  await files.writeFile(sshdDropInPath, content, { mode: 0o644 });
  const check = await run("/usr/sbin/sshd", ["-t"], { timeout: 15_000 });
  if (!check.ok) {
    if (previous === null) await files.unlink(sshdDropInPath).catch(() => {});
    else await files.writeFile(sshdDropInPath, previous, { mode: 0o644 });
    throw new Error(`sshd rejected the configuration; nothing was changed: ${check.stderr.split("\n").slice(-2).join(" ")}`);
  }
  log?.(`$ systemctl reload-or-restart ssh.service`, "stdout");
  const reload = await run("/usr/bin/systemctl", ["reload-or-restart", "ssh.service"], { timeout: 60_000 });
  if (!reload.ok) throw new Error(`ssh reload failed: ${reload.stderr.split("\n").slice(-2).join(" ")}`);
  return { passwordAuthentication: enabled, dropIn: sshdDropInPath };
}
