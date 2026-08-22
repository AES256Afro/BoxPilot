import { readFile } from "node:fs/promises";
import path from "node:path";
import { defineOperation } from "./registry.mjs";
import { githubUserPattern, usernamePattern, validKeyLines } from "../tasks/users.mjs";

const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
const minutes = (value) => value * 60_000;

/** Human accounts: root plus uid >= 1000 with a login shell. */
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
      id: "users.inspect", title: "List users and SSH access", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Human accounts, their sudo membership and key counts, and the effective sshd settings.",
      run: async (_parameters, { run }) => {
        const [passwd, group] = await Promise.all([
          readFile("/etc/passwd", "utf8").catch(() => ""),
          readFile("/etc/group", "utf8").catch(() => ""),
        ]);
        const users = parseUsers(passwd, group);
        for (const user of users) {
          const keys = await readFile(path.join(user.home, ".ssh", "authorized_keys"), "utf8").catch(() => "");
          user.keyCount = validKeyLines(keys).length;
          delete user.home;
        }
        const effective = await run("/usr/sbin/sshd", ["-T"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
        const service = await run(systemctl, ["show", "ssh.service", "--property=ActiveState"], { timeout: 15_000 });
        return {
          users,
          sshd: effective.ok ? parseSshdConfig(effective.stdout) : null,
          sshActive: /ActiveState=active/.test(service.stdout ?? ""),
        };
      },
    }),
    defineOperation({
      id: "users.add", title: "Add a user", risk: "medium", timeoutMs: minutes(3),
      description: "Creates the account with a home directory and bash, password login locked. Optionally imports the user's public keys from GitHub.",
      parameters: { fields: { username: usernameField, githubUser: githubUserField } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("users.add", { username: parameters.username, githubUser: parameters.githubUser ?? null }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "users.keys.import", title: "Import SSH keys", risk: "high", timeoutMs: minutes(3),
      description: "Adds public keys to the user's authorized_keys — from github.com/<user>.keys or pasted text. Existing keys are kept.",
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
      description: "Turns SSH password authentication on or off via a validated sshd drop-in, then reloads ssh. Turning it off requires at least one user with a key. Tailscale SSH is unaffected.",
      parameters: { fields: { enabled: { type: "boolean" } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("ssh.password-auth", { enabled: parameters.enabled }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
  ];
}
