import { access, readFile } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { exportsPath, parseExports, scopes, validateNfsConfig } from "../tasks/nfs.mjs";

const minutes = (value) => value * 60_000;
const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";

/** NFS server: export this server's folders to the tailnet (and optionally the LAN). */
export function nfsOperations() {
  return [
    defineOperation({
      id: "nfs.inspect", title: "Read NFS server state", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "Whether the NFS server is installed and running, and the exports BoxPilot manages.",
      run: async (_parameters, { run }) => {
        const installed = await access("/usr/sbin/exportfs").then(() => true, () => false);
        const content = await readFile(exportsPath, "utf8").catch(() => "");
        const config = parseExports(content);
        let running = null;
        if (installed) {
          const active = await run(systemctl, ["is-active", "nfs-server"], { timeout: 10_000 }).catch(() => null);
          running = active ? active.stdout.trim() === "active" : null;
        }
        const scope = config.exports.some((entry) => entry.clients.some((client) => client !== "100.64.0.0/10")) ? "lan" : "tailscale";
        return { installed, running, configured: content.length > 0 && config.managed, config: { ...config, scope } };
      },
    }),
    defineOperation({
      id: "nfs.apply", title: "Apply NFS exports", risk: "medium", timeoutMs: minutes(3),
      description: "Writes /etc/exports.d/boxpilot.exports for the chosen folders (NFSv4 only, offered to the Tailscale range and optionally the LAN), validates it with exportfs, and starts the NFS server.",
      parameters: { fields: {
        scope: { type: "string", optional: true, enum: [...scopes] },
        exports: { type: "array", validate: (value, parameters) => validateNfsConfig({ scope: parameters.scope ?? "tailscale", exports: value }) },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("nfs.apply", { scope: parameters.scope ?? "tailscale", exports: parameters.exports.map((entry) => ({ path: entry.path, readOnly: entry.readOnly ?? false })) }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
  ];
}
