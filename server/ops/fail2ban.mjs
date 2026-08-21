import { access, readFile } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { jailPath, parseJail } from "../tasks/fail2ban.mjs";

const minutes = (value) => value * 60_000;
const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
const client = "/usr/bin/fail2ban-client";
const whole = (min, max) => (value) => (Number.isInteger(value) && value >= min && value <= max ? null : `must be a whole number between ${min} and ${max}`);

/** Brute-force protection for SSH with fail2ban. */
export function fail2banOperations() {
  return [
    defineOperation({
      id: "fail2ban.inspect", title: "Read brute-force protection state", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "Whether fail2ban is installed and running, the managed sshd jail settings, and how many addresses are banned right now.",
      run: async (_parameters, { run }) => {
        const installed = await access(client).then(() => true, () => false);
        const config = parseJail(await readFile(jailPath, "utf8").catch(() => ""));
        let running = null; let currentlyBanned = null; let totalBanned = null;
        if (installed) {
          const active = await run(systemctl, ["is-active", "fail2ban"], { timeout: 10_000 }).catch(() => null);
          running = active ? active.stdout.trim() === "active" : null;
          const status = await run(client, ["status", "sshd"], { timeout: 10_000 }).catch(() => null);
          if (status?.ok) {
            currentlyBanned = Number(status.stdout.match(/Currently banned:\s*(\d+)/)?.[1] ?? 0);
            totalBanned = Number(status.stdout.match(/Total banned:\s*(\d+)/)?.[1] ?? 0);
          }
        }
        return { installed, running, configured: config.managed, config, currentlyBanned, totalBanned };
      },
    }),
    defineOperation({
      id: "fail2ban.apply", title: "Apply brute-force protection", risk: "medium", timeoutMs: minutes(3),
      description: "Writes /etc/fail2ban/jail.d/boxpilot.local enabling the sshd jail with your thresholds (loopback, the tailnet, and optionally the LAN are never banned), tests it, and starts fail2ban. Disabling stops the service and removes the file.",
      parameters: { fields: {
        enabled: { type: "boolean", optional: true },
        maxRetry: { type: "number", optional: true, validate: whole(1, 50) },
        findTimeMinutes: { type: "number", optional: true, validate: whole(1, 1440) },
        banTimeMinutes: { type: "number", optional: true, validate: whole(1, 43200) },
        ignoreLan: { type: "boolean", optional: true },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("fail2ban.apply", { enabled: parameters.enabled ?? true, maxRetry: parameters.maxRetry ?? 5, findTimeMinutes: parameters.findTimeMinutes ?? 10, banTimeMinutes: parameters.banTimeMinutes ?? 60, ignoreLan: parameters.ignoreLan ?? true }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
  ];
}
