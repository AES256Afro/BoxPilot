import { access, readFile, readdir, unlink } from "node:fs/promises";
import { writeFileDurably as writeFile } from "../durable-file.mjs";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { readBounded } from "../../packages/harness/src/index.mjs";

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
  // Bounded (M50): a page of keys is kilobytes, and this runs as root.
  return readBounded(response, 256 * 1024);
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

/** @param {{ username?: string, githubUser?: string | null }} [parameters] */
export async function userAdd({ username, githubUser = null } = {}, { run = fixedRun, log = null, files = { readFile, writeFile }, fetchKeys = defaultFetchKeys } = {}) {
  assertUsername(username);
  if (githubUser !== null && (typeof githubUser !== "string" || !githubUserPattern.test(githubUser))) throw new Error("GitHub username is invalid");
  if (await userEntry(run, username)) throw new Error(`User ${username} already exists`);
  log?.(`$ useradd --create-home --shell /bin/bash ${username}`, "stdout");
  const result = await run("/usr/sbin/useradd", ["--create-home", "--shell", "/bin/bash", username], { timeout: 30_000 });
  if (!result.ok) throw new Error(`The account ${username} could not be created: ${result.stderr.split("\n").filter(Boolean).slice(-2).join(" ") || "no reason given"}. Nothing was changed.`);
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

/** @param {{ username?: string, githubUser?: string | null, keys?: string | null }} [parameters] */
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

/** @param {{ username?: string, sudo?: boolean }} [parameters] */
export async function userSudoSet({ username, sudo } = {}, { run = fixedRun, log = null } = {}) {
  assertUsername(username);
  if (typeof sudo !== "boolean") throw new Error("Choose on or off.");
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

const dayMs = 86_400_000;

/** sshd's PermitRootLogin values that let root in with a key; `no` and `forced-commands-only` do not give a shell. */
const rootKeyLogin = new Set(["yes", "prohibit-password", "without-password"]);

/**
 * Groups whose members are root in all but name: sudo and its older names, and the daemons that run
 * whatever a member asks as root (a container or VM with / mounted). Locking or opening one of these
 * accounts changes who administers this server.
 */
export const rootEquivalentGroups = Object.freeze(["sudo", "admin", "wheel", "docker", "lxd", "libvirt"]);

/**
 * Accounts whose login is shut: an expiry date that has passed. `usermod -L` alone locks only the
 * password, and sshd still takes a key; an expired account is refused whatever it signs in with.
 * @returns {Set<string>}
 */
export function lockedAccounts(shadowContent, today) {
  const locked = new Set();
  for (const line of String(shadowContent ?? "").split("\n")) {
    const fields = line.split(":");
    if (fields.length < 8 || !fields[0]) continue;
    const expire = fields[7];
    if (/^\d+$/.test(expire) && Number(expire) <= today) locked.add(fields[0]);
  }
  return locked;
}

/** A shadow password field that signs in: not empty, not locked ("!"), not "*" (never had one). */
const usablePassword = (field) => typeof field === "string" && field !== "" && !field.startsWith("!") && !field.startsWith("*");

/**
 * The `sshd -T` settings that decide who can still sign in. sshd prints one `key value` line per
 * setting, and one line per entry for AllowUsers, DenyUsers, AllowGroups and DenyGroups; both shapes
 * are read. A setting sshd did not print takes OpenSSH's default, except UsePAM, read as off (the
 * stricter: without PAM, sshd refuses an account whose password is locked even with a key).
 */
export function parseEffectiveSshd(stdout) {
  /** @type {Map<string, string[]>} */
  const lines = new Map();
  for (const line of String(stdout ?? "").split("\n")) {
    const match = line.trim().match(/^([A-Za-z0-9]+)\s+(.+)$/);
    if (match) lines.set(match[1].toLowerCase(), [...(lines.get(match[1].toLowerCase()) ?? []), match[2].trim()]);
  }
  const first = (key) => lines.get(key)?.[0] ?? null;
  const words = (key) => (lines.get(key) ?? []).flatMap((value) => value.split(/\s+/)).filter(Boolean);
  const methods = first("authenticationmethods") ?? "any";
  const command = first("authorizedkeyscommand");
  return {
    pubkey: first("pubkeyauthentication")?.toLowerCase() !== "no",
    password: first("passwordauthentication")?.toLowerCase() === "yes",
    keyboardInteractive: first("kbdinteractiveauthentication")?.toLowerCase() === "yes",
    permitRootLogin: first("permitrootlogin")?.toLowerCase() ?? "prohibit-password",
    usePam: first("usepam")?.toLowerCase() === "yes",
    authenticationMethods: methods,
    /** null is `any`; otherwise each list is a set of methods that must all succeed. */
    methodLists: /^any$/i.test(methods) ? null : methods.split(/\s+/).map((list) => list.toLowerCase().split(",").filter(Boolean)),
    allowUsers: words("allowusers"),
    denyUsers: words("denyusers"),
    allowGroups: words("allowgroups"),
    denyGroups: words("denygroups"),
    authorizedKeysFiles: lines.has("authorizedkeysfile") ? words("authorizedkeysfile") : [".ssh/authorized_keys", ".ssh/authorized_keys2"],
    authorizedKeysCommand: command && command.toLowerCase() !== "none" ? command : null,
  };
}

/** sshd's own pattern match: `*` and `?`, the whole name. */
const globMatches = (pattern, value) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value);

/**
 * Which of AllowUsers, DenyUsers, AllowGroups or DenyGroups shuts this account out, or null. sshd
 * checks DenyUsers, then AllowUsers, then DenyGroups, then AllowGroups. A `user@host` pattern depends
 * on where the owner connects from, which is not known here: it counts as denying, never as allowing.
 * So does a negated pattern.
 * @param {{ name: string, groups: string[] }} account
 * @param {ReturnType<typeof parseEffectiveSshd>} sshd
 */
function shutOutBy(account, sshd) {
  const userOf = (pattern) => { const at = pattern.indexOf("@"); return at < 0 ? { user: pattern, host: false } : { user: pattern.slice(0, at), host: true }; };
  if (sshd.denyUsers.some((pattern) => { const { user } = userOf(pattern); return user.startsWith("!") || globMatches(user, account.name); })) return "DenyUsers";
  if (sshd.allowUsers.length > 0 && !sshd.allowUsers.some((pattern) => { const { user, host } = userOf(pattern); return !host && !user.startsWith("!") && globMatches(user, account.name); })) return "AllowUsers";
  if (sshd.denyGroups.some((pattern) => pattern.startsWith("!") || account.groups.some((group) => globMatches(pattern, group)))) return "DenyGroups";
  if (sshd.allowGroups.length > 0 && !sshd.allowGroups.some((pattern) => !pattern.startsWith("!") && account.groups.some((group) => globMatches(pattern, group)))) return "AllowGroups";
  return null;
}

/**
 * The files sshd reads an account's keys from: AuthorizedKeysFile with %h, %u, %U and %% expanded,
 * relative paths under the home. A path with any other token, or a `~`, is left out: it cannot be
 * resolved here the way sshd would, so its keys are not counted.
 */
export function authorizedKeyPaths(patterns, account) {
  const paths = [];
  for (const pattern of patterns) {
    if (pattern.toLowerCase() === "none") continue;
    let expanded = "";
    let known = true;
    for (let index = 0; index < pattern.length; index += 1) {
      if (pattern[index] !== "%") { expanded += pattern[index]; continue; }
      const token = pattern[index + 1];
      index += 1;
      if (token === "%") expanded += "%";
      else if (token === "h") expanded += account.home;
      else if (token === "u") expanded += account.name;
      else if (token === "U") expanded += String(account.uid);
      else known = false;
    }
    if (!known || expanded.startsWith("~") || !expanded) continue;
    paths.push(path.posix.isAbsolute(expanded) ? path.posix.normalize(expanded) : path.posix.join(account.home, expanded));
  }
  return [...new Set(paths)];
}

/** Logical sudoers lines: continuations joined, blank lines dropped. */
const sudoersLines = (text) => String(text ?? "").replace(/\\\r?\n/g, " ").split("\n").map((line) => line.trim()).filter(Boolean);
/** A `#` starts a comment unless it is `#include` (handled first) or a `#uid`. */
const withoutComment = (line) => line.replace(/(^|\s)#(?!\d).*$/, "").trim();
const plainWho = (who) => who === "ALL" || usernamePattern.test(who) || /^%[a-z_][a-z0-9_-]*$/.test(who);

/**
 * One sudoers line as a rule: who it names, whether it gives every command as root on every host,
 * and whether the last NOPASSWD/PASSWD tag says no password.
 */
function parseSudoRule(line) {
  if (/^Defaults\b/.test(line) || /^(Runas|Host|Cmnd|Cmd)_Alias\b/.test(line)) return { kind: "other" };
  if (/^User_Alias\b/.test(line)) return { kind: "unknown" };
  const match = line.match(/^(\S+)\s+([^=\s]+)\s*=\s*(.+)$/);
  if (!match) return { kind: "unknown" };
  const command = match[3].trim().match(/^(?:\(\s*([^)]*)\)\s*)?((?:[A-Z_]+\s*:\s*)*)ALL$/);
  const runasRoot = !command?.[1] || /^(ALL|root)(\s*:\s*\S*)?$/.test(command[1].trim());
  // The last NOPASSWD/PASSWD tag anywhere in the line, for a rule of any shape: one that names some
  // commands and asks for a password can still be the rule sudo applies after a NOPASSWD grant.
  const passwordTags = match[3].match(/\b(?:NO)?PASSWD\s*:/g) ?? [];
  return {
    kind: "rule",
    who: match[1].split(",").filter(Boolean),
    allCommands: Boolean(command) && runasRoot && match[2] === "ALL",
    nopasswd: passwordTags.at(-1)?.startsWith("NO") ?? false,
  };
}

/**
 * /etc/sudoers and, where it says `@includedir /etc/sudoers.d` (or `#includedir`), that folder's
 * files in sudo's order (sorted, skipping names with a `.` or ending in `~`). `complete` is false
 * when anything that could grant or change a grant was not read or not understood: another include,
 * an unreadable file, a User_Alias, a netgroup or uid in a rule.
 * @param {{ read: (file: string) => Promise<string>, list: (dir: string) => Promise<string[]> }} sources
 */
export async function readSudoers({ read, list }) {
  const text = (file) => Promise.resolve().then(() => read(file)).then(String, () => null);
  const main = await text("/etc/sudoers");
  if (main === null) return { readable: false, complete: false, rules: [] };
  /** @type {Array<{ who: string[], allCommands: boolean, nopasswd: boolean }>} */
  const rules = [];
  let complete = true;
  const take = (line) => {
    const rule = parseSudoRule(line);
    if (rule.kind === "unknown") complete = false;
    if (rule.kind !== "rule") return;
    if (!rule.who.every(plainWho)) complete = false;
    rules.push({ who: rule.who, allCommands: rule.allCommands, nopasswd: rule.nopasswd });
  };
  for (const raw of sudoersLines(main)) {
    const include = raw.match(/^[@#]include(dir)?\s+(.+)$/);
    if (!include) { const line = withoutComment(raw); if (line) take(line); continue; }
    if (include[1] !== "dir" || include[2].trim() !== "/etc/sudoers.d") { complete = false; continue; }
    const names = await Promise.resolve().then(() => list("/etc/sudoers.d")).catch(() => null);
    if (names === null) { complete = false; continue; }
    for (const name of [...names].map(String).sort()) {
      if (name.includes(".") || name.endsWith("~")) continue;
      const content = await text(`/etc/sudoers.d/${name}`);
      if (content === null) { complete = false; continue; }
      for (const inner of sudoersLines(content)) {
        if (/^[@#]include/.test(inner)) { complete = false; continue; }
        const line = withoutComment(inner);
        if (line) take(line);
      }
    }
  }
  return { readable: true, complete, rules };
}

/** Does this sudoers rule name the account, by name, by one of its groups, or as ALL? */
export const sudoRuleNames = (rule, account) => rule.who.some((who) => who === "ALL" || who === account.name || (who.startsWith("%") && account.groups.includes(who.slice(1))));

/** An account's groups by name: its primary group and every group that lists it. */
export function groupsOf(name, passwdContent, groupContent) {
  const gid = String(passwdContent ?? "").split("\n").map((line) => line.split(":")).find((fields) => fields[0] === name)?.[3];
  return String(groupContent ?? "").split("\n").map((line) => line.split(":")).filter((fields) => fields.length >= 3 && fields[0])
    .filter((fields) => fields[2] === gid || (fields[3] ?? "").split(",").map((member) => member.trim()).includes(name))
    .map((fields) => fields[0]);
}

/**
 * Login accounts (root, and uid 1000 up with a shell) with everything that decides whether each could
 * sign in and administer: keys in the files sshd reads, lock, password, groups, and what sudoers gives
 * it. Read as root. `unreadable` lists /etc/passwd, /etc/group or /etc/shadow when they could not be
 * read: a caller that guards a lock-out refuses then. With `sshd` null, keys are read from
 * ~/.ssh/authorized_keys only.
 * @param {{ read: (file: string) => Promise<string>, list: (dir: string) => Promise<string[]>, today: number, sshd?: ReturnType<typeof parseEffectiveSshd> | null }} sources
 */
export async function accessFacts({ read, list, today, sshd = null }) {
  const text = (file) => Promise.resolve().then(() => read(file)).then(String, () => null);
  const [passwd, group, shadow] = await Promise.all(["/etc/passwd", "/etc/group", "/etc/shadow"].map(text));
  const unreadable = /** @type {Array<[string, string | null]>} */ ([["/etc/passwd", passwd], ["/etc/group", group], ["/etc/shadow", shadow]]).filter(([, content]) => content === null).map(([file]) => file);
  const passwords = new Map(String(shadow ?? "").split("\n").map((line) => line.split(":")).filter((fields) => fields.length >= 2 && fields[0]).map((fields) => [fields[0], fields[1]]));
  const locked = lockedAccounts(shadow ?? "", today);
  const sudoers = await readSudoers({ read, list });
  const accounts = [];
  for (const [name, , uidText, , , home, shell] of String(passwd ?? "").split("\n").map((line) => line.split(":")).filter((fields) => fields.length >= 7)) {
    const uid = Number(uidText);
    if (!(uid === 0 || (uid >= 1000 && uid < 60000)) || /nologin$|false$/.test(shell)) continue;
    const groups = groupsOf(name, passwd, group);
    const keys = new Set();
    for (const file of sshd ? authorizedKeyPaths(sshd.authorizedKeysFiles, { name, uid, home }) : [path.posix.join(home, ".ssh", "authorized_keys")]) {
      for (const line of validKeyLines((await text(file)) ?? "")) keys.add(line);
    }
    const account = { name, groups };
    // sudo takes the last rule that matches. A rule for every command as root grants; any later rule
    // for this account that asks for a password, whatever it names, may be the one sudo applies, so
    // it takes NOPASSWD back (counting fewer administrators, never more).
    let grant = null;
    for (const rule of sudoers.rules) {
      if (!sudoRuleNames(rule, account)) continue;
      if (rule.allCommands) grant = rule.nopasswd ? "nopasswd" : "password";
      else if (grant === "nopasswd" && !rule.nopasswd) grant = "password";
    }
    const sudoGroup = groups.includes("sudo");
    const password = passwords.get(name);
    accounts.push({
      name, uid, home, groups,
      sudo: name === "root" || sudoGroup,
      locked: locked.has(name),
      keyCount: keys.size,
      passwordUsable: usablePassword(password),
      // Unknown counts as locked: without PAM, sshd refuses such an account even with a key.
      passwordLocked: typeof password !== "string" || password.startsWith("!"),
      // Where sudoers was not all read, the sudo group stands in for it (Ubuntu's %sudo rule).
      canSudo: name === "root" || grant !== null || (!sudoers.complete && sudoGroup),
      nopasswd: sudoers.complete && grant === "nopasswd",
      rootEquivalent: name === "root" || groups.some((member) => rootEquivalentGroups.includes(member)) || !sudoers.complete || sudoers.rules.some((rule) => sudoRuleNames(rule, account)),
    });
  }
  return { accounts, sshd, unreadable, sudoers: { readable: sudoers.readable, complete: sudoers.complete } };
}

/** @typedef {Awaited<ReturnType<typeof accessFacts>>["accounts"][number]} AccessAccount */

const keyOnlyAllowed = (sshd) => !sshd.methodLists || sshd.methodLists.some((list) => list.length > 0 && list.every((method) => method === "publickey"));
const passwordOnlyAllowed = (sshd) => !sshd.methodLists || sshd.methodLists.some((list) => list.length > 0 && list.every((method) => method === "password" || method === "keyboard-interactive" || method.startsWith("keyboard-interactive:")));
const asksForPassword = (sshd) => Boolean(sshd.methodLists?.some((list) => list.some((method) => method === "password" || method.startsWith("keyboard-interactive"))));

/** Why this account, once signed in, could not use sudo; null when it can. */
function sudoGap(account) {
  if (account.name === "root") return null;
  if (!account.canSudo) return "it is not an administrator";
  if (!account.passwordUsable && !account.nopasswd) return "it has no password, so sudo would ask for one it cannot give (set one with sudo passwd, or add a NOPASSWD sudo rule)";
  return null;
}

/** Why this account could not sign in with a key and then use sudo; null when it could. */
function keyAdminGap(account, sshd) {
  if (account.keyCount === 0) return `it has no key in ${sshd.authorizedKeysFiles.join(" ")} (where sshd reads keys)`;
  if (account.locked) return "the account is locked";
  if (account.name === "root" && !rootKeyLogin.has(sshd.permitRootLogin)) return `PermitRootLogin ${sshd.permitRootLogin} keeps root out`;
  const shut = shutOutBy(account, sshd);
  if (shut) return `${shut} in the SSH configuration keeps it out`;
  if (!sshd.usePam && account.passwordLocked) return "its password is locked and UsePAM is off, so sshd refuses the account even with a key";
  return sudoGap(account);
}

/**
 * Who could still sign in over SSH with a key alone and use sudo: an account with a key in a file
 * sshd reads, not locked, admitted by AllowUsers/DenyUsers/AllowGroups/DenyGroups, root only while
 * PermitRootLogin lets a key in, and able to sudo (a password, or a NOPASSWD rule for every command).
 * @param {{ accounts: AccessAccount[], sshd: ReturnType<typeof parseEffectiveSshd> }} facts
 * @returns {string[]}
 */
export function keyAdmins({ accounts, sshd }) {
  if (!sshd.pubkey || !keyOnlyAllowed(sshd)) return [];
  return accounts.filter((account) => keyAdminGap(account, sshd) === null).map((account) => account.name);
}

/** Could this account sign in with its password, as sshd is set now? */
function passwordSignIn(account, sshd) {
  if (!(sshd.password || (sshd.keyboardInteractive && sshd.usePam)) || !passwordOnlyAllowed(sshd)) return false;
  if (!account.passwordUsable || account.locked) return false;
  if (account.name === "root" && sshd.permitRootLogin !== "yes") return false;
  return shutOutBy(account, sshd) === null;
}

/** Accounts that could sign in over SSH today, with a key or a password, and then use sudo. */
function signInAdmins({ accounts, sshd }) {
  const byKey = new Set(keyAdmins({ accounts, sshd }));
  return accounts.filter((account) => byKey.has(account.name) || (passwordSignIn(account, sshd) && sudoGap(account) === null)).map((account) => account.name);
}

/**
 * Why turning password login off would lock everyone out, in words for the owner; null when an
 * administrator could still sign in with a key and use sudo.
 * @param {Awaited<ReturnType<typeof accessFacts>> & { sshd: ReturnType<typeof parseEffectiveSshd> }} facts
 */
export function keyOnlyRefusal({ accounts, sshd, unreadable }) {
  if (unreadable.length > 0) return `Could not read ${unreadable.join(", ")}, so BoxPilot cannot tell who could still sign in. Nothing was changed.`;
  if (!sshd.pubkey) return "This server's SSH configuration has key logins turned off (PubkeyAuthentication no), so turning off password logins would leave no way in over SSH.";
  if (asksForPassword(sshd) || !keyOnlyAllowed(sshd)) {
    return `This server's SSH configuration asks for more than a key to sign in (AuthenticationMethods ${sshd.authenticationMethods}), such as a key and then a password or one-time code. Turning password login off turns keyboard-interactive off too, so nobody could complete that and sign in. Change AuthenticationMethods in /etc/ssh/sshd_config first, or leave password login on. Nothing was changed.`;
  }
  if (keyAdmins({ accounts, sshd }).length > 0) return null;
  const command = sshd.authorizedKeysCommand ? ` Keys that AuthorizedKeysCommand (${sshd.authorizedKeysCommand}) hands sshd cannot be checked from here, so they are not counted.` : "";
  const defaultFiles = sshd.authorizedKeysFiles.join(" ") === ".ssh/authorized_keys .ssh/authorized_keys2";
  if (!accounts.some((account) => account.keyCount > 0)) return `No user has an SSH key${defaultFiles ? "" : ` in ${sshd.authorizedKeysFiles.join(" ")} (where sshd reads keys)`} yet. Import a key first so key-only login still works.${command}`;
  const considered = accounts.filter((account) => account.keyCount > 0 || (account.name !== "root" && account.canSudo));
  const reasons = considered.map((account) => `${account.name}: ${keyAdminGap(account, sshd)}`);
  return `No administrator could sign in with a key and use sudo afterwards. ${reasons.join("; ")}.${command} Import a key for an administrator who has a password first. Nothing was changed.`;
}

const effectiveValue = (stdout, key) => String(stdout ?? "").match(new RegExp(`^${key}\\s+(\\S+)`, "im"))?.[1]?.toLowerCase() ?? null;

/** @param {{ enabled?: boolean }} [parameters] */
/** @param {{ readFile: Function, readdir?: Function }} files */
const factSources = (files) => ({
  read: (file) => files.readFile(file, "utf8"),
  list: (dir) => (files.readdir ? files.readdir(dir) : Promise.reject(new Error("no readdir"))),
});

/** @param {{ enabled?: boolean }} [parameters] */
export async function sshPasswordAuthSet({ enabled } = {}, { run = fixedRun, log = null, files = { readFile, readdir, writeFile, unlink }, now = Date.now() } = {}) {
  if (typeof enabled !== "boolean") throw new Error("Choose on or off.");
  if (!enabled) {
    // A key is only a way in if sshd will accept it from that account, and an administrator only if
    // sudo then works for them: the guard reads both as sshd and sudo would (accessFacts, keyOnlyRefusal).
    const effective = await run("/usr/sbin/sshd", ["-T"], { timeout: 15_000 });
    if (!effective.ok) throw new Error("Could not read the effective SSH configuration, so BoxPilot cannot confirm key logins would still work. Nothing was changed.");
    const sshd = parseEffectiveSshd(effective.stdout);
    const facts = await accessFacts({ ...factSources(files), today: Math.floor(now / dayMs), sshd });
    const refusal = keyOnlyRefusal({ ...facts, sshd });
    if (refusal) throw new Error(refusal);
    log?.(`Administrators who can sign in with a key and use sudo: ${keyAdmins({ accounts: facts.accounts, sshd }).join(", ")}`, "stdout");
  }
  // Off writes both: with KbdInteractiveAuthentication on, PAM still asks for the password. On drops
  // the keyboard-interactive line, so it goes back to what the rest of sshd's configuration says.
  const content = `# Managed by BoxPilot (Users & SSH page). sshd uses the first value it reads,\n# and this file sorts before the distribution drop-ins.\nPasswordAuthentication ${enabled ? "yes" : "no"}\n${enabled ? "" : "KbdInteractiveAuthentication no\n"}`;
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
  // Read back what sshd now does, rather than report what was written.
  const after = await run("/usr/sbin/sshd", ["-T"], { timeout: 15_000 });
  if (!after.ok) return { passwordAuthentication: enabled, dropIn: sshdDropInPath, warnings: ["The setting was written and ssh reloaded, but the effective configuration could not be read back to confirm it."] };
  const passwordAuthentication = effectiveValue(after.stdout, "passwordauthentication") === "yes";
  const keyboardInteractive = effectiveValue(after.stdout, "kbdinteractiveauthentication") === "yes";
  if (!enabled && (passwordAuthentication || keyboardInteractive)) {
    throw new Error(`${sshdDropInPath} was written and ssh reloaded, but sshd still takes passwords (${[passwordAuthentication && "PasswordAuthentication yes", keyboardInteractive && "KbdInteractiveAuthentication yes"].filter(Boolean).join(", ")}): another file under /etc/ssh sets it first.`);
  }
  return { passwordAuthentication, keyboardInteractive, dropIn: sshdDropInPath };
}

/** BoxPilot's own service accounts; the one boxpilot.service runs as is asked of systemd too. */
const boxpilotAccounts = Object.freeze(["boxpilot", "boxpilot-agents", "boxpilot-model-gateway"]);

async function serviceAccounts(run) {
  const shown = await run("/usr/bin/systemctl", ["show", "boxpilot.service", "--property=User", "--value"], { timeout: 10_000 });
  const user = shown.ok ? String(shown.stdout ?? "").trim() : "";
  return new Set([...boxpilotAccounts, ...(user ? [user] : [])]);
}

/** Read one account's shadow entry: the password field and the expiry day. */
async function shadowEntry(files, username) {
  const shadow = await files.readFile("/etc/shadow", "utf8").catch(() => "");
  const fields = String(shadow).split("\n").map((line) => line.split(":")).find((entry) => entry[0] === username);
  return fields ? { password: fields[1] ?? "", expire: fields[7] ?? "" } : null;
}

/**
 * The checks lock and remove share: a person's account (not root, not a system account below uid
 * 1000, not one BoxPilot runs as), and not the last administrator who could still sign in.
 */
async function personAccount(run, username, verb) {
  assertUsername(username);
  if (username === "root") throw new Error(`root cannot be ${verb} here.`);
  if ((await serviceAccounts(run)).has(username)) throw new Error(`${username} is an account BoxPilot runs as, so it cannot be ${verb} here.`);
  const entry = await userEntry(run, username);
  if (!entry) throw new Error(`User ${username} does not exist`);
  if (!(entry.uid >= 1000 && entry.uid < 60000)) throw new Error(`${username} is a system account (uid ${entry.uid}); only people's accounts, uid 1000 and up, are ${verb} here.`);
  return entry;
}

/**
 * Refuse to shut out the last administrator who can actually get in: another account that could sign
 * in over SSH today (a key sshd accepts from it, or its password while sshd takes passwords) and then
 * use sudo (a password, or a NOPASSWD rule). A sudo member with no password and no key does not count.
 * Nothing is checked for an account that cannot administer in the first place.
 */
async function assertAnotherAdmin(run, files, username, today, doing) {
  const cannotTell = (why) => new Error(`${why}, so BoxPilot cannot tell whether ${username} is the last administrator who can sign in. Nothing was changed.`);
  const first = await accessFacts({ ...factSources(files), today });
  if (first.unreadable.length > 0) throw cannotTell(`Could not read ${first.unreadable.join(", ")}`);
  const target = first.accounts.find((account) => account.name === username);
  if (!target || !(target.sudo || target.canSudo)) return;
  const effective = await run("/usr/sbin/sshd", ["-T"], { timeout: 15_000 });
  if (!effective.ok) throw cannotTell("Could not read the effective SSH configuration");
  const sshd = parseEffectiveSshd(effective.stdout);
  const facts = await accessFacts({ ...factSources(files), today, sshd });
  if (facts.unreadable.length > 0) throw cannotTell(`Could not read ${facts.unreadable.join(", ")}`);
  const others = signInAdmins({ accounts: facts.accounts.filter((account) => account.name !== username), sshd });
  if (others.length === 0) {
    throw new Error(`${username} is the last administrator who can sign in; ${doing} would leave nobody who can sign in over SSH and use sudo. First give another administrator a way in: an SSH key sshd accepts, or a password while password login is on, and a password (or a NOPASSWD sudo rule) so sudo works.`);
  }
}

const tailOf = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-2).join(" ");

/**
 * Shut an account: lock its password and expire it, so neither a password nor a key signs it in.
 * @param {{ username?: string }} [parameters]
 */
export async function userLock({ username } = {}, { run = fixedRun, log = null, files = { readFile, readdir }, now = Date.now() } = {}) {
  const today = Math.floor(now / dayMs);
  await personAccount(run, username, "locked");
  const before = await shadowEntry(files, username);
  if (before && /^\d+$/.test(before.expire) && Number(before.expire) <= today && before.password.startsWith("!")) return { username, locked: true, changed: false };
  await assertAnotherAdmin(run, files, username, today, "locking it");
  log?.(`$ usermod --lock --expiredate 1 ${username}`, "stdout");
  const result = await run("/usr/sbin/usermod", ["--lock", "--expiredate", "1", username], { timeout: 30_000 });
  if (!result.ok) throw new Error(`${username} could not be locked: ${tailOf(result.stderr) || "no reason given"}. Nothing was changed.`);
  const after = await shadowEntry(files, username);
  if (!after || !(/^\d+$/.test(after.expire) && Number(after.expire) <= today)) throw new Error(`usermod finished, but ${username}'s account is not shown as expired, so it may still sign in with a key.`);
  return { username, locked: true, changed: true, note: "Sessions already open stay until they end." };
}

/**
 * Open a locked account again: clear the expiry, and unlock the password if it had one.
 * @param {{ username?: string }} [parameters]
 */
export async function userUnlock({ username } = {}, { run = fixedRun, log = null, files = { readFile }, now = Date.now() } = {}) {
  const today = Math.floor(now / dayMs);
  await personAccount(run, username, "unlocked");
  const before = await shadowEntry(files, username);
  if (!before) throw new Error(`${username}'s shadow entry could not be read. Nothing was changed.`);
  // A lone "!" is an account that never had a password (users.add makes them so): unlocking it would
  // leave it passwordless, which usermod refuses. Only a locked hash is unlocked.
  const unlockPassword = before.password.startsWith("!") && before.password.length > 1;
  const args = ["--expiredate", "", ...(unlockPassword ? ["--unlock"] : []), username];
  log?.(`$ usermod ${args.map((arg) => arg || "''").join(" ")}`, "stdout");
  const result = await run("/usr/sbin/usermod", args, { timeout: 30_000 });
  if (!result.ok) throw new Error(`${username} could not be unlocked: ${tailOf(result.stderr) || "no reason given"}. Nothing was changed.`);
  const after = await shadowEntry(files, username);
  if (after && /^\d+$/.test(after.expire) && Number(after.expire) <= today) throw new Error(`usermod finished, but ${username}'s account is still expired.`);
  return { username, locked: false, passwordUnlocked: unlockPassword };
}

/** A home folder userdel may remove: one level under /home, and nobody else's. */
const removableHome = /^\/home\/[a-z_][a-z0-9_-]{0,31}\/?$/;

/**
 * Remove an account, keeping its home folder unless the owner asked for it to go too.
 * @param {{ username?: string, removeHome?: boolean }} [parameters]
 */
export async function userRemove({ username, removeHome = false } = {}, { run = fixedRun, log = null, files = { readFile, readdir, access }, now = Date.now() } = {}) {
  if (typeof removeHome !== "boolean") throw new Error("Choose whether the home folder goes too.");
  const today = Math.floor(now / dayMs);
  const entry = await personAccount(run, username, "removed");
  await assertAnotherAdmin(run, files, username, today, "removing it");
  if (removeHome) {
    if (!removableHome.test(entry.home)) throw new Error(`${username}'s home is ${entry.home}, not a folder of its own under /home, so it is not removed from here. Remove the account and keep the folder instead.`);
    const passwd = await files.readFile("/etc/passwd", "utf8").catch(() => "");
    const sharing = String(passwd).split("\n").map((line) => line.split(":")).filter((fields) => fields.length >= 7 && fields[0] !== username && fields[5].replace(/\/$/, "") === entry.home.replace(/\/$/, ""));
    if (sharing.length) throw new Error(`${entry.home} is also the home of ${sharing.map((fields) => fields[0]).join(", ")}, so it is not removed. Remove the account and keep the folder instead.`);
  }
  const args = [...(removeHome ? ["--remove"] : []), username];
  log?.(`$ userdel ${args.join(" ")}`, "stdout");
  const result = await run("/usr/sbin/userdel", args, { timeout: 60_000 });
  const gone = !(await userEntry(run, username));
  if (!gone) throw new Error(`${username} could not be removed: ${tailOf(result.stderr) || "no reason given"}. Nothing was changed.`);
  if (!removeHome) return { username, removed: true, home: entry.home, homeRemoved: false };
  const homeLeft = await files.access(entry.home).then(() => true, () => false);
  if (homeLeft) return { username, removed: true, home: entry.home, homeRemoved: false, warnings: [`The account was removed, but its home folder could not be: ${entry.home} is still there${tailOf(result.stderr) ? ` (${tailOf(result.stderr)})` : ""}.`] };
  return { username, removed: true, home: entry.home, homeRemoved: true };
}
