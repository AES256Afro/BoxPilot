import { access, readFile } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { parseSmbConf, sambaUsernamePattern, scopes, shareNamePattern, smbConfPath, validateSambaConfig, workgroupPattern } from "../tasks/samba.mjs";

const minutes = (value) => value * 60_000;
const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";

/**
 * Samba file server: share this server's folders with the owner's tailnet (and optionally
 * the LAN). State is read from smb.conf and the sambashare group; changes are root tasks.
 */
export function sambaOperations() {
  return [
    defineOperation({
      id: "samba.inspect", title: "Read file-server state", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "Whether Samba is installed and running, the shares BoxPilot manages, and the Samba users.",
      run: async (_parameters, { run }) => {
        const installed = await access("/usr/sbin/smbd").then(() => true, () => false);
        const content = await readFile(smbConfPath, "utf8").catch(() => "");
        const config = parseSmbConf(content);
        let running = null;
        if (installed) {
          const active = await run(systemctl, ["is-active", "smbd"], { timeout: 10_000 }).catch(() => null);
          running = active ? active.stdout.trim() === "active" : null;
        }
        const group = await run("/usr/bin/getent", ["group", "sambashare"], { timeout: 10_000 }).catch(() => null);
        const users = group?.ok && group.stdout ? (group.stdout.trim().split(":")[3] ?? "").split(",").filter(Boolean).sort() : [];
        return { installed, running, configured: content.length > 0 && config.managed, config, users };
      },
    }),
    defineOperation({
      id: "samba.apply", title: "Apply file-server shares", risk: "medium", timeoutMs: minutes(3),
      description: "Writes /etc/samba/smb.conf from the chosen shares (binding to loopback and tailscale0, plus the LAN when chosen), validates it with testparm, and reloads Samba. The original file is kept as smb.conf.before-boxpilot.",
      parameters: { fields: {
        workgroup: { type: "string", optional: true, maxLength: 15, pattern: workgroupPattern },
        scope: { type: "string", optional: true, enum: [...scopes] },
        shares: { type: "array", validate: (value, parameters) => validateSambaConfig({ workgroup: parameters.workgroup ?? "WORKGROUP", scope: parameters.scope ?? "tailscale", shares: value }) },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("samba.apply", {
        workgroup: parameters.workgroup ?? "WORKGROUP", scope: parameters.scope ?? "tailscale",
        shares: parameters.shares.map((share) => ({ name: share.name, path: share.path, comment: share.comment ?? null, readOnly: share.readOnly ?? false, guest: share.guest ?? false, users: share.users ?? [] })),
      }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "samba.user.set", title: "Add or update a file-server user", risk: "medium", timeoutMs: minutes(2),
      description: "Creates a shell-less Linux account in the sambashare group if needed and sets its Samba password. The password never touches the database or a command line.",
      parameters: { fields: {
        username: { type: "string", maxLength: 32, pattern: sambaUsernamePattern },
        password: { type: "string", maxLength: 128, secret: true, validate: (value) => (value.length >= 8 ? null : "must be at least 8 characters") },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("samba.user.set", { username: parameters.username, password: parameters.password }, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "samba.user.remove", title: "Remove a file-server user", risk: "medium", timeoutMs: minutes(2),
      description: "Removes the user's Samba password so they can no longer connect. The Linux account is kept.",
      parameters: { fields: { username: { type: "string", maxLength: 32, pattern: sambaUsernamePattern } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("samba.user.remove", { username: parameters.username }, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
  ];
}

export { shareNamePattern };
