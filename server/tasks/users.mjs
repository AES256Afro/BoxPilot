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
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${githubUser}.keys — check the username`);
  return response.text();
}

/** Append new keys to <home>/.ssh/authorized_keys with correct ownership and modes. */
async function appendAuthorizedKeys(run, log, files, entry, keys) {
  const sshDirectory = path.join(entry.home, ".ssh");
  const target = path.join(sshDirectory, "authorized_keys");
  const install = await run("/usr/bin/install", ["-d", "-m", "700", "-o", String(entry.uid), "-g", String(entry.gid), sshDirectory], { timeout: 10_000 });
  if (!install.ok) throw new Error(`Could not prepare ${sshDirectory}: ${install.stderr}`);
  const existing = await files.readFile(target, "utf8").catch(() => "");
  const current = new Set(validKeyLines(existing));
  const added = keys.filter((key) => !current.has(key));
  if (added.length > 0) {
    const content = `${existing.replace(/\n*$/, existing ? "\n" : "")}${added.join("\n")}\n`;
    await files.writeFile(target, content, { mode: 0o600 });
    const chown = await run("/usr/bin/chown", [`${entry.uid}:${entry.gid}`, target], { timeout: 10_000 });
    if (!chown.ok) throw new Error(`Could not chown ${target}: ${chown.stderr}`);
    await run("/usr/bin/chmod", ["600", target], { timeout: 10_000 });
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
    if (keys.length === 0) throw new Error(`No public keys found at github.com/${githubUser}.keys — the account was still created`);
    importedKeys = await appendAuthorizedKeys(run, log, files, entry, keys);
  }
  return { username, uid: entry.uid, home: entry.home, passwordLoginDisabled: true, importedKeys };
}

export async function userKeysImport({ username, githubUser = null, keys = null } = {}, { run = fixedRun, log = null, files = { readFile, writeFile }, fetchKeys = defaultFetchKeys } = {}) {
  assertUsername(username);
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
