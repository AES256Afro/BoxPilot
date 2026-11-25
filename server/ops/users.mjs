import { readFile, readdir } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { accessFacts, githubUserPattern, keyAdmins, keyOnlyRefusal, parseEffectiveSshd, usernamePattern } from "../tasks/users.mjs";

const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
const minutes = (value) => value * 60_000;

/**
 * Human accounts: root plus uid >= 1000 with a login shell.
 * @returns {Array<{ name: string, uid: number, home: string, shell: string, sudo: boolean, keyCount?: number, locked?: boolean, rootEquivalent?: boolean }>} keyCount, locked and rootEquivalent are filled in by users.inspect
 */
export function parseUsers(passwdContent, groupContent) {
  const sudoLine = String(groupContent ?? "").split("\n").find((line) => line.startsWith("sudo:"));
  const sudoMembers = new Set((sudoLine?.split(":")[3] ?? "").split(",").filter(Boolean));
  return String(passwdContent ?? "").split("\n").map((line) => line.split(":")).filter((fields) => fields.length >= 7)
    .filter(([, , uid, , , , shell]) => (Number(uid) >= 1000 && Number(uid) < 60000 && !/nologin$|false$/.test(shell)) || Number(uid) === 0)
    .map(([name, , uid, , , home, shell]) => ({ name, uid: Number(uid), home, shell, sudo: name === "root" || sudoMembers.has(name) }))
    .sort((a, b) => a.uid - b.uid);
}

/** Parse `sshd -T` output (lower-case `key value` lines) down to the fields the page shows. */
export function parseSshdConfig(stdout) {
  const fields = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const match = line.match(/^(passwordauthentication|permitrootlogin|port|pubkeyauthentication|kbdinteractiveauthentication)\s+(.+)$/);
    if (match) fields[match[1]] = fields[match[1]] ?? match[2].trim();
  }
  return {
    passwordAuthentication: fields.passwordauthentication === "yes",
    keyboardInteractive: fields.kbdinteractiveauthentication === "yes",
    pubkeyAuthentication: fields.pubkeyauthentication !== "no",
    permitRootLogin: fields.permitrootlogin ?? null,
    port: fields.port ? Number(fields.port) : 22,
  };
}

const usernameField = { type: "string", maxLength: 32, pattern: usernamePattern };
const githubUserField = { type: "string", optional: true, nullable: true, maxLength: 39, pattern: githubUserPattern };

export function userOperations() {
  return [
    defineOperation({
      // operator (ADR-003): reads every user's ~/.ssh/authorized_keys and sshd -T as root - files a viewer cannot open.
      id: "users.inspect", title: "List users and SSH access", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 60_000,
      description: "Human accounts, their sudo membership, key counts and whether they are locked, and the effective sshd settings.",
      run: async (_parameters, { run, read = (file) => readFile(file, "utf8"), list = (dir) => readdir(dir), now = Date.now() }) => {
        const [passwd, group] = await Promise.all(["/etc/passwd", "/etc/group"].map((file) => read(file).catch(() => "")));
        const effective = await run("/usr/sbin/sshd", ["-T"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
        const service = await run(systemctl, ["show", "ssh.service", "--property=ActiveState"], { timeout: 15_000 });
        const sshd = effective.ok ? parseSshdConfig(effective.stdout) : null;
        const effectiveSshd = effective.ok ? parseEffectiveSshd(effective.stdout) : null;
        // The same facts ssh.password-auth.set and the lock/remove guards read (tasks/users.mjs).
        const facts = await accessFacts({ read, list, today: Math.floor(now / 86_400_000), sshd: effectiveSshd });
        const byName = new Map(facts.accounts.map((account) => [account.name, account]));
        const users = parseUsers(passwd, group);
        for (const user of users) {
          const account = byName.get(user.name);
          user.keyCount = account?.keyCount ?? 0;
          user.locked = account?.locked ?? false;
          // In a group that is root in all but name (docker, lxd, libvirt, wheel, admin, sudo) or named
          // in sudoers: locking or opening it is the owner's, as the escalation hook raises it.
          user.rootEquivalent = account?.rootEquivalent ?? true;
          delete user.home;
        }
        return {
          users,
          sshd,
          sshActive: /ActiveState=active/.test(service.stdout ?? ""),
          // Who could still sign in with a key and use sudo, were passwords off (the guard ssh.password-auth.set applies).
          keyAdmins: effectiveSshd ? keyAdmins({ accounts: facts.accounts, sshd: effectiveSshd }) : [],
          // Why turning passwords off would be refused, in the owner's words; null when it would go ahead.
          keyOnlyProblem: effectiveSshd ? keyOnlyRefusal({ ...facts, sshd: effectiveSshd }) : "The effective SSH configuration could not be read.",
        };
      },
    }),
    defineOperation({
      id: "users.add", title: "Add a user", risk: "medium", timeoutMs: minutes(3),
      description: "Creates the account with a home folder. It cannot sign in with a password; its SSH keys can be brought in from GitHub at the same time.",
      parameters: { fields: { username: usernameField, githubUser: githubUserField } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("users.add", { username: parameters.username, githubUser: parameters.githubUser ?? null }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "users.keys.import", title: "Import SSH keys", risk: "high", timeoutMs: minutes(3),
      description: "Adds public keys to the user's authorized_keys, from github.com/<user>.keys or pasted text. Existing keys are kept.",
      parameters: { fields: { username: usernameField, githubUser: githubUserField, keys: { type: "string", optional: true, nullable: true, maxLength: 65536 } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("users.keys-import", { username: parameters.username, githubUser: parameters.githubUser ?? null, keys: parameters.keys ?? null }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "users.sudo.set", title: "Change administrator rights", risk: "high", timeoutMs: minutes(3),
      description: "Adds the user to, or removes them from, the sudo group. The last sudo user cannot be removed.",
      parameters: { fields: { username: usernameField, sudo: { type: "boolean" } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("users.sudo", { username: parameters.username, sudo: parameters.sudo }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "ssh.password-auth.set", title: "Change SSH password login", risk: "high", timeoutMs: minutes(3),
      description: "Turns signing in over SSH with a password on or off; off also turns off keyboard-interactive login, which asks for the same password. Turning it off needs an administrator who can sign in with a key sshd accepts and then use sudo, and is refused while AuthenticationMethods asks for more than a key, so nobody is locked out. Tailscale SSH is not affected.",
      parameters: { fields: { enabled: { type: "boolean" } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("ssh.password-auth", { enabled: parameters.enabled }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "users.lock", title: "Lock a user", risk: "medium", timeoutMs: minutes(3),
      description: "Locks the account's password and expires it, so it cannot sign in with a password or a key. Its files and keys are kept. Refused for root, system accounts, BoxPilot's own accounts and the last administrator.",
      parameters: { fields: { username: usernameField } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("users.lock", { username: parameters.username }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "users.unlock", title: "Unlock a user", risk: "medium", timeoutMs: minutes(3),
      description: "Clears the account's expiry and unlocks its password if it has one, so it can sign in again.",
      parameters: { fields: { username: usernameField } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("users.unlock", { username: parameters.username }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "users.remove", title: "Remove a user", risk: "high", timeoutMs: minutes(3),
      confirm: (parameters) => parameters.username,
      description: "Deletes the account with userdel. Its home folder is kept unless you choose to remove it too. Refused for root, system accounts, BoxPilot's own accounts and the last administrator.",
      parameters: { fields: { username: usernameField, removeHome: { type: "boolean", optional: true } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("users.remove", { username: parameters.username, removeHome: parameters.removeHome ?? false }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
  ];
}
